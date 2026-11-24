import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { sessions, store, type Env } from '../server/context.js';
import type { Chat, Message, Page } from '../server/connector.js';
import { dropShared, sharedInFlight, sharedRead, upstreamSignal } from '../server/inflight.js';
import { Registry } from '../server/registry.js';
import { fakeSource } from './fakesource.js';

// Reads for the browsers shared while they run (server/inflight.ts, 2026-11-18: a request snowball saturated
// beeper-server): one upstream call for identical concurrent requests, aborted only once all of them have gone;
// the top of the chat list kept a second, forgotten on any change; errors never kept.

const later = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, ko) => ((resolve = ok), (reject = ko)));
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 5));

test('single flight: identical reads share one call, each waiter gets its answer', async () => {
  let calls = 0;
  const gate = later<string>();
  const run = async () => {
    calls++;
    return gate.promise;
  };
  const a = sharedRead('k1', undefined, run);
  const b = sharedRead('k1', undefined, run);
  const other = sharedRead('k2', undefined, async () => 'other');
  await tick();
  assert.equal(calls, 1);
  gate.resolve('v');
  assert.deepEqual(await Promise.all([a, b, other]), ['v', 'v', 'other']);
  // Done: the next one asks again (no ttl).
  assert.equal(await sharedRead('k1', undefined, async () => (calls++, 'w')), 'w');
  assert.equal(calls, 2);
  assert.equal(sharedInFlight(), 0);
});

test('a waiter that leaves does not abort the call for the others; the last one leaving does', async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const gate = later<string>();
  const run = async () => {
    seen.push(upstreamSignal());
    return gate.promise;
  };
  const one = new AbortController();
  const two = new AbortController();
  const a = sharedRead('k3', one.signal, run);
  const b = sharedRead('k3', two.signal, run);
  await tick();
  assert.equal(seen.length, 1);
  const signal = seen[0]!;
  assert.ok(signal, 'the connector call sees the shared signal (upstreamSignal)');
  one.abort();
  await tick();
  assert.equal(signal.aborted, false, 'another waiter is still there');
  two.abort();
  await tick();
  assert.equal(signal.aborted, true, 'everyone has gone: the upstream call stops');
  assert.equal(sharedInFlight(), 0, 'a new request starts afresh');
  gate.reject(new Error('aborted'));
  await assert.rejects(a);
  await assert.rejects(b);
  // Outside a shared read, no signal.
  assert.equal(upstreamSignal(), undefined);
});

test('a request already aborted when it comes does not keep the call alive', async () => {
  const gone = new AbortController();
  gone.abort();
  let signal: AbortSignal | undefined;
  const r = sharedRead('k4', gone.signal, async () => {
    signal = upstreamSignal();
    await tick();
    return 1;
  });
  await r;
  assert.equal(signal?.aborted, true);
});

test('micro-cache: a success kept for its ttl, dropped on a change; an error never kept', async () => {
  let calls = 0;
  const ok = async () => ++calls;
  assert.equal(await sharedRead('k5', undefined, ok, 1000), 1);
  assert.equal(await sharedRead('k5', undefined, ok, 1000), 1, 'kept');
  dropShared();
  assert.equal(await sharedRead('k5', undefined, ok, 1000), 2, 'dropped on a change');
  // An answer that started before a change is not kept after it.
  const gate = later<number>();
  const slow = sharedRead('k6', undefined, () => gate.promise, 1000);
  dropShared();
  gate.resolve(7);
  assert.equal(await slow, 7);
  assert.equal(await sharedRead('k6', undefined, async () => 8, 1000), 8);
  let fails = 0;
  const bad = async (): Promise<number> => {
    fails++;
    throw new Error('upstream');
  };
  await assert.rejects(sharedRead('k7', undefined, bad, 1000));
  await assert.rejects(sharedRead('k7', undefined, bad, 1000));
  assert.equal(fails, 2, 'errors are not kept');
});

