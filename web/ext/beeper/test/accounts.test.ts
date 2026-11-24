import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { Hono } from 'hono';
import { dataPath } from '#core/config.js';
import { newChatRoutes } from '#core/newchat.js';
import { relay } from '#core/relay.js';
import { connectorForAccount } from '#core/sources.js';
import { accountsPending, flushAccounts, knownAccount, noteAccountList, noteAccounts, noteChatAccounts, resetAccountsForTests } from '../server/accounts.js';
import { beeperReactionKey } from '../server/mxc.js';
import { mockUpstream } from '../../../test/mock.js';
import { localMxc } from '../../../test/fixtures/identities.js';
import { registry } from './setup.js';

// Beeper claims the accounts beeper-server has listed, or that its chats are on (accounts.ts: its ownsAccount),
// kept in the data volume so that they keep resolving across restarts and while beeper-server is down (until the
// first listing, the accounts no other connector claims: accountsPending); and its long
// reaction keys (image reactions: strict mxc:// URIs, moved from the core's relay).

const up = mockUpstream({
  'GET /v1/accounts': () => [200, [{ accountID: 'listed', network: 'Telegram' }]],
  'GET /v1/chats': () => [200, { items: [{ id: '!a:x', accountID: 'onchat', title: 'A' }], hasMore: false, oldestCursor: null, newestCursor: null }],
  'GET /v1/bridges/telegram/capabilities': () => [200, { resolve_identifier: { create_dm: true }, group_creation: {} }],
});
const app = new Hono().route('/api', relay).route('/api', newChatRoutes);
const file = () => dataPath('beeper-accounts.json');
const beeper = () => registry.modules('connector').find((k) => k.id === 'beeper');

before(async () => {
  await up.start();
  rmSync(file(), { force: true });
  resetAccountsForTests();
});
after(() => up.stop());

test('first start (no file): the accounts no other connector claims are its own until beeper-server lists them', async () => {
  assert.equal(knownAccount('listed'), false);
  assert.equal(accountsPending(), true);
  assert.equal(beeper()?.accountsPending, accountsPending);
  // The window after a first deploy: a saved network filter or a per-account setting still reaches Beeper.
  assert.equal(connectorForAccount('listed')?.id, 'beeper');
  assert.equal(connectorForAccount('stranger')?.id, 'beeper');
  // Chats alone (a list page) are not all of its accounts: still pending.
  noteChatAccounts([{ accountID: 'partial' }]);
  assert.equal(accountsPending(), true);
  assert.equal((await app.request('/api/accounts')).status, 200);
  assert.equal(accountsPending(), false);
  assert.equal(knownAccount('listed'), true);
  assert.equal(connectorForAccount('listed')?.id, 'beeper');
  assert.equal(connectorForAccount('partial')?.id, 'beeper');
  // Listed: an account it never saw is nobody's (new chats too).
  assert.equal(connectorForAccount('stranger'), undefined);
  assert.equal((await app.request('/api/accounts/stranger/new-chat')).status, 404);
  assert.notEqual((await app.request('/api/accounts/listed/new-chat')).status, 404);
  flushAccounts();
  assert.equal((JSON.parse(readFileSync(file(), 'utf8')) as { listed: boolean }).listed, true);
  resetAccountsForTests();
  assert.equal(accountsPending(), false, 'listed once: known across restarts, even while beeper-server is down');
  assert.equal(connectorForAccount('stranger'), undefined);
});

test('learnt from its chats too (a list page), kept on disk (0600) and read back after a restart', async () => {
  assert.equal(knownAccount('onchat'), false);
  assert.equal((await app.request('/api/chats')).status, 200);
  assert.equal(knownAccount('onchat'), true);
  flushAccounts();
  const saved = JSON.parse(readFileSync(file(), 'utf8')) as { v: number; accounts: string[] };
  assert.equal(saved.v, 1);
  assert.deepEqual(saved.accounts.sort(), ['listed', 'onchat', 'partial']);
  assert.equal(statSync(file()).mode & 0o777, 0o600);
  resetAccountsForTests();
  assert.equal(knownAccount('onchat'), true, 'read back');
  assert.equal(beeper()?.ownsAccount?.('onchat'), true);
});

test('an empty listing ends the first start too (and is saved); accounts learnt from chats only are not', () => {
  rmSync(file(), { force: true });
  resetAccountsForTests();
  noteChatAccounts([{ accountID: 'onchat-only' }]);
  flushAccounts();
  resetAccountsForTests();
  assert.equal(knownAccount('onchat-only'), true);
  assert.equal(accountsPending(), true, 'chats only: not all of them');
  noteAccountList([]);
  flushAccounts();
  resetAccountsForTests();
  assert.equal(accountsPending(), false);
  rmSync(file(), { force: true });
  resetAccountsForTests();
});

test('bounded: at most 1000, the oldest out first; junk ignored', () => {
  rmSync(file(), { force: true });
  resetAccountsForTests();
  noteAccounts([42, '', 'a b', 'x'.repeat(201), null]);
  assert.equal(knownAccount(''), false);
  noteAccounts(Array.from({ length: 1005 }, (_, i) => `acc${i}`));
  assert.equal(knownAccount('acc0'), false);
  assert.equal(knownAccount('acc4'), false);
  assert.equal(knownAccount('acc5'), true);
  assert.equal(knownAccount('acc1004'), true);
  flushAccounts();
  assert.equal((JSON.parse(readFileSync(file(), 'utf8')) as { accounts: string[] }).accounts.length, 1000);
});

test('long reaction keys: strict mxc:// URIs only (image reactions, up to 255 characters)', () => {
  const mxc = localMxc('a'.repeat(64));
  assert.ok(beeperReactionKey(mxc));
  assert.equal(beeper()?.longReactionKey, beeperReactionKey);
  for (const k of [`file:///data/${'a'.repeat(64)}`, `${mxc}?x=1`, `${mxc}/../x`, `mxc://${'a'.repeat(64)}`, `mxc://h/${'a'.repeat(260)}`, `https://example.org/${'a'.repeat(60)}`])
    assert.ok(!beeperReactionKey(k), k.slice(0, 30));
});
