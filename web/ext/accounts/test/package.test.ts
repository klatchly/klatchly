import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { dataPath } from '#core/config.js';
import { connector } from '#core/registry.js';
import { fakeSource, testPackage } from '../../../test/fakesource.js';
import { createApp } from '#core/app.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { mockUpstream } from '../../../test/mock.js';
import { load, plain } from '../../../test/sw-harness.js';
import { packages } from '../../packages.server.js';
import fr from '../locales/fr.js';
import { launch } from '../locales/launch.js';
import { networksSpace } from '../package.js';
import { accountSlug } from '../slug.js';
import { resetSinceForTests } from '../server/routes.js';

// The accounts package: always on when built in (no config), its space on both halves with the same URLs, its
// read-only API on a canned beeper-server through the core's chatSources (GET only: nothing else ever reaches
// upstream), its pages, notification targets and log paths (its catalogs and its two halves: ext/build.test.ts,
// test/boundary.test.ts). Neutral fake identities.

const WA_ID = 'local-whatsapp_ba_Q0FBQUFBQkFBQUFC';
const SLACK_ID = 'slackgo.T0001-U0001';
const PHONE = '+15550100000';
const ACCOUNTS = [
  {
    accountID: WA_ID,
    bridge: { id: 'local-whatsapp', type: 'whatsapp', provider: 'local' },
    network: 'WhatsApp',
    user: { id: 'wa-user-0001', phoneNumber: PHONE, fullName: 'Alex Sample', imgURL: 'file:///secret/avatar.jpg' },
    status: 'connected',
    capabilities: { reply: 1, edit: 1, reaction: 1, maxTextLength: 65536 },
  },
  { accountID: SLACK_ID, bridge: { id: 'slackgo', type: 'slackgo', provider: 'cloud' }, network: 'Slack', user: { id: 'U1', username: 'alex' }, status: 'reconnect_required', statusText: 'Sign in again' },
];
const chat = (id: string, accountID: string, over: Record<string, unknown> = {}) => ({
  id,
  accountID,
  network: 'x',
  title: `Chat ${id}`,
  type: 'single',
  participants: { items: [], hasMore: false, total: 0 },
  unreadCount: 0,
  lastActivity: '2026-01-01T00:00:00Z',
  preview: { text: 'message content never relayed' },
  ...over,
});
// Two pages of chats, to check the cursor is followed.
const PAGE1 = [chat('!a:x', WA_ID, { unreadCount: 2, lastActivity: '2026-01-03T00:00:00Z' }), chat('!b:x', SLACK_ID, { isArchived: true })];
const PAGE2 = [chat('!c:x', WA_ID, { type: 'group', isLowPriority: true })];

const up = mockUpstream({
  'GET /v1/accounts': () => [200, ACCOUNTS],
  'GET /v1/chats': (req) => {
    const u = new URL(req.url!, 'http://x');
    const ids = u.searchParams.getAll('accountIDs');
    if (ids.length) return [200, { items: [...PAGE1, ...PAGE2].filter((c) => ids.includes(c.accountID)), hasMore: false, oldestCursor: null, newestCursor: null }];
    return u.searchParams.get('cursor') === 'c1'
      ? [200, { items: PAGE2, hasMore: false, oldestCursor: null, newestCursor: null }]
      : [200, { items: PAGE1, hasMore: true, oldestCursor: 'c1', newestCursor: null }];
  },
});
/** What reached upstream, but the beeper connector's event socket (/v1/ws, opened at start). */
const reads = () => up.calls.filter((c) => !c.url.startsWith('/v1/ws'));
before(() => up.start());
after(() => up.stop());
beforeEach(() => {
  resetSinceForTests();
  up.calls.length = 0;
});

