import { Component, createElement, lazy, Suspense, useState, type ComponentProps, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { useBootT } from './i18n';

// Screens not needed at launch live in their own chunks (all precached by the service worker). After a deploy
// an open page may ask for a chunk of its own, older build that is gone: reload once onto the new build.

const KEY = 'chunk-reload';

/** Reloads the page unless it already did so for a missing chunk in the last 30 s (no loop on a real fault). */
export function reloadForNewBuild(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 30_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  location.reload();
  return true;
}

type AnyComponent = ComponentType<any>;
type Comp<T> = T extends AnyComponent ? T : never;
/**
 * A lazy component: a function component (so one that takes fewer props fits a slot that passes more: a slot's
 * props grow by adding) with a way to fetch its chunk ahead.
 */
export type Chunk<C extends AnyComponent> = ((props: ComponentProps<C>) => ReactNode) & {
  preload: () => void;
  /** Its chunk is in: it renders at once, without suspending. */
  ready: () => boolean;
  /** Settles once its chunk is in, or failed to load (then mounting it shows the boundary's `failed`). */
  whenReady: () => Promise<void>;
};

// The browser keeps a failed module import for the life of the page: a retry asks for the same file under a
// new URL (taken from the error, as Chromium and Firefox give it), one import per file so the screens of a
// chunk share one module instance. Without a URL (WebKit), or if that fails too, Retry reloads the page.
const retried = new Map<string, Promise<unknown>>();
const stale = new Set<() => void>();
let reloadOnRetry = false;
const urlOf = (e: unknown) => /https?:\/\/[^\s'"]+\/assets\/[^\s'"?]+\.js/.exec(e instanceof Error ? e.message : String(e))?.[0];
function importAgain(url: string): Promise<unknown> {
  let p = retried.get(url);
  if (!p) {
    p = import(/* @vite-ignore */ `${url}?retry=${Date.now()}`).catch((e: unknown) => {
      retried.delete(url);
      throw e;
    });
    retried.set(url, p);
  }
  return p;
}

/**
 * One named export of a chunk as a component, plus preload() to fetch it ahead (never reloads the page). Once
 * loaded it renders without suspending; after a failed load the next mount (Retry, or reopening an overlay)
 * tries again, where React.lazy would keep the failure forever.
 */
export function lazyChunk<M, K extends keyof M>(load: () => Promise<M>, name: K): Chunk<Comp<M[K]>> {
  type C = Comp<M[K]>;
  let loaded: C | undefined;
  let pending: Promise<C> | undefined;
  let failedURL: string | undefined;
  let failures = 0;
  const get = () =>
    (pending ??= (failedURL ? (importAgain(failedURL) as Promise<M>) : load()).then(
      (m) => (loaded = m[name] as C),
      (e: unknown) => {
        pending = undefined;
        failedURL = urlOf(e) ?? failedURL;
        if (++failures > 1 || !failedURL) reloadOnRetry = true;
        throw e;
      },
    ));
  const make = () =>
    lazy(() =>
      get().then(
        (c) => ({ default: c }),
        (e: unknown) => {
          // A fresh lazy for the next mount, once the error has reached a boundary (renewing it now would let
          // React retry the same render with a new pending lazy, and loop).
          stale.add(() => (current = make()));
          return reloadForNewBuild() ? new Promise<never>(() => {}) : Promise.reject(e);
        },
      ),
    );
  let current = make();
  function Chunk(props: ComponentProps<C>) {
    // Fixed per mount: switching from the lazy wrapper to the loaded component would remount the subtree.
    const [Comp] = useState<AnyComponent>(() => loaded ?? current);
    return createElement(Comp, props);
  }
  return Object.assign(Chunk, {
    preload: () => void get().catch(() => {}),
    ready: () => loaded !== undefined,
    whenReady: () => get().then(
      () => {},
      () => {},
    ),
  });
}

// Retry on one failed screen retries them all (a space's two panes and its controller share one chunk).
const boundaries = new Set<() => void>();
export function retryChunks(): void {
  if (reloadOnRetry) location.reload();
  else boundaries.forEach((reset) => reset());
}

class Boundary extends Component<{ children: ReactNode; failed: ReactNode; onError?: () => void }, { failed: boolean }> {
  override state = { failed: false };
  private readonly reset = () => this.setState({ failed: false });
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidMount() {
    boundaries.add(this.reset);
  }
  override componentWillUnmount() {
    boundaries.delete(this.reset);
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('screen failed to load', error, info.componentStack);
    stale.forEach((renew) => renew());
    stale.clear();
    this.props.onError?.();
  }
  override render() {
    return this.state.failed ? this.props.failed : this.props.children;
  }
}

/** What a failed screen shows: a line and Retry. */
export function LoadError() {
  const t = useBootT();
  return (
    <div className="list-status" role="alert" data-testid="load-error">
      <p>{t.loadFailed}</p>
      <button type="button" className="text-btn" data-testid="load-retry" onClick={retryChunks}>
        {t.retry}
      </button>
    </div>
  );
}

/**
 * Where a lazy screen renders: by default nothing while its chunk loads (a few ms from the precache: a
 * placeholder would only flash). If it cannot load: `failed` (LoadError by default; overlays pass null and
 * close themselves in onError, so opening them again retries).
 */
export function Lazy({ children, fallback = null, failed = <LoadError />, onError }: { children: ReactNode; fallback?: ReactNode; failed?: ReactNode; onError?: () => void }) {
  return (
    <Boundary failed={failed} onError={onError}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </Boundary>
  );
}
