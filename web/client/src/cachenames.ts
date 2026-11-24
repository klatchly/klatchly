// The service worker's runtime caches, named once for the page (devicestore.ts, thumbs.ts) and the build
// (vite.config.ts, client/sw-app.js). No imports, no browser: the tests and the build compile it alone.

/** Thumbnails (server/thumbs.ts): emptied at sign-out. */
export const THUMB_CACHE = 'thumbs';
/**
 * The app's private chunks: one cache per version, the older ones deleted when a new worker activates
 * (client/sw-app.js); emptied at sign-out.
 */
export const PRIVATE_CACHE_PREFIX = 'app-private-';
export const privateCacheName = (version: string): string => `${PRIVATE_CACHE_PREFIX}${version}`;
/**
 * The key client/sw-app.js writes into a version's private cache once every file of its list is in it (outside
 * /assets/: never a chunk's URL). Its absence means the cache may be partial: the boot then waits for the session check.
 */
export const PRIVATE_COMPLETE_KEY = '/__klatchly-private-complete';
