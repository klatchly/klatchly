import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { relay } from '#core/relay.js';
import { mockUpstream } from '../../../test/mock.js';
import './setup.js';

const msg = (o: Record<string, unknown>) => ({ id: 'x', chatID: '!c1', accountID: 'a', senderID: 's', timestamp: '2026-01-01T00:00:00Z', sortKey: '1', ...o });
const up = mockUpstream({
  'GET /v1/chats/!c1/messages/own': () => [200, msg({ id: 'own', isSender: true, text: 'hi' })],
  'GET /v1/chats/!c1/messages/other': () => [200, msg({ id: 'other', isSender: false, text: 'theirs' })],
  'GET /v1/chats/!c1/messages/att': () => [200, msg({ id: 'att', isSender: true, attachments: [{ type: 'img' }] })],
  'GET /v1/chats/!c1/messages/gone': () => [200, msg({ id: 'gone', isSender: true, isDeleted: true })],
  'PUT /v1/chats/!c1/messages/own': () => [200, { ...msg({ id: 'own', isSender: true }), success: true, messageID: 'own' }],
  'DELETE /v1/chats/!c1/messages/own': () => [204],
  'DELETE /v1/chats/!c1/messages/att': () => [204],
});
const app = new Hono().route('/api', relay);
const json = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const mutations = () => up.calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE');

before(() => up.start());
after(() => up.stop());

test('edit own message', async () => {
  const r = await json('PUT', '/api/chats/!c1/messages/own', { text: 'edited' });
  assert.equal(r.status, 200);
  const put = mutations().pop()!;
  assert.equal(put.url, '/v1/chats/!c1/messages/own');
  assert.deepEqual(JSON.parse(put.body), { text: 'edited' });
  assert.equal(put.auth, 'Bearer test-token');
});

test('edit refused for others, deleted, attachments; nothing sent upstream', async () => {
  const before = mutations().length;
  for (const id of ['other', 'gone', 'att']) {
    const r = await json('PUT', `/api/chats/!c1/messages/${id}`, { text: 'x' });
    assert.equal(r.status, 409, id);
  }
  assert.equal((await json('PUT', '/api/chats/!c1/messages/missing', { text: 'x' })).status, 404);
  assert.equal(mutations().length, before);
});

test('edit body validation', async () => {
  for (const b of [{}, { text: '' }, { text: '   ' }, { text: 1 }, { text: 'a', extra: 1 }, { text: 'x'.repeat(20_001) }]) {
    assert.equal((await json('PUT', '/api/chats/!c1/messages/own', b)).status, 400, JSON.stringify(b).slice(0, 40));
  }
});

test('delete own message (forEveryone default true, explicit false)', async () => {
  assert.equal((await json('DELETE', '/api/chats/!c1/messages/own')).status, 200);
  assert.match(mutations().pop()!.url, /forEveryone=true/);
  assert.equal((await json('DELETE', '/api/chats/!c1/messages/own?forEveryone=false')).status, 200);
  assert.match(mutations().pop()!.url, /forEveryone=false/);
  // own attachment messages can be deleted (only editing is text-only)
  assert.equal((await json('DELETE', '/api/chats/!c1/messages/att')).status, 200);
});

test('delete refused for others / bad query', async () => {
  const before = mutations().length;
  assert.equal((await json('DELETE', '/api/chats/!c1/messages/other')).status, 409);
  assert.equal((await json('DELETE', '/api/chats/!c1/messages/gone')).status, 409);
  assert.equal((await json('DELETE', '/api/chats/!c1/messages/own?forEveryone=yes')).status, 400);
  assert.equal(mutations().length, before);
});

test('pin/mute patch only forwards the allowed booleans', async () => {
  assert.equal((await json('PATCH', '/api/chats/c1', { isPinned: true, title: 'x' })).status, 400);
  assert.equal(up.calls.filter((c) => c.method === 'PATCH').length, 0);
});
