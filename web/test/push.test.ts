import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRequest, MAX_MESSAGE_BYTES, parseSubscription, serialize, validEndpoint, wireMessage, type Payload } from '../server/push.js';
import { badgeCount, handleEvent, isNotifiable, noteChat, noteRead, payloadFor } from '../server/pushwatch.js';
import { reseedUnread } from '../server/badgecount.js';
import { parseClientMessage, setView, spaceViewedBy, suppressed } from '../server/ws.js';
import { store } from '../server/context.js';
import { vapid } from '../server/vapid.js';
import { fakeBrowser, verifyVapid } from './webpush.js';
import { fakeSource, withFake } from './fakesource.js';
import { rmSync, writeFileSync } from 'node:fs';
import { dataPath } from '../server/config.js';
import { resetQuiet } from '../server/quiet.js';

test('endpoint allowlist', () => {
  for (const u of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
    'https://jmt17.google.com/fcm/send/abc',
  ]) assert.ok(validEndpoint(u), u);
  for (const u of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://evil.com/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.com/x',
    'https://beeper-server:23373/v1/chats',
    'https://127.0.0.1/x',
    'https://x.jmt17.google.com/fcm/send/abc',
    'https://google.com/x',
    'file:///etc/passwd',
    42,
  ]) assert.ok(!validEndpoint(u), String(u));
});

test('subscription parsing', () => {
  const b = fakeBrowser();
  const ok = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: b.keys };
  assert.deepEqual(parseSubscription(ok), { endpoint: ok.endpoint, ...b.keys });
  assert.equal(parseSubscription({ ...ok, extra: 1 }), null);
  assert.equal(parseSubscription({ ...ok, keys: { ...b.keys, auth: 'AAAA' } }), null);
  assert.equal(parseSubscription({ ...ok, keys: { ...b.keys, p256dh: Buffer.alloc(65, 5).toString('base64url') } }), null);
  assert.equal(parseSubscription({ ...ok, endpoint: 'https://example.com/x' }), null);
  assert.deepEqual(parseSubscription({ ...ok, lang: 'fr' }), { endpoint: ok.endpoint, ...b.keys, lang: 'fr' });
  assert.equal(parseSubscription({ ...ok, lang: 'xx' }), null);
  assert.equal(parseSubscription({ ...ok, lang: 42 }), null);
  assert.deepEqual(parseSubscription({ ...ok, lang: 'fr', declarative: true }), { endpoint: ok.endpoint, ...b.keys, lang: 'fr', declarative: true });
  assert.deepEqual(parseSubscription({ ...ok, declarative: false }), { endpoint: ok.endpoint, ...b.keys });
  assert.equal(parseSubscription({ ...ok, declarative: 'yes' }), null);
});

test('aes128gcm payload decrypts in a fake browser; VAPID JWT is valid', () => {
  const b = fakeBrowser();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
  const payload = { title: 'Alice · Famille', body: 'Salut 👋', tag: '!room:beeper.local', url: '/chat/%21room%3Abeeper.local' };
  const req = buildRequest({ endpoint, ...b.keys, lang: 'fr' }, payload);
  const h = req.headers as Record<string, string>;
  assert.equal(h['Content-Encoding'], 'aes128gcm');
  assert.equal(h['Content-Type'], 'application/octet-stream');
  assert.equal(String(h.TTL), '21600');
  assert.equal(h.Urgency, 'high');
  assert.match(h.Topic!, /^[A-Za-z0-9_-]{32}$/);
  const claims = verifyVapid(h.Authorization!, endpoint, vapid().publicKey);
  assert.equal(claims.sub, 'mailto:push@localhost.invalid');
  const m = JSON.parse(b.decrypt(req.body as Buffer)) as { web_push: number; notification: { navigate: string }; title: string; url: string };
  assert.deepEqual(m as unknown, wireMessage(payload, { lang: 'fr' }));
  assert.equal(m.web_push, 8030);
  assert.equal(m.notification.navigate, 'http://localhost:3095/chat/%21room%3Abeeper.local');
  // Legacy copy for a device not known to run the new service worker.
  assert.equal(m.title, payload.title);
  assert.equal(m.url, payload.url);
});

