import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { onBrowserFrame } from '../server/broadcast.js';
import { emitChatEvent } from '../server/chatactor.js';
import { listenProblem } from '../server/listeners.js';
import { createApp } from '../server/app.js';
import { config, dataPath } from '../server/config.js';
import { sessions, store, type Env } from '../server/context.js';
import { activeSpaces, isSpaceLink, moduleOn, packageOn, segmentProblem, spacePlace } from '../server/extension.js';
import { augmentation, provider, Registry, space, type ServerPackage } from '../server/registry.js';
import { fakeSource, testPackage as definePackage } from './fakesource.js';

// The package registry (server/registry.ts), and the app built from it. The core suite never imports ext/
// (boundary.test.ts): the app here is the core alone, or the core with made-up packages.

const sid = store.mutate((s) => sessions.create(s));
// The chat source every started registry needs (the registry refuses to start without a connector).
const fake = fakeSource();
const call = (app: Hono<Env>, path: string, signedIn = true) => app.request(path, { headers: signedIn ? { cookie: `sid=${sid}` } : {} });

const demoSpace = { id: 'demo', path: '/demo', segment: '[a-z]{3}' };
const demo = (over: Partial<ServerPackage> = {}, routes = new Hono<Env>().get('/ping', (c) => c.json({ pong: true }))) =>
  definePackage({
    id: 'demo',
    config: ['KLATCHLY_TEST_DEMO'],
    modules: [space({ ...demoSpace, routes, logPath: (p) => p.replace(/^\/api\/demo\/[a-z]+/, '/api/demo/:x') })],
    ...over,
  });
const demoModules = [{ type: 'space', id: 'demo', path: '/demo', segment: '[a-z]{3}' }];

test('core alone: no package, no space, nothing extra mounted', async () => {
  for (const app of [createApp(), createApp(new Registry([]))]) {
    assert.deepEqual(await (await call(app, '/api/extensions')).json(), { packages: [] });
    assert.equal((await call(app, '/api/extensions', false)).status, 302);
    // No page or API of any package, those that were the core's before them included (the chat agent).
    for (const p of ['/example', '/demo', '/demo/abc', '/api/example/hello', '/api/chatagent/agents']) assert.equal((await call(app, p)).status, 404, p);
    const r = await call(app, '/api/demo/overview');
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'not_found' });
    // The worker's list of space targets is there, empty, and needs no session (it installs before sign-in).
    const links = await call(app, '/push-links.js', false);
    assert.equal(links.status, 200);
    assert.match(links.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.match(await links.text(), /self\.pushLinks = \[\];/);
    // Settings and its pages (a core page, a package's page under its own /settings/ext/<id>/, a place inside one), the shell
    // any other /settings/… is no page.
    for (const p of ['/settings', '/settings/notifications', '/settings/ext/writing/ai', '/settings/ext/writing/ai/x']) assert.equal((await call(app, p)).status, 200, p);
    for (const p of ['/settings/', '/settings/ext/writing', '/settings/ext/writing/ai/x.y', '/settings/ext/writing/ai/x/y', '/settings/Notifications', '/settings/nope', '/settings/apps']) assert.equal((await call(app, p)).status, 404, p);
  }
});

test('a package that is on: its routes behind the session, its pages, its links, its status', async () => {
  const app = createApp(new Registry([demo()], { KLATCHLY_TEST_DEMO: '1' }));
  assert.deepEqual(await (await call(app, '/api/extensions')).json(), { packages: [{ id: 'demo', active: true, modules: demoModules }] });
  assert.deepEqual(await (await call(app, '/api/demo/ping')).json(), { pong: true });
  assert.equal((await call(app, '/api/demo/ping', false)).status, 302);
  for (const p of ['/demo', '/demo/abc']) assert.equal((await call(app, p)).status, 200, p);
  for (const p of ['/demo/abcd', '/demo/abc/x', '/demox', '/demo/', '//demo']) assert.equal((await call(app, p)).status, 404, p);
  // Signed out, a space's page is a 302 to / (only a space that declares signedOutPage opens the shell: bearer.test.ts).
  assert.equal((await call(app, '/demo', false)).status, 302);
  assert.equal((await call(app, '/demo/abcd', false)).status, 302);
  assert.ok((await (await call(app, '/push-links.js', false)).text()).includes(`self.pushLinks = ${JSON.stringify([{ path: '/demo', segment: '[a-z]{3}' }])};`));
});

