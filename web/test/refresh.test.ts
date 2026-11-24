import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/query-core';
import type { NewestMessage, NewestPage } from '../client/src/newest.js';
import {
  CONVERSATION_REFRESH_MS,
  LIST_REFRESH_MS,
  LIST_REFRESH_PAGES,
  refreshAfterReconnect,
  refreshConversationSoon,
  refreshListsSoon,
  refreshNewest,
  type ListChat,
  type RefreshApi,
} from '../client/src/refresh.js';

// What the client reads again when something may have changed (client/src/refresh.ts), with a QueryClient of its
// own: 2026-11-18, every reconnect refetched the whole cache and every list refresh every page held.

const at = (n: number) => new Date(Date.UTC(2026, 10, 18, 10, n)).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const later = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => (resolve = ok));
  return { promise, resolve };
};

type Chat = ListChat & { title?: string };
const chats = (from: number, n: number, cursor: string | null): NewestPage<Chat> => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `c${from + i}`, lastActivity: at(1000 - from - i) })),
  hasMore: !!cursor,
  oldestCursor: cursor,
  newestCursor: null,
});
const listData = (pages: number) => ({
  pages: Array.from({ length: pages }, (_, i) => chats(i * 2, 2, `p${i + 1}`)),
  pageParams: Array.from({ length: pages }, (_, i) => (i ? `p${i}` : undefined)),
});
const msgs = (ids: [string, number][], cursor: string | null): NewestPage<NewestMessage> => ({
  items: ids.map(([id, n]) => ({ id, timestamp: at(n) })),
  hasMore: !!cursor,
  oldestCursor: cursor,
  newestCursor: null,
});

function client() {
  // No garbage-collection timers: the test process ends with its tests.
  return new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
}

function fakeApi(over: Partial<RefreshApi> = {}) {
  const calls: string[] = [];
  const api: RefreshApi = {
    async listPage(key, cursor) {
      calls.push(`list ${key.join(',')} ${cursor ?? '-'}`);
      const i = cursor ? Number(cursor.slice(1)) : 0;
      return chats(i * 2, 2, `p${i + 1}`);
    },
    async newestMessages(chatID) {
      calls.push(`newest ${chatID}`);
      return msgs([['m3', 3], ['m2', 2]], 'cur');
    },
    ...over,
  };
  return { api, calls };
}

