import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { dataPath } from '../server/config.js';
import { notifyRoutes } from '../server/notify.js';
import { ConnectorError } from '../server/connector.js';
import { readAllRoutes } from '../server/readall.js';
import { discreetFor, readingRoutes, resetReading } from '../server/reading.js';
import { relay } from '../server/relay.js';
import { fakeSource, withFake } from './fakesource.js';
import { Registry } from '../server/registry.js';

// Discreet reading (server/reading.ts): which reads tell the network, per account and per chat, on fake connectors: one that can
// keep a read quiet (two accounts, chats a1… and b1…), one that declares nothing ('old', chats o:…), one that
// cannot send a receipt ('mute', chats m:…), one whose network refuses receipts for now ('flaky', chats f:…).

const calls: string[] = [];
const read = (name: string) => async (chatID: string) => void calls.push(`${name} ${chatID} -`);
const receipts = (name: string, send = true) => ({
  readQuietly: async (chatID: string) => void calls.push(`${name} ${chatID} receipt=false`),
  ...(send ? { send: async (chatID: string) => void calls.push(`${name} ${chatID} receipt=true`) } : {}),
});
// "Mark all read" in the low-priority inbox: which of its chats' accounts the core says are quiet.
const quietAsked: string[] = [];
const src = fakeSource({
  receipts: {
    ...receipts('fake'),
    note: { en: 'note', fr: 'note' },
    async readAllLowPriorityByChat(onRead, quiet) {
      for (const [id, account] of [['a1', 'acc-a'], ['b1', 'acc-b'], ['u1', undefined]] as const) {
        quietAsked.push(`${id} ${quiet(id, account) ? 'quiet' : 'told'}`);
        onRead(id);
      }
      return { total: 3, read: ['a1', 'b1', 'u1'], failed: 0, complete: true };
    },
  },
  accounts: async () => [{ accountID: 'acc-a', network: 'A' }, { accountID: 'acc-b', network: 'B' }],
  markRead: read('fake'),
});
src.chats.set('a1', { id: 'a1', accountID: 'acc-a' });
src.chats.set('b1', { id: 'b1', accountID: 'acc-b' });
// A chat whose account the connector does not say.
src.chats.set('u1', { id: 'u1' });
const old = fakeSource({ owns: (id) => id.startsWith('o:'), ownsAccount: (id) => id === 'old', markRead: read('old') }, 'old');
const mute = fakeSource(
  { owns: (id) => id.startsWith('m:'), ownsAccount: (id) => id === 'mute', markRead: read('mute'), receipts: receipts('mute', false) },
  'mute',
);
let refused = false;
const flaky = fakeSource(
  {
    owns: (id) => id.startsWith('f:'),
    ownsAccount: (id) => id === 'flaky',
    markRead: read('flaky'),
    receipts: {
      ...receipts('flaky'),
      async send(chatID: string) {
        calls.push(`flaky ${chatID} send`);
        refused = true;
        throw new ConnectorError(409, 'receipt_unavailable');
      },
      sendAvailable: () => !refused,
    },
  },
  'flaky',
);
// Replying always tells here (receipts.replyTells, 1.7.0): after a reply, a discreet chat is read for real.
const tell = fakeSource(
  { owns: (id) => id.startsWith('t:'), ownsAccount: (id) => id === 'tell', markRead: read('tell'), receipts: { ...receipts('tell'), replyTells: true } },
  'tell',
);
tell.chats.set('t:1', { id: 't:1', accountID: 'tell' });
withFake(src, [old.pkg, mute.pkg, flaky.pkg, tell.pkg]);
const app = new Hono().route('/api', readingRoutes).route('/api', notifyRoutes).route('/api', readAllRoutes).route('/api', relay);
const req = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

function fresh() {
  rmSync(dataPath('reading.json'), { force: true });
  resetReading();
  calls.length = 0;
  quietAsked.length = 0;
}