test('a package left off: nothing mounted, and its status says why', async () => {
  const app = createApp(new Registry([demo()], {}));
  assert.deepEqual(await (await call(app, '/api/extensions')).json(), {
    packages: [{ id: 'demo', active: false, reason: 'missing config KLATCHLY_TEST_DEMO', modules: demoModules }],
  });
  assert.equal((await call(app, '/api/demo/ping')).status, 404);
  assert.equal((await call(app, '/demo')).status, 404);
  assert.match(await (await call(app, '/push-links.js', false)).text(), /\[\]/);
});

test('requires, config and checks decide what is on', () => {
  const env = { KLATCHLY_TEST_DEMO: '1', KLATCHLY_EMPTY: '' };
  const pkg = (id: string, over: Partial<ServerPackage> = {}): ServerPackage => definePackage({ id, modules: [], ...over });
  const r = new Registry(
    [
      pkg('needs-base', { requires: { 'base': '^1.0' } }),
      pkg('base'),
      pkg('needs-ghost', { requires: { 'ghost': '^1.0' } }),
      pkg('empty-var', { config: ['KLATCHLY_EMPTY', 'KLATCHLY_UNSET'] }),
      pkg('bad-check', { modules: [provider({ id: 'llm', check: () => 'no key file', status: () => ({ ready: false }) })] }),
      pkg('needs-bad', { requires: { 'bad-check': '^1.0' } }),
      pkg('loop-a', { requires: { 'loop-b': '^1.0' } }),
      pkg('loop-b', { requires: { 'loop-a': '^1.0' } }),
    ],
    env,
  );
  const st = Object.fromEntries(r.describe().packages.map((p) => [p.id, p.active ? 'on' : p.reason]));
  assert.deepEqual(st, {
    'needs-base': 'on',
    base: 'on',
    'needs-ghost': 'requires ghost (not installed)',
    'empty-var': 'missing config KLATCHLY_EMPTY, KLATCHLY_UNSET',
    'bad-check': 'llm: no key file',
    'needs-bad': 'requires bad-check (off)',
    'loop-a': 'requires loop-b (off)',
    'loop-b': 'requires loop-a (off)',
  });
  // Listed by declared order, then id (not the list's order).
  assert.deepEqual(r.describe().packages.map((p) => p.id).slice(0, 3), ['bad-check', 'base', 'empty-var']);
  assert.ok(r.isActive('base') && !r.isActive('bad-check') && !r.isActive('ghost'));
});

test('start: providers, then connectors, then the rest; stop in reverse; a failing start does not stop the others', async () => {
  const order: string[] = [];
  const mod = (name: string) => ({ start: () => void order.push(`start ${name}`), stop: () => void order.push(`stop ${name}`) });
  let seenProvider: unknown;
  const r = new Registry([fake.pkg, 
    definePackage({ id: 'ui', order: 1, requires: { llm: '^1.0' }, modules: [space({ id: 'ui', path: '/ui', ...mod('space'), start: (ctx) => void (order.push('start space'), (seenProvider = ctx.provider('llm')?.status())) })] }),
    definePackage({
      id: 'chats',
      order: 2,
      modules: [
        augmentation({ id: 'helper', scope: 'on-demand', ...mod('augmentation') }),
        { ...fakeSource({ id: 'src', ...mod('connector'), owns: () => false }, 'src').module },
        augmentation({ id: 'broken', scope: 'events', onEvent: () => {}, start: () => Promise.reject(new Error('boom')) }),
      ],
    }),
    definePackage({ id: 'llm', modules: [provider({ id: 'llm', ...mod('provider'), status: () => ({ ready: true }) })] }),
  ]);
  await r.start();
  // 'chats' fails at its third module: the two it started stop at once (last first), the other packages run on.
  assert.deepEqual(order, ['start provider', 'start connector', 'start space', 'start augmentation', 'stop augmentation', 'stop connector']);
  assert.deepEqual(seenProvider, { ready: true });
  assert.equal(r.describe().packages.find((p) => p.id === 'chats')!.reason, 'broken: start failed');
  order.length = 0;
  await r.stop();
  assert.deepEqual(order, ['stop space', 'stop provider']);
});

test('log paths: each active module removes its own ids', () => {
  assert.equal(new Registry([demo()], { KLATCHLY_TEST_DEMO: '1' }).logPath('/api/demo/abc/x'), '/api/demo/:x/x');
  assert.equal(new Registry([demo()], {}).logPath('/api/demo/abc/x'), '/api/demo/abc/x');
  assert.equal(new Registry([]).logPath('/api/chats'), '/api/chats');
});

