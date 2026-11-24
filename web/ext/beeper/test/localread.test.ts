import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { readingRoutes } from '#core/reading.js';
import { relay } from '#core/relay.js';
import { mockUpstream } from '../../../test/mock.js';
import { readAllLowPriority } from '../server/inbox.js';
import { flushLocalRead, localChat, localFrame, readLocally, resetLocalRead } from '../server/localread.js';
import './setup.js';

// Discreet reading on Beeper (localread.ts): the Desktop API's read (which sends the receipt) is only called for a
// real read; a discreet one hides the unread count Klatchly saw, in every chat the connector hands on.

let unread = 3;
const chat = () => ({ id: '!c1', accountID: 'whatsapp', network: 'WhatsApp', title: 'C', unreadCount: unread });
const up = mockUpstream({
  'GET /v1/accounts': () => [200, [{ accountID: 'whatsapp', network: 'WhatsApp' }]],
  'GET /v1/chats/!c1': () => [200, chat()],
  'GET /v1/chats': () => [200, { items: [chat()], hasMore: false, oldestCursor: null, newestCursor: null }],
  'GET /v1/chats/search': () => [
    200,
    {
      items: [
        { id: '!lp1', accountID: 'whatsapp', unreadCount: 2, isLowPriority: true },
        { id: '!lp2', accountID: 'telegram', unreadCount: 4, isLowPriority: true },
      ],
      hasMore: false,
      oldestCursor: null,
    },
  ],
  'POST /v1/chats/!lp1/read': () => [200, { success: true }],
  'POST /v1/chats/!c1/messages': () => [200, { chatID: '!c1', pendingMessageID: 'p1' }],
  'POST /v1/chats/!c1/read': () => {
    unread = 0;
    return [200, { success: true }];
  },
});
const app = new Hono().route('/api', readingRoutes).route('/api', relay);
const req = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
const reads = () => up.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/read')).length;
const shown = async () => ((await (await req('GET', '/api/chats/!c1')).json()) as { unreadCount: number }).unreadCount;

// The accounts Beeper lists are its own (accounts.ts): Settings' per-account choices find their connector.
before(async () => {
  await up.start();
  assert.equal((await req('GET', '/api/accounts')).status, 200);
});
after(() => up.stop());

test('a discreet read sends nothing upstream and hides what was unread; "Mark as read" sends the read', async () => {
  resetLocalRead();
  assert.equal((await req('PUT', '/api/reading/whatsapp', { discreet: true })).status, 200);
  const r = await req('POST', '/api/chats/!c1/read', {});
  assert.deepEqual(await r.json(), { ok: true, receipt: false });
  assert.equal(reads(), 0, 'no read reached the Desktop API');
  assert.equal(await shown(), 0);
  // A new message upstream: only it is unread in Klatchly.
  unread = 4;
  assert.equal(await shown(), 1);
  const list = (await (await req('GET', '/api/chats')).json()) as { items: { unreadCount: number }[] };
  assert.equal(list.items[0]!.unreadCount, 1);
  // The explicit read: the Desktop API's, once.
  assert.deepEqual(await (await req('POST', '/api/chats/!c1/read', { receipt: true })).json(), { ok: true, receipt: true });
  assert.equal(reads(), 1);
  unread = 2;
  assert.equal(await shown(), 2, 'nothing hidden any more');
  flushLocalRead();
});

test('a reply in a discreet chat reads it for real (replyTells): one Desktop API read, the entry dropped', async () => {
  resetLocalRead();
  unread = 3;
  assert.equal((await req('PUT', '/api/reading/whatsapp', { discreet: true })).status, 200);
  await req('POST', '/api/chats/!c1/read', {});
  const n = reads();
  unread = 4;
  assert.equal(await shown(), 1);
  assert.equal((await req('POST', '/api/chats/!c1/messages', { text: 'hi' })).status, 200);
  for (let i = 0; i < 50 && reads() === n; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(reads(), n + 1, 'one read, after the send');
  const urls = up.calls.map((c) => `${c.method} ${c.url}`);
  assert.ok(urls.lastIndexOf('POST /v1/chats/!c1/read') > urls.lastIndexOf('POST /v1/chats/!c1/messages'));
  unread = 2;
  assert.equal(await shown(), 2, 'nothing hidden any more: Beeper’s count');
  flushLocalRead();
});

test('read elsewhere: a count below what was hidden, or at most it with a new last activity; socket frames too', () => {
  resetLocalRead();
  readLocally({ id: '!c2', unreadCount: 5, lastActivity: 't1' });
  assert.equal(localChat({ id: '!c2', unreadCount: 5, lastActivity: 't1' }).unreadCount, 0);
  assert.equal(localChat({ id: '!c2', unreadCount: 7, lastActivity: 't2' }).unreadCount, 2, 'new messages after it');
  assert.equal(localChat({ id: '!c2', unreadCount: 1 }).unreadCount, 1);
  // Dropped: back at 5, it is 5 again.
  assert.equal(localChat({ id: '!c2', unreadCount: 5, lastActivity: 't1' }).unreadCount, 5);
  // Read there, then as many messages again: same count, a new last activity.
  readLocally({ id: '!c5', unreadCount: 2, lastActivity: 't1' });
  assert.equal(localChat({ id: '!c5', unreadCount: 2, lastActivity: 't3' }).unreadCount, 2);
  readLocally({ id: '!c3', unreadCount: 2 });
  const frame = JSON.stringify({ type: 'chat.upserted', entries: [{ id: '!c3', unreadCount: 3 }, { id: '!c4', unreadCount: 1 }] });
  assert.deepEqual(JSON.parse(localFrame(frame)).entries, [{ id: '!c3', unreadCount: 1 }, { id: '!c4', unreadCount: 1 }]);
  const other = JSON.stringify({ type: 'message.upserted', entries: [] });
  assert.equal(localFrame(other), other);
});

test('a chat without its unread count passes as is; a mark-unread read discreetly is cleared', () => {
  resetLocalRead();
  readLocally({ id: '!c6', unreadCount: 2 });
  const partial = { id: '!c6', title: 'renamed' };
  assert.equal(localChat(partial), partial, 'a partial upsert: untouched');
  readLocally({ id: '!c7', unreadCount: 0, isMarkedUnread: true, lastActivity: 't1' });
  assert.deepEqual(localChat({ id: '!c7', unreadCount: 0, isMarkedUnread: true, lastActivity: 't1' }), { id: '!c7', unreadCount: 0, isMarkedUnread: false, lastActivity: 't1' });
  assert.equal(localChat({ id: '!c7', isMarkedUnread: true }).isMarkedUnread, false);
});

test('"mark all read" in the low-priority inbox: discreet chats read in Klatchly only, the others through the Desktop API', async () => {
  resetLocalRead();
  const n = up.calls.length;
  const read: string[] = [];
  const r = await readAllLowPriority((id) => read.push(id), (_chat, account) => account !== 'whatsapp');
  assert.deepEqual([r.total, r.failed, read.sort()], [2, 0, ['!lp1', '!lp2']]);
  const posts = up.calls.slice(n).filter((c) => c.method === 'POST').map((c) => c.url);
  assert.deepEqual(posts, ['/v1/chats/!lp1/read'], 'only the non-discreet account told');
  assert.equal(localChat({ id: '!lp2', accountID: 'telegram', unreadCount: 4 }).unreadCount, 0);
});
