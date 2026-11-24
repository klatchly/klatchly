import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '#core/app.js';
import { badgeCount } from '#core/badgecount.js';
import { config } from '#core/config.js';
import { sessions, store } from '#core/context.js';
import type { SourceEvent, SourceFeed } from '#core/sdk.js';
import { attemptAfter, BeeperEvents, openLive, STABLE_MS } from '../server/events.js';
import { registry } from './setup.js';

// The Desktop API's WebSocket, canned (on KLATCHLY_UPSTREAM's port, /v1/ws, with the token): the persistent socket
// (BeeperEvents: subscribed to everything, its events into the core; 'ready' recounts the badge from /v1/chats)
// and one socket per browser socket (openLive, through the core's /api/ws: the browser's subscriptions
// forwarded once validated, only the domain frames back, keepalive pings, the upstream's end closing the
// browser's socket with 1011).

type Conn = { ws: WebSocket; auth?: string; got: unknown[] };
const conns: Conn[] = [];
let autoPong = true;
const upstream: Server = createServer((req, res) => {
  // The badge's recount (unreadChats): one page of chats.
  if ((req.url ?? '').startsWith('/v1/chats')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ items: [{ id: 'u1', unreadCount: 3 }, { id: 'u2', unreadCount: 2, isMuted: true }], hasMore: false, oldestCursor: null }));
  }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ noServer: true, autoPong: false });