test('a malformed list is a programming error', () => {
  const sp = (id: string, extra: object = {}) => definePackage({ id: 'a', modules: [space({ id, path: `/${id}`, ...extra })] });
  const bad: [string, ServerPackage[]][] = [
    ['bad id', [definePackage({ id: 'Demo', modules: [] })]],
    ['twice', [definePackage({ id: 'a', modules: [] }), definePackage({ id: 'a', modules: [] })]],
    ['bad config name', [definePackage({ id: 'a', config: ['lower'], modules: [] })]],
    // Core sections, pages and API prefixes are reserved.
    ...['chats', 'chat', 'lowpriority', 'archive', 'settings', 'api', 'extensions', 'media', 'push-links'].map((id): [string, ServerPackage[]] => [`reserved ${id}`, [sp(id)]]),
    ['reserved api id', [definePackage({ id: 'a', modules: [provider({ id: 'chats', routes: new Hono<Env>(), status: () => ({ ready: true }) })] })]],
    ['path is not /<id>', [definePackage({ id: 'a', modules: [space({ id: 'a', path: '/b' })] })]],
    ['same id twice', [demo(), demo({ id: 'other' })]],
    ['two modules on one /api/<id>', [definePackage({ id: 'a', modules: [space({ id: 'x', path: '/x' }), provider({ id: 'x', routes: new Hono<Env>(), status: () => ({ ready: true }) })] })]],
    // Extra mounts follow the same rules: no core path, no other module's, a valid id.
    ...['chats', 'extensions', 'Bad', 'x'].map((at): [string, ServerPackage[]] => [
      `mount ${at}`,
      [definePackage({ id: 'a', modules: [space({ id: 'x', path: '/x' }), augmentation({ id: 'y', scope: 'on-demand', mounts: { [at]: new Hono<Env>() } })] })],
    ]),
    // Free-form patterns are gone: a segment pattern cannot leave its segment, anchor, or close the core's group.
    ...['.*', '[^x]+', 'a/b', 'a\\/b', '^a', 'a$', 'a)|(.*', 'a)|(b', '(a', 'a\\d', ''].map((seg): [string, ServerPackage[]] => [`segment ${seg}`, [sp('a', { segment: seg })]]),
    // Former homes of a renamed space (1.18): plain homes, never the core's, its own, another space's or twice.
    ...['old', '/Old', '/chats', '/a', '/x/y', '//x'].map((f): [string, ServerPackage[]] => [`former ${f}`, [sp('a', { formerPaths: [f] })]]),
    ['former home of another space', [definePackage({ id: 'a', modules: [space({ id: 'a', path: '/a', formerPaths: ['/b'] })] }), definePackage({ id: 'b', modules: [space({ id: 'b', path: '/b' })] })]],
    ['former home twice', [definePackage({ id: 'a', modules: [space({ id: 'a', path: '/a', formerPaths: ['/old'] })] }), definePackage({ id: 'b', modules: [space({ id: 'b', path: '/b', formerPaths: ['/old'] })] })]],
  ];
  for (const [name, list] of bad) assert.throws(() => new Registry(list, {}), Error, name);
  assert.doesNotThrow(() => new Registry([sp('a', { formerPaths: ['/old'] })], {}));
  assert.equal(segmentProblem('[a-f0-9]{12}|machine'), null);
});

test('capability declarations (1.16): variables it declares, host names, * and data; shown in the details as declared', () => {
  const pkg = (over: Partial<ServerPackage>) => definePackage({ id: 'cap', optionalConfig: ['KLATCHLY_CAP_URL', 'KLATCHLY_CAP_KEY_FILE', 'KLATCHLY_CAP_LISTEN'], modules: [], ...over });
  const refused: [string, Partial<ServerPackage>, RegExp][] = [
    ['an undeclared variable', { network: ['KLATCHLY_OTHER_URL'] }, /network "KLATCHLY_OTHER_URL"/],
    ['a URL instead of a host', { network: ['https://api.example.com'] }, /network/],
    ['a bare word', { network: ['localhost'] }, /network/],
    ['a listener not in a variable', { listen: ['127.0.0.1:9000'] }, /listen/],
    ['a path written in place', { files: ['/etc/passwd'] }, /files/],
  ];
  for (const [name, over, re] of refused) assert.throws(() => new Registry([pkg(over)], {}), re, name);
  const r = new Registry([pkg({ network: ['KLATCHLY_CAP_URL', 'api.example.com', '*'], listen: ['KLATCHLY_CAP_LISTEN'], files: ['data', 'KLATCHLY_CAP_KEY_FILE'] }), demo({ config: [] })], {});
  const d = new Map(r.details().packages.map((p) => [p.id, p.capabilities]));
  assert.deepEqual(d.get('cap'), { network: ['KLATCHLY_CAP_URL', 'api.example.com', '*'], listen: ['KLATCHLY_CAP_LISTEN'], files: ['data', 'KLATCHLY_CAP_KEY_FILE'], spawns: false });
  // Nothing declared: nothing reached (the boundary test holds the line against its code).
  assert.deepEqual(d.get('demo'), { network: [], listen: [], files: [], spawns: false });
});

