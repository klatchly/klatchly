// The service worker, from the public boot entry (boot.tsx): registered signed out too (the sign-in page installs it,
// with its push handlers), and the update flow. No app code: shared with the app (App.tsx asks for the warm-up).

/**
 * Registers /sw.js once the page has loaded (or at once if it already has: the boot may run after the load event,
 * a past iOS bug left the worker unregistered), then watches for new versions.
 */
export function registerWorker(): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  const register = () =>
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(watchUpdates)
      .catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}

/**
 * New versions: the worker activates on its own (autoUpdate) but the open page keeps the old code. Check for an
 * update each time the app comes back to the foreground, and reload once a new worker has taken over, at the
 * next moment the app is out of sight, so a single relaunch is enough on iOS.
 */
export function watchUpdates(reg: ServiceWorkerRegistration): void {
  let pending = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First install (no previous worker): nothing to reload.
    if (!hadController) return;
    if (document.visibilityState === 'hidden') location.reload();
    else pending = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (pending) location.reload();
    } else {
      void reg.update().catch(() => {});
    }
  });
}

/**
 * Signed in: asks the worker to fetch this version's private chunks into its cache (client/sw-app.js, from GET
 * /api/assets), so the next launch opens offline with every screen. Called on every signed-in launch (App.tsx), which
 * covers a sign-in, a manual refresh and a first install; the worker also does it when a new version installs while
 * signed in. One GET /api/assets, then missing files only: cheap when they are all there. Nothing without a worker (development, unsupported).
 */
export function warmPrivate(): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  void navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: 'klatchly-warm' }))
    .catch(() => {});
}
