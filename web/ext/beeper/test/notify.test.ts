import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { notifyRoutes } from '#core/notify.js';
import { noteChat } from '#core/pushwatch.js';
import { mockUpstream } from '../../../test/mock.js';
import './setup.js';

const up = mockUpstream({
  'POST /v1/chats/!c1/read': () => [200, { success: true }],
  'POST /v1/chats/!c1/messages': () => [200, { chatID: '!c1', pendingMessageID: 'p1' }],
});
const app = new Hono().route('/api', notifyRoutes);
const post = (path: string, body: unknown, type = 'application/json') =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

before(() => up.start());
after(() => up.stop());

test('mark as read from a notification', async () => {
  noteChat({ id: '!c1', unreadCount: 4 });
  noteChat({ id: '!c9', unreadCount: 2 });
  const r = await post('/api/notify/read', { chatID: '!c1' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, badge: 2 });
  const call = up.calls.pop()!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/v1/chats/!c1/read');
});

test('badge count route', async () => {
  const r = await app.request('/api/notify/badge');
  assert.equal(r.status, 200);
  assert.equal(typeof ((await r.json()) as { badge: number }).badge, 'number');
});

test('reply from a notification: send then mark read', async () => {
  const n = up.calls.length;
  const r = await post('/api/notify/reply', { chatID: '!c1', text: 'ok 👍' });
  assert.equal(r.status, 200);
  const calls = up.calls.slice(n);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /v1/chats/!c1/messages', 'POST /v1/chats/!c1/read']);
  assert.deepEqual(JSON.parse(calls[0]!.body), { text: 'ok 👍' });
});

test('notification routes validate their bodies; nothing reaches upstream', async () => {
  const n = up.calls.length;
  for (const [path, body] of [
    ['/api/notify/read', {}],
    ['/api/notify/read', { chatID: '' }],
    ['/api/notify/read', { chatID: 'a b' }],
    ['/api/notify/read', { chatID: '!c1', messageID: 'x' }],
    ['/api/notify/reply', { chatID: '!c1' }],
    ['/api/notify/reply', { chatID: '!c1', text: '   ' }],
    ['/api/notify/reply', { chatID: '!c1', text: 'x'.repeat(20_001) }],
    ['/api/notify/reply', { chatID: '!c1', text: 'hi', replyToMessageID: 'm' }],
    ['/api/notify/reply', { chatID: 42, text: 'hi' }],
  ] as const) {
    assert.equal((await post(path, body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await post('/api/notify/read', '{"chatID":"c1"}', 'text/plain')).status, 400);
  assert.equal(up.calls.length, n);
});