const chatPayload: Payload = {
  title: 'Alice',
  body: 'Salut',
  tag: '!a:b',
  url: '/chat/!a%3Ab',
  ts: 1793275455000,
  chatID: '!a:b',
  badge: 4,
  labels: { reply: 'Répondre', read: 'Marquer comme lu', placeholder: 'Message', replyFailed: 'Réponse non envoyée' },
};

test('declarative message: shape, absolute navigate, badge, language; mutable only for new service workers', () => {
  const m = wireMessage(chatPayload, { lang: 'fr', declarative: true });
  assert.deepEqual(m, {
    web_push: 8030,
    notification: {
      title: 'Alice',
      body: 'Salut',
      navigate: 'http://localhost:3095/chat/!a%3Ab',
      tag: '!a:b',
      lang: 'fr',
      dir: 'auto',
      silent: false,
      icon: 'http://localhost:3095/icon-192.png',
      timestamp: 1793275455000,
      data: { chatID: '!a:b', labels: chatPayload.labels },
    },
    app_badge: 4,
    mutable: true,
  });
  // Device whose worker may predate the format: not mutable (iOS shows it without the worker), plus the
  // flat fields an older worker reads (declarative parsers ignore unknown members).
  const legacy = wireMessage(chatPayload, {});
  assert.equal(legacy.mutable, false);
  assert.equal((legacy.notification as { lang: string }).lang, 'en', 'default language');
  for (const [k, v] of Object.entries(chatPayload)) assert.deepEqual(legacy[k], v, k);
  // No title: still a non-empty one (required by the declarative parser).
  assert.equal((wireMessage({ ...chatPayload, title: '' }, {}).notification as { title: string }).title, '•');
});

test('declarative message: badge from the unread total when the payload has none', () => {
  const m = wireMessage({ title: 'T', body: 'b', tag: 'test', url: '/' }, { declarative: true });
  assert.equal(typeof m.app_badge, 'number', 'pushwatch registers the badge source');
  assert.equal((m.notification as { navigate: string }).navigate, 'http://localhost:3095/');
  assert.equal((m.notification as { data?: unknown }).data, undefined);
});