test('space URLs: the core builds the match; a segment never holds a slash', () => {
  const s = { id: 'demo', path: '/demo', segment: '[a-z]{3}|(x|y)z' };
  assert.deepEqual(spacePlace(s, '/demo'), { place: undefined });
  assert.deepEqual(spacePlace(s, '/demo/abc'), { place: 'abc' });
  assert.deepEqual(spacePlace(s, '/demo/xz'), { place: 'xz' });
  assert.deepEqual(spacePlace(s, '/demo/abcd'), { place: undefined });
  for (const p of ['/demo/', '/demo/a/b', '/demo/ab\\c', '/demox', '//demo', '/other']) assert.equal(spacePlace(s, p), null, p);
  assert.ok(isSpaceLink(s, '/demo') && isSpaceLink(s, '/demo/abc') && !isSpaceLink(s, '/demo/abcd'));
  assert.ok(!isSpaceLink({ id: 'home', path: '/home' }, '/home/x'));
});

test("the client's spaces are on only where the server has the same space on, with the same URLs", () => {
  const mine = [{ pkg: 'demo', space: demoSpace }, { pkg: 'other', space: { id: 'other', path: '/other' } }];
  const reply = (modules: object[], active = true) => ({ packages: [{ id: 'demo', active, modules } as never] });
  assert.deepEqual(activeSpaces(reply(demoModules), mine), [demoSpace]);
  assert.deepEqual(activeSpaces(reply(demoModules, false), mine), []);
  assert.deepEqual(activeSpaces(reply([{ ...demoModules[0], segment: '[a-z]{4}' }]), mine), []);
  assert.deepEqual(activeSpaces(reply([{ ...demoModules[0], path: '/x' }]), mine), []);
  assert.deepEqual(activeSpaces(undefined, mine), []);
});

test('package routes live under /api/<module id>, after the core: no shadowing, no global middleware', async () => {
  const sneaky = new Hono<Env>();
  sneaky.use('*', async (c) => c.json({ hijacked: true }));
  const app = createApp(new Registry([demo({}, sneaky)], { KLATCHLY_TEST_DEMO: '1' }));
  assert.deepEqual(await (await call(app, '/api/demo/anything')).json(), { hijacked: true });
  for (const p of ['/api/extensions', '/api/session']) assert.notDeepEqual(await (await call(app, p)).json(), { hijacked: true }, p);
  assert.deepEqual(await (await call(app, '/api/unknown')).json(), { error: 'not_found' });
});

test('a package whose start fails goes off: status, routes, pages, links, provider', async () => {
  const r = new Registry([fake.pkg, 
    definePackage({ id: 'llm', modules: [provider({ id: 'llm', start: () => Promise.reject(new Error('down')), status: () => ({ ready: false }) })] }),
    demo({ requires: { 'llm': '^1.0' } }),
  ], { KLATCHLY_TEST_DEMO: '1' });
  const app = createApp(r);
  assert.equal((await call(app, '/api/demo/ping')).status, 200);
  await r.start();
  const st = r.describe().packages;
  assert.deepEqual(st.filter((p) => p.id !== 'fake').map((p) => [p.id, p.active, p.reason]), [['demo', false, 'requires llm (off)'], ['llm', false, 'llm: start failed']]);
  assert.deepEqual(await (await call(app, '/api/demo/ping')).json(), { error: 'not_found' });
  assert.equal((await call(app, '/demo')).status, 404);
  assert.match(await (await call(app, '/push-links.js', false)).text(), /= \[\];/);
  assert.equal(r.modules('provider').length, 0);
});

test('stop waits for a start under way', async () => {
  const order: string[] = [];
  let release!: () => void;
  const r = new Registry([fake.pkg, 
    definePackage({ id: 'slow', modules: [provider({ id: 'slow', start: () => new Promise<void>((ok) => (release = () => (order.push('started'), ok()))), stop: () => void order.push('stopped'), status: () => ({ ready: true }) })] }),
  ]);
  void r.start();
  const stopping = r.stop();
  await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(order, []);
  release();
  await stopping;
  assert.deepEqual(order, ['started', 'stopped']);
});

