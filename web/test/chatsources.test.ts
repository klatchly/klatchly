import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { CHATS_MAX, type ChatSources } from '../server/chatsources.js';
import { ConnectorError, type Account } from '../server/connector.js';
import { augmentation, connector, provider, Registry, space, type ServerPackage } from '../server/registry.js';
import { fakeSource, testPackage } from './fakesource.js';

// ModuleContext.chatSources: what a space that shows the user's accounts reads of the connectors that are on.
// Handed to the spaces that declare it only (the registry refuses the flag elsewhere), projected to declared fields
// (no avatar, no user id, no message content), logged with the package's id and counts only, reading nothing once
// the package is off. Made-up connectors and packages, neutral fake names.

const PHONE = '+15550100000';

/** What the server writes to stdout meanwhile (its logs). */
async function logsOf<T>(run: () => Promise<T>): Promise<{ v: T; logs: string }> {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => (out.push(String(s)), true)) as typeof process.stdout.write;
  try {
    return { v: await run(), logs: out.join('') };
  } finally {
    process.stdout.write = write;
  }
}

function build() {
  const main = fakeSource({
    accounts: async () =>
      [
      {
        accountID: 'main-wa',
        network: 'WhatsApp',
        status: 'reconnect_required',
        statusText: 'Sign in again',
        bridge: { id: 'b1', type: 'whatsapp', provider: 'cloud', secret: 'x' },
        user: { id: 'user-0001', fullName: 'Alex Sample', phoneNumber: PHONE, imgURL: 'file:///avatar.jpg' },
        capabilities: { reply: 1 },
        extra: 'not declared',
      },
      { network: 'no id' },
      ] as unknown as Account[],
  });
  main.chats.set('c1', { id: 'c1', accountID: 'main-wa', title: 'Chat one', type: 'group', unreadCount: 2, isMuted: true, preview: { text: 'message content' }, participants: { items: [{ id: 'p', fullName: 'Someone' }] } });
  main.chats.set('c2', { id: 'c2', title: 'no account' });
  // A second source that reports its status apart from accounts() (e.g. one still loading).
  const other = connector({
    ...fakeSource({}, 'other').module,
    owns: (id) => id.startsWith('o:'),
    ownsAccount: (id) => id === 'other',
    accounts: async () => [],
    accountStatus: async () => [{ accountID: 'other', network: 'Other', status: 'connecting' }],
    unreadChats: async () => [{ id: 'o:1', accountID: 'other', isArchived: true }],
    listChats: async (q) => ({ items: [{ id: 'o:1', accountID: 'other', lastActivity: '2026-01-01T00:00:00Z' }, { id: 'o:2', accountID: 'stranger' }], hasMore: false, oldestCursor: null, newestCursor: null, q }),
  });
  const otherPkg = testPackage({ id: 'other', order: 20, about: { name: { en: 'Other', fr: 'Autre' }, description: { en: 'x', fr: 'x' } }, modules: [other] });
  return { main, otherPkg };
}

test('only a space that declares it gets chatSources; the registry refuses the flag on anything else', async () => {
  const { main } = build();
  const got: Record<string, boolean> = {};
  const r = new Registry([
    main.pkg,
    testPackage({
      id: 'board',
      modules: [
        space({ id: 'board', path: '/board', chatSources: true, start: (ctx) => void (got.declared = !!ctx.chatSources) }),
        space({ id: 'plain', path: '/plain', start: (ctx) => void (got.space = !!ctx.chatSources) }),
        augmentation({ id: 'a', scope: 'on-demand', start: (ctx) => void (got.augmentation = !!ctx.chatSources) }),
        provider({ id: 'p', status: () => ({ ready: true }), start: (ctx) => void (got.provider = !!ctx.chatSources) }),
      ],
    }),
  ]);
  await r.start();
  assert.deepEqual(got, { declared: true, space: false, augmentation: false, provider: false });
  // Settings → Extensions says so.
  const d = new Map(r.details().packages.map((p) => [p.id, p]));
  assert.equal(d.get('board')!.chatSources, true);
  assert.ok(!('chatSources' in d.get('fake')!));
  await r.stop();
  for (const m of [
    { type: 'augmentation', id: 'x', scope: 'on-demand', chatSources: true },
    { type: 'provider', id: 'x', status: () => ({ ready: true }), chatSources: true },
    { type: 'space', id: 'x', path: '/x', chatSources: 'yes' },
  ]) {
    assert.throws(() => new Registry([main.pkg, testPackage({ id: 'x', modules: [m as unknown as ServerPackage['modules'][number]] })]), /chatSources is for spaces only/, m.type);
  }
});