/** The whole build's app, started (the space gets its chatSources at start; a new start begins with no cache). */
// Its API reads a canned beeper-server through the build's beeper connector: those tests wait for a build with it.
const withBeeper = { skip: packages.some((p) => p.id === 'beeper') ? false : 'the build has no beeper package' };
const running: Registry[] = [];
async function started(list = packages) {
  const r = new Registry(list);
  const app = createApp(r);
  await r.start();
  running.push(r);
  return app;
}
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

const sid = store.mutate((s) => sessions.create(s));
const call = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { cookie: `sid=${sid}`, origin: 'http://localhost:3095', ...init.headers } });
const SPACE = { type: 'space', id: 'networks', path: '/networks', segment: '[A-Za-z0-9_-]{1,600}' };

/** What the server writes to stdout meanwhile (its logs). */
async function logsOf(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => (out.push(String(s)), true)) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = write;
  }
  return out.join('');
}

test('the build lists accounts, on without any config, with its space', withBeeper, async () => {
  const app = await started();
  const listed = ((await (await call(app, '/api/extensions')).json()) as { packages: { id: string }[] }).packages;
  assert.deepEqual(listed.find((p) => p.id === 'accounts'), { id: 'accounts', active: true, modules: [SPACE] });
  for (const p of ['/networks', `/networks/${accountSlug(WA_ID)}`, `/networks/${accountSlug(SLACK_ID)}`]) assert.equal((await call(app, p)).status, 200, p);
  for (const p of [`/networks/${SLACK_ID}`, '/networks/a/b', '/networksx']) assert.equal((await call(app, p)).status, 404, p);
});

test('a build without it: no pages, no API (the core alone keeps its own /api/accounts)', withBeeper, async () => {
  const app = await started(packages.filter((p) => p.id !== 'accounts'));
  assert.equal((await call(app, '/networks')).status, 404);
  assert.equal((await call(app, '/api/networks/overview')).status, 404);
  assert.equal((await call(app, '/api/accounts')).status, 200);
});

test('overview: the accounts cleaned, trouble first and counted; one upstream GET, no identity in the logs', withBeeper, async () => {
  const app = await started();
  let body: { accounts: Record<string, unknown>[]; trouble: number; sources: unknown[] } | undefined;
  const logs = await logsOf(async () => {
    const r = await call(app, '/api/networks/overview');
    assert.equal(r.status, 200);
    body = (await r.json()) as typeof body;
  });
  assert.equal(body!.trouble, 1);
  assert.deepEqual(body!.accounts.map((a) => [a.accountID, a.health, a.status]), [[SLACK_ID, 'trouble', 'reconnect_required'], [WA_ID, 'ok', 'connected']]);
  assert.deepEqual(body!.accounts[1]!.user, { fullName: 'Alex Sample', phoneNumber: PHONE });
  assert.equal(typeof body!.accounts[0]!.since, 'string');
  assert.deepEqual(body!.accounts.map((a) => a.source), ['beeper', 'beeper']);
  // The connectors that are on (only Beeper here), with their package's name.
  assert.deepEqual(body!.sources, [{ id: 'beeper', name: { en: 'Beeper (Desktop API)', fr: 'Beeper (API Desktop)' }, ok: true }]);
  const raw = JSON.stringify(body);
  for (const leak of ['imgURL', 'secret', 'capabilities', 'wa-user-0001']) assert.ok(!raw.includes(leak), leak);
  assert.deepEqual(reads().map((c) => `${c.method} ${c.url}`), ['GET /v1/accounts']);
  for (const leak of [PHONE, 'Alex', 'alex', WA_ID, SLACK_ID]) assert.ok(!logs.includes(leak), leak);
  // Cached for a moment: the badge and the space share it.
  await call(app, '/api/networks/overview');
  assert.equal(reads().length, 1);
});

