import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedRead } from '#core/inflight.js';
import { mockUpstream } from '../../../test/mock.js';
import { desktop } from '../server/desktop.js';
import { setPeerResolver, upstreamPeer } from '../server/delivery.js';
import { dropScan, patchScan, SCAN_TTL, unreadChats } from '../server/inbox.js';
import { readLocally, resetLocalRead } from '../server/localread.js';
import './setup.js';

// The shared chat scan (inbox.ts unreadChats: the badge's recount and the accounts page's figures, 2026-11-18): one
// scan at a time, kept a few minutes, kept current by the socket's chat upserts, read again after a change; and the
// Desktop API reads stopping with the browser requests waiting on them (the core's upstreamSignal).

let unread = 2;
const up = mockUpstream({
  'GET /v1/chats': (req) => {
    const cursor = new URL(req.url!, 'http://x').searchParams.get('cursor');
    return cursor
      ? [200, { items: [{ id: '!old', accountID: 'acc', unreadCount: 0 }], hasMore: false, oldestCursor: null }]
      : [200, { items: [{ id: '!new', accountID: 'acc', unreadCount: unread, lastActivity: '2026-11-18T10:00:00Z' }], hasMore: true, oldestCursor: 'p2' }];
  },
  'POST /v1/chats/!new/archive': () => [200, { success: true }],
  'GET /v1/chats/!dm': () => [200, { id: '!dm', type: 'single', network: 'WhatsApp', participants: { items: [{ id: 'me', isSelf: true }, { id: 'peer' }] } }],
});
const scans = () => up.calls.filter((c) => c.method === 'GET' && c.url.startsWith('/v1/chats?')).length;

before(async () => {
  await up.start();
  resetLocalRead();
});
after(() => up.stop());

test('one scan for concurrent askers, kept for the next ones', async () => {
  dropScan();
  const at = scans();
  const [a, b] = await Promise.all([unreadChats(), unreadChats()]);
  assert.equal(scans() - at, 2, 'two pages, scanned once');
  assert.deepEqual(a.map((c) => c.id).sort(), ['!new', '!old']);
  assert.deepEqual(a, b);
  await unreadChats();
  assert.equal(scans() - at, 2, 'kept');
});

test("the socket's chat upserts keep it current; a change made here or a read forgets it", async () => {
  dropScan();
  await unreadChats();
  const at = scans();
  patchScan([{ id: '!new', accountID: 'acc', unreadCount: 7 }, { id: '!brand', accountID: 'acc', unreadCount: 1 }]);
  const now = await unreadChats();
  assert.equal(scans(), at, 'no new scan');
  assert.equal(now.find((c) => c.id === '!new')?.unreadCount, 7);
  assert.equal(now.find((c) => c.id === '!brand')?.unreadCount, 1);
  // A flag changed through Klatchly: read again.
  await desktop.archive('!new', true);
  await unreadChats();
  assert.equal(scans(), at + 2);
  // A discreet read: read again, and shown without what was read.
  unread = 4;
  readLocally({ id: '!new', unreadCount: 4, lastActivity: '2026-11-18T10:00:00Z' });
  const after = await unreadChats();
  assert.equal(scans(), at + 4);
  assert.equal(after.find((c) => c.id === '!new')?.unreadCount, 0);
  resetLocalRead();
});

test('a scan under way when an upsert comes takes it once done', async () => {
  dropScan();
  const pending = unreadChats();
  patchScan([{ id: '!old', accountID: 'acc', unreadCount: 9 }]);
  const got = await pending;
  assert.equal(got.find((c) => c.id === '!old')?.unreadCount, 9);
  const at = scans();
  assert.equal((await unreadChats()).find((c) => c.id === '!old')?.unreadCount, 9);
  assert.equal(scans(), at);
});

test('a drop during a scan: those asking afterwards share the one scan that follows it, none alongside', async () => {
  dropScan();
  const at = up.calls.length;
  const first = unreadChats();
  // Reads come often (localread.ts readUpstream fires the watchers on every upstream read).
  dropScan();
  const a = unreadChats();
  const b = unreadChats();
  dropScan();
  const c = unreadChats();
  await Promise.all([first, a, b, c]);
  const pages = up.calls
    .slice(at)
    .filter((x) => x.method === 'GET' && x.url.startsWith('/v1/chats?'))
    .map((x) => (x.url.includes('cursor=') ? 'p2' : 'p1'));
  assert.deepEqual(pages, ['p1', 'p2', 'p1', 'p2'], 'two scans, one after the other');
  const n = scans();
  await unreadChats();
  assert.equal(scans(), n, 'the one that followed is kept');
});

test('kept longer than the accounts page polls its figures (a minute): that page does not scan every time', async () => {
  dropScan();
  await unreadChats();
  const at = scans();
  const now = Date.now;
  try {
    Date.now = () => now() + 61_000;
    await unreadChats();
    assert.equal(scans(), at, 'a minute later: still kept');
    Date.now = () => now() + SCAN_TTL + 1;
    await unreadChats();
    assert.equal(scans(), at + 2, 'past its time: read again');
  } finally {
    Date.now = now;
  }
});

test("reads made for a browser stop with it: the Desktop API call takes the request's signal", async () => {
  const gone = new AbortController();
  gone.abort();
  await assert.rejects(
    sharedRead('test:message', gone.signal, () => desktop.message('!new', '$m')),
    (e: Error) => /abort/i.test(e.name) || /abort/i.test(e.message),
  );
});

test("a delivery tick's chat lookup: one upstream call for a burst in the same chat", async () => {
  setPeerResolver(null);
  const at = up.calls.filter((c) => c.url.startsWith('/v1/chats/!dm')).length;
  const peers = await Promise.all([upstreamPeer('!dm'), upstreamPeer('!dm'), upstreamPeer('!dm')]);
  assert.deepEqual(peers, [{ peerID: 'peer' }, { peerID: 'peer' }, { peerID: 'peer' }]);
  assert.equal(up.calls.filter((c) => c.url.startsWith('/v1/chats/!dm')).length - at, 1);
});