upstream.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').split('?')[0] !== '/v1/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const c: Conn = { ws, auth: req.headers.authorization, got: [] };
    conns.push(c);
    ws.on('ping', (d) => autoPong && ws.pong(d));
    ws.on('message', (d) => c.got.push(JSON.parse(String(d))));
  });
});

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out: ${what}`);
};
const frame = (c: Conn, f: unknown) => c.ws.send(typeof f === 'string' ? f : JSON.stringify(f));

before(() => new Promise<void>((r) => upstream.listen(Number(new URL(process.env.KLATCHLY_UPSTREAM!).port), '127.0.0.1', () => r())));
after(async () => {
  for (const c of conns) c.ws.terminate();
  await new Promise<void>((r) => upstream.close(() => r()));
});

test('persistent socket: subscribed to every chat with the token; its events into the core; closed on stop', async () => {
  const events: SourceEvent[] = [];
  const frames: unknown[] = [];
  const feed: SourceFeed = { event: (e) => void events.push(e), toBrowsers: (f) => void frames.push(f) };
  const ev = new BeeperEvents(feed);
  ev.start();
  await until(() => conns.length === 1 && conns[0]!.got.length === 1, 'connected');
  const c = conns[0]!;
  assert.equal(c.auth, 'Bearer test-token');
  assert.deepEqual(c.got, [{ type: 'subscriptions.set', chatIDs: ['*'] }]);
  frame(c, { type: 'ready' });
  frame(c, { type: 'chat.upserted', entries: [{ id: 'c1', unreadCount: 1 }] });
  frame(c, { type: 'message.upserted', entries: [{ id: 'm1', chatID: 'c1', text: 'hi' }] });
  // Ignored: no entries, not JSON, binary, other types.
  frame(c, { type: 'chat.upserted' });
  frame(c, 'not json');
  c.ws.send(Buffer.from('{"type":"ready"}'), { binary: true });
  frame(c, { type: 'chat.deleted', entries: [{ id: 'c1' }] });
  await until(() => events.length >= 3, 'events');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(events, [
    { type: 'ready' },
    { type: 'chat.upserted', entries: [{ id: 'c1', unreadCount: 1 }] },
    { type: 'message.upserted', entries: [{ id: 'm1', chatID: 'c1', text: 'hi' }] },
  ]);
  ev.stop();
  await until(() => events.at(-1)?.type === 'closed', 'closed event');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(conns.length, 1, 'no reconnection once stopped');
});

test("persistent socket in the app: 'ready' recounts the badge from the chat list; the upstream's end, then a reconnection", async () => {
  conns.length = 0;
  const before = badgeCount();
  await registry.start();
  await until(() => conns.length === 1 && conns[0]!.got.length === 1, 'connected');
  frame(conns[0]!, { type: 'ready' });
  // u1's 3 unread count; u2 is muted.
  await until(() => badgeCount() === before + 3, 'badge recounted');
  conns[0]!.ws.close();
  await until(() => conns.length === 2, 'reconnected after the upstream closed');
  await registry.stop();
  conns.length = 0;
});

test('live session: queued subscriptions, frames to the sink, pings answered or not, close', async () => {
  const got: string[] = [];
  let ended = 0;
  const s = openLive({ frame: (t) => void got.push(t), closed: () => void ended++ });
  s.subscribe(['c1']);
  await until(() => conns.length === 1 && conns[0]!.got.length === 1, 'subscription sent once open');
  const c = conns[0]!;
  assert.deepEqual(c.got, [{ type: 'subscriptions.set', chatIDs: ['c1'] }]);
  frame(c, { type: 'message.upserted', chatID: 'c1', entries: [{ id: 'm1', chatID: 'c1' }] });
  await until(() => got.length === 1, 'frame');
  assert.equal(JSON.parse(got[0]!).type, 'message.upserted');
  // Keepalive: answered, the next ping goes; one left unanswered is tolerated (a busy upstream), two in a row say the
  // socket is dead.
  assert.equal(s.ping(), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.ping(), true);
  await new Promise((r) => setTimeout(r, 50));
  autoPong = false;
  assert.equal(s.ping(), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.ping(), true, 'one pong late: tolerated');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.ping(), false, 'no pong for two pings in a row');
  autoPong = true;
  s.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ended, 0, 'closing it ourselves is not the upstream ending');
  conns.length = 0;
});

test('through /api/ws: validated subscriptions forwarded, domain frames only, the upstream ending closes the browser socket (1011)', async () => {
  const app = createApp(registry);
  const browsers = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1', websocket: { server: browsers } }) as Server;
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  const sid = store.mutate((s) => sessions.create(s));
  const open = () =>
    new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`, { headers: { origin: config().origin, cookie: `sid=${sid}` } });
  try {
    const b = open();
    const down: { type: string }[] = [];
    let code = 0;
    b.on('message', (d) => down.push(JSON.parse(String(d))));
    b.on('close', (c) => (code = c));
    await new Promise((r) => b.once('open', r));
    await until(() => conns.length === 1, 'upstream socket per browser');
    const c = conns[0]!;
    b.send(JSON.stringify({ type: 'subscriptions.set', chatIDs: ['c1', 'c2'] }));
    await until(() => c.got.length === 1, 'subscription forwarded');
    assert.deepEqual(c.got, [{ type: 'subscriptions.set', chatIDs: ['c1', 'c2'] }]);
    for (const f of [
      { type: 'message.upserted', chatID: 'c1', entries: [] },
      { type: 'chat.deleted', chatID: 'c1', entries: [] },
      { type: 'something.else', secret: 1 },
      { type: 'message.delivered', chatID: 'c1' },
    ])
      frame(c, f);
    frame(c, 'not json');
    await until(() => down.some((f) => f.type === 'chat.deleted'), 'frames');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(down.map((f) => f.type).filter((t) => t !== 'keepalive'), ['message.upserted', 'chat.deleted']);
    // The upstream goes away: the browser's socket closes with 1011.
    c.ws.close();
    await until(() => code !== 0, 'browser closed');
    assert.equal(code, 1011);

    // A malformed subscription: the browser's socket closes (1008), nothing reaches upstream.
    const b2 = open();
    let code2 = 0;
    b2.on('close', (x) => (code2 = x));
    await new Promise((r) => b2.once('open', r));
    await until(() => conns.length === 2, 'second upstream socket');
    b2.send(JSON.stringify({ type: 'subscriptions.set', chatIDs: ['*', 'c1'] }));
    await until(() => code2 !== 0, 'refused');
    assert.equal(code2, 1008);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(conns[1]!.got, []);
    await until(() => conns[1]!.ws.readyState === WebSocket.CLOSED, 'its upstream socket closed too');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    browsers.close();
  }
});

test("the persistent socket's backoff starts over only after a lasting connection, not on each 'ready'", () => {
  // Dropped for missed pongs (2 pings of 25 s unanswered): up about a minute, the backoff goes on growing.
  assert.equal(attemptAfter(4, 60_000), 4);
  assert.equal(attemptAfter(4, undefined), 4, 'never ready');
  assert.ok(STABLE_MS > 75_000, 'longer than the slowest drop for missed pongs');
  assert.equal(attemptAfter(4, STABLE_MS), 0);
});