test('mounts: a module answers on the extra /api/<key>/ it declares, only while its package is on', async () => {
  const legacy = new Hono<Env>().get('/', (c) => c.json({ root: true })).get('/x', (c) => c.json({ x: true }));
  const pkg = (env: Record<string, string>) =>
    new Registry([definePackage({ id: 'help', config: ['KLATCHLY_TEST_HELP'], modules: [augmentation({ id: 'help', scope: 'on-demand', mounts: { old: legacy } })] })], env);
  const on = createApp(pkg({ KLATCHLY_TEST_HELP: '1' }));
  assert.deepEqual(await (await call(on, '/api/old')).json(), { root: true });
  assert.deepEqual(await (await call(on, '/api/old/x')).json(), { x: true });
  assert.equal((await call(on, '/api/old/x', false)).status, 302, 'behind the session');
  assert.equal((await call(on, '/api/help/x')).status, 404, 'no routes under its id: none mounted there');
  const off = createApp(pkg({}));
  assert.equal((await call(off, '/api/old/x')).status, 404);
});

test("a module gets the providers of the packages it requires (and its own), not the others'", async () => {
  const seen: Record<string, unknown> = {};
  const prov = (id: string) => definePackage({ id, modules: [provider({ id, status: () => ({ ready: true, detail: id }) })] });
  const user = (id: string, requires: string[]) =>
    definePackage({
      id,
      requires: Object.fromEntries(requires.map((r) => [r, '^1.0'])),
      modules: [augmentation({ id, scope: 'on-demand', start: (ctx) => void (seen[id] = ['llm', 'other'].map((p) => ctx.provider(p)?.status().detail ?? null)) })],
    });
  const r = new Registry([fake.pkg, prov('llm'), prov('other'), user('needs-llm', ['llm']), user('needs-none', [])]);
  await r.start();
  assert.deepEqual(seen, { 'needs-llm': ['llm', null], 'needs-none': [null, null] });
});

test("the client's augmentations and sections follow the server's status of their package", () => {
  const reply = { packages: [{ id: 'writing', active: true, modules: [{ type: 'augmentation' as const, id: 'writing' }] }, { id: 'off', active: false, reason: 'x', modules: [{ type: 'augmentation' as const, id: 'off' }] }] };
  assert.ok(moduleOn(reply, 'writing', 'augmentation', 'writing'));
  assert.ok(!moduleOn(reply, 'writing', 'space', 'writing'), 'same id, other type');
  assert.ok(!moduleOn(reply, 'off', 'augmentation', 'off'));
  assert.ok(!moduleOn(undefined, 'writing', 'augmentation', 'writing'), 'nothing before the server answers');
  assert.ok(packageOn(reply, 'writing') && !packageOn(reply, 'off') && !packageOn(reply, 'ghost') && !packageOn(undefined, 'writing'));
});

test('the chat reader goes to augmentations only; info shows while the package is on', async () => {
  const got: Record<string, boolean> = {};
  const r = new Registry([fake.pkg, 
    definePackage({
      id: 'mixed',
      modules: [
        provider({ id: 'p', status: () => ({ ready: true }), start: (ctx) => void (got.provider = !!ctx.chats) }),
        augmentation({ id: 'a', scope: 'on-demand', info: () => ({ label: { en: 'Model X', fr: 'Modèle X' } }), start: (ctx) => void (got.augmentation = !!ctx.chats) }),
        space({ id: 's', path: '/s', start: (ctx) => void (got.space = !!ctx.chats) }),
      ],
    }),
  ]);
  await r.start();
  assert.deepEqual(got, { provider: false, augmentation: true, space: false });
  const mods = r.describe().packages[1]!.modules;
  assert.deepEqual(mods[1], { type: 'augmentation', id: 'a', info: { label: { en: 'Model X', fr: 'Modèle X' } } });
  assert.ok(!('info' in mods[0]!), 'no info, no field');
  const off = new Registry([definePackage({ id: 'mixed', config: ['KLATCHLY_UNSET_X'], modules: [augmentation({ id: 'a', scope: 'on-demand', info: () => ({ k: 'v' }) })] })], {});
  assert.ok(!('info' in off.describe().packages[0]!.modules[0]!), 'off: no info');
});

test("dataPath (sdk): a plain .json name in the data volume, never a path", () => {
  assert.equal(dataPath('assist.json'), `${config().dataDir}/assist.json`);
  assert.equal(dataPath('ai-2.v1.json'), `${config().dataDir}/ai-2.v1.json`);
  for (const bad of ['../state.json', 'a/b.json', 'state', 'State.json', '.hidden.json', 'a..json', 'x.json/..', '/etc/passwd', '']) {
    assert.throws(() => dataPath(bad), /bad data file name/, bad);
  }
});