test('message size stays under the push service limit', () => {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  // Long but realistic: full texts and a long bridged room ID, legacy copy included.
  const longID = `!${'x'.repeat(120)}:beeper.local`;
  const big = { ...chatPayload, title: '😀'.repeat(80), body: '😀'.repeat(180), chatID: longID, tag: longID, url: `/chat/${encodeURIComponent(longID)}` };
  const s1 = serialize(wireMessage(big, { lang: 'fr' }));
  assert.ok(bytes(s1) <= MAX_MESSAGE_BYTES, String(bytes(s1)));
  assert.equal(JSON.parse(s1).chatID, longID, 'legacy copy kept when it fits');
  // Absurd IDs: legacy copy dropped, then texts trimmed; always valid declarative JSON.
  const huge = 'é'.repeat(900);
  const s2 = serialize(wireMessage({ ...big, chatID: huge, tag: huge, url: `/chat/${encodeURIComponent(huge)}` }, {}));
  assert.ok(bytes(s2) <= MAX_MESSAGE_BYTES, String(bytes(s2)));
  const m2 = JSON.parse(s2);
  assert.equal(m2.web_push, 8030);
  assert.ok(m2.notification.title && m2.notification.navigate);
  // The request body (encrypted, one record) fits in 4096 bytes.
  const b = fakeBrowser();
  const req = buildRequest({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', ...b.keys }, { ...big, chatID: huge, tag: huge, url: `/chat/${encodeURIComponent(huge)}` });
  assert.ok((req.body as Buffer).length <= 4096, String((req.body as Buffer).length));
});

test('notifiable messages', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  const m = { id: '1', chatID: 'c', timestamp: '2026-10-28T09:59:00Z', text: 'hi', type: 'TEXT' };
  assert.ok(isNotifiable(m, now));
  assert.ok(!isNotifiable({ ...m, isSender: true }, now));
  assert.ok(!isNotifiable({ ...m, isHidden: true }, now));
  assert.ok(!isNotifiable({ ...m, isDeleted: true }, now));
  assert.ok(!isNotifiable({ ...m, editedTimestamp: '2026-10-28T09:59:30Z' }, now));
  assert.ok(!isNotifiable({ ...m, type: 'REACTION' }, now));
  assert.ok(!isNotifiable({ ...m, timestamp: '2026-10-28T09:00:00Z' }, now));
  // Arrivals and departures in groups (membership.ts), as beeper-server sends them: no type.
  const { type: _type, ...untyped } = m;
  assert.ok(!isNotifiable({ ...untyped, text: 'Yuichiro joined the chat' }, now));
  assert.ok(!isNotifiable({ ...untyped, text: 'Yuichiro was invited to the chat' }, now));
  assert.ok(isNotifiable({ ...m, text: 'I joined the chat late, sorry' }, now));
  assert.ok(isNotifiable({ ...m, text: 'Dad left the group.' }, now), 'typed by someone: a message');
});

test('payload text', () => {
  const long = 'x'.repeat(300);
  assert.deepEqual(payloadFor({ id: '1', chatID: '!a:b', senderName: 'Alice', text: long, type: 'TEXT' }, { title: 'Alice', type: 'single' }, 'fr', 3), {
    title: 'Alice',
    body: `${'x'.repeat(119)}…`,
    tag: '!a:b',
    url: '/chat/!a%3Ab',
    chatID: '!a:b',
    badge: 3,
    labels: { reply: 'Répondre', read: 'Marquer comme lu', placeholder: 'Message', replyFailed: 'Réponse non envoyée' },
  });
  assert.equal(payloadFor({ id: '1', chatID: 'c', type: 'TEXT', text: 'x' }, { title: 'X', type: 'single' }).labels?.read, 'Mark as read');
  const g = payloadFor({ id: '1', chatID: 'c', senderName: 'Bob', type: 'IMAGE' }, { title: 'Famille', type: 'group' });
  assert.equal(g.title, 'Bob · Famille');
  assert.equal(g.body, '📷 Photo');
  assert.equal(payloadFor({ id: '1', chatID: 'c', type: 'FILE' }, { title: 'X', type: 'single' }).body, '📎 Attachment');
  assert.equal(payloadFor({ id: '1', chatID: 'c', type: 'FILE' }, { title: 'X', type: 'single' }, 'fr').body, '📎 Pièce jointe');
  assert.equal(payloadFor({ id: '1', chatID: 'c', type: 'VIDEO' }, { title: 'X', type: 'single' }, 'fr').body, '🎥 Vidéo');
  assert.equal(payloadFor({ id: '1', chatID: 'c', type: 'VIDEO' }, { title: 'X', type: 'single' }, 'xx').body, '🎥 Video');
});

// Watcher -> push service, end to end against local mocks.
// The chats as their connector (a fake one) describes them.
const src = fakeSource();
for (const c of [
  { id: 'c1', title: 'Famille', type: 'group', isMuted: false },
  { id: 'muted', title: 'M', type: 'single', isMuted: true },
  { id: 'c2', title: 'Bob', type: 'single', isMuted: false },
  { id: 'lowpri', title: 'Bank', type: 'single', isMuted: false, isLowPriority: true },
]) src.chats.set(c.id, c);
withFake(src);
const received: { url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
let pushStatus = 201;
const pushSrv = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (d: Buffer) => chunks.push(d));
  req.on('end', () => {
    received.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(pushStatus).end();
  });
});
const browser = fakeBrowser();
let endpoint = '';

before(async () => {
  await new Promise<void>((r) => pushSrv.listen(0, '127.0.0.1', () => r()));
  endpoint = `http://127.0.0.1:${(pushSrv.address() as AddressInfo).port}/push/sub1`;
  // Stored directly: the subscribe route would (rightly) refuse a non push-service endpoint.
  store.mutate((s) => {
    s.sessions.push({ hash: 'h1', createdAt: Date.now(), lastSeen: Date.now() });
    s.push = [{ id: 'p1', sessionHash: 'h1', endpoint, ...browser.keys, createdAt: Date.now() }];
  });
});
after(async () => {
  pushSrv.close();
});

const msg = (o: Record<string, unknown>) => ({ id: String(Math.random()), chatID: 'c1', senderName: 'Alice', text: 'Coucou', type: 'TEXT', timestamp: new Date().toISOString(), ...o });

