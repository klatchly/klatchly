import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSameShape, languageFiles } from '../test/catalogs.js';

// The whole build (ext/packages.server.ts) together, whatever the list (KLATCHLY_PACKAGES, ext/packages.json): what
// each package declares (versions, ranges, about), every range satisfied by the packages and the extension API of
// this build, and the app running with each package off in turn, whether left out of the build or turned off in
// Settings while it runs: it still starts and serves its own routes, what requires that package goes off with the
// right reason, and turning packages off and on again leaves nothing behind (timers, sockets, listeners, chat
// stream subscriptions). Nothing here names a package: what holds for one package only is in its own tests
// (ext/<id>/test/). Every package is configured against nothing real by its own test/build-env.ts (dead endpoints,
// a socket nobody listens on, made-up keys), read before the build is imported (some read their configuration then).

const dir = mkdtempSync(join(tmpdir(), 'klatchly-build-'));
writeFileSync(join(dir, 'key'), 'build-test-key-0123456789\n');
// The ids of the build, from the composition file itself (importing it would load the packages too early).
const listed = [...readFileSync(new URL('./packages.server.js', import.meta.url), 'utf8').matchAll(/from '\.\/([a-z][a-z0-9-]*)\/server\/index\.js'/g)].map((m) => m[1]!);
for (const id of listed) {
  const env = new URL(`./${id}/test/build-env.js`, import.meta.url);
  if (!existsSync(env)) continue;
  const { default: buildEnv } = (await import(env.href)) as { default: (o: { dir: string; key: string }) => Promise<Record<string, string>> };
  Object.assign(process.env, await buildEnv({ dir, key: join(dir, 'key') }));
}
const { packages } = await import('./packages.server.js');
const { Registry } = await import('#core/registry.js');
const { createApp } = await import('#core/app.js');
const { sessions, store } = await import('#core/context.js');
const { EXTENSION_API } = await import('#core/extension.js');
const { parseVersion, satisfies } = await import('#core/semver.js');
const { onBrowserFrame } = await import('#core/broadcast.js');

type ServerPackage = (typeof packages)[number];
const sid = store.mutate((s) => sessions.create(s));
const call = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { cookie: `sid=${sid}`, ...(init.headers ?? {}) } });

/** The packages that require `id`, directly or not. */
function dependants(id: string, list: readonly ServerPackage[] = packages): string[] {
  const out = new Set<string>();
  const add = (x: string) => {
    for (const p of list) if (p.requires && Object.hasOwn(p.requires, x) && !out.has(p.id)) (out.add(p.id), add(p.id));
  };
  add(id);
  return [...out].sort();
}

test('the composition files are what scripts/compose-packages.mjs writes from the package list (generated, not edited)', () => {
  const web = fileURLToPath(new URL('../../', import.meta.url));
  try {
    execFileSync(process.execPath, [join(web, 'scripts/compose-packages.mjs'), '--check'], { cwd: web, stdio: 'pipe' });
  } catch (e) {
    assert.fail(String((e as { stderr?: Buffer }).stderr ?? e));
  }
});

test('every package declares a version, its range over the extension API, an order, and its name and description', () => {
  const bad: string[] = [];
  for (const p of packages) {
    if (!parseVersion(p.version)) bad.push(`${p.id}: version ${p.version} is not x.y.z`);
    if (p.order === undefined) bad.push(`${p.id}: no order (package.ts)`);
    for (const lang of ['en', 'fr']) {
      const name = p.about?.name[lang];
      const line = p.about?.description[lang];
      if (!name) bad.push(`${p.id}: no ${lang} name`);
      if (!line || line.length > 140 || /\n/.test(line)) bad.push(`${p.id}: ${lang} description missing or not one short line`);
    }
  }
  assert.deepEqual(bad, []);
});

// The packages' strings, by the core's rule (test/catalogs.ts): every language file of a package's locales/ has the
// shape of its en.ts, every by-language map of its index.ts lists exactly those files, and its launch strings
// (launch.ts, when it has some) have the keys of English in every language.
test("every package's catalogs: each language matches English and is registered", async () => {
  for (const p of packages) {
    const dir = new URL(`./${p.id}/locales/`, import.meta.url);
    assert.ok(existsSync(dir), `${p.id}: no locales/`);
    const files = await languageFiles(dir);
    assert.ok(files.en && files.fr, `${p.id}: en and fr`);
    assertSameShape(files, `${p.id}/locales`);
    const index = (await import(new URL('index.js', dir).href)) as Record<string, unknown>;
    for (const [name, v] of Object.entries(index))
      if (v && typeof v === 'object' && Object.hasOwn(v, 'en')) assert.deepEqual(Object.keys(v).sort(), Object.keys(files).sort(), `${p.id}/locales/index.ts ${name}`);
    if (existsSync(new URL('launch.js', dir))) assertSameShape(((await import(new URL('launch.js', dir).href)) as { launch: Record<string, unknown> }).launch, `${p.id}/locales/launch.ts`);
  }
});

