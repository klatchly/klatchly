import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { ConnectorError } from '../server/connector.js';
import { chatSender } from '../server/chatsender.js';
import { sessions, store, type Env } from '../server/context.js';
import { augmentation, Registry, space, type ServerPackage } from '../server/registry.js';
import { fakeSource, testPackage as definePackage } from './fakesource.js';

// A space's device API (ServerSpace.bearerRoutes, API 1.24): mounted at /api/bearer/<id>/ before the origin check
// and the session guard, reached only with a Bearer header, never with the cookie; the cookie routes never with a
// Bearer header. And sending on its own (ServerSpace.sends, ModuleContext.sender): the composer's path, bound to the
// package. The share package (ext/share) is the user; its own tests check its tokens.

const sid = store.mutate((s) => sessions.create(s));
const TOKEN = 'Bearer test-token-aaaaaaaaaaaa';

/** What the device routes saw: the session (must stay undefined) and the header. */
const seen: { session?: string; auth?: string }[] = [];
const deviceRoutes = () =>
  new Hono<Env>()
    .get('/v1/ping', (c) => {
      seen.push({ session: c.get('session'), auth: c.req.header('authorization') });
      return c.json({ pong: true });
    })
    .post('/v1/echo', async (c) => c.json({ got: (await c.req.text()).length }));

function build(over: Partial<ServerPackage> = {}) {
  const fake = fakeSource();
  const holder: { sender?: import('../server/chatsender.js').ChatSender } = {};
  const pkg = definePackage({
    id: 'dev',
    modules: [
      space({
        id: 'dev',
        path: '/dev',
        sends: true,
        routes: new Hono<Env>().get('/mine', (c) => c.json({ session: !!c.get('session') })),
        bearerRoutes: deviceRoutes(),
        start: (ctx) => {
          holder.sender = ctx.sender;
        },
      }),
    ],
    ...over,
  });
  const registry = new Registry([fake.pkg, pkg]);
  return { app: createApp(registry), registry, fake, holder };
}

const req = (app: ReturnType<typeof createApp>, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  app.request(path, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}) });

