import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createApp } from '../server/app.js';
import { badgeCount } from '../server/badgecount.js';
import { onBrowserFrame } from '../server/broadcast.js';
import { emitChatEvent } from '../server/chatactor.js';
import { config } from '../server/config.js';
import { sessions, store, type Env } from '../server/context.js';
import { EXTENSION_API } from '../server/extension.js';
import { augmentation, provider, Registry, space } from '../server/registry.js';
import { fakeSource, testPackage } from './fakesource.js';

// Packages turned off and on while the app runs (Settings → Extensions, registry.setEnabled, PUT
// /api/extensions/<id>), their versions and ranges, `enhances`, and the declared order. Made-up packages only (the
// whole build: ext/build.test.ts).

const sid = store.mutate((s) => sessions.create(s));
const fake = fakeSource();
const call = (app: Hono<Env>, path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { cookie: `sid=${sid}`, ...(init.headers ?? {}) } });
const put = (app: Hono<Env>, id: string, body: unknown, headers: Record<string, string> = {}) =>
  call(app, `/api/extensions/${id}`, { method: 'PUT', headers: { origin: config().origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const reasons = (r: Registry) => Object.fromEntries(r.describe().packages.map((p) => [p.id, p.active ? 'on' : p.reason]));
const tmp = () => mkdtempSync(join(tmpdir(), 'klatchly-toggles-'));

/** Records each module's start and stop. */
function recorder() {
  const order: string[] = [];
  const mod = (name: string) => ({ start: () => void order.push(`start ${name}`), stop: () => void order.push(`stop ${name}`) });
  return { order, mod };
}

test('versions: a package is off when the extension API or a version it requires does not match; the rest starts', async () => {
  const r = new Registry([
    fake.pkg,
    testPackage({ id: 'llm', version: '1.0.0', modules: [provider({ id: 'llm', status: () => ({ ready: true }) })] }),
    testPackage({ id: 'newer', requires: { llm: '^1.1' }, modules: [] }),
    testPackage({ id: 'future', klatchly: '^3', modules: [] }),
    testPackage({ id: 'later', requires: { future: '*' }, modules: [] }),
    testPackage({ id: 'fine', requires: { llm: '^1.0 || ^2' }, modules: [] }),
  ]);
  assert.deepEqual(reasons(r), {
    fake: 'on',
    fine: 'on',
    future: `requires extension API ^3 (present ${EXTENSION_API})`,
    later: 'requires future (off)',
    llm: 'on',
    newer: 'requires llm ^1.1 (present 1.0.0)',
  });
  const d = new Map(r.details().packages.map((p) => [p.id, p]));
  assert.deepEqual(d.get('newer')!.cause, { kind: 'requires', id: 'llm', range: '^1.1', present: '1.0.0', state: 'version' });
  assert.deepEqual(d.get('newer')!.requires, [{ id: 'llm', range: '^1.1', present: '1.0.0', ok: false }]);
  assert.deepEqual(d.get('future')!.cause, { kind: 'api', range: '^3', present: EXTENSION_API });
  assert.equal(d.get('future')!.apiOk, false);
  assert.equal(d.get('newer')!.canEnable, false);
  assert.equal(d.get('later')!.canEnable, false, 'what it requires cannot run');
  await r.start();
  assert.ok(r.isActive('llm') && r.isActive('fine'));
  await r.stop();
});

test('a malformed version or range is a programming error', () => {
  for (const over of [{ version: '1.0' }, { version: 'x' }, { klatchly: 'soon' }, { requires: { llm: 'latest' } }, { enhances: { llm: '>>1' } }, { requires: { Bad: '1' } }, { order: 1.5 }]) {
    assert.throws(() => new Registry([testPackage({ id: 'a', modules: [], ...over } as never)]), Error, JSON.stringify(over));
  }
});

test('enhances: used when on at a matching version, never a reason to be off; started before', async () => {
  const { order, mod } = recorder();
  const seen: Record<string, unknown> = {};
  const helper = (env: Record<string, string>, version = '1.0.0') =>
    testPackage({ id: 'helper', version, config: ['KLATCHLY_TEST_HELPER'], modules: [provider({ id: 'helper', ...mod('helper'), status: () => ({ ready: true, detail: 'helper' }) })] });
  const user = testPackage({
    id: 'user',
    order: 1,
    enhances: { helper: '^1.0' },
    modules: [augmentation({ id: 'user', scope: 'on-demand', ...mod('user'), start: (ctx) => void (order.push('start user'), (seen.user = ctx.provider('helper')?.status().detail ?? null)) })],
  });
  // On, matching: its provider is there, and it starts first though listed later and ordered after.
  let r = new Registry([fake.pkg, user, helper({})], { KLATCHLY_TEST_HELPER: '1' });
  await r.start();
  assert.deepEqual(order, ['start helper', 'start user']);
  assert.equal(seen.user, 'helper');
  assert.deepEqual(r.details().packages.find((p) => p.id === 'user')!.enhances, [{ id: 'helper', range: '^1.0', present: '1.0.0', ok: true }]);
  assert.deepEqual(r.details().packages.find((p) => p.id === 'helper')!.enhancedBy, ['user']);
  // Turning the enhanced one off does not take the other along.
  assert.equal((await r.setEnabled('helper', false)).ok, true);
  assert.ok(r.isActive('user'));
  await r.stop();
  // Off (unconfigured), or another major: the package is on all the same, without it.
  for (const r2 of [new Registry([fake.pkg, user, helper({})], {}), new Registry([fake.pkg, user, helper({}, '2.0.0')], { KLATCHLY_TEST_HELPER: '1' })]) {
    r = r2;
    await r.start();
    assert.ok(r.isActive('user'));
    assert.equal(seen.user, null);
    await r.stop();
  }
});

test('the declared order decides, then the id; the list order does not', () => {
  const p = (id: string, order?: number) => testPackage({ id, ...(order === undefined ? {} : { order }), modules: [] });
  const list = [p('zz'), p('b', 5), p('a', 5), p('c', 1)];
  for (const l of [list, [...list].reverse()]) assert.deepEqual(new Registry(l).describe().packages.map((x) => x.id), ['c', 'a', 'b', 'zz']);
});

test('turned off while the app runs: 404 at once, dependants first, links and frames; on again, in order; kept on disk', async () => {
  const dir = tmp();
  const stateFile = join(dir, 'extensions.json');
  const { order, mod } = recorder();
  const frames: string[] = [];
  const offFrames = onBrowserFrame((f) => void frames.push(f.type));
  const build = () => [
    fake.pkg,
    testPackage({ id: 'base', modules: [provider({ id: 'base', ...mod('base'), status: () => ({ ready: true }) })] }),
    testPackage({
      id: 'room',
      requires: { base: '^1.0' },
      modules: [space({ id: 'room', path: '/room', segment: '[a-z]{2}', ...mod('room'), routes: new Hono<Env>().get('/ping', (c) => c.json({ pong: true })) })],
    }),
    testPackage({ id: 'aside', modules: [augmentation({ id: 'aside', scope: 'on-demand', ...mod('aside') })] }),
  ];
  const r = new Registry(build(), process.env, { stateFile });
  const app = createApp(r);
  await r.start();
  // Providers first, then the rest in dependency order (aside before room: the id breaks the tie).
  assert.deepEqual(order, ['start base', 'start aside', 'start room']);
  order.length = 0;
  assert.equal((await call(app, '/api/room/ping')).status, 200);
  assert.match(await (await call(app, '/push-links.js')).text(), /"path":"\/room"/);

  // What would go with it, and that it may go.
  const d = r.details().packages.find((p) => p.id === 'base')!;
  assert.deepEqual([d.dependants, d.requiredBy, d.canDisable], [['room'], ['room'], true]);

  const res = await put(app, 'base', { enabled: false });
  assert.equal(res.status, 200);
  const details = (await res.json()) as { packages: { id: string; state: string }[] };
  assert.deepEqual(details.packages.map((p) => [p.id, p.state]), [['fake', 'on'], ['aside', 'on'], ['base', 'disabled'], ['room', 'disabled']]);
  assert.deepEqual(order, ['stop room', 'stop base'], 'dependants first');
  assert.deepEqual(reasons(r), { fake: 'on', aside: 'on', base: 'disabled in settings', room: 'disabled in settings' });
  assert.equal((await call(app, '/api/room/ping')).status, 404);
  assert.equal((await call(app, '/room/ab')).status, 404);
  assert.match(await (await call(app, '/push-links.js')).text(), /= \[\];/);
  assert.ok(frames.includes('extensions'), 'the browsers are told to ask again');
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { disabled: ['base', 'room'] });

  // Turned on: refused while what it requires is off, unless asked to take it along.
  order.length = 0;
  const refused = await put(app, 'room', { enabled: true });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'requires_disabled', needs: ['base'] });
  assert.deepEqual(r.details().packages.find((p) => p.id === 'room')!.needs, ['base']);
  assert.equal((await put(app, 'room', { enabled: true, withRequired: true })).status, 200);
  assert.deepEqual(order, ['start base', 'start room']);
  assert.equal((await call(app, '/api/room/ping')).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { disabled: [] });

  // Kept: a new start (another process) reads the choices.
  await r.setEnabled('aside', false);
  const again = new Registry(build(), process.env, { stateFile });
  assert.deepEqual(reasons(again), { fake: 'on', aside: 'disabled in settings', base: 'on', room: 'on' });
  await r.stop();
  offFrames();
});

