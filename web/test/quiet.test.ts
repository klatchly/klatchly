import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { dataPath } from '../server/config.js';
import { badgeCount, noteChat, reseedUnread } from '../server/badgecount.js';
import { quietNow, quietRoutes, resetQuiet, type QuietReply } from '../server/quiet.js';
import { fakeSource, withFake } from './fakesource.js';

// Quiet hours, the server (server/quiet.ts): rules kept per account and per chat, the routes' checks, and the app
// badge leaving out what they hold. Push is in push.test.ts (it needs the fake push service).

const src = fakeSource({ accounts: async () => [{ accountID: 'acc-a', network: 'WhatsApp', user: { fullName: 'Me' } }, { accountID: 'acc-b', network: 'Telegram' }] });
src.chats.set('a1', { id: 'a1', accountID: 'acc-a' });
withFake(src);
const app = new Hono().route('/api', quietRoutes);
const req = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

function fresh() {
  rmSync(dataPath('quiet.json'), { force: true });
  resetQuiet();
}

/** A rule open now in UTC: from ten minutes ago to ten minutes from now. */
function openNow() {
  const m = Math.floor((Date.now() % 86_400_000) / 60_000);
  return { from: (m - 10 + 1440) % 1440, to: (m + 10) % 1440, days: [0, 1, 2, 3, 4, 5, 6], tz: 'UTC' };
}
/** A rule closed now. */
function closedNow() {
  const m = Math.floor((Date.now() % 86_400_000) / 60_000);
  return { from: (m + 60) % 1440, to: (m + 120) % 1440, days: [0, 1, 2, 3, 4, 5, 6], tz: 'UTC' };
}

test('GET lists the accounts and the rules; an account rule is kept (0600) and removed', async () => {
  fresh();
  let r = (await (await req('GET', '/api/quiet')).json()) as QuietReply;
  assert.deepEqual(r.list, [
    { accountID: 'acc-a', network: 'WhatsApp', name: 'Me', source: 'fake' },
    { accountID: 'acc-b', network: 'Telegram', source: 'fake' },
  ]);
  assert.deepEqual([r.accounts, r.chats], [{}, {}]);
  const rule = { from: 1320, to: 420, days: [5, 1], tz: 'Europe/Paris' };
  const put = await req('PUT', '/api/quiet/account/acc-a', { rule });
  assert.equal(put.status, 200);
  assert.deepEqual(((await put.json()) as QuietReply).accounts, { 'acc-a': { ...rule, days: [1, 5] } });
  assert.equal(statSync(dataPath('quiet.json')).mode & 0o777, 0o600);
  resetQuiet();
  r = (await (await req('GET', '/api/quiet')).json()) as QuietReply;
  assert.deepEqual(r.accounts['acc-a']?.days, [1, 5], 'kept across a restart');
  await req('PUT', '/api/quiet/account/acc-a', { rule: null });
  assert.deepEqual(JSON.parse(readFileSync(dataPath('quiet.json'), 'utf8')).accounts, {});
});

test('a chat: its own rule, never quiet, back to its account’s; all reset at once', async () => {
  fresh();
  assert.equal((await req('PUT', '/api/quiet/chat/a1', { rule: openNow() })).status, 200);
  assert.equal((await req('PUT', '/api/quiet/chat/a2', { rule: false })).status, 200);
  let r = (await (await req('GET', '/api/quiet')).json()) as QuietReply;
  assert.equal(r.chats.a2, false);
  assert.ok(r.chats.a1);
  r = (await (await req('PUT', '/api/quiet/chat/a1', { rule: null })).json()) as QuietReply;
  assert.deepEqual(Object.keys(r.chats), ['a2']);
  r = (await (await req('DELETE', '/api/quiet/chats')).json()) as QuietReply;
  assert.deepEqual(r.chats, {});
});

test('bad requests: shapes, ids, zones, false only for a chat', async () => {
  fresh();
  for (const body of [{}, { rule: 'x' }, { rule: { from: 1, to: 1, days: [1], tz: 'UTC' } }, { rule: null, x: 1 }, { rule: false }]) {
    assert.equal((await req('PUT', '/api/quiet/account/acc-a', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await req('PUT', '/api/quiet/account/a%20b', { rule: null })).status, 400);
  assert.equal((await req('PUT', '/api/quiet/chat/a1', { rule: { ...openNow(), tz: 'Nope/Nope' } })).status, 400);
  assert.deepEqual(JSON.parse((await (await req('GET', '/api/quiet')).text()) || '{}').accounts, {});
});

test('quietNow: the chat’s own rule over its account’s; a stored file with junk keeps only what is valid', async () => {
  fresh();
  writeFileSync(
    dataPath('quiet.json'),
    JSON.stringify({ v: 1, accounts: { 'acc-a': openNow(), 'bad id': openNow(), 'acc-b': { from: 'x' } }, chats: { a1: false, a3: closedNow() } }),
  );
  resetQuiet();
  assert.ok(quietNow('x', 'acc-a'));
  assert.ok(!quietNow('a1', 'acc-a'), 'never quiet wins');
  assert.ok(!quietNow('a3', 'acc-a'), 'its own window, closed now, wins');
  assert.ok(!quietNow('x', 'acc-b'), 'invalid rule dropped');
});

test('the badge leaves out chats held now, and counts them again once read or released', async () => {
  fresh();
  reseedUnread(
    [
      { id: 'q1', accountID: 'acc-a', unreadCount: 3, lastActivity: new Date().toISOString() },
      { id: 'q2', accountID: 'acc-b', unreadCount: 2, lastActivity: new Date().toISOString() },
      // Unread from before the window opened: still counted.
      { id: 'q3', accountID: 'acc-a', unreadCount: 1, lastActivity: new Date(Date.now() - 3600_000).toISOString() },
    ],
    (id) => id.startsWith('q'),
  );
  assert.equal(badgeCount(), 6);
  await req('PUT', '/api/quiet/account/acc-a', { rule: openNow() });
  assert.equal(badgeCount(), 3, 'q1 held');
  await req('POST', '/api/quiet/release');
  assert.equal(badgeCount(), 6, 'released: counted again');
  noteChat({ id: 'q1', unreadCount: 4, lastActivity: new Date(Date.now() + 1000).toISOString() });
  assert.equal(badgeCount(), 3, 'a new message after the release is held again');
  reseedUnread([], (id) => id.startsWith('q'));
});