test('device API: only with a Bearer header of a sane form; refusals are 400 bad_token, never 401/403 or a redirect', async () => {
  const { app, registry } = build();
  await registry.start();
  for (const headers of [{} as Record<string, string>, { authorization: 'Bearer' }, { authorization: 'Basic dXNlcjpwYXNz' }, { authorization: 'Bearer short' }, { authorization: 'Bearer has space inside' }, { cookie: `sid=${sid}` }]) {
    const r = await req(app, '/api/bearer/dev/v1/ping', { headers });
    assert.equal(r.status, 400, JSON.stringify(headers));
    assert.deepEqual(await r.json(), { error: 'bad_token' });
  }
  const ok = await req(app, '/api/bearer/dev/v1/ping', { headers: { authorization: TOKEN } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { pong: true });
  await registry.stop();
});

test('device API: the cookie is never read there (no session, no renewal), even beside a good header', async () => {
  const { app, registry } = build();
  await registry.start();
  seen.length = 0;
  const r = await req(app, '/api/bearer/dev/v1/ping', { headers: { authorization: TOKEN, cookie: `sid=${sid}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.deepEqual(seen, [{ session: undefined, auth: TOKEN }]);
  await registry.stop();
});

test('device API: before the origin check (a POST without Origin is served), body capped at 64 KB', async () => {
  const { app, registry } = build();
  await registry.start();
  const r = await req(app, '/api/bearer/dev/v1/echo', { method: 'POST', headers: { authorization: TOKEN, 'content-type': 'text/plain' }, body: 'x'.repeat(1000) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { got: 1000 });
  const big = await req(app, '/api/bearer/dev/v1/echo', { method: 'POST', headers: { authorization: TOKEN, 'content-type': 'text/plain' }, body: 'x'.repeat(65 * 1024) });
  assert.equal(big.status, 413);
  await registry.stop();
});

test('device API: anything else under /api/bearer/ is a 404 (never a cookie route, never a redirect); off: 404', async () => {
  const { app, registry } = build();
  await registry.start();
  for (const [path, method] of [['/api/bearer/dev/v1/nope', 'GET'], ['/api/bearer/dev/mine', 'GET'], ['/api/bearer/other/x', 'POST'], ['/api/bearer/', 'GET']] as const) {
    const r = await req(app, path, { method, headers: { authorization: TOKEN, cookie: `sid=${sid}` } });
    assert.equal(r.status, 404, path);
    assert.deepEqual(await r.json(), { error: 'not_found' }, path);
  }
  const off = await registry.setEnabled('dev', false);
  assert.equal(off.ok, true);
  assert.equal((await req(app, '/api/bearer/dev/v1/ping', { headers: { authorization: TOKEN } })).status, 404);
  await registry.stop();
});

test('cookie routes never take a Bearer header: without the cookie they redirect as before', async () => {
  const { app, registry } = build();
  await registry.start();
  for (const p of ['/api/dev/mine', '/api/chats', '/api/extensions']) {
    const r = await req(app, p, { headers: { authorization: TOKEN } });
    assert.equal(r.status, 302, p);
  }
  // With the cookie, the package's own route sees its session as usual.
  assert.deepEqual(await (await req(app, '/api/dev/mine', { headers: { cookie: `sid=${sid}` } })).json(), { session: true });
  await registry.stop();
});

test('Settings → Extensions says a package sends and has a device API; only spaces may', async () => {
  const { registry } = build();
  const d = registry.details().packages.find((p) => p.id === 'dev')!;
  assert.equal(d.sends, true);
  assert.equal(d.bearer, true);
  assert.equal(registry.details().packages.find((p) => p.id === 'fake')!.sends, undefined);
  const bad = (m: object) => () => new Registry([fakeSource().pkg, definePackage({ id: 'x', modules: [augmentation({ id: 'x', scope: 'on-demand', ...m } as never)] })]);
  assert.throws(bad({ sends: true }), /sends is for spaces only/);
  assert.throws(bad({ bearerRoutes: new Hono<Env>() }), /bearerRoutes is for spaces only/);
  // /api/bearer is the core's: no space may take the id.
  assert.throws(() => new Registry([fakeSource().pkg, definePackage({ id: 'bearer', modules: [space({ id: 'bearer', path: '/bearer' })] })]), /takes a core or used id/);
});

test('sender: the composer path through the chat connector, bound to its package, refused once off', async () => {
  const { registry, fake, holder } = build();
  await registry.start();
  const sender = holder.sender!;
  assert.ok(sender);
  assert.equal(sender.canSend('c1'), true);
  assert.equal(sender.canSend('bad id'), false);
  const r = await sender.send('c1', 'hello https://example.com');
  assert.ok(r.pendingMessageID);
  assert.ok(fake.calls.includes('send c1 {"text":"hello https://example.com"}'), fake.calls.join('\n'));
  for (const [id, text] of [['bad id', 'x'], ['c1', '   '], ['c1', 'x'.repeat(20_001)]] as const) {
    await assert.rejects(sender.send(id, text), (e: unknown) => e instanceof ConnectorError && e.status === 400);
  }
  await registry.setEnabled('dev', false);
  assert.equal(sender.canSend('c1'), false);
  await assert.rejects(sender.send('c1', 'late'), (e: unknown) => e instanceof ConnectorError && e.status === 404);
  await registry.stop();
});

test('sender: a chat no connector that is on owns is not_found', async () => {
  const owned = fakeSource({ owns: (id) => id.startsWith('z:') }, 'zz');
  const s = chatSender('t');
  const registry = new Registry([fakeSource().pkg, owned.pkg]);
  await registry.start();
  await registry.setEnabled('zz', false);
  assert.equal(s.canSend('z:1'), false);
  await assert.rejects(s.send('z:1', 'x'), (e: unknown) => e instanceof ConnectorError && e.status === 404);
  await registry.stop();
});

test('signed out: only the home of a space that declares signedOutPage opens the app, decided without running it', async () => {
  let shownCalls = 0;
  const shown = () => (shownCalls++, false);
  const mk = (id: string, extra: object) => definePackage({ id, modules: [space({ id, path: `/${id}`, segment: '[a-z]{3}', ...extra })] });
  const registry = new Registry([fakeSource().pkg, mk('open', { signedOutPage: true, shown }), mk('shut', { signedOutPage: true }), mk('agents', { shown: () => (shownCalls++, true) })]);
  const app = createApp(registry);
  await registry.start();
  shownCalls = 0;
  // A space whose shown() says false answers exactly as one whose shown() says true: the shell; shown never runs.
  for (const p of ['/open?url=https%3A%2F%2Fexample.com', '/shut']) assert.equal((await req(app, p)).status, 200, p);
  // Its places, a space without the opt-in (whatever its shown), anything else: back to /.
  for (const p of ['/open/abc', '/open/', '/agents', '/agents/abc', '/nope', '/settings/general']) {
    const r = await req(app, p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/', p);
  }
  assert.equal(shownCalls, 0, 'no module code for an anonymous visitor');
  // Off: the answer does not change (it tells nothing of the runtime).
  await registry.setEnabled('shut', false);
  assert.equal((await req(app, '/shut')).status, 200);
  await registry.stop();
  // Only a space may declare it, and only as true.
  assert.throws(() => new Registry([definePackage({ id: 'bad', modules: [augmentation({ id: 'bad', scope: 'on-demand', signedOutPage: true } as never)] })]), /signedOutPage is for spaces only/);
});

test('the manifest makes the installed app a share target: GET /share with title, text and url', () => {
  const src = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
  const m = /share_target:\s*(\{[^\n]*\})/.exec(src);
  assert.ok(m, 'share_target in the manifest');
  assert.match(m[1]!, /action: '\/share'/);
  assert.match(m[1]!, /method: 'GET'/);
  assert.match(m[1]!, /params: \{ title: 'title', text: 'text', url: 'url' \}/);
  // Only in a build that has the share package.
  assert.match(src, /\.\.\.\(HAS_SHARE \? \{ share_target:/);
  assert.ok(config().origin);
});