test('reading tells the network unless the account reads discreetly; "Mark as read" always tells it', async () => {
  fresh();
  assert.equal((await req('POST', '/api/chats/a1/read', {})).status, 200);
  assert.equal((await req('PUT', '/api/reading/acc-a', { discreet: true })).status, 200);
  const quiet = await req('POST', '/api/chats/a1/read', {});
  assert.deepEqual(await quiet.json(), { ok: true, receipt: false });
  // The other account of the same connector keeps its own setting (its chat's account is looked up once).
  await req('POST', '/api/chats/b1/read', {});
  await req('POST', '/api/chats/b1/read', {});
  const told = await req('POST', '/api/chats/a1/read', { receipt: true });
  assert.deepEqual(await told.json(), { ok: true, receipt: true });
  assert.deepEqual(calls, ['fake a1 receipt=true', 'fake a1 receipt=false', 'fake b1 receipt=true', 'fake b1 receipt=true', 'fake a1 receipt=true']);
  assert.deepEqual(src.calls.filter((c) => c.startsWith('chat ')), ['chat a1', 'chat b1'], 'one lookup per chat');
});

test('a notification\'s "Mark as read" and a reply follow the setting', async () => {
  fresh();
  await req('PUT', '/api/reading/acc-a', { discreet: true });
  await req('POST', '/api/notify/read', { chatID: 'a1' });
  await req('POST', '/api/notify/reply', { chatID: 'a1', text: 'ok' });
  assert.deepEqual(calls, ['fake a1 receipt=false', 'fake a1 receipt=false']);
});

