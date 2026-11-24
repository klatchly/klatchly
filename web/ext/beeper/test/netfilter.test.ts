import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { relay } from '#core/relay.js';
import { mockUpstream } from '../../../test/mock.js';
import { TELEGRAM_ACCOUNT } from '../../../test/fixtures/identities.js';
import './setup.js';

const page = { items: [], hasMore: false };
const ids = ['line.U_z0LM', TELEGRAM_ACCOUNT];
const up = mockUpstream({
  'GET /v1/accounts': () => [200, ids.map((accountID) => ({ accountID, network: 'X' }))],
  'GET /v1/chats': () => [200, page],
  'GET /v1/chats/search': () => [200, page],
  'GET /v1/messages/search': () => [200, { ...page, chats: {} }],
});
const app = new Hono().route('/api', relay);
const accountsOf = (url: string) => new URL(url, 'http://x').searchParams.getAll('accountIDs');

// The accounts Beeper lists are its own (accounts.ts): the filter asks it for them.
before(async () => {
  await up.start();
  assert.equal((await app.request('/api/accounts')).status, 200);
});
after(() => up.stop());

test('network filter is forwarded on the chat list and both searches', async () => {
  const qs = ids.map((a) => `accountIDs=${encodeURIComponent(a)}`).join('&');
  for (const path of ['/api/chats?limit=50', '/api/chats/search?query=hi', '/api/messages/search?query=hi']) {
    const r = await app.request(`${path}&${qs}`);
    assert.equal(r.status, 200, path);
    assert.deepEqual(accountsOf(up.calls.at(-1)!.url).sort(), ids.sort(), path);
  }
});

test('no filter means no accountIDs upstream', async () => {
  await app.request('/api/chats?limit=50');
  assert.deepEqual(accountsOf(up.calls.at(-1)!.url), []);
});

test('malformed or too many account IDs are refused before reaching upstream', async () => {
  const n = up.calls.length;
  for (const bad of ['a%20b', 'x%0A', '../etc', 'a'.repeat(201)]) {
    assert.equal((await app.request(`/api/chats?accountIDs=${bad}`)).status, 400, bad);
  }
  const many = Array.from({ length: 21 }, (_, i) => `accountIDs=acc${i}`).join('&');
  assert.equal((await app.request(`/api/messages/search?query=x&${many}`)).status, 400);
  assert.equal(up.calls.length, n);
});
