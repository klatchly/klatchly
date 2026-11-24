import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, statSync } from 'node:fs';
import { createApp } from '#core/app.js';
import { config, dataPath } from '#core/config.js';
import { EXTENSION_API } from '#core/extension.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { satisfies } from '#core/semver.js';
import { assertSameShape, languageFiles } from '../../../test/catalogs.js';
import { fakeSource } from '../../../test/fakesource.js';
import { packages } from '../../packages.server.js';
import { launch } from '../locales/launch.js';
import fr from '../locales/fr.js';
import example from '../server/index.js';

// The example package, as the registry and the app see it. These tests run with `npm test` whether or not the
// package is in the build's list (the next line tells scripts/run-tests.mjs so): they build their own registry,
// with the core's fake chat source (test/fakesource.ts) as the connector every started registry needs, and add the
// package to the build's list when it is not there.
// klatchly-test: any-list
//
// A package's tests use the core's modules directly (#core/*: the app, the registry, the session store) and its
// test helpers (test/*.ts); only its shipped code is held to #core/sdk.js and client/src/sdk.ts.

const sid = store.mutate((s) => sessions.create(s));
const fake = fakeSource();
type App = ReturnType<typeof createApp>;
const call = (app: App, path: string, init: { method?: string; body?: unknown; origin?: string | null } = {}) => {
  const write = init.method && init.method !== 'GET';
  const origin = init.origin === undefined ? config().origin : init.origin;
  return app.request(path, {
    method: init.method ?? 'GET',
    headers: { cookie: `sid=${sid}`, ...(write && origin ? { origin } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
};
const json = async <T>(r: Response | Promise<Response>): Promise<T> => (await (await r).json()) as T;

/** A started app with the fake connector and the example package. */
async function started(): Promise<{ app: App; registry: Registry }> {
  const registry = new Registry([fake.pkg, example]);
  const app = createApp(registry);
  await registry.start();
  return { app, registry };
}

const prefsFile = () => dataPath('example.json');
beforeEach(() => {
  delete process.env.KLATCHLY_EXAMPLE_GREETING;
  rmSync(prefsFile(), { force: true });
});
after(() => rmSync(prefsFile(), { force: true }));

test('on with no configuration: its space, its augmentation (on-demand), its page served, other paths not', async () => {
  const { app, registry } = await started();
  const listed = (await json<{ packages: { id: string; active: boolean; modules: unknown[] }[] }>(call(app, '/api/extensions'))).packages;
  assert.deepEqual(listed.find((p) => p.id === 'example'), {
    id: 'example',
    active: true,
    modules: [
      { type: 'space', id: 'example', path: '/example' },
      { type: 'augmentation', id: 'example-words' },
    ],
  });
  // Settings → Extensions says what it sees: the augmentation reads only what the user hands it.
  const details = registry.details().packages.find((p) => p.id === 'example')!;
  assert.equal(details.apiOk, true);
  assert.deepEqual(details.modules.find((m) => m.type === 'augmentation'), { type: 'augmentation', id: 'example-words', scope: 'on-demand' });
  assert.equal(details.about?.name.fr, 'Exemple');
  // Its page is served (the client routes it); no places: anything under it is a 404, as is a look-alike.
  assert.equal((await call(app, '/example')).status, 200);
  for (const p of ['/example/x', '/examplex']) assert.equal((await call(app, p)).status, 404, p);
  await registry.stop();
});

test('GET /api/example/hello: the greeting (configured or null), when it started, calls counted', async () => {
  const { app, registry } = await started();
  let r = await json<{ greeting: string | null; startedAt: string | null; calls: number }>(call(app, '/api/example/hello'));
  assert.equal(r.greeting, null);
  assert.ok(r.startedAt && Date.now() - Date.parse(r.startedAt) < 60_000, 'started just now');
  assert.equal(r.calls, 1);
  assert.equal((await json<{ calls: number }>(call(app, '/api/example/hello'))).calls, 2);
  // Configured (read when asked): in the reply and in the module's public info for the client half.
  process.env.KLATCHLY_EXAMPLE_GREETING = '  Hi there  ';
  r = await json(call(app, '/api/example/hello'));
  assert.equal(r.greeting, 'Hi there');
  const ext = await json<{ packages: { id: string; modules: { id: string; info?: unknown }[] }[] }>(call(app, '/api/extensions'));
  assert.deepEqual(ext.packages.find((p) => p.id === 'example')!.modules[0]!.info, { greeting: 'Hi there' });
  // Signed out: the core's session guard answers before the package (a redirect, never the route).
  assert.equal((await app.request('/api/example/hello')).status, 302);
  await registry.stop();
});

test('prefs: default, saved (0600 in the data volume), bad bodies and foreign origins refused', async () => {
  const { app, registry } = await started();
  assert.deepEqual(await json(call(app, '/api/example/prefs')), { characters: false });
  assert.deepEqual(await json(call(app, '/api/example/prefs', { method: 'PUT', body: { characters: true, extra: 'dropped' } })), { characters: true });
  assert.deepEqual(await json(call(app, '/api/example/prefs')), { characters: true });
  assert.equal(statSync(prefsFile()).mode & 0o777, 0o600);
  for (const body of [{ characters: 'yes' }, {}, ['characters'], 'true']) {
    assert.equal((await call(app, '/api/example/prefs', { method: 'PUT', body })).status, 400, JSON.stringify(body));
  }
  // A write without the app's origin is refused by the core (CSRF: 400 bad_origin), before the package sees it.
  for (const origin of [null, 'https://evil.example']) {
    const r = await call(app, '/api/example/prefs', { method: 'PUT', body: { characters: false }, origin });
    assert.deepEqual([r.status, await r.json()], [400, { error: 'bad_origin' }], String(origin));
  }
  assert.deepEqual(await json(call(app, '/api/example/prefs')), { characters: true });
  await registry.stop();
});

test('turned off in Settings → Extensions: its API and page go; on again, it starts afresh', async () => {
  const { app, registry } = await started();
  await call(app, '/api/example/hello');
  await call(app, '/api/example/hello');
  assert.equal((await registry.setEnabled('example', false)).ok, true);
  assert.equal((await call(app, '/api/example/hello')).status, 404);
  assert.equal((await call(app, '/example')).status, 404);
  assert.equal((await registry.setEnabled('example', true)).ok, true);
  assert.equal((await json<{ calls: number }>(call(app, '/api/example/hello'))).calls, 1);
  await registry.stop();
  assert.equal(existsSync(prefsFile()), false, 'nothing written unless the user saves a preference');
});

test("added to this build's list: every range satisfied, all packages valid together", () => {
  // What `KLATCHLY_PACKAGES=<the list>,example` composes (the owner's list leaves it out).
  assert.ok(satisfies(EXTENSION_API, example.klatchly), `klatchly ${example.klatchly} over ${EXTENSION_API}`);
  const list = packages.some((p) => p.id === 'example') ? packages : [...packages, example];
  const r = new Registry(list);
  assert.equal(r.describe().packages.find((p) => p.id === 'example')?.active, true);
  assert.deepEqual(r.details().packages.filter((p) => !p.apiOk).map((p) => p.id), []);
});

test('catalogs: French matches English, launch strings in both, plurals', async () => {
  const files = await languageFiles(new URL('../locales/', import.meta.url));
  assert.deepEqual(Object.keys(files).sort(), ['en', 'fr']);
  assertSameShape(files, 'example/locales');
  assertSameShape(launch, 'example/locales/launch.ts');
  assert.equal(fr.calls(1), '1 appel à sa route depuis son démarrage');
  assert.equal(fr.wordsAndCharacters(2, 1), '2 mots, 1 caractère');
});