test('a read that comes after a change never joins a call that started before it', async () => {
  let calls = 0;
  const before = later<string>();
  const run1 = async () => (calls++, before.promise);
  const old = sharedRead('k8', undefined, run1);
  await tick();
  // A write, or a source event: what the call under way answers may be out of date.
  dropShared();
  const fresh = sharedRead('k8', undefined, async () => (calls++, 'after'));
  // A request after that one joins the new call, not the old one.
  const joined = sharedRead('k8', undefined, async () => (calls++, 'third'));
  assert.equal(await fresh, 'after');
  assert.equal(await joined, 'after');
  assert.equal(calls, 2);
  before.resolve('before');
  assert.equal(await old, 'before', 'the old call still answers those waiting on it');
  await tick();
  assert.equal(sharedInFlight(), 0);
});

// ── Through the relay ──

const sid = store.mutate((s) => sessions.create(s));
const get = (app: Hono<Env>, path: string, signal?: AbortSignal) => app.request(path, { headers: { cookie: `sid=${sid}` }, ...(signal ? { signal } : {}) });
const post = (app: Hono<Env>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { cookie: `sid=${sid}`, origin: config().origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const page = <T>(items: T[]): Page<T> => ({ items, hasMore: false, oldestCursor: null, newestCursor: null });

test('relay: identical concurrent reads ask the connector once; the list top is kept a moment, until a change', async () => {
  const gate = later<void>();
  const signals: (AbortSignal | undefined)[] = [];
  let lists = 0;
  const src = fakeSource({
    async messages(chatID) {
      signals.push(upstreamSignal());
      await gate.promise;
      return page<Message>([{ id: 'm1', chatID }]);
    },
    async listChats(q) {
      lists++;
      return page<Chat>([{ id: 'c1', title: `call ${lists}`, ...(q.cursor ? { cursor: q.cursor } : {}) }]);
    },
  });
  src.chats.set('c1', { id: 'c1' });
  const app = createApp(new Registry([src.pkg]));
  const a = get(app, '/api/chats/c1/messages');
  const b = get(app, '/api/chats/c1/messages');
  await tick();
  assert.equal(signals.length, 1, 'one connector call for both');
  assert.ok(signals[0], 'the connector sees the request signal');
  gate.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200);
  assert.deepEqual(await ra.json(), await rb.json());

  dropShared();
  const first = (await (await get(app, '/api/chats')).json()) as Page<Chat>;
  const again = (await (await get(app, '/api/chats')).json()) as Page<Chat>;
  assert.equal(lists, 1, 'the top of the list kept a moment');
  assert.deepEqual(first, again);
  // Another request (another query) is another key; a later page is never kept.
  await get(app, '/api/chats?limit=10');
  assert.equal(lists, 2);
  await get(app, '/api/chats?cursor=x');
  await get(app, '/api/chats?cursor=x');
  assert.equal(lists, 4);
  // A change (any write through the API) forgets it.
  assert.equal((await post(app, '/api/chats/c1/read', {})).status, 200);
  const fresh = (await (await get(app, '/api/chats')).json()) as Page<Chat>;
  assert.equal(lists, 5);
  assert.notDeepEqual(fresh, first);
});

test('relay: a browser that goes away stops its read upstream', async () => {
  const gate = later<void>();
  let signal: AbortSignal | undefined;
  const src = fakeSource({
    async message(chatID, messageID) {
      signal = upstreamSignal();
      await Promise.race([gate.promise, new Promise((_, ko) => signal?.addEventListener('abort', () => ko(new Error('aborted'))))]);
      return { id: messageID, chatID };
    },
  });
  src.chats.set('c1', { id: 'c1' });
  const app = createApp(new Registry([src.pkg]));
  const browser = new AbortController();
  const r = get(app, '/api/chats/c1/messages/m9', browser.signal);
  await tick();
  assert.ok(signal && !signal.aborted);
  browser.abort();
  await tick();
  assert.equal(signal!.aborted, true);
  const res = await Promise.resolve(r).catch(() => undefined);
  // Never a 401/403, whatever is answered to a request nobody reads.
  if (res) assert.ok(res.status !== 401 && res.status !== 403);
  gate.resolve();
});
