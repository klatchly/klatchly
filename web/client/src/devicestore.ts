// What this device keeps of a signed-in session, named in one place. Shared by the public boot entry (boot.tsx) and
// the app: the boot wipes it without loading the app's code.
import { PRIVATE_CACHE_PREFIX, PRIVATE_COMPLETE_KEY, privateCacheName, THUMB_CACHE } from './cachenames';

export { PRIVATE_CACHE_PREFIX, THUMB_CACHE } from './cachenames';
/** The IndexedDB database of the stored chat copy (persist.ts). */
export const PERSIST_DB = 'klatchly-cache';
/** localStorage: unsent drafts (drafts.ts), learned member names (names.ts). */
export const DRAFTS_KEY = 'drafts';
export const NAMES_KEY = 'klatchly.names.v1';
/**
 * localStorage: this device was signed in when last used. Only a hint, never a credential: it lets the boot entry
 * load the app's code (from the worker's cache) alongside the session check, so a signed-in launch shows the stored
 * copy at once; the server still decides (a session found gone signs out and wipes).
 */
const HINT_KEY = 'klatchly.signedin';

export function probablySignedIn(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}
export function rememberSignedIn(): void {
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* private mode: no hint, the launch waits for the session check */
  }
}
export function forgetSignedIn(): void {
  try {
    localStorage.removeItem(HINT_KEY);
  } catch {
    /* nothing stored */
  }
}

/**
 * Whether the worker holds this version's whole cache of private chunks (filled once signed in: client/sw-app.js).
 * Its completion marker, not the cache's mere existence: the warm-up opens the cache before fetching, the runtime
 * route creates it on the first chunk, and a warm-up can be cut off.
 */
export async function hasPrivateCache(): Promise<boolean> {
  try {
    return 'caches' in window && !!(await caches.match(PRIVATE_COMPLETE_KEY, { cacheName: privateCacheName(__APP_VERSION__) }));
  } catch {
    return false;
  }
}

/** Deletes the worker's caches of private data and code: thumbnails, private chunks (every version). */
export async function dropPrivateCaches(): Promise<void> {
  if (!('caches' in window)) return;
  const keys = await caches.keys().catch(() => [] as string[]);
  await Promise.all(keys.filter((k) => k === THUMB_CACHE || k.startsWith(PRIVATE_CACHE_PREFIX)).map((k) => caches.delete(k).catch(() => false)));
}

/**
 * Signed out, seen by the boot entry without the app's code (boot.tsx): the hint, the stored copy, drafts, learned
 * names and the private caches. The app's own sign-out (App.tsx) does the same with its modules.
 */
export async function wipeDevice(): Promise<void> {
  forgetSignedIn();
  try {
    localStorage.removeItem(DRAFTS_KEY);
    localStorage.removeItem(NAMES_KEY);
  } catch {
    /* no storage */
  }
  try {
    indexedDB.deleteDatabase(PERSIST_DB);
  } catch {
    /* no IndexedDB */
  }
  await dropPrivateCaches();
}
