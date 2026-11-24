// Offline klatchly for E2E scripts (../run-offline.sh): the built app (dist/public, and build-test from `npm test`)
// with every package of its list on, each on a fake backend in this process, all made-up and deterministic. The
// core's fakes, here:
// - beeper.mjs: the Desktop API (beeper-server), the beeper connector's backend: accounts, chats and their
//   histories, media, sends, edits, reactions, reads, archive… kept in memory, with its WebSocket; plus the test
//   hooks (reset, incoming messages, what was read; the packages' fakes add theirs: harness.mjs). It stays here, not
//   in ext/beeper/: every core script runs against its canned chats, and run.mjs talks to its hooks;
// - web.mjs: the public web the link previews fetch (a few pages, behind the real SSRF guard);
// - oidc.mjs: an OIDC provider, with R_OIDC=1 only (the sign-in through a provider, oidc.e2e.js).
// Each package of the build brings its own, ext/<id>/test/offline.mjs (packages.mjs), with the same shape:
// start({ dir, index, reset }) → { env } (applied before the app is imported), and optionally reset() (before each
// script) and patchApp(built) (after the app is compiled, before it starts).
// Nothing real is ever reached (the container has no network). Writes enrollment codes to R_CODE_FILE
// (offline/.code). Run with node --conditions=klatchly-test from web/; R_INDEX (the fakes' ports, with R_PORT) lets
// several instances run side by side (offline/run.mjs: one per worker).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageFakes } from './packages.mjs';

const root = process.env.R_ROOT ?? process.cwd();
const index = Number(process.env.R_INDEX ?? 0);
const dir = mkdtempSync(join(tmpdir(), 'klatchly-offline-'));
writeFileSync(join(dir, 'token'), 'offline-token\n');
// A made-up key the packages' fakes may share (dir/key).
writeFileSync(join(dir, 'key'), 'offline-key-0123456789\n');
Object.assign(process.env, {
  KLATCHLY_ORIGIN: process.env.R_ORIGIN ?? 'http://localhost:3095',
  KLATCHLY_RP_ID: process.env.R_RP ?? 'localhost',
  KLATCHLY_TOKEN_FILE: join(dir, 'token'),
  KLATCHLY_DATA_DIR: dir,
  KLATCHLY_PUBLIC_DIR: join(root, 'dist/public'),
});

// The fakes, each started before the app reads its environment. reset() puts each back to its starting state
// (POST /__reset on the fake Desktop API, by run.mjs before each script).
const fakes = await Promise.all([
  ...['beeper', 'web', 'oidc'].map((n) => import(`./${n}.mjs`)),
  ...packageFakes(root).map(([, f]) => import(pathToFileURL(f).href)),
]);
const started = [];
// The app's own state a script may leave behind (quiet hours: they would add a tab), put back with the fakes.
let resetApp = async () => {};
for (const f of fakes) {
  const { env } = await f.start({ dir, index, reset: () => Promise.all([...fakes.map((x) => x.reset?.()), resetApp()]) });
  Object.assign(process.env, env);
  started.push(f);
}

// The app as `npm test` compiled it (test/e2e has its own package.json: no #core/* imports from here).
const built = (p) => import(pathToFileURL(join(root, 'build-test', p)).href);
for (const f of started) await f.patchApp?.(built);
const { WebSocketServer } = await import('ws');
const { serve } = await import('@hono/node-server');
const { createApp } = await built('server/app.js');
const { store } = await built('server/context.js');
const { addEnrollCode, newEnrollCode } = await built('server/sessions.js');
const { Registry } = await built('server/registry.js');
const { packages } = await built('ext/packages.server.js');
const { resetQuiet } = await built('server/quiet.js');
resetApp = async () => {
  rmSync(join(dir, 'quiet.json'), { force: true });
  resetQuiet();
};

// As server/index.ts: the choices of Settings → Extensions kept in the data volume, and the browsers' socket
// (/api/ws: live frames, the 'extensions' one included).
const registry = new Registry(packages, process.env, { stateFile: join(dir, 'extensions.json') });
const appWss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
const server = serve({ fetch: createApp(registry).fetch, port: Number(process.env.R_PORT ?? 3095), hostname: '::', websocket: { server: appWss } });
await registry.start({ server });
// One single-use code per script (the runner takes them in order).
const codes = Array.from({ length: 64 }, () => newEnrollCode());
store.mutate((s) => codes.forEach((c) => addEnrollCode(s, c, 3600_000)));
writeFileSync(process.env.R_CODE_FILE ?? join(root, 'test/e2e/offline/.code'), `${codes.join('\n')}\n`);
console.log('offline instance ready');