test("the stream of new messages and the actor go to 'events' augmentations only, while their package is on", async () => {
  const got: Record<string, { actor: boolean; events: unknown[] }> = {};
  const seen = (id: string) => (got[id] ??= { actor: false, events: [] });
  const r = new Registry([fake.pkg, 
    definePackage({
      id: 'watcher',
      modules: [
        augmentation({ id: 'agent', scope: 'events', onEvent: (ev) => void seen('agent').events.push(ev), start: (ctx) => void (seen('agent').actor = !!ctx.actor) }),
        augmentation({ id: 'helper', scope: 'on-demand', start: (ctx) => void (seen('helper').actor = !!ctx.actor) }),
        space({ id: 'room', path: '/room', start: (ctx) => void (seen('room').actor = !!ctx.actor) }),
      ],
    }),
    // A handler that throws does not stop the others (nor the core's notifications, pushwatch.ts).
    definePackage({ id: 'flaky', modules: [augmentation({ id: 'flaky', scope: 'events', onEvent: () => { throw new Error('x'); } })] }),
  ]);
  await r.start();
  assert.deepEqual(
    Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.actor])),
    { agent: true, helper: false, room: false },
  );
  // Projected: the declared fields of EventMessage, nothing else (reactions, raw attachments…); other upstream
  // events and entries without ids are not delivered.
  emitChatEvent({ type: 'chat.upserted', entries: [{ id: '!c:x' }] }, 'fake');
  emitChatEvent(
    {
      type: 'message.upserted',
      entries: [
        { id: 'm1', chatID: '!c:x', text: 'hi', senderID: '@a:x', senderName: 'Sam', timestamp: '2026-11-01T00:00:00Z', type: 'TEXT', isSender: false, attachments: [{ srcURL: 'mxc://x' }], reactions: [{}] },
        { chatID: '!c:x', text: 'no id' },
      ],
    },
    'fake',
  );
  assert.deepEqual(got.agent!.events, [
    { type: 'message.upserted', source: 'fake', entries: [{ id: 'm1', chatID: '!c:x', text: 'hi', senderID: '@a:x', senderName: 'Sam', timestamp: '2026-11-01T00:00:00Z', type: 'TEXT', isSender: false, attachments: 1 }] },
  ]);
  await r.stop();
  emitChatEvent({ type: 'message.upserted', entries: [{ id: 'm2', chatID: '!c:x', text: 'later' }] }, 'fake');
  assert.equal(got.agent!.events.length, 1, 'nothing after stop');
});

test("an augmentation's scope and onEvent must agree (the registry refuses a list where they do not)", () => {
  const bad = (m: Record<string, unknown>) => () => new Registry([definePackage({ id: 'x', modules: [{ type: 'augmentation', id: 'x', ...m } as unknown as ServerPackage['modules'][number]] })]);
  assert.throws(bad({ scope: 'on-demand', onEvent: () => {} }), /scope/);
  assert.throws(bad({ scope: 'events' }), /scope/);
  assert.throws(bad({ scope: 'all' }), /scope/);
});

