import { AsyncLocalStorage } from 'node:async_hooks';

// Reads of the chat sources made for the browsers (the relay's GET routes), shared while they run: identical
// requests that arrive while one is under way wait for that one instead of each asking upstream again (a reload or
// a reconnect of several tabs used to send the same list pages, conversations and messages several times over,
// each running until the upstream timeout under load: 2026-11-18, beeper-server saturated).
//
// - Single flight: one call per key at a time (the key is the whole request: method, path and query). A waiter that
//   goes away (its browser aborted the request) leaves the call to the others; the call itself is aborted only
//   once every waiter has gone, through the signal its connector reads with `upstreamSignal()`.
// - Micro-cache (opt-in per route, about a second): a success is kept that long for the same key; never an error.
//   Dropped whenever something may have changed: any write through the API (app.ts), any source event
//   (pushwatch.ts sourceEvent).
//
// Single-user app: every session reads the same account's data, the key carries the whole request.

const scope = new AsyncLocalStorage<AbortSignal>();

/**
 * The signal of the browser read the current connector call runs for (a GET of the chat list, a search, a chat, its
 * messages, one message), when there is one: aborted once every browser request waiting on that read has gone.
 * Connectors pass it to their upstream calls for reads; never to writes. Undefined outside such a read (a
 * notification's lookup, a package's call).
 */
export const upstreamSignal = (): AbortSignal | undefined => scope.getStore();

interface Flight {
  promise: Promise<unknown>;
  controller: AbortController;
  waiters: number;
  done: boolean;
  /** The generation it started in: a request after a change (dropShared) never joins it. */
  gen: number;
}

const flights = new Map<string, Flight>();
const kept = new Map<string, { at: number; value: unknown }>();
// Bumped by dropShared: an answer that started before a change is not kept after it.
let generation = 0;
const KEPT_MAX = 200;

/**
 * Forgets the kept answers (something may have changed). Calls under way go on for those waiting on them, but their
 * answers are not kept, and a request that comes afterwards does not join them: it asks again.
 */
export function dropShared(): void {
  generation++;
  kept.clear();
}

/** How many calls are under way (tests). */
export const sharedInFlight = (): number => flights.size;

/**
 * Runs `run` once for every identical request (`key`) that comes while it runs, and gives each its answer. `signal`:
 * the request's own (the browser leaving); the call is aborted when all of its waiters have left. `ttl` (ms): how
 * long a success is kept for the same key (0: not kept).
 */
export async function sharedRead<T>(key: string, signal: AbortSignal | undefined, run: () => Promise<T>, ttl = 0): Promise<T> {
  if (ttl > 0) {
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  }
  let flight = flights.get(key);
  // A call that started before a change may answer what was true before it: not joined.
  if (flight && flight.gen !== generation) flight = undefined;
  if (!flight) {
    const controller = new AbortController();
    const gen = generation;
    const f: Flight = { controller, waiters: 0, done: false, gen, promise: Promise.resolve() };
    f.promise = scope
      .run(controller.signal, async () => run())
      .then((v) => {
        if (ttl > 0 && gen === generation && !controller.signal.aborted) {
          if (kept.size >= KEPT_MAX) kept.clear();
          kept.set(key, { at: Date.now(), value: v });
        }
        return v;
      })
      .finally(() => {
        f.done = true;
        if (flights.get(key) === f) flights.delete(key);
      });
    flights.set(key, f);
    flight = f;
  }
  const f = flight;
  f.waiters++;
  const leave = () => {
    if (--f.waiters > 0 || f.done) return;
    // Nobody waits any more: the upstream call stops, and a new request starts afresh rather than join it.
    if (flights.get(key) === f) flights.delete(key);
    f.controller.abort();
  };
  if (signal?.aborted) leave();
  else signal?.addEventListener('abort', leave, { once: true });
  try {
    return (await f.promise) as T;
  } finally {
    signal?.removeEventListener('abort', leave);
  }
}
