// The service worker's cache of the app's private chunks (docs/auth-security.md, "Code served signed out"), imported
// by the generated /sw.js (vite.config.ts importScripts) after the push handlers. The build writes it to /sw-app.js
// with this version's values in place of the two placeholders below (vite.config.ts swApp). The private chunks
// themselves are served from that cache by the worker's own route (vite.config.ts runtimeCaching, CacheFirst); this
// script fills it ahead and keeps one version:
// - warm(): GET /api/assets (the build's private files, for a session only), then each file missing from the cache,
//   fetched with the cookies; a redirect (signed out meanwhile) or anything but a script or a stylesheet is never kept.
//   On install (a new version, while signed in: the next launch opens offline even right after the update; never
//   failing nor holding the install more than WARM_INSTALL_MS) and when the page asks (swreg.ts warmPrivate: on every
//   signed-in launch, App.tsx; one GET /api/assets, then only the files missing from the cache), which covers a
//   sign-in, a manual refresh and a first install. Once every listed file is in the cache, it writes the completion
//   marker DONE: the boot takes the cache for this version's app only then (devicestore.ts hasPrivateCache), never a
//   cache cut off half way (install timer, worker killed, signed out meanwhile) nor one the runtime route started;
// - on activate, the older versions' caches are deleted.
// Tested in a fake worker scope: test/swapp.test.ts.
(() => {
  const VERSION = '__KLATCHLY_VERSION__';
  const CACHE = '__KLATCHLY_PRIVATE_CACHE__';
  const DONE = '__KLATCHLY_PRIVATE_DONE__';
  const PREFIX = CACHE.slice(0, CACHE.length - VERSION.length);
  const WARM_INSTALL_MS = 30000;
  const PARALLEL = 4;
  const FILE = /^\/assets\/[\w.-]+$/;

  const cacheable = (r) =>
    !!r && r.status === 200 && r.type !== 'opaqueredirect' && !r.redirected && /javascript|css/.test(r.headers.get('content-type') || '');

  let running = null;
  /** Fetches this version's private files missing from its cache; resolves with how many were added. */
  function warm() {
    running ??= (async () => {
      const res = await fetch('/api/assets', { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
      if (res.status !== 200 || !/json/.test(res.headers.get('content-type') || '')) return 0;
      const body = await res.json();
      // Another build answers (a deploy in between): its files are not this worker's.
      if (!body || body.version !== VERSION || !Array.isArray(body.files)) return 0;
      const files = body.files.filter((f) => typeof f === 'string' && FILE.test(f));
      const cache = await caches.open(CACHE);
      let added = 0;
      let stop = false;
      let missing = 0;
      const next = async () => {
        while (!stop && files.length) {
          const f = files.shift();
          if (await cache.match(f)) continue;
          const r = await fetch(f, { credentials: 'same-origin', redirect: 'manual' });
          if (cacheable(r)) {
            await cache.put(f, r);
            added++;
          } else {
            missing++;
            if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) stop = true; // signed out
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, next));
      // Complete: every file of the list is in the cache (a put that threw rejected above, before this line).
      if (!stop && !missing && !files.length) await cache.put(DONE, new Response(VERSION));
      return added;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  const quietly = (p) => p.catch(() => 0);
  self.addEventListener('install', (event) => {
    event.waitUntil(Promise.race([quietly(warm()), new Promise((ok) => setTimeout(ok, WARM_INSTALL_MS))]));
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
        .catch(() => {}),
    );
  });
  self.addEventListener('message', (event) => {
    const d = event.data;
    if (d && typeof d === 'object' && d.type === 'klatchly-warm') event.waitUntil(quietly(warm()));
  });
})();
