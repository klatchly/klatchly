import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { readAllRoutes } from '#core/readall.js';
import { eachLimited, readAllLowPriority, unreadLowPriority } from '../server/inbox.js';
import { badgeCount, noteChat } from '#core/badgecount.js';
import { mockUpstream } from '../../../test/mock.js';
import './setup.js';

// Low-priority inbox in three pages; some chats unread, one fails to mark.
const page = (ids: [string, number][], cursor: string | null) => ({
  items: ids.map(([id, n]) => ({ id, unreadCount: n, isLowPriority: true, accountID: 'whatsapp' })),
  hasMore: !!cursor,
  oldestCursor: cursor,
});
const pages: Record<string, unknown> = {
  first: page([['a', 2], ['b', 0], ['c', 1]], 'p2'),
  p2: page([['d', 0], ['e', 5]], 'p3'),
  p3: page([['f', 3], ['broken', 1]], null),
};
const routes: Parameters<typeof mockUpstream>[0] = {
  'GET /v1/chats/search': (req) => [200, pages[new URL(req.url!, 'http://x').searchParams.get('cursor') ?? 'first']],
};
for (const id of ['a', 'c', 'e', 'f']) routes[`POST /v1/chats/${id}/read`] = () => [200, { success: true }];
routes['POST /v1/chats/broken/read'] = () => [500, { message: 'x' }];
const up = mockUpstream(routes);
const app = new Hono().route('/api', readAllRoutes);
const readAll = () => app.request('/api/inbox/low-priority/read-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

before(() => up.start());
after(() => up.stop());

test('unread low-priority chats of a page', () => {
  assert.deepEqual(
    unreadLowPriority([
      { id: 'a', unreadCount: 1 },
      { id: 'b', unreadCount: 0 },
      { id: 'n', unreadCount: 2, isLowPriority: false },
      { unreadCount: 2 },
    ]),
    ['a'],
  );
});

test('bounded concurrency', async () => {
  let now = 0;
  let peak = 0;
  await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async () => {
    peak = Math.max(peak, ++now);
    await new Promise((r) => setTimeout(r, 5));
    now--;
  });
  assert.equal(peak, 3);
});

test('every page of the inbox, every unread chat marked, badge counts cleared', async () => {
  noteChat({ id: 'e', unreadCount: 5, isLowPriority: false, isMuted: false, isArchived: false });
  const before = badgeCount();
  const r = await readAll();
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { total: 5, marked: 4, failed: 1, complete: true });
  const searches = up.calls.filter((c) => c.url.startsWith('/v1/chats/search')).map((c) => new URL(c.url, 'http://x').searchParams);
  assert.equal(searches.length, 3);
  assert.ok(searches.every((q) => q.get('inbox') === 'low-priority' && q.get('limit') === '50'));
  assert.equal(searches[1]!.get('cursor'), 'p2');
  const marked = up.calls.filter((c) => c.method === 'POST').map((c) => c.url).sort();
  assert.deepEqual(marked, ['/v1/chats/a/read', '/v1/chats/broken/read', '/v1/chats/c/read', '/v1/chats/e/read', '/v1/chats/f/read']);
  assert.equal(badgeCount(), before - 5);
});

test('each chat is reported as soon as it is marked (the badge does not wait for the last one)', async () => {
  const seen: string[] = [];
  const r = await readAllLowPriority((id) => {
    // Its own read call is already made, the later ones not all.
    seen.push(`${id}@${up.calls.filter((c) => c.method === 'POST').length}`);
  });
  assert.deepEqual(seen.map((x) => x.split('@')[0]).sort(), [...r.read].sort());
  assert.equal(new Set(seen.map((x) => x.split('@')[1])).size > 1, true);
});

test('rate limited', async () => {
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) limited = (await readAll()).status === 429;
  assert.ok(limited);
});