test("no module takes the name of the core's frames (message.*, chat.*, ready…), whatever its type", () => {
  for (const id of ['message', 'chat', 'ready', 'keepalive', 'error', 'subscriptions', 'visibility']) {
    assert.throws(() => new Registry([definePackage({ id: 'x', modules: [provider({ id, status: () => ({ ready: true }) })] })]), /core's frames/, id);
    assert.throws(() => new Registry([definePackage({ id: 'x', modules: [augmentation({ id, scope: 'on-demand' })] })]), /core's frames/, id);
  }
});

test('frames to the browsers: only the types of the module that sends them, only while its package is on', async () => {
  const frames: unknown[] = [];
  const off = onBrowserFrame((f) => void frames.push(f));
  let send: ((t: string) => void) | undefined;
  const r = new Registry([fake.pkg, definePackage({ id: 'demo', modules: [space({ id: 'demo', path: '/demo', start: (ctx) => void (send = (type) => ctx.toBrowsers({ type, chatID: 'c' })) })] })]);
  await r.start();
  for (const t of ['demo', 'demo.changed', 'demox', 'other', 'message.upserted', 'chat.deleted']) send!(t);
  assert.deepEqual(frames, [{ type: 'demo', chatID: 'c' }, { type: 'demo.changed', chatID: 'c' }]);
  off();
});

test("a provider's own listener: providers only, a specific IPv4 address, the app never served there, closed at stop", async () => {
  // The app's server (index.ts) on 127.0.0.1: once a provider listens on that address, the app drops what
  // comes to it there.
  const main = createServer((_, res) => res.end('app'));
  await new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve));
  const mainPort = (main.address() as AddressInfo).port;
  const get = (port: number) =>
    new Promise<string>((resolve) => {
      // A new connection each time (no keep-alive agent): each one meets the app's check.
      const req = httpGet({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        let b = '';
        res.on('data', (d: Buffer) => (b += d));
        res.on('end', () => resolve(b));
      });
      req.on('error', (e) => resolve(`error ${(e as NodeJS.ErrnoException).code ?? ''}`));
    });
  assert.equal(await get(mainPort), 'app');
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const has: Record<string, boolean> = {};
  const errors: string[] = [];
  const r = new Registry([fake.pkg, 
    definePackage({
      id: 'callback',
      modules: [
        provider({
          id: 'callback',
          status: () => ({ ready: true }),
          start: async (ctx) => {
            has.provider = !!ctx.listen;
            for (const [h, p] of [['0.0.0.0', port], ['localhost', port], ['127.0.0.1', 0]] as const) await ctx.listen!(h, p, () => {}).catch((e: Error) => errors.push(e.message));
            await ctx.listen!('127.0.0.1', port, (_, res) => res.end('provider'));
          },
        }),
        augmentation({ id: 'a', scope: 'on-demand', start: (ctx) => void (has.augmentation = !!ctx.listen) }),
        space({ id: 'room', path: '/room', start: (ctx) => void (has.space = !!ctx.listen) }),
      ],
    }),
  ]);
  await r.start({ server: main });
  assert.deepEqual(has, { provider: true, augmentation: false, space: false });
  assert.deepEqual(errors, ['host must be a specific address', 'host must be an IPv4 address', 'bad port']);
  assert.equal(await get(port), 'provider');
  assert.match(await get(mainPort), /^error ECONNRESET$|^$/, 'the app is not served on that address');
  const t0 = Date.now();
  await r.stop();
  assert.ok(Date.now() - t0 < 1500, 'bounded');
  assert.match(await get(port), /^error ECONNREFUSED$/, 'closed at stop');
  await new Promise<void>((resolve) => main.close(() => resolve()));
  assert.equal(listenProblem('192.0.2.3', 8081), null);
});

test("a provider's configured listener host is refused by the app even when its package is off", async () => {
  const main = createServer((_, res) => res.end('app'));
  await new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve));
  const port = (main.address() as AddressInfo).port;
  const get = () =>
    new Promise<string>((resolve) => {
      const req = httpGet({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        let b = '';
        res.on('data', (d: Buffer) => (b += d));
        res.on('end', () => resolve(b));
      });
      req.on('error', (e) => resolve(`error ${(e as NodeJS.ErrnoException).code ?? ''}`));
    });
  assert.equal(await get(), 'app');
  const off = definePackage({
    id: 'callback',
    modules: [provider({ id: 'callback', check: () => 'key file missing', reserves: () => ['127.0.0.1'], status: () => ({ ready: false }) })],
  });
  const r = new Registry([fake.pkg, off]);
  assert.equal(r.describe().packages.find((p) => p.id === 'callback')!.active, false);
  await r.start({ server: main });
  assert.match(await get(), /^error /, 'the app is not served on the reserved host');
  await r.stop();
  await new Promise<void>((resolve) => main.close(() => resolve()));
});

test('a connector is mandatory: the registry refuses to start without one that is on, and says why', async () => {
  const none = new Registry([]);
  assert.equal(none.startProblem(), 'no connector package in the build (ext/packages.server.ts)');
  await assert.rejects(none.start(), /no connector package in the build/);
  const src = fakeSource({ check: () => 'token file missing' }, 'src');
  const off = new Registry([src.pkg]);
  // The module named after its package gives its reason once (B4: never "src: src: …").
  assert.equal(off.startProblem(), 'no connector on (src: token file missing)');
  await assert.rejects(off.start(), /no connector on/);
  const on = new Registry([fakeSource().pkg]);
  assert.equal(on.startProblem(), null);
  await on.start();
  await on.stop();
  // No connector is privileged (1.25): a legacy one without owns off, another on, the app starts.
  const owned = fakeSource({ owns: (id) => id.startsWith('o:'), ownsAccount: (a) => a === 'owned' }, 'owned');
  const legacyOff = new Registry([src.pkg, owned.pkg]);
  assert.equal(legacyOff.startProblem(), null);
  await legacyOff.start();
  await legacyOff.stop();
  assert.equal(new Registry([owned.pkg]).startProblem(), null, 'a build of owning connectors only');
  // One legacy connector (no owns) at most.
  assert.throws(() => new Registry([fakeSource({}, 'one').pkg, fakeSource({}, 'two').pkg]), /second connector without owns/);
});

