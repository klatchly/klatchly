import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The browser's WebSocket (/api/ws) and the session (audit, tests to add): the handshake needs the exact Origin, a
// valid session cookie and an upgrade, else a plain 400 (never 401/403); a session signed out from another device
// (Settings → Connected devices) or by signing out closes its sockets with 4001 at once.
const { serve } = await import('@hono/node-server');
const { default: WebSocket, WebSocketServer } = await import('ws');
const { createApp } = await import('../server/app.js');
const { config } = await import('../server/config.js');
const { sessions, store } = await import('../server/context.js');
const { sha256 } = await import('../server/sessions.js');

const app = createApp();
const browsers = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1', websocket: { server: browsers } }) as Server;
await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`;
const origin = config().origin;
const newSession = () => store.mutate((s) => sessions.create(s, Date.now(), 'Firefox · Linux'));

/** The handshake's HTTP status when refused, or 101 once open (then closed). */
function handshake(headers: Record<string, string>): Promise<number> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, { headers });
    ws.once('unexpected-response', (_req, res) => {
      ok(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('open', () => {
      ok(101);
      ws.close();
    });
    ws.once('error', (e) => (e.message.includes('Unexpected server response') ? undefined : fail(e)));
  });
}

/** An open socket of `sid`, and the close code it gets. */
async function socketOf(sid: string) {
  const ws = new WebSocket(url, { headers: { origin, cookie: `sid=${sid}` } });
  const closed = new Promise<number>((ok) => ws.once('close', (code) => ok(code)));
  await new Promise((ok, fail) => (ws.once('open', ok), ws.once('error', fail)));
  return { ws, closed };
}

const within = <T>(p: Promise<T>, ms = 3000) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('timed out')), ms))]);

test('handshake: the exact Origin, a valid session and an upgrade, else 400 (never 401/403)', async () => {
  const sid = newSession();
  try {
    assert.equal(await handshake({ cookie: `sid=${sid}` }), 400, 'no Origin');
    assert.equal(await handshake({ origin: 'https://evil.example', cookie: `sid=${sid}` }), 400, 'a foreign Origin');
    assert.equal(await handshake({ origin: `${origin}.evil.example`, cookie: `sid=${sid}` }), 400, 'an Origin that only starts the same');
    assert.equal(await handshake({ origin }), 400, 'no session');
    assert.equal(await handshake({ origin, cookie: `sid=${'A'.repeat(43)}` }), 400, 'an unknown session');
    assert.equal((await app.request('/api/ws', { headers: { origin, cookie: `sid=${sid}` } })).status, 400, 'no upgrade');
    assert.equal(await handshake({ origin, cookie: `sid=${sid}` }), 101, 'all three: open');
    sessions.revoke(sha256(sid));
    assert.equal(await handshake({ origin, cookie: `sid=${sid}` }), 400, 'a session signed out');
  } finally {
    sessions.revoke(sha256(sid));
  }
});

test('a session signed out from another device, or signing out: its sockets close with 4001 at once', async () => {
  const phone = newSession();
  const laptop = newSession();
  const a = await socketOf(phone);
  const b = await socketOf(laptop);
  // The laptop signs the phone out (just signed in: no step-up needed).
  const r = await app.request(`/api/auth/sessions/${sha256(phone).slice(0, 16)}`, { method: 'DELETE', headers: { origin, cookie: `sid=${laptop}` } });
  assert.equal(r.status, 200);
  assert.equal(await within(a.closed), 4001, "the phone's socket closed");
  assert.equal(b.ws.readyState, WebSocket.OPEN, "the laptop's stays open");
  // Signing out on the laptop closes its own.
  assert.equal((await app.request('/api/auth/logout', { method: 'POST', headers: { origin, cookie: `sid=${laptop}` } })).status, 200);
  assert.equal(await within(b.closed), 4001);
  browsers.clients.forEach((ws) => ws.terminate());
  await new Promise<void>((ok) => server.close(() => ok()));
});
