// First: what this device kept under the app's former name (beep), moved before anything reads it.
import './legacystore';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppRootProps } from './appmain';
import { hasPrivateCache, probablySignedIn, rememberSignedIn, wipeDevice } from './devicestore';
import { setSessionKnown, startSessionCheck, type SessionReply } from './api';
import { useBootT } from './i18n';
import { Lazy, lazyChunk, reloadForNewBuild } from './lazy';
import { afterSignIn, saveReturn, type ReturnStorage } from './signinreturn';
import { registerWorker } from './swreg';
import { fitIOSViewport, watchKeyboard } from './viewport';
import './boot.css';

// The public entry (index.html): everything a signed-out visitor's browser gets. The session check, the sign-in and
// enrolment screens (Auth.tsx, its own chunk), the service worker's registration (with its push handlers), and the
// way into the app: the private entry (appmain.tsx: App, Shell, the registry, every package's client code), imported only
// once signed in. The server serves the private entry's files to a session only (server/appassets.ts); the worker
// precaches this entry's files only, and keeps the private ones in a cache of their own (client/sw-app.js).
//
// Instant open: a device that was signed in (devicestore.ts probablySignedIn) and holds this version's private chunks
// (hasPrivateCache) imports the private entry at once, from the worker's cache, alongside the session check, and hands
// the screen to the app as soon as it is in: the app shows the stored copy while the check runs, and signs out (wiping
// the copy and the caches) if the session is gone. Any other launch waits for the check: signed in, then the app;
// signed out, the sign-in screen, without any app code; offline, the app from the cache if it is there, else a line
// saying to connect once.
// No top-level await (Safari 17: this module also registers the worker on the load event).

const Login = lazyChunk(() => import('./Auth'), 'Login');
const Enroll = lazyChunk(() => import('./Auth'), 'Enroll');

const root = createRoot(document.getElementById('root')!);
const show = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>);

// Same as the static splash of index.html, which shows until this first render.
const splash = (
  <div className="splash">
    <div className="gate-mark" aria-hidden="true" />
  </div>
);

/** A launch that cannot go on (the app's code missing): one line and Retry, which reloads. */
function BootError({ pending }: { pending?: boolean }) {
  const t = useBootT();
  return (
    <div className="splash">
      <div className="list-status" role="alert" data-testid={pending ? 'update-pending' : 'load-error'}>
        <p>{pending ? t.updatePending : t.loadFailed}</p>
        <button type="button" className="text-btn" data-testid="load-retry" onClick={() => location.reload()}>
          {t.retry}
        </button>
      </div>
    </div>
  );
}

/**
 * BootError for app code that would not load while signed in, after the one reload: the page may still be the previous
 * version's, its worker in charge until the new one has installed. Reload as soon as the new worker takes over (an
 * error screen has nothing to lose; swreg.ts would wait for the page to be hidden).
 */
function showStaleError(): void {
  show(<BootError />);
  navigator.serviceWorker?.addEventListener('controllerchange', () => location.reload(), { once: true });
}

/** This tab's sessionStorage, or none (blocked, private mode): the return across an OIDC sign-in is then lost. */
function tabStorage(): ReturnStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
/**
 * Before leaving for the OIDC provider (which always comes back to /): keeps the page to return to, in this tab only.
 * The boot does not know the app's pages (the registry is private): any well-formed path of this origin is kept, and
 * the app checks it again against its pages when it reads it back (signinreturn.ts takeReturn, App.tsx).
 */
const keepReturnForProvider = () => saveReturn(tabStorage(), afterSignIn(window.location.pathname, window.location.search, () => true));

type AppModule = typeof import('./appmain');
let appModule: Promise<AppModule> | undefined;
// The browser keeps a failed module import for the life of the page (lazy.tsx): once the private entry failed (offline
// and not cached, or asked for with a session gone: the server's redirect is no script), only a reload loads it.
let importFailed = false;
function loadApp(): Promise<AppModule> {
  appModule ??= import('./appmain').catch((e: unknown) => {
    appModule = undefined;
    importFailed = true;
    throw e;
  });
  return appModule;
}

let appShown = false;
function showApp(m: AppModule, props: AppRootProps = {}): void {
  appShown = true;
  show(<m.AppRoot {...props} />);
}

/** Signed in from the boot's own screen (sign-in or enrolment): the app, at the page the screen showed over. */
function signedIn(): void {
  rememberSignedIn();
  setSessionKnown({ authenticated: true });
  show(splash);
  // A device that was signed in, whose session had ended, and whose cached app code was gone: the boot's early import
  // failed; the session now in, a reload imports the app afresh (the page stays where the sign-in showed).
  if (importFailed) return location.reload();
  loadApp().then(
    (m) => showApp(m, { signedInNow: true }),
    () => void (reloadForNewBuild() || showStaleError()),
  );
}

function showLogin(methods?: SessionReply['login']): void {
  show(
    <Lazy fallback={splash} failed={<BootError />}>
      <Login onDone={signedIn} methods={methods} beforeProvider={keepReturnForProvider} />
    </Lazy>,
  );
}

