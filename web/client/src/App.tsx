import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { api, setSignedOutHandler } from './endpoints';
import { Shell } from './Shell';
import { clearPersisted, resumePersist } from './persist';
import { dropPrivateCaches, forgetSignedIn, rememberSignedIn } from './devicestore';
import { sessionOnce } from './api';
import { warmPrivate } from './swreg';
import { drafts } from './drafts';
import { forgetNames } from './names';
import { Lazy, LoadError, lazyChunk } from './lazy';
import { afterSignIn, saveReturn, takeReturn, type ReturnStorage } from './signinreturn';
import { spaceAt } from './registry';
import { isSettingsPath } from '../../server/settingspages';

// Sign-in (with @simplewebauthn), when signed out from inside the app (or a session found gone): the boot's chunk
// (Auth.tsx, public). Enrolment (/enroll) is the boot entry's alone (boot.tsx).
const Login = lazyChunk(() => import('./Auth'), 'Login');

// Same as the static splash of index.html, which shows until this first render.
const splash = (
  <div className="splash">
    <div className="gate-mark" aria-hidden="true" />
  </div>
);
const failed = (
  <div className="splash">
    <LoadError />
  </div>
);

/** The pages a sign-in may come back to besides a chat (signinreturn.ts): Settings, a space of this build. */
const isReturnPage = (path: string): boolean => isSettingsPath(path) || !!spaceAt(path);
/** This tab's sessionStorage, or none (blocked, private mode): the return across an OIDC sign-in is then lost. */
function tabStorage(): ReturnStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
/** Before leaving for the OIDC provider (which always comes back to /): keeps the page to return to, in this tab only. */
const keepReturnForProvider = () => saveReturn(tabStorage(), afterSignIn(window.location.pathname, window.location.search, isReturnPage));

/**
 * restored: a stored copy of the chats was loaded (persist.ts): show it while the session check runs. signedInNow:
 * the boot's sign-in screen has just signed in (boot.tsx): go to the page it showed over. The first session query
 * takes the boot's own check (api.ts sessionOnce): a launch asks once.
 */
export function App({ restored = false, signedInNow = false }: { restored?: boolean; signedInNow?: boolean }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const session = useQuery({ queryKey: ['session'], queryFn: sessionOnce, staleTime: Infinity, retry: 2 });

  const signedOut = useCallback(() => {
    // Nothing read in the app stays on the device: stored copy, unsent drafts, learned member names.
    void clearPersisted();
    // Pictures and code too: the worker's thumbnail cache (authenticated media, served from it without the server)
    // and its cache of the app's private chunks (the next launch waits for the session check: devicestore.ts).
    forgetSignedIn();
    void dropPrivateCaches();
    drafts.clear();
    forgetNames();
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
    // The sign-in page's methods (passkeys, an OIDC provider): asked again when signed out from inside the app.
    const cur = qc.getQueryData<Awaited<ReturnType<typeof api.session>>>(['session']);
    qc.setQueryData(['session'], { authenticated: false, login: cur?.login });
    if (!cur?.login) void qc.refetchQueries({ queryKey: ['session'] });
    document.title = '•';
  }, [qc]);

  const signedIn = useCallback(() => {
    resumePersist();
    qc.setQueryData(['session'], { authenticated: true });
    // Back to the page the sign-in showed over, with its query (a link shared into /share…); enrolment ends at home.
    navigate(afterSignIn(window.location.pathname, window.location.search, isReturnPage), { replace: true });
  }, [qc, navigate]);

  useEffect(() => setSignedOutHandler(signedOut), [signedOut]);
  const authenticated = session.data?.authenticated;
  useEffect(() => {
    if (authenticated === false) signedOut();
    // Signed in: the next launch may load this code from the worker's cache at once, which the worker fills now.
    if (authenticated === true) {
      rememberSignedIn();
      warmPrivate();
    }
  }, [authenticated, signedOut]);
  // Signed in on the boot's screen: back to the page it showed over, as signedIn does for the app's own screen.
  const arrived = useRef(signedInNow);
  useEffect(() => {
    if (!arrived.current) return;
    arrived.current = false;
    navigate(afterSignIn(window.location.pathname, window.location.search, isReturnPage), { replace: true });
  }, [navigate]);
  // Signed in at home (an OIDC sign-in lands on /): the page kept before leaving for the provider, read once, deleted,
  // checked again, dropped when old. Read at the first signed-in render only.
  const returned = useRef(false);
  useEffect(() => {
    if (authenticated !== true || returned.current) return;
    returned.current = true;
    const to = takeReturn(tabStorage(), isReturnPage);
    if (to && window.location.pathname === '/') navigate(to, { replace: true });
  }, [authenticated, navigate]);

  // Offline or slow: the restored copy shows; a session found gone signs out (and wipes it).
  if (!session.data && !restored) return splash;
  if (authenticated === false)
    return (
      <Lazy fallback={splash} failed={failed}>
        <Login onDone={signedIn} methods={session.data?.login} beforeProvider={keepReturnForProvider} />
      </Lazy>
    );
  return <Shell onSignedOut={signedOut} />;
}