test('a build of owning connectors only starts and serves: each its own chats, nothing for an unclaimed one', async () => {
  const a = fakeSource({ owns: (id) => id.startsWith('a:'), ownsAccount: (x) => x === 'a' }, 'a');
  const b = fakeSource({ owns: (id) => id.startsWith('b:'), ownsAccount: (x) => x === 'b' }, 'b');
  a.chats.set('a:1', { id: 'a:1', title: 'A', lastActivity: '2026-11-02T00:00:00Z' });
  b.chats.set('b:1', { id: 'b:1', title: 'B', lastActivity: '2026-11-01T00:00:00Z' });
  const reg = new Registry([a.pkg, b.pkg]);
  assert.equal(reg.startProblem(), null);
  await reg.start();
  try {
    const app = createApp(reg);
    assert.equal((await call(app, '/healthz')).status, 200);
    const list = (await (await call(app, '/api/chats')).json()) as { items: { id: string }[] };
    assert.deepEqual(list.items.map((c) => c.id), ['a:1', 'b:1']);
    assert.equal((await call(app, '/api/chats/b%3A1')).status, 200);
    assert.equal((await call(app, '/api/chats/!x')).status, 404);
  } finally {
    await reg.stop();
  }
});

test("the chat routes ask the chat's connector: the one that owns it, else the default; nothing once it is off", async () => {
  const main = fakeSource();
  const other = fakeSource({ owns: (id) => id.startsWith('o:') }, 'other');
  main.chats.set('c1', { id: 'c1', title: 'Main' });
  other.chats.set('o:1', { id: 'o:1', title: 'Other' });
  const app = createApp(new Registry([other.pkg, main.pkg]));
  assert.deepEqual(await (await call(app, '/api/chats/c1')).json(), { id: 'c1', title: 'Main' });
  assert.deepEqual(await (await call(app, '/api/chats/o%3A1')).json(), { id: 'o:1', title: 'Other' });
  assert.deepEqual([main.calls, other.calls], [['chat c1'], ['chat o:1']]);
  // The source's own "not found" mapping (failure), and the accounts of every connector.
  assert.equal((await call(app, '/api/chats/nope')).status, 404);
  // Both first in the declared order (fake sources: 10), then by id.
  assert.deepEqual(await (await call(app, '/api/accounts')).json(), [{ accountID: 'fake', network: 'Fake' }, { accountID: 'other', network: 'Fake' }]);
  // A chat flag the connector does not keep: 409, nothing asked.
  const patch = await app.request('/api/chats/c1', { method: 'PATCH', headers: { cookie: `sid=${sid}`, origin: config().origin, 'content-type': 'application/json' }, body: '{"isLowPriority":true}' });
  assert.equal(patch.status, 409);
  const off = createApp(new Registry([definePackage({ id: 'gone', config: ['KLATCHLY_UNSET_X'], modules: [main.module] })], {}));
  assert.equal((await call(off, '/api/chats/c1')).status, 404);
});

test("a connector's feed: events reach the badge and the stream, frames only of the sources' types, while it is on", async () => {
  const frames: unknown[] = [];
  const offFrames = onBrowserFrame((f) => void frames.push(f));
  let feed: import('../server/connector.js').SourceFeed | undefined;
  const src = fakeSource({ start: (ctx) => void (feed = ctx.feed), unreadChats: async () => [{ id: 'u1', unreadCount: 4 }] }, 'feeder');
  const events: unknown[] = [];
  const r = new Registry([src.pkg, definePackage({ id: 'watch', modules: [augmentation({ id: 'watch', scope: 'events', onEvent: (ev) => void events.push(ev) })] })]);
  await r.start();
  assert.ok(feed);
  feed.event({ type: 'ready' });
  await new Promise((ok) => setTimeout(ok, 20));
  const { badgeCount } = await import('../server/badgecount.js');
  assert.ok(badgeCount() >= 4, 'reseeded from unreadChats on ready');
  feed.event({ type: 'message.upserted', entries: [{ id: 'm1', chatID: 'u1', text: 'hi', isSender: true }] });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(events, [{ type: 'message.upserted', source: 'feeder', entries: [{ id: 'm1', chatID: 'u1', text: 'hi', isSender: true }] }]);
  feed.event({ type: 'closed' });
  feed.toBrowsers({ type: 'message.delivered', chatID: 'u1', messageID: 'm1', delivered: {} });
  feed.toBrowsers({ type: 'feeder.x' });
  feed.toBrowsers({ type: 'keepalive' });
  assert.deepEqual(frames, [{ type: 'message.delivered', chatID: 'u1', messageID: 'm1', delivered: {} }]);
  await r.stop();
  offFrames();
});