test('where replying always tells, a reply reads a discreet chat for real (composer, notification); elsewhere as before', async () => {
  fresh();
  await req('PUT', '/api/reading/tell', { discreet: true });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  // Discreet: opening reads quietly; the composer's reply then tells, once (not awaited by the send).
  await req('POST', '/api/chats/t%3A1/read', {});
  assert.equal((await req('POST', '/api/chats/t%3A1/messages', { text: 'hi' })).status, 200);
  await until(() => calls.length >= 2);
  assert.deepEqual(calls, ['tell t:1 receipt=false', 'tell t:1 receipt=true']);
  // A notification's reply: the read for real, instead of the quiet one.
  calls.length = 0;
  await req('POST', '/api/notify/reply', { chatID: 't:1', text: 'ok' });
  assert.deepEqual(calls, ['tell t:1 receipt=true']);
  // Not discreet: its reads told already, a reply adds nothing; a source that only "may" tell (fake): nothing either.
  await req('PUT', '/api/reading/tell', { discreet: false });
  await req('PUT', '/api/reading/acc-a', { discreet: true });
  calls.length = 0;
  await req('POST', '/api/chats/t%3A1/messages', { text: 'hi' });
  await req('POST', '/api/chats/a1/messages', { text: 'hi' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, []);
});

test('a connector without receipts reads as before and cannot be made discreet; one without send refuses the explicit read', async () => {
  fresh();
  await req('POST', '/api/chats/o%3A1/read', {});
  await req('POST', '/api/chats/o%3A1/read', { receipt: true });
  assert.equal((await req('PUT', '/api/reading/old', { discreet: true })).status, 409);
  // No send: every read is quiet, and "Mark as read" is refused.
  await req('POST', '/api/chats/m%3A1/read', {});
  assert.equal((await req('POST', '/api/chats/m%3A1/read', { receipt: true })).status, 409);
  assert.deepEqual(calls, ['old o:1 -', 'old o:1 -', 'mute m:1 receipt=false']);
});

test('GET /api/reading lists every account with its setting and what its connector can do; choices are kept', async () => {
  fresh();
  await req('PUT', '/api/reading/mute', { discreet: false });
  await req('PUT', '/api/reading/acc-b', { discreet: true });
  resetReading();
  const r = (await (await req('GET', '/api/reading')).json()) as { accounts: { accountID: string; discreet: boolean; support: unknown }[] };
  assert.deepEqual(r.accounts.map((a) => a.accountID).sort(), ['acc-a', 'acc-b', 'flaky', 'mute', 'old', 'tell']);
  const by = Object.fromEntries(r.accounts.map((a) => [a.accountID, a]));
  assert.equal(by['acc-a']!.discreet, false);
  assert.equal(by['acc-b']!.discreet, true);
  assert.equal(by.mute!.discreet, true, 'no send: quiet whatever the choice');
  assert.equal(by.old!.support, null);
  assert.deepEqual(by['acc-a']!.support, { discreet: true, send: true, available: true, replyMayTell: false, replyTells: false, note: { en: 'note', fr: 'note' } });
  const f = by.tell!.support as { replyMayTell: boolean; replyTells: boolean };
  assert.deepEqual([f.replyTells, f.replyMayTell], [true, true], 'replyTells implies replyMayTell');
});

test('bad requests', async () => {
  fresh();
  for (const body of [{}, { discreet: 'yes' }, { discreet: true, x: 1 }]) assert.equal((await req('PUT', '/api/reading/acc-a', body)).status, 400);
  assert.equal((await req('PUT', '/api/reading/a%20b', { discreet: true })).status, 400);
  assert.equal((await req('POST', '/api/chats/a1/read', { receipt: false })).status, 400);
  assert.deepEqual(calls, []);
});

test('an unknown account fails closed: quiet when any account of its source reads discreetly', async () => {
  fresh();
  await req('POST', '/api/chats/u1/read', {});
  await req('PUT', '/api/reading/acc-a', { discreet: true });
  // No account given by the connector, then a chat it does not have (its lookup fails).
  await req('POST', '/api/chats/u1/read', {});
  await req('POST', '/api/chats/x9/read', {});
  await req('PUT', '/api/reading/acc-a', { discreet: false });
  await req('POST', '/api/chats/u1/read', {});
  assert.deepEqual(calls, ['fake u1 receipt=true', 'fake u1 receipt=false', 'fake x9 receipt=false', 'fake u1 receipt=true']);
});

test('"mark all read" (low priority) keeps discreet accounts quiet, unknown ones too when any is', async () => {
  fresh();
  await req('PUT', '/api/reading/acc-b', { discreet: true });
  const r = await req('POST', '/api/inbox/low-priority/read-all', {});
  assert.deepEqual(await r.json(), { total: 3, marked: 3, failed: 0, complete: true });
  assert.deepEqual(quietAsked, ['a1 told', 'b1 quiet', 'u1 quiet']);
});

test('a network that refuses receipts: a plain read is quiet, never an error, and is not retried; "Mark as read" says why', async () => {
  fresh();
  refused = false;
  const first = await req('POST', '/api/chats/f%3A1/read', {});
  assert.deepEqual([first.status, await first.json()], [200, { ok: true, receipt: false }]);
  await req('POST', '/api/chats/f%3A1/read', {});
  const told = await req('POST', '/api/chats/f%3A1/read', { receipt: true });
  assert.deepEqual([told.status, await told.json()], [409, { error: 'receipt_unavailable' }]);
  assert.deepEqual(calls, ['flaky f:1 send', 'flaky f:1 receipt=false', 'flaky f:1 receipt=false', 'flaky f:1 send']);
  const r = (await (await req('GET', '/api/reading')).json()) as { accounts: { accountID: string; discreet: boolean; support: { available: boolean } }[] };
  const a = r.accounts.find((x) => x.accountID === 'flaky')!;
  assert.deepEqual([a.discreet, a.support.available], [true, false]);
});

test('a chat\'s own choice wins over its account\'s, both ways; null goes back to the account\'s; "Mark as read" still tells', async () => {
  fresh();
  await req('PUT', '/api/reading/acc-a', { discreet: true });
  assert.equal((await req('PUT', '/api/reading/chat/a1', { discreet: false })).status, 200);
  assert.equal((await req('PUT', '/api/reading/chat/b1', { discreet: true })).status, 200);
  await req('POST', '/api/chats/a1/read', {});
  await req('POST', '/api/chats/b1/read', {});
  await req('POST', '/api/notify/read', { chatID: 'b1' });
  await req('POST', '/api/notify/reply', { chatID: 'b1', text: 'ok' });
  await req('POST', '/api/chats/b1/read', { receipt: true });
  const back = (await (await req('PUT', '/api/reading/chat/a1', { discreet: null })).json()) as { chats: Record<string, boolean> };
  assert.deepEqual(back.chats, { b1: true });
  await req('POST', '/api/chats/a1/read', {});
  assert.deepEqual(calls, [
    'fake a1 receipt=true',
    'fake b1 receipt=false',
    'fake b1 receipt=false',
    'fake b1 receipt=false',
    'fake b1 receipt=true',
    'fake a1 receipt=false',
  ]);
});

test('chat choices are kept (0600), listed by GET, and reset all at once', async () => {
  fresh();
  await req('PUT', '/api/reading/chat/a1', { discreet: true });
  await req('PUT', '/api/reading/chat/u1', { discreet: false });
  resetReading();
  const r = (await (await req('GET', '/api/reading')).json()) as { chats: Record<string, boolean> };
  assert.deepEqual(r.chats, { a1: true, u1: false });
  assert.equal(statSync(dataPath('reading.json')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(dataPath('reading.json'), 'utf8')).chats, { a1: true, u1: false });
  const cleared = (await (await req('DELETE', '/api/reading/chats')).json()) as { chats: Record<string, boolean> };
  assert.deepEqual(cleared.chats, {});
  resetReading();
  await req('POST', '/api/chats/a1/read', {});
  assert.deepEqual(calls, ['fake a1 receipt=true']);
});

test('a chat choice: bad requests, and only where a receipt can be sent', async () => {
  fresh();
  for (const body of [{}, { discreet: 'yes' }, { discreet: 1 }, { discreet: true, x: 1 }, [true]]) assert.equal((await req('PUT', '/api/reading/chat/a1', body)).status, 400);
  assert.equal((await req('PUT', '/api/reading/chat/a%20b', { discreet: true })).status, 400);
  assert.equal((await req('PUT', `/api/reading/chat/${'x'.repeat(600)}`, { discreet: true })).status, 400);
  // No receipts, or no send: every read there is the same whatever the choice.
  assert.equal((await req('PUT', '/api/reading/chat/o%3A1', { discreet: true })).status, 409);
  assert.equal((await req('PUT', '/api/reading/chat/m%3A1', { discreet: false })).status, 409);
  const big = await req('PUT', '/api/reading/chat/a1', { discreet: true, pad: 'x'.repeat(2000) });
  assert.equal(big.status, 413);
  assert.deepEqual((await (await req('GET', '/api/reading')).json() as { chats: object }).chats, {});
});

test('"mark all read" asks chat by chat; asked by account only, a chat made discreet keeps its account quiet', async () => {
  fresh();
  await req('PUT', '/api/reading/acc-b', { discreet: true });
  await req('PUT', '/api/reading/chat/a1', { discreet: true });
  await req('PUT', '/api/reading/chat/b1', { discreet: false });
  await req('POST', '/api/inbox/low-priority/read-all', {});
  assert.deepEqual(quietAsked, ['a1 quiet', 'b1 told', 'u1 quiet']);
  // The account-only question (a connector before API 1.6): fail closed for the account of a1 (seen above).
  assert.equal(discreetFor(src.module, 'acc-a'), true);
  await req('PUT', '/api/reading/chat/a1', { discreet: null });
  assert.equal(discreetFor(src.module, 'acc-a'), false);
});

test('an account no connector claims right now (not listed yet since a restart) fails closed: its discreet choice holds', async () => {
  fresh();
  // A build of connectors that each claim their accounts (no legacy catch-all): 'later' is nobody's until listed.
  let listed = false;
  const own = fakeSource(
    { owns: (id) => id.startsWith('x:'), ownsAccount: (id) => listed && id === 'later', markRead: read('own'), receipts: receipts('own') },
    'own',
  );
  own.chats.set('x:1', { id: 'x:1', accountID: 'later' });
  new Registry([own.pkg]);
  try {
    writeFileSync(dataPath('reading.json'), JSON.stringify({ v: 1, accounts: { later: true }, chats: {} }));
    resetReading();
    assert.equal((await req('POST', '/api/chats/x%3A1/read', {})).status, 200);
    assert.ok(discreetFor(own.module, undefined), 'asked without the account: quiet');
    // Listed: its own, the same answer.
    listed = true;
    assert.equal((await req('POST', '/api/chats/x%3A1/read', {})).status, 200);
    assert.deepEqual(calls, ['own x:1 receipt=false', 'own x:1 receipt=false']);
  } finally {
    withFake(src, [old.pkg, mute.pkg, flaky.pkg, tell.pkg]);
    fresh();
  }
});