test('what cannot be turned off or on: the last connector on, a package that cannot run, an unknown one', async () => {
  const owned = fakeSource({ owns: (id) => id.startsWith('o:') }, 'owned');
  const r = new Registry([fake.pkg, owned.pkg, testPackage({ id: 'unset', config: ['KLATCHLY_TEST_UNSET'], modules: [] }), testPackage({ id: 'needs-unset', requires: { unset: '^1.0' }, modules: [] })], {});
  const app = createApp(r);
  await r.start();
  const d = new Map(r.details().packages.map((p) => [p.id, p]));
  // No connector is privileged (1.25): the legacy one without owns may go while another is on.
  assert.deepEqual([d.get('fake')!.canDisable, d.get('fake')!.keep], [true, undefined]);
  assert.equal(d.get('owned')!.canDisable, true);
  assert.deepEqual([d.get('unset')!.state, d.get('unset')!.canEnable, d.get('unset')!.cause], ['off', false, { kind: 'config', missing: ['KLATCHLY_TEST_UNSET'] }]);
  assert.equal(d.get('needs-unset')!.canEnable, false);
  for (const [id, body, status, error] of [
    ['unset', { enabled: true }, 409, 'cannot_run'],
    ['needs-unset', { enabled: true }, 409, 'cannot_run'],
    ['ghost', { enabled: false }, 404, 'not_found'],
  ] as const) {
    const res = await put(app, id, body);
    assert.equal(res.status, status, id);
    assert.equal(((await res.json()) as { error: string }).error, error, id);
  }
  assert.ok(r.isActive('fake'));
  // fake off: allowed; owned is then the last connector on and cannot go.
  assert.equal((await put(app, 'fake', { enabled: false })).status, 200);
  assert.ok(!r.isActive('fake'));
  const last = await put(app, 'owned', { enabled: false });
  assert.equal(last.status, 409);
  assert.equal(((await last.json()) as { error: string }).error, 'required');
  assert.equal(new Map(r.details().packages.map((p) => [p.id, p])).get('owned')!.keep, 'no-connector');
  assert.equal((await put(app, 'fake', { enabled: true })).status, 200);
  // A build whose only connector it is: the last one cannot go; with another one on, either may.
  assert.equal(new Registry([owned.pkg]).details().packages[0]!.keep, 'no-connector');
  assert.equal(new Registry([fake.pkg, owned.pkg], {}, {}).details().packages[0]!.keep, undefined);
  assert.equal(new Registry([fake.pkg]).details().packages[0]!.keep, 'no-connector');
  // A choice the app cannot run with, written by hand: not kept.
  const dir = tmp();
  writeFileSync(join(dir, 'extensions.json'), '{"disabled":["fake","owned"]}');
  assert.deepEqual(reasons(new Registry([fake.pkg, owned.pkg], {}, { stateFile: join(dir, 'extensions.json') })), { fake: 'on', owned: 'disabled in settings' });
  writeFileSync(join(dir, 'bad.json'), 'not json');
  assert.deepEqual(reasons(new Registry([fake.pkg, owned.pkg], {}, { stateFile: join(dir, 'bad.json') })), { fake: 'on', owned: 'on' });
  await r.stop();
});