function showEnroll(methods?: SessionReply['login']): void {
  show(
    <Lazy fallback={splash} failed={<BootError />}>
      <Enroll
        onDone={() => {
          // Enrolment ends at home.
          history.replaceState(null, '', '/');
          signedIn();
        }}
        methods={methods}
      />
    </Lazy>,
  );
}

// Session checks after a failure (offline, server unreachable): when the network comes back, else after a while.
const RETRY_MS = [3_000, 10_000, 30_000, 60_000];
// sessionStorage: reloads in a row while the app's code could not be fetched (the delay grows across them).
const RELOAD_KEY = 'klatchly.boot.reloads';
function nextReloadDelay(): number {
  let n = RETRY_MS.length - 1;
  try {
    n = Math.min(Number(sessionStorage.getItem(RELOAD_KEY)) || 0, RETRY_MS.length - 1);
    sessionStorage.setItem(RELOAD_KEY, String(n + 1));
  } catch {
    /* no storage: the longest delay */
  }
  return RETRY_MS[n]!;
}
function resetReloads(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* no storage */
  }
}

function launch(): void {
  // /enroll: the enrolment screen whatever the session (as before the split); the check only says what it offers.
  if (/^\/enroll\/?$/.test(location.pathname)) {
    showEnroll();
    startSessionCheck().then(
      (s) => showEnroll(s.login),
      () => {},
    );
    return;
  }

  const hinted = probablySignedIn();
  // Offline, a device may be signed in without the hint (its first launch since the update that brought it: the
  // worker warmed the private cache while installing): the cache says so then.
  let maybeSignedIn = hinted;
  let session: 'unknown' | 'in' | 'out' | 'error' = 'unknown';
  let importing = false;
  let appFailed = false;
  let recovering = false;

  // The private entry, once: the app takes the screen as soon as it is in, whatever the session (it shows the stored
  // copy, or signs out and wipes).
  const startApp = () => {
    if (importing) return;
    importing = true;
    loadApp().then(
      (m) => showApp(m),
      () => {
        appFailed = true;
        decide();
      },
    );
  };

  // What the boot shows while the app is not on screen.
  function decide(login?: SessionReply['login']): void {
    if (appShown) return;
    if (session === 'out') {
      // The app, loading from the cache, signs out by itself; otherwise the boot's screen, without any app code.
      if (importing && !appFailed) return;
      void wipeDevice();
      showLogin(login);
    } else if (session === 'in') {
      if (!importing) startApp();
      // Signed in and online, yet the app's code would not load: most often a page of the previous version (served by
      // the worker that was still in charge) asking for private chunks the new version no longer has, its cache wiped
      // when the new worker took over. One reload lands on the new version (lazy.tsx: once per 30 s, no loop).
      else if (appFailed && !reloadForNewBuild()) showStaleError();
    } else if (session === 'error' && maybeSignedIn) {
      // Offline (or the server unreachable) on a device that was signed in: the app from the cache, with the stored
      // copy. Its code not there (offline right after an update, before the new version's private chunks could be
      // fetched; or online with the server down, a restart): say which, and reload (a failed import stays failed for
      // the page's life) once the network is back or after a while, as the session check does.
      if (!importing) startApp();
      else if (appFailed && !recovering) {
        recovering = true;
        show(<BootError pending={!navigator.onLine} />);
        const timer = window.setTimeout(() => location.reload(), nextReloadDelay());
        window.addEventListener(
          'online',
          () => {
            window.clearTimeout(timer);
            location.reload();
          },
          { once: true },
        );
      }
    }
  }

  // Instant open: a device that was signed in and holds this version's whole cache of private chunks (its completion
  // marker: devicestore.ts hasPrivateCache) loads them now, alongside the session check. Without it (just updated,
  // evicted, a warm-up cut off, no worker) it waits for the check. A chunk can still go to the network (evicted after
  // the marker, a lazy screen): signed out, the server answers 302 and the failed import is handled (BootError, Retry).
  if (hinted) void hasPrivateCache().then((cached) => cached && session !== 'out' && startApp());

  let attempt = 0;
  const check = () => {
    startSessionCheck().then(
      (s) => {
        session = s.authenticated ? 'in' : 'out';
        resetReloads();
        if (s.authenticated) rememberSignedIn();
        decide(s.login);
      },
      () => {
        session = 'error';
        if (maybeSignedIn) return decide();
        void hasPrivateCache().then((cached) => {
          if (cached) {
            maybeSignedIn = true;
            return decide();
          }
          // Not known to be signed in and no answer: the splash stays; ask again when the network is back.
          const again = () => {
            window.removeEventListener('online', again);
            window.clearTimeout(timer);
            check();
          };
          const timer = window.setTimeout(again, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
          window.addEventListener('online', again);
        });
      },
    );
  };
  check();
}

fitIOSViewport();
watchKeyboard();
launch();
registerWorker();
