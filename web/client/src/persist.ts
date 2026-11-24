import { dehydrate, hydrate, type DehydratedState, type Query, type QueryClient } from '@tanstack/react-query';
import { PERSIST_DB } from './devicestore';
import { cutQueries, keptKey } from './persistcut';

/**
 * Copy of the chat list and recent conversations in IndexedDB, so a reload or a cold start shows them at
 * once while the server copy loads. The restored entries are marked old: everything shown is refetched
 * on mount, the websocket keeps it current afterwards. Single messages looked up on their own (reply quotes,
 * reaction previews: 'message', 'reaction-target') are kept too, as they are while young (persistcut.ts
 * LOOKUP_STALE_MS): a launch no longer asks for each of them again (about 40 requests a load, 2026-11-18). Wiped on
 * sign-out.
 */
const DB = PERSIST_DB;
const STORE = 'kv';
const KEY = 'queries';
// A new build may change the data shapes: start from the server again.
const BUSTER = `${__APP_VERSION__}/1`;
const MAX_AGE = 7 * 24 * 3600_000;
interface Snapshot {
  buster: string;
  savedAt: number;
  state: DehydratedState;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const persisted = (q: Query) => q.state.status === 'success' && keptKey(q.queryKey[0]);

/** Only what makes the first screen (persistcut.ts): the top of the list, the latest pages of recent conversations, single messages looked up. */
function snapshot(qc: QueryClient): DehydratedState {
  const state = dehydrate(qc, { shouldDehydrateQuery: persisted });
  return { mutations: [], queries: cutQueries(state.queries) };
}

let enabled = true;
let timer: number | undefined;

async function save(qc: QueryClient): Promise<void> {
  timer = undefined;
  if (!enabled) return;
  const snap: Snapshot = { buster: BUSTER, savedAt: Date.now(), state: snapshot(qc) };
  await run('readwrite', (s) => s.put(snap, KEY)).catch(() => {});
}

/** Fill the query cache from the stored copy (at startup, alongside the first render). True when something was restored. */
export async function restore(qc: QueryClient): Promise<boolean> {
  try {
    const snap = await run<Snapshot | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<Snapshot | undefined>);
    if (!snap || snap.buster !== BUSTER || Date.now() - snap.savedAt > MAX_AGE || !snap.state?.queries?.length) return false;
    // Signed out while the copy was being read (the first render no longer waits for it): it is stale.
    if (!enabled) return false;
    hydrate(qc, snap.state);
    return true;
  } catch {
    return false;
  }
}

/** Keep the stored copy in step with the cache (at most every few seconds, and when the page goes away). */
export function persist(qc: QueryClient): void {
  qc.getQueryCache().subscribe((e) => {
    if (!enabled || timer !== undefined || e.type !== 'updated' || e.action.type !== 'success') return;
    if (!persisted(e.query)) return;
    timer = window.setTimeout(() => void save(qc), 3000);
  });
  const flush = () => {
    if (document.visibilityState !== 'hidden' || timer === undefined) return;
    window.clearTimeout(timer);
    void save(qc);
  };
  document.addEventListener('visibilitychange', flush);
}

/** Signed out: forget the stored copy (and stop writing until signed in again). */
export async function clearPersisted(): Promise<void> {
  enabled = false;
  window.clearTimeout(timer);
  timer = undefined;
  await run('readwrite', (s) => s.delete(KEY)).catch(() => {});
}

export function resumePersist(): void {
  enabled = true;
}