test('incoming message -> one encrypted push; duplicates, own, muted, visible are skipped', async () => {
  const m = msg({});
  await handleEvent({ type: 'message.upserted', entries: [m] }, 'fake');
  await handleEvent({ type: 'message.upserted', entries: [m] }, 'fake'); // same message again (e.g. reaction update)
  assert.equal(received.length, 1);
  const r = received[0]!;
  assert.equal(r.headers['content-encoding'], 'aes128gcm');
  verifyVapid(String(r.headers.authorization), endpoint, vapid().publicKey);
  const p = JSON.parse(browser.decrypt(r.body));
  assert.deepEqual(p.title, 'Alice · Famille');
  assert.equal(p.body, 'Coucou');
  assert.equal(p.tag, 'c1');
  assert.equal(p.url, '/chat/c1');
  assert.equal(p.web_push, 8030);
  assert.deepEqual(
    { title: p.notification.title, body: p.notification.body, tag: p.notification.tag, navigate: p.notification.navigate },
    { title: 'Alice · Famille', body: 'Coucou', tag: 'c1', navigate: 'http://localhost:3095/chat/c1' },
  );
  assert.equal(p.app_badge, p.badge);
  assert.ok(p.app_badge >= 1, 'the new message counts');
  assert.equal(p.mutable, false);

  await handleEvent({ type: 'message.upserted', entries: [msg({ isSender: true })] }, 'fake');
  await handleEvent({ type: 'message.upserted', entries: [msg({ chatID: 'muted' })] }, 'fake');
  const tok = {};
  setView(tok, 'h1', { visible: true, focused: true, chatID: null });
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  setView(tok, 'h1', null);
  assert.equal(received.length, 1);

  // A chat muted later (chat.upserted) stops notifications for it.
  await handleEvent({ type: 'chat.upserted', entries: [{ id: 'c1', isMuted: true }] }, 'fake');
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  assert.equal(received.length, 1);
  await handleEvent({ type: 'chat.upserted', entries: [{ id: 'c1', isMuted: false }] }, 'fake');
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  assert.equal(received.length, 2);

  // Low-priority chats never notify, muted or not; moving one back turns notifications on again.
  await handleEvent({ type: 'message.upserted', entries: [msg({ chatID: 'lowpri' })] }, 'fake');
  await handleEvent({ type: 'chat.upserted', entries: [{ id: 'c1', isLowPriority: true }] }, 'fake');
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  assert.equal(received.length, 2);
  await handleEvent({ type: 'chat.upserted', entries: [{ id: 'c1', isLowPriority: false }] }, 'fake');
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  assert.equal(received.length, 3);
});

test('quiet hours hold a chat’s notifications while its window is open (server/quiet.ts)', async () => {
  const m = Math.floor((Date.now() % 86_400_000) / 60_000);
  const open = { from: (m - 10 + 1440) % 1440, to: (m + 10) % 1440, days: [0, 1, 2, 3, 4, 5, 6], tz: 'UTC' };
  const before = received.length;
  writeFileSync(dataPath('quiet.json'), JSON.stringify({ v: 1, accounts: {}, chats: { c1: open } }));
  resetQuiet();
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  assert.equal(received.length, before, 'held: no push');
  // "Never quiet" for this chat: it notifies again.
  writeFileSync(dataPath('quiet.json'), JSON.stringify({ v: 1, accounts: {}, chats: { c1: false } }));
  resetQuiet();
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  assert.equal(received.length, before + 1);
  rmSync(dataPath('quiet.json'), { force: true });
  resetQuiet();
});

test('dead endpoint (410) is pruned; subscriptions of revoked sessions are not used', async () => {
  pushStatus = 410;
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  assert.equal(store.read().push?.length, 0);
  pushStatus = 201;
  store.mutate((s) => {
    s.push = [{ id: 'p2', sessionHash: 'gone-session', endpoint, ...browser.keys, createdAt: Date.now() }];
  });
  const n = received.length;
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  assert.equal(received.length, n);
});