test('stats: every page of the chat list, counted per account', withBeeper, async () => {
  const app = await started();
  const s = (await (await call(app, '/api/networks/stats')).json()) as { byAccount: Record<string, Record<string, unknown>>; complete: boolean };
  assert.ok(s.complete);
  assert.deepEqual(s.byAccount[WA_ID], { chats: 2, groups: 1, unreadChats: 1, unreadMessages: 2, lowPriority: 1, archived: 0, muted: 0, lastActivity: '2026-01-03T00:00:00.000Z' });
  assert.equal(s.byAccount[SLACK_ID]!.archived, 1);
  assert.equal(reads().length, 2);
  assert.match(reads()[1]!.url, /cursor=c1/);
});

test('one account: capabilities in plain terms, its recent chats without content; unknown or malformed ids refused', withBeeper, async () => {
  const app = await started();
  const r = await call(app, `/api/networks/account/${accountSlug(WA_ID)}`);
  assert.equal(r.status, 200);
  const d = (await r.json()) as { account: { accountID: string }; capabilities: { key: string }[]; recent: { id: string }[]; stats: { chats: number } };
  assert.equal(d.account.accountID, WA_ID);
  assert.deepEqual(d.capabilities.map((c) => c.key), ['reply', 'edit', 'reaction', 'maxTextLength']);
  assert.deepEqual(d.recent.map((c) => c.id), ['!a:x', '!c:x']);
  assert.equal(d.stats.chats, 2);
  assert.ok(!JSON.stringify(d).includes('message content'));
  assert.ok(reads().some((c) => c.url.includes(`accountIDs=${encodeURIComponent(WA_ID)}`)));
  assert.equal((await call(app, `/api/networks/account/${accountSlug('nobody')}`)).status, 404);
  assert.equal((await call(app, '/api/networks/account/_2E')).status, 400);
});