async function started(packages: ServerPackage[]): Promise<{ r: Registry; cs: ChatSources }> {
  let cs: ChatSources | undefined;
  const r = new Registry([...packages, testPackage({ id: 'board', modules: [space({ id: 'board', path: '/board', chatSources: true, start: (ctx) => void (cs = ctx.chatSources) })] })]);
  createApp(r);
  await r.start();
  return { r, cs: cs! };
}

test("accounts: every connector's, with the status it reports, projected to the declared fields; logged without names", async () => {
  const { main, otherPkg } = build();
  const { r, cs } = await started([main.pkg, otherPkg]);
  const { v, logs } = await logsOf(() => cs.accounts());
  assert.deepEqual(v.accounts, [
    {
      source: 'fake',
      accountID: 'main-wa',
      network: 'WhatsApp',
      status: 'reconnect_required',
      statusText: 'Sign in again',
      bridge: { type: 'whatsapp', provider: 'cloud' },
      user: { fullName: 'Alex Sample', phoneNumber: PHONE },
      capabilities: { reply: 1 },
    },
    { source: 'other', accountID: 'other', network: 'Other', status: 'connecting', user: {} },
  ]);
  assert.deepEqual(v.sources, [{ id: 'fake', ok: true }, { id: 'other', name: { en: 'Other', fr: 'Autre' }, ok: true }]);
  assert.match(logs, /chatsources accounts pkg=board count=2/);
  for (const leak of [PHONE, 'Alex', 'main-wa', 'user-0001']) assert.ok(!logs.includes(leak), leak);
  await r.stop();
});

test('chats: every chat of every source, flags and counts only (no preview, no participants)', async () => {
  const { main, otherPkg } = build();
  const { r, cs } = await started([main.pkg, otherPkg]);
  const { chats, complete, sources } = await cs.chats();
  assert.deepEqual(chats, [
    { id: 'c1', accountID: 'main-wa', title: 'Chat one', type: 'group', unreadCount: 2, isMuted: true },
    { id: 'o:1', accountID: 'other', isArchived: true },
  ]);
  assert.equal(complete, true);
  assert.equal(sources.length, 2);
  assert.ok(!JSON.stringify(chats).includes('message content') && !JSON.stringify(chats).includes('Someone'));
  await r.stop();
});

test('chats: a source with CHATS_MAX chats or more makes the figures lower bounds', async () => {
  const many = fakeSource({ unreadChats: async () => Array.from({ length: CHATS_MAX + 3 }, (_, i) => ({ id: `c${i}`, accountID: 'a' })) });
  const { r, cs } = await started([many.pkg]);
  const got = await cs.chats();
  assert.equal(got.chats.length, CHATS_MAX);
  assert.equal(got.complete, false);
  await r.stop();
});

test("recent chats: the account's connector's list, filtered to that account, bounded", async () => {
  const { main, otherPkg } = build();
  const { r, cs } = await started([main.pkg, otherPkg]);
  assert.deepEqual(await cs.recentChats('other', 500), [{ id: 'o:1', accountID: 'other', lastActivity: '2026-01-01T00:00:00Z' }]);
  // The legacy catch-all (no ownsAccount) answers for accounts no other claims.
  assert.deepEqual((await cs.recentChats('main-wa', 12)).map((c) => c.id), ['c1']);
  await r.stop();
});