test('suppression rule (per device)', () => {
  const v = (visible: boolean, focused: boolean, chatID: string | null = null) => ({ visible, focused, chatID });
  assert.equal(suppressed([], 'c1'), false);
  assert.equal(suppressed([v(true, true)], 'c1'), true, 'focused window: nothing');
  assert.equal(suppressed([v(true, false, 'c1')], 'c1'), true, 'visible, showing that chat');
  assert.equal(suppressed([v(true, false, 'c1')], 'c2'), false, 'visible, other chat: notify');
  assert.equal(suppressed([v(false, false, 'c1')], 'c1'), false, 'hidden: notify');
  assert.equal(suppressed([v(false, false), v(true, true, 'c9')], 'c1'), true, 'any focused window of the device');
});

test('visibility messages', () => {
  assert.deepEqual(parseClientMessage('{"type":"visibility","visible":true}'), { kind: 'visibility', visible: true, focused: true, chatID: null, space: null });
  assert.deepEqual(parseClientMessage('{"type":"visibility","visible":true,"focused":false,"chatID":"!a:b"}'), {
    kind: 'visibility', visible: true, focused: false, chatID: '!a:b', space: null,
  });
  // A package's space on screen (its id).
  assert.deepEqual(parseClientMessage('{"type":"visibility","visible":true,"focused":true,"chatID":null,"space":"demo"}'), {
    kind: 'visibility', visible: true, focused: true, chatID: null, space: 'demo',
  });
  for (const bad of [
    '{"type":"visibility","visible":"yes"}',
    '{"type":"visibility","visible":true,"focused":1}',
    '{"type":"visibility","visible":true,"chatID":""}',
    '{"type":"visibility","visible":true,"chatID":"a b"}',
    '{"type":"visibility","visible":true,"chatID":42}',
    '{"type":"visibility","visible":true,"extra":1}',
    '{"type":"visibility","visible":true,"space":"Demo"}',
    '{"type":"visibility","visible":true,"space":"../x"}',
    '{"type":"visibility","visible":true,"space":7}',
  ]) assert.equal(parseClientMessage(bad), null, bad);
});

test('subscriptions from the browser: chat ids or *, bounded, for the live feeds', () => {
  assert.deepEqual(parseClientMessage('{"type":"subscriptions.set","chatIDs":["!a:b","c"]}'), { kind: 'subscriptions', chatIDs: ['!a:b', 'c'] });
  assert.deepEqual(parseClientMessage('{"type":"subscriptions.set","chatIDs":["*"]}'), { kind: 'subscriptions', chatIDs: ['*'] });
  for (const bad of [
    '{"type":"subscriptions.set","chatIDs":["*","a"]}',
    `{"type":"subscriptions.set","chatIDs":${JSON.stringify(Array.from({ length: 21 }, (_, i) => `c${i}`))}}`,
    '{"type":"subscriptions.set","chatIDs":[""]}',
    '{"type":"subscriptions.set","chatIDs":["a"],"x":1}',
    '{"type":"other","chatIDs":["a"]}',
  ]) assert.equal(parseClientMessage(bad), null, bad);
});

test("a space's pushes are withheld only from a device looking at that space", () => {
  const w1 = {};
  const w2 = {};
  setView(w1, 'phone', { visible: true, focused: true, chatID: '!chat:x', space: null });
  setView(w2, 'pc', { visible: true, focused: false, chatID: null, space: 'demo' });
  assert.equal(spaceViewedBy('phone', 'demo'), false, 'in the app, but on a chat');
  assert.equal(spaceViewedBy('pc', 'demo'), false, 'space open but not focused');
  setView(w2, 'pc', { visible: true, focused: true, chatID: null, space: 'demo' });
  assert.equal(spaceViewedBy('pc', 'demo'), true);
  assert.equal(spaceViewedBy('pc', 'other'), false, 'another space');
  setView(w1, 'phone', null);
  setView(w2, 'pc', null);
});