test('read-only: nothing but GET reaches upstream; writes to the API are not routes', withBeeper, async () => {
  const app = await started();
  for (const p of ['/api/networks/overview', '/api/networks/stats', `/api/networks/account/${accountSlug(WA_ID)}`]) {
    await call(app, p);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await call(app, p, { method, headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, `${method} ${p}`);
  }
  assert.ok(reads().length > 0);
  assert.deepEqual([...new Set(reads().map((c) => c.method))], ['GET']);
  assert.deepEqual([...new Set(reads().map((c) => c.url.split('?')[0]))].sort(), ['/v1/accounts', '/v1/chats']);
});

test('an upstream failure is a 502, nothing cached', withBeeper, async () => {
  const app = await started();
  await up.stop();
  try {
    assert.equal((await call(app, '/api/networks/overview')).status, 502);
  } finally {
    await up.start();
  }
  assert.equal((await call(app, '/api/networks/overview')).status, 200);
});

/** A second source next to Beeper: one account, connected, whose chat list fails. */
function otherSource() {
  const k = connector({
    ...fakeSource({}, 'other').module,
    owns: (id) => id.startsWith('o:'),
    ownsAccount: (id) => id === 'other',
    accounts: async () => [{ accountID: 'other', network: 'Other', status: 'connected' }],
    listChats: async () => Promise.reject(new Error('list down')),
  });
  return testPackage({ id: 'other', order: 20, modules: [k] });
}

test('a source that does not answer: the others listed, the badge counts it, its accounts say so (503), times kept', withBeeper, async () => {
  const app = await started([...packages, otherSource()]);
  const first = (await (await call(app, '/api/networks/overview')).json()) as { accounts: { accountID: string; since: string }[]; trouble: number };
  assert.equal(first.trouble, 1);
  const since = first.accounts.find((a) => a.accountID === WA_ID)!.since;
  assert.equal(statSync(dataPath('accounts.json')).mode & 0o777, 0o600);
  // Its chat list failing: the page shows without recent chats.
  const other = await call(app, `/api/networks/account/${accountSlug('other')}`);
  assert.equal(other.status, 200);
  assert.deepEqual(((await other.json()) as { recent: unknown[] }).recent, []);
  await up.stop();
  try {
    // The cache (15 s) is the started space's: a fresh one reads again.
    resetSinceForTests();
    const app2 = await started([...packages, otherSource()]);
    const r = await call(app2, '/api/networks/overview');
    assert.equal(r.status, 200);
    const o = (await r.json()) as { accounts: { accountID: string }[]; trouble: number; sources: { id: string; ok: boolean }[] };
    assert.deepEqual(o.sources.map((x) => [x.id, x.ok]), [['beeper', false], ['other', true]]);
    assert.deepEqual(o.accounts.map((a) => a.accountID), ['other']);
    // Beeper down counts as one thing to check.
    assert.equal(o.trouble, 1);
    const page = await call(app2, `/api/networks/account/${accountSlug(WA_ID)}`);
    assert.equal(page.status, 503);
    assert.deepEqual(await page.json(), { error: 'source_down' });
  } finally {
    await up.start();
  }
  resetSinceForTests();
  const app3 = await started([...packages, otherSource()]);
  const back = (await (await call(app3, '/api/networks/overview')).json()) as { accounts: { accountID: string; since: string }[] };
  assert.equal(back.accounts.find((a) => a.accountID === WA_ID)!.since, since, 'since kept while Beeper was down');
});

test('off: its API answers 404 and its cache goes; on again, it reads afresh', withBeeper, async () => {
  const r = new Registry(packages);
  const app = createApp(r);
  await r.start();
  running.push(r);
  assert.equal((await call(app, '/api/networks/overview')).status, 200);
  assert.equal((await r.setEnabled('accounts', false)).ok, true);
  assert.equal((await call(app, '/api/networks/overview')).status, 404);
  assert.equal((await call(app, '/networks')).status, 404);
  up.calls.length = 0;
  assert.equal((await r.setEnabled('accounts', true)).ok, true);
  assert.equal((await call(app, '/api/networks/overview')).status, 200);
  assert.deepEqual(reads().map((c) => `${c.method} ${c.url}`), ['GET /v1/accounts'], 'not the answer cached before it went off');
});

test('Settings → Extensions: its name, version, and that it reads the chat sources', withBeeper, async () => {
  const app = await started();
  const d = ((await (await call(app, '/api/extensions/details')).json()) as { packages: { id: string; version: string; chatSources?: boolean; about?: { name: Record<string, string> } }[] }).packages.find((p) => p.id === 'accounts')!;
  assert.equal(d.version, '1.2.0');
  assert.equal(d.chatSources, true);
  assert.equal(d.about!.name.fr, 'Comptes et réseaux');
});

test('notifications may open the space; log paths keep no account ids', withBeeper, async () => {
  const r = new Registry(packages);
  const sw = load({ links: r.pushLinksScript() });
  const slug = accountSlug(SLACK_ID);
  for (const url of ['/networks', `/networks/${slug}`, '/networks/a.b', '/networks/a/b']) {
    await sw.fire('notificationclick', { action: '', notification: { data: { url }, close: () => {} } });
  }
  assert.deepEqual(plain(sw.opened), ['/networks', `/networks/${slug}`, '/', '/']);
  assert.equal(r.logPath(`/api/networks/account/${slug}`), '/api/networks/account/:id');
  assert.equal(r.logPath('/api/networks/overview'), '/api/networks/overview');
});

test('catalogs: plurals and interpolation (their shape: ext/build.test.ts)', () => {
  assert.equal(fr.summary(2), '2 comptes');
  assert.equal(launch.en!.settings, 'Networks');
  assert.equal(launch.fr!.settings, 'Réseaux');
});


test('GET /networks/qr/:source: 404 for a source without a sign-in QR code; a bad id refused; never cached', withBeeper, async () => {
  const app = await started();
  const r = await call(app, '/api/networks/qr/beeper');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await call(app, '/api/networks/qr/BAD..id')).status, 404, 'not a source id: not routed');
});
