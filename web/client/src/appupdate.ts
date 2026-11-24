import { clearPersisted } from './persist';

/**
 * Manual "refresh the app": drops the stored chat copy and the service worker's runtime caches (the private chunks,
 * thumbnails, pdf.js data), asks the worker to look for a new version, then reloads. Online, the reload fetches the
 * app's private code again (and warms its cache: swreg.ts warmPrivate). The public shell's precache (index.html, the
 * boot entry: workbox, '<cacheId>-precache-…') is kept: workbox does not refill a missing entry while sw.js is
 * unchanged, so wiping it would leave the app unable to open offline until the next version. Offline afterwards, the
 * boot opens and says to connect once (boot.tsx). The worker itself stays registered: unregistering it would also
 * drop the push subscription.
 */
export async function refreshApp(): Promise<void> {
  await clearPersisted();
  if ('caches' in window) {
    const keys = await caches.keys().catch(() => [] as string[]);
    await Promise.all(keys.filter((k) => !k.includes('-precache-')).map((k) => caches.delete(k).catch(() => false)));
  }
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  await reg?.update().catch(() => {});
  location.reload();
}