test('two devices: only the one in the app is spared', async () => {
  const other = fakeBrowser();
  const otherEndpoint = endpoint.replace('sub1', 'sub2');
  store.mutate((s) => {
    s.sessions.push({ hash: 'h2', createdAt: Date.now(), lastSeen: Date.now() });
    s.push = [
      { id: 'pa', sessionHash: 'h1', endpoint, ...browser.keys, createdAt: Date.now(), lang: 'fr' },
      { id: 'pb', sessionHash: 'h2', endpoint: otherEndpoint, ...other.keys, createdAt: Date.now() },
    ];
  });
  const sockA = {};
  // Device A focused: only B is notified, in its own language (en by default).
  setView(sockA, 'h1', { visible: true, focused: true, chatID: 'c1' });
  let n = received.length;
  await handleEvent({ type: 'message.upserted', entries: [msg({ type: 'IMAGE', text: '' })] }, 'fake');
  assert.equal(received.length, n + 1);
  const r = received[received.length - 1]!;
  assert.equal(r.url, '/push/sub2');
  assert.equal(JSON.parse(other.decrypt(r.body)).body, '📷 Photo');
  // Device A visible but not focused, showing c1: spared for c1 only.
  setView(sockA, 'h1', { visible: true, focused: false, chatID: 'c1' });
  n = received.length;
  await handleEvent({ type: 'message.upserted', entries: [msg({})] }, 'fake');
  assert.equal(received.length, n + 1);
  await handleEvent({ type: 'message.upserted', entries: [msg({ chatID: 'c2', senderName: 'Bob' })] }, 'fake');
  assert.equal(received.length, n + 3);
  const forA = received.slice(-2).find((x) => x.url === '/push/sub1')!;
  const pa = JSON.parse(browser.decrypt(forA.body));
  assert.equal(pa.chatID, 'c2');
  assert.equal(pa.labels.reply, 'Répondre');
  assert.equal(typeof pa.badge, 'number');
  setView(sockA, 'h1', null);

  // Device B re-subscribed with the new service worker: mutable, no legacy copy, labels in notification.data.
  store.mutate((s) => {
    s.push!.find((p) => p.id === 'pb')!.declarative = true;
  });
  n = received.length;
  await handleEvent({ type: 'message.upserted', entries: [msg({ chatID: 'c2', senderName: 'Bob', text: 'Yo' })] }, 'fake');
  const forB = received.slice(n).find((x) => x.url === '/push/sub2')!;
  const pb = JSON.parse(other.decrypt(forB.body));
  assert.equal(pb.mutable, true);
  assert.equal(pb.title, undefined);
  assert.equal(pb.notification.navigate, 'http://localhost:3095/chat/c2');
  assert.equal(pb.notification.lang, 'en');
  assert.deepEqual(pb.notification.data.chatID, 'c2');
  assert.equal(pb.notification.data.labels.reply, 'Reply');
  assert.equal(typeof pb.app_badge, 'number');
});

test('badge count: unread of non-muted, non-archived chats', () => {
  noteChat({ id: 'b1', unreadCount: 2 });
  noteChat({ id: 'b2', unreadCount: 5, isMuted: true });
  noteChat({ id: 'b3', unreadCount: 1, isArchived: true });
  const base = badgeCount();
  noteChat({ id: 'b4', unreadCount: 0 });
  assert.equal(badgeCount('b4'), base + 1, 'a just-received message counts');
  assert.equal(badgeCount('new-chat'), base + 1);
  noteRead('b1');
  assert.equal(badgeCount(), base - 2);
  noteChat({ id: 'b2', isMuted: false });
  assert.equal(badgeCount(), base - 2 + 5, 'partial update keeps unread count');
  noteChat({ id: 'b2', isLowPriority: true });
  assert.equal(badgeCount(), base - 2, 'low-priority chats do not count');
  noteChat({ id: 'b2', unreadCount: 6 });
  assert.equal(badgeCount(), base - 2, 'partial update keeps low priority');
  noteChat({ id: 'b2', isLowPriority: false });
  assert.equal(badgeCount(), base - 2 + 6);
});

test('badge recount replaces stale upstream entries and keeps the others', () => {
  noteChat({ id: 'stale', unreadCount: 7 });
  noteChat({ id: 'keep-me', unreadCount: 1 });
  const before = badgeCount();
  reseedUnread([{ id: 'fresh', unreadCount: 2 }], (id) => id !== 'keep-me');
  assert.equal(badgeCount(), 1 + 2, 'only the kept entry and the fresh list count');
  assert.ok(before >= 8);
});