/** An infinite query on screen (an observer), holding `data`, never fetching by itself; its fetches counted. */
function shownList(qc: QueryClient, key: readonly unknown[], data: unknown, fetched: string[]) {
  qc.setQueryData(key, data);
  const o = new InfiniteQueryObserver(qc, {
    queryKey: key,
    queryFn: async ({ pageParam }) => {
      fetched.push(`${key.join(',')} ${String(pageParam ?? '-')}`);
      const i = typeof pageParam === 'string' ? Number(pageParam.slice(1)) : 0;
      return chats(i * 2, 2, `p${i + 1}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: NewestPage<Chat>) => last.oldestCursor ?? undefined,
    staleTime: Infinity,
  });
  return o.subscribe(() => {});
}

function shown(qc: QueryClient, key: readonly unknown[], data: unknown, fetched: string[]) {
  qc.setQueryData(key, data);
  const o = new QueryObserver(qc, { queryKey: key, queryFn: async () => (fetched.push(key.join(',')), data), staleTime: Infinity });
  return o.subscribe(() => {});
}

test('a reconnect reads again only what may have changed and is on screen, never single messages', async () => {
  const qc = client();
  const { api, calls } = fakeApi();
  const fetched: string[] = [];
  const offs = [
    // Single messages (a reply quote, a reaction preview) on screen: left as they are.
    shown(qc, ['message', 'open', 'q1'], { id: 'q1' }, fetched),
    shown(qc, ['reaction-target', 'c0', 't', 'r'], { id: 't' }, fetched),
    // The chat on screen: refetched.
    shown(qc, ['chat', 'open'], { id: 'open' }, fetched),
    shown(qc, ['messages', 'open'], { pages: [msgs([['m2', 2], ['m1', 1]], null)], pageParams: [undefined] }, fetched),
  ];
  // Not on screen: marked stale, not fetched.
  qc.setQueryData(['chat', 'other'], { id: 'other' });
  qc.setQueryData(['messages', 'other'], { pages: [msgs([['x', 1]], null)], pageParams: [undefined] });
  qc.setQueryData(['accounts'], []);

  refreshAfterReconnect(qc, api, 'open');
  await sleep(20);
  assert.deepEqual(fetched, ['chat,open'], 'the chat on screen only, not the single messages');
  assert.deepEqual(calls, ['newest open'], "the open conversation: its newest page, one request");
  const open = qc.getQueryData<{ pages: NewestPage<NewestMessage>[] }>(['messages', 'open'])!;
  assert.deepEqual(open.pages[0]!.items.map((m) => m.id), ['m3', 'm2', 'm1']);
  assert.equal(qc.getQueryState(['messages', 'other'])?.isInvalidated, true);
  assert.equal(qc.getQueryState(['chat', 'other'])?.isInvalidated, true);
  assert.equal(qc.getQueryState(['accounts'])?.isInvalidated, true);
  assert.equal(qc.getQueryState(['message', 'open', 'q1'])?.isInvalidated, false);
  for (const off of offs) off();
  qc.clear();
});

test('list refreshes: one per window; a long list on screen keeps its pages beyond the top, one off screen is cut', async () => {
  const qc = client();
  const { api, calls } = fakeApi();
  const fetched: string[] = [];
  // On screen, scrolled to page 6 (the network filter's list): the rows read stay.
  const off = shownList(qc, ['chats', 'acc'], listData(6), fetched);
  // On screen, short (the low-priority count): refetched whole.
  const offLow = shownList(qc, ['chats-lowpri'], listData(2), fetched);
  // Off screen, long: cut, marked stale.
  qc.setQueryData(['chats'], listData(8));

  for (let i = 0; i < 5; i++) refreshListsSoon(qc, api);
  await sleep(LIST_REFRESH_MS + 100);
  assert.deepEqual(calls, ['list chats,acc -'], 'a burst: the top page of the long list on screen, once');
  assert.deepEqual(fetched.sort(), ['chats-lowpri -', 'chats-lowpri p1'], 'the short list on screen: refetched whole, once');
  const long = qc.getQueryData<{ pages: NewestPage<Chat>[] }>(['chats', 'acc'])!;
  assert.equal(long.pages.length, 6, 'nothing scrolled to is cut');
  const away = qc.getQueryData<{ pages: unknown[] }>(['chats'])!;
  assert.equal(away.pages.length, LIST_REFRESH_PAGES);
  assert.equal(qc.getQueryState(['chats'])?.isInvalidated, true);

  // A reconnect: the top LIST_REFRESH_PAGES pages of the long list.
  calls.length = 0;
  refreshListsSoon(qc, api, true);
  refreshListsSoon(qc, api);
  await sleep(LIST_REFRESH_MS + 100);
  assert.deepEqual(calls, ['list chats,acc -', 'list chats,acc p1', 'list chats,acc p2']);
  off();
  offLow();
  qc.clear();
});

test('refreshNewest: asked again while one runs, one more after it, shared by everyone asking meanwhile', async () => {
  const qc = client();
  const gate = later<void>();
  let n = 0;
  const { api } = fakeApi({
    async newestMessages() {
      n++;
      if (n === 1) await gate.promise;
      return msgs([['m2', 2]], null);
    },
  });
  qc.setQueryData(['messages', 'c'], { pages: [msgs([['m1', 1]], null)], pageParams: [undefined] });
  const a = refreshNewest(qc, api, 'c');
  const b = refreshNewest(qc, api, 'c');
  const c = refreshNewest(qc, api, 'c');
  assert.equal(b, c, 'one queued run for both');
  gate.resolve();
  await Promise.all([a, b, c]);
  assert.equal(n, 2);
  // Not cached: nothing read.
  await refreshNewest(qc, api, 'none');
  assert.equal(n, 2);
  qc.clear();
});

test('an empty message event: the conversation on screen reads its newest page (not every page), another is marked stale', async () => {
  const qc = client();
  const { api, calls } = fakeApi();
  const fetched: string[] = [];
  const off = shown(qc, ['messages', 'open'], { pages: [msgs([['m2', 2]], 'p1'), msgs([['m1', 1]], 'p2'), msgs([['m0', 0]], null)], pageParams: [undefined, 'p1', 'p2'] }, fetched);
  qc.setQueryData(['messages', 'away'], { pages: [msgs([['x', 1]], null)], pageParams: [undefined] });
  for (let i = 0; i < 4; i++) {
    refreshConversationSoon(qc, api, 'open');
    refreshConversationSoon(qc, api, 'away');
  }
  await sleep(CONVERSATION_REFRESH_MS + 100);
  assert.deepEqual(calls, ['newest open'], 'one request for the burst');
  assert.deepEqual(fetched, [], 'its pages are not refetched one after the other');
  assert.equal(qc.getQueryData<{ pages: unknown[] }>(['messages', 'open'])!.pages.length, 3);
  assert.equal(qc.getQueryState(['messages', 'away'])?.isInvalidated, true);
  off();
  qc.clear();
});