test('PUT /api/extensions/<id>: behind the session and the origin check, a strict body', async () => {
  const r = new Registry([fake.pkg, testPackage({ id: 'aside', modules: [] })]);
  const app = createApp(r);
  assert.equal((await app.request('/api/extensions/aside', { method: 'PUT', headers: { origin: config().origin, 'content-type': 'application/json' }, body: '{"enabled":false}' })).status, 302, 'no session');
  assert.equal((await put(app, 'aside', { enabled: false }, { origin: 'https://evil.example' })).status, 400, 'another origin');
  for (const body of [{}, { enabled: 'no' }, { enabled: true, withRequired: 1 }, []]) assert.equal((await put(app, 'aside', body)).status, 400, JSON.stringify(body));
  assert.equal((await put(app, 'Aside', { enabled: false })).status, 404, 'not an id');
  assert.ok(r.isActive('aside'));
  assert.equal((await call(app, '/api/extensions/details')).status, 200);
  assert.equal((await app.request('/api/extensions/details')).status, 302);
});

test("a failed start: off with its reason; turned on again, it is tried again", async () => {
  let fail = true;
  const r = new Registry([fake.pkg, testPackage({ id: 'flaky', modules: [provider({ id: 'flaky', start: () => (fail ? Promise.reject(new Error('x')) : undefined), status: () => ({ ready: true }) })] })]);
  await r.start();
  const d = r.details().packages.find((p) => p.id === 'flaky')!;
  assert.deepEqual([d.state, d.cause, d.canEnable], ['off', { kind: 'start', module: 'flaky' }, true]);
  fail = false;
  assert.equal((await r.setEnabled('flaky', true)).ok, true);
  assert.ok(r.isActive('flaky'));
  await r.stop();
});