test('every range of the build is satisfied: the extension API, what each package requires or enhances', () => {
  const bad: string[] = [];
  const byID = new Map(packages.map((p) => [p.id, p]));
  for (const p of packages) {
    if (!satisfies(EXTENSION_API, p.klatchly)) bad.push(`${p.id} needs extension API ${p.klatchly}, the build has ${EXTENSION_API}`);
    for (const [kind, deps] of [['requires', p.requires], ['enhances', p.enhances]] as const) {
      for (const [id, range] of Object.entries(deps ?? {})) {
        const q = byID.get(id);
        if (!q) {
          if (kind === 'requires') bad.push(`${p.id} requires ${id} ${range}, not in the build`);
        } else if (!satisfies(q.version, range)) bad.push(`${p.id} ${kind} ${id} ${range}, the build has ${q.version}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('configured, every package is on; the order of ext/packages.server.ts does not matter', () => {
  const r = new Registry(packages, process.env);
  const st = r.describe().packages;
  assert.deepEqual(st.filter((p) => !p.active).map((p) => `${p.id}: ${p.reason}`), []);
  // The declared order (package.ts `order`, then the id): connectors first, the spaces and augmentations as the
  // sidebar shows them, whatever the order of the list.
  const order = st.map((p) => p.id);
  assert.deepEqual(new Registry([...packages].reverse(), process.env).describe().packages.map((p) => p.id), order);
  const byID = new Map(packages.map((p) => [p.id, p]));
  for (let i = 1; i < order.length; i++) {
    const [a, b] = [byID.get(order[i - 1]!)!, byID.get(order[i]!)!];
    assert.ok((a.order ?? 100) < (b.order ?? 100) || ((a.order ?? 100) === (b.order ?? 100) && a.id < b.id), `${a.id} (${a.order}) before ${b.id} (${b.order})`);
  }
  const details = r.details();
  assert.equal(details.api, EXTENSION_API);
  // A package it enhances may be absent from the build (never a reason to be off); present, its version matches.
  assert.deepEqual(details.packages.filter((p) => !p.apiOk || [...p.requires, ...p.enhances.filter((d) => d.present !== undefined)].some((d) => !d.ok)).map((p) => p.id), []);
});

/** The app on this registry: started, its own routes answering. */
async function serves(r: InstanceType<typeof Registry>, label: string): Promise<void> {
  const app = createApp(r);
  await r.start();
  assert.equal((await call(app, '/healthz')).status, 200, `${label}: /healthz`);
  const ext = await call(app, '/api/extensions');
  assert.equal(ext.status, 200, `${label}: /api/extensions`);
  assert.equal((await call(app, '/api/extensions/details')).status, 200, `${label}: /api/extensions/details`);
  for (const p of ['/settings', '/push-links.js', '/api/notify/badge', '/api/session']) assert.ok((await call(app, p)).status < 500, `${label}: ${p}`);
  // A chat route: asked of the connector (the upstream is dead here: a gateway error, never a crash).
  assert.ok([200, 404, 502, 503].includes((await call(app, '/api/accounts')).status), `${label}: /api/accounts`);
}

test('each package left out of the build in turn: the app starts and serves; what requires it is off, and says why', async () => {
  for (const out of packages) {
    const rest = packages.filter((p) => p !== out);
    const r = new Registry(rest, process.env);
    if (!rest.some((p) => p.modules.some((m) => m.type === 'connector'))) {
      // The build's only connector: the core refuses to start without one, and says so.
      assert.match(r.startProblem() ?? '', /^no connector package in the build/, `without ${out.id}`);
      continue;
    }
    try {
      assert.equal(r.startProblem(), null, `without ${out.id}`);
      await serves(r, `without ${out.id}`);
      const st = new Map(r.describe().packages.map((p) => [p.id, p]));
      const deps = dependants(out.id);
      for (const p of rest) {
        const direct = !!p.requires && Object.hasOwn(p.requires, out.id);
        if (direct) assert.equal(st.get(p.id)!.reason, `requires ${out.id} (not installed)`, `${p.id} without ${out.id}`);
        else if (deps.includes(p.id)) assert.match(st.get(p.id)!.reason ?? '', /^requires [a-z-]+ \(off\)$/, `${p.id} without ${out.id}`);
        else assert.ok(st.get(p.id)!.active, `${p.id} stays on without ${out.id}`);
      }
    } finally {
      await r.stop();
    }
  }
});

test('each package turned off in turn while the app runs: dependants go with it, the rest stays; on again, all back', async () => {
  const frames: string[] = [];
  const off = onBrowserFrame((f) => void frames.push(f.type));
  try {
    for (const p of packages) {
      const r = new Registry(packages, process.env);
      const app = createApp(r);
      try {
        await serves(r, `all on (${p.id})`);
        const details = r.details().packages.find((x) => x.id === p.id)!;
        assert.deepEqual([...details.dependants].sort(), dependants(p.id), `${p.id}: what would go with it`);
        const put = (enabled: boolean) =>
          call(app, `/api/extensions/${p.id}`, { method: 'PUT', headers: { origin: process.env.KLATCHLY_ORIGIN!, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
        const res = await put(false);
        if (!details.canDisable) {
          // The last connector on: the app cannot run without one.
          assert.equal(details.keep, 'no-connector');
          assert.equal(res.status, 409);
          assert.deepEqual(await res.json(), { error: 'required' });
          assert.ok(r.isActive(p.id));
          continue;
        }
        assert.equal(res.status, 200, `${p.id} off`);
        assert.ok(frames.includes('extensions'), 'the browsers are told');
        const st = new Map(r.describe().packages.map((x) => [x.id, x]));
        for (const q of packages) {
          if (q.id === p.id || dependants(p.id).includes(q.id)) assert.equal(st.get(q.id)!.reason, 'disabled in settings', `${q.id} with ${p.id} off`);
          else assert.ok(st.get(q.id)!.active, `${q.id} stays on with ${p.id} off`);
        }
        assert.equal(r.startProblem(), null);
        assert.equal((await call(app, '/healthz')).status, 200);
        // Its modules' routes and pages answer 404 at once.
        for (const m of p.modules) if (m.routes) assert.equal((await call(app, `/api/${m.id}/x`)).status, 404, `/api/${m.id}`);
        for (const m of p.modules) if (m.type === 'space') assert.equal((await call(app, m.path)).status, 404, m.path);
        // On again, with what it took along: everything back.
        for (const id of [p.id, ...dependants(p.id)]) assert.equal((await r.setEnabled(id, true, { withRequired: true })).ok, true, `${id} on`);
        assert.deepEqual(r.describe().packages.filter((x) => !x.active).map((x) => x.id), []);
      } finally {
        await r.stop();
      }
    }
  } finally {
    off();
  }
});

/** What keeps the process busy, by kind (timers, sockets, servers…), without the ones that come and go. */
function resources(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of process.getActiveResourcesInfo()) if (!/^(FSReqCallback|FSReqPromise|GetAddrInfoReqWrap|TTYWrap|PipeWrap|Immediate)$/.test(r)) out[r] = (out[r] ?? 0) + 1;
  return out;
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** The resources once they stop changing (sockets close a tick after a stop): three equal samples 30 ms apart. */
async function quiet(): Promise<Record<string, number>> {
  let last = JSON.stringify(resources());
  for (let same = 0, t0 = Date.now(); same < 2 && Date.now() - t0 < 3000; ) {
    await sleep(30);
    const now = JSON.stringify(resources());
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return JSON.parse(last) as Record<string, number>;
}

test('off and on again, twice: each package leaves nothing running behind it (timers, sockets, listeners, chat stream subscriptions)', async () => {
  const { chatEventSubscribers } = await import('#core/chatactor.js');
  const r = new Registry(packages, process.env);
  await r.start();
  await quiet();
  try {
    for (const p of packages) {
      if (!r.details().packages.find((x) => x.id === p.id)!.canDisable) continue;
      const all = [p.id, ...dependants(p.id)];
      const subscribers = chatEventSubscribers();
      const cycle = async () => {
        assert.equal((await r.setEnabled(p.id, false)).ok, true);
        const offNow = await quiet();
        assert.ok(chatEventSubscribers() <= subscribers, `${p.id} off: no subscription to the chat stream added`);
        for (const id of all) assert.equal((await r.setEnabled(id, true, { withRequired: true })).ok, true);
        await quiet();
        // On again: subscribed as before, once (none doubled, none lost).
        assert.equal(chatEventSubscribers(), subscribers, `${p.id} on again: the chat stream's subscribers`);
        return offNow;
      };
      const first = await cycle();
      const second = await cycle();
      // Off twice: the same resources each time (nothing left from the first time it ran).
      assert.deepEqual(second, first, `${p.id}: resources after its second stop`);
      assert.deepEqual(r.describe().packages.filter((x) => !x.active).map((x) => x.id), [], `${p.id}: all back on`);
    }
  } finally {
    await r.stop();
  }
  await quiet();
});
