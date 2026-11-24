// First: the former BEEP_* variables, before any module reads the environment.
import './legacyenv.js';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { config, dataPath } from './config.js';
import { createApp } from './app.js';
import { store } from './context.js';
import { legacyAuth, migrateAuth, oidcReady } from './auth.js';
import { log } from './log.js';
import { vapid } from './vapid.js';
import { Registry } from './registry.js';
// The one import of the packages (ext/packages.server.ts, built to dist/ext/): see package.json "imports".
import { packages } from '#ext/packages.server.js';

const cfg = config();
// What Settings → Extensions turned off is kept in the data volume (server-wide).
const registry = new Registry(packages, process.env, { stateFile: dataPath('extensions.json') });
// A messaging client needs a chat source: fail fast without one (e.g. Beeper's token file missing), before the
// store or the VAPID keys are touched.
const problem = registry.startProblem();
if (problem) {
  log('server', 'cannot start', { reason: problem });
  process.exit(1);
}
const state = store.read();
vapid(); // create the VAPID key pair on first start
// How one signs in (auth.ts): passkeys only. A state file from before may still say "password" or "none" (removed):
// back to passkeys, the password hash, TOTP secret and recovery codes deleted, the sessions open kept (whoever is
// signed in stays signed in); a new passkey always comes from the CLI's enrollment code (cli.js enroll, /enroll).
const legacy = legacyAuth(state);
if (legacy) {
  store.mutate(migrateAuth);
  log('auth', 'WARNING stored sign-in mode removed, now passkeys only (password, TOTP and recovery codes deleted from the state)', { stored: legacy });
}
if (process.env.KLATCHLY_AUTH_NONE_ALLOWED !== undefined) log('auth', 'WARNING KLATCHLY_AUTH_NONE_ALLOWED is ignored: the sign-in mode "none" was removed');
const oidc = cfg.oidc;
const fresh = store.read();
log('auth', 'sign-in', { mode: 'passkey', passkeys: fresh.credentials.length, ...(oidc ? { oidc: oidc.issuer.host, oidcClient: oidc.clientSecret ? 'confidential' : 'public', oidcPinned: oidcReady(fresh, oidc) } : {}) });
if (oidc && !oidcReady(fresh, oidc)) log('auth', 'oidc: no account linked yet: run cli.js enroll, then on /enroll choose the provider (or set KLATCHLY_OIDC_ALLOWED_SUB)');
else if (!fresh.credentials.length && !oidc) log('auth', 'no passkey yet: run cli.js enroll in the container, then open /enroll with the code');

const app = createApp(registry);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
// HTTP by default (a reverse proxy in front terminates TLS); native HTTPS with KLATCHLY_TLS_CERT / KLATCHLY_TLS_KEY (e.g. a
// Cloudflare origin certificate, for cloudflared or a proxy that talks to the origin over HTTPS).
const tls = cfg.tls ? { createServer: createHttpsServer, serverOptions: { cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key) } } : {};
const server = serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0', websocket: { server: wss }, ...tls }, (info) => {
  log('server', 'listening', { port: info.port, tls: !!cfg.tls, origin: cfg.origin, rpID: cfg.rpID });
}) as Server;
server.headersTimeout = 30_000;
server.requestTimeout = 0; // media streams may be long

// The server goes along: a provider's own listener address (ModuleContext.listen) never serves the app.
registry.start({ server }).catch(() => {});

const stop = async () => {
  log('server', 'shutting down');
  // Whatever happens below, the process is gone within 3 s.
  setTimeout(() => process.exit(0), 3000).unref();
  // The packages stop before the server closes (after a start still under way), their listeners with them.
  await registry.stop().catch(() => {});
  wss.clients.forEach((ws) => ws.close(1001));
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