test('recent chats: newest activity first, then cut, whatever order and length the connector gives (pinned first, all at once)', async () => {
  const at = (h: number) => `2026-01-01T${String(h).padStart(2, '0')}:00:00Z`;
  const all = fakeSource({
    listChats: async () => ({
      items: [
        { id: 'pinned-old', accountID: 'fake', isPinned: true, lastActivity: at(1) },
        { id: 'mid', accountID: 'fake', lastActivity: at(5) },
        { id: 'new', accountID: 'fake', lastActivity: at(9) },
        { id: 'never', accountID: 'fake' },
        { id: 'late', accountID: 'fake', lastActivity: at(7) },
      ],
      hasMore: false,
      oldestCursor: null,
      newestCursor: null,
    }),
  });
  const { r, cs } = await started([all.pkg]);
  assert.deepEqual((await cs.recentChats('fake', 3)).map((c) => c.id), ['new', 'late', 'mid']);
  assert.deepEqual((await cs.recentChats('fake', 50)).map((c) => c.id), ['new', 'late', 'mid', 'pinned-old', 'never']);
  await r.stop();
});

test('a source that fails is reported and left out; all failing, the error goes on (its connector maps it)', async () => {
  const { main } = build();
  const broken = connector({ ...fakeSource({}, 'broken').module, owns: (id) => id.startsWith('b:'), ownsAccount: (id) => id === 'broken', accounts: async () => Promise.reject(new Error('down')), unreadChats: async () => Promise.reject(new Error('down')) });
  const one = await started([main.pkg, testPackage({ id: 'broken', order: 20, modules: [broken] })]);
  const { v, logs } = await logsOf(() => one.cs.accounts());
  assert.deepEqual(v.sources.map((s) => [s.id, s.ok]), [['fake', true], ['broken', false]]);
  assert.equal(v.accounts.length, 1);
  assert.match(logs, /chatsources accounts failed id=broken status=502/);
  assert.equal((await one.cs.chats()).sources.find((s) => s.id === 'broken')!.ok, false);
  await one.r.stop();
  const alone = fakeSource({ accounts: async () => Promise.reject(new ConnectorError(504, 'timeout')) });
  const all = await started([alone.pkg]);
  await assert.rejects(all.cs.accounts(), (e) => e instanceof ConnectorError && e.status === 504);
  await all.r.stop();
});

test('once its package is off, it reads nothing; a connector that is off is not asked', async () => {
  const { main, otherPkg } = build();
  const { r, cs } = await started([main.pkg, otherPkg]);
  assert.equal((await r.setEnabled('other', false)).ok, true);
  assert.deepEqual((await cs.accounts()).sources.map((s) => s.id), ['fake']);
  assert.deepEqual(await cs.recentChats('other', 5), []);
  assert.equal((await r.setEnabled('board', false)).ok, true);
  assert.deepEqual(await cs.accounts(), { accounts: [], sources: [] });
  assert.deepEqual(await cs.chats(), { chats: [], complete: true, sources: [] });
  assert.deepEqual(await cs.recentChats('main-wa', 5), []);
  await r.stop();
});

test('login QR: a connector that has one says so; its answer is checked (known state, PNG only while waiting)', async () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const { main, otherPkg } = build();
  let answer: unknown = { status: 'waiting', image: PNG, token: 'not passed on' };
  main.module.loginQR = async () => answer as never;
  const { r, cs } = await started([main.pkg, otherPkg]);
  const { v } = await logsOf(() => cs.accounts());
  assert.deepEqual(v.sources.map((x) => [x.id, !!x.qr]), [['fake', true], ['other', false]]);
  assert.deepEqual(await cs.loginQR('fake'), { status: 'waiting', image: PNG });
  assert.equal(await cs.loginQR('other'), null, 'it has none');
  assert.equal(await cs.loginQR('nobody'), null);
  answer = { status: 'logged_in', image: PNG };
  assert.deepEqual(await cs.loginQR('fake'), { status: 'logged_in' }, 'a picture only while it waits');
  answer = { status: 'waiting', image: '<svg/>' };
  assert.deepEqual(await cs.loginQR('fake'), { status: 'waiting' }, 'not a PNG');
  answer = { status: 'weird' };
  assert.deepEqual(await cs.loginQR('fake'), { status: 'none' });
  await r.stop();
});