test("the event stream stops with its package and comes back with it; nothing is delivered in between", async () => {
  const got: string[] = [];
  const r = new Registry([fake.pkg, testPackage({ id: 'watch', modules: [augmentation({ id: 'watch', scope: 'events', onEvent: (ev) => void got.push(ev.entries[0]!.id) })] })]);
  await r.start();
  const send = (id: string) => emitChatEvent({ type: 'message.upserted', entries: [{ id, chatID: 'c1', text: 'x' }] }, 'fake');
  send('m1');
  await r.setEnabled('watch', false);
  send('m2');
  for (let i = 0; i < 3; i++) {
    await r.setEnabled('watch', true);
    await r.setEnabled('watch', false);
  }
  await r.setEnabled('watch', true);
  send('m3');
  // Once each: no subscription left over from the earlier runs.
  assert.deepEqual(got, ['m1', 'm3']);
  await r.stop();
});

test("a connector turned off: its chats belong to nobody, its unread counts leave the badge, its feed is dead", async () => {
  let feed: import('../server/connector.js').SourceFeed | undefined;
  const owned = fakeSource({ owns: (id) => id.startsWith('o:'), start: (ctx) => void (feed = ctx.feed), unreadChats: async () => [{ id: 'o:1', unreadCount: 7 }] }, 'owned');
  owned.chats.set('o:1', { id: 'o:1', title: 'O' });
  const r = new Registry([fake.pkg, owned.pkg]);
  const app = createApp(r);
  await r.start();
  const before = badgeCount();
  feed!.event({ type: 'ready' });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(badgeCount(), before + 7);
  assert.equal((await call(app, '/api/chats/o%3A1')).status, 200);
  await r.setEnabled('owned', false);
  assert.equal(badgeCount(), before, 'its chats left the count');
  assert.equal((await call(app, '/api/chats/o%3A1')).status, 404);
  const old = feed!;
  old.event({ type: 'ready' });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(badgeCount(), before, 'the old feed is dead');
  await r.setEnabled('owned', true);
  assert.notEqual(feed, old, 'a new feed on the new start');
  await r.stop();
});

test("a provider's listener closes when its package goes off, its address stays refused by the app; on again, it listens", async () => {
  const main: Server = createServer((_, res) => res.end('app'));
  await new Promise<void>((ok) => main.listen(0, '127.0.0.1', ok));
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
  const get = (p: number) =>
    new Promise<string>((ok) => {
      const req = httpGet({ host: '127.0.0.1', port: p, path: '/', agent: false }, (res) => {
        let b = '';
        res.on('data', (d: Buffer) => (b += d));
        res.on('end', () => ok(b));
      });
      req.on('error', (e) => ok(`error ${(e as NodeJS.ErrnoException).code ?? ''}`));
    });
  let starts = 0;
  const r = new Registry([
    fake.pkg,
    testPackage({
      id: 'callback',
      modules: [provider({ id: 'callback', reserves: () => ['127.0.0.1'], status: () => ({ ready: true }), start: async (ctx) => void (starts++, await ctx.listen!('127.0.0.1', port, (_, res) => res.end('provider'))) })],
    }),
  ]);
  await r.start({ server: main });
  assert.equal(await get(port), 'provider');
  for (let i = 0; i < 2; i++) {
    await r.setEnabled('callback', false);
    assert.match(await get(port), /^error ECONNREFUSED$/, 'closed');
    assert.match(await get((main.address() as AddressInfo).port), /^error |^$/, 'the app is still not served on that address');
    await r.setEnabled('callback', true);
    assert.equal(await get(port), 'provider', 'listening again');
  }
  assert.equal(starts, 3);
  await r.stop();
  await new Promise<void>((ok) => main.close(() => ok()));
});

test('PUT /api/extensions/<id> is rate-limited', async () => {
  const app = createApp(new Registry([fake.pkg, testPackage({ id: 'aside', modules: [] })]));
  let status = 0;
  for (let i = 0; i < 80 && status !== 429; i++) status = (await put(app, 'aside', { enabled: i % 2 === 1 })).status;
  assert.equal(status, 429);
});
