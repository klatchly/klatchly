// The app was called beep before 0.26.0: what a device kept under that name moves to the new one, once, before the
// boot reads anything (imported first by boot.tsx). localStorage and sessionStorage keys "beep.<x>" become
// "klatchly.<x>" (a value already under the new name wins); the stored chat copy ("beep-cache", IndexedDB) is
// deleted, not copied: it is only a cache, refilled from the server at the next sign-in or launch.
const OLD = 'beep.';
const NEW = 'klatchly.';
export const LEGACY_PERSIST_DB = 'beep-cache';

export function moveKeys(storage: Storage): void {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(OLD)) old.push(k);
  }
  for (const k of old) {
    const v = storage.getItem(k);
    const name = NEW + k.slice(OLD.length);
    if (v !== null && storage.getItem(name) === null) storage.setItem(name, v);
    storage.removeItem(k);
  }
}

for (const get of [() => window.localStorage, () => window.sessionStorage]) {
  try {
    moveKeys(get());
  } catch {
    /* storage blocked (private mode, quota): nothing kept under either name */
  }
}
try {
  indexedDB.deleteDatabase(LEGACY_PERSIST_DB);
} catch {
  /* no IndexedDB: nothing stored */
}
