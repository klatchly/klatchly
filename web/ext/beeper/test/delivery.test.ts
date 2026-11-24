import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  deliveredFor,
  enrichFrame,
  flushDelivered,
  markDelivered,
  onDeliveryEvent,
  resetDeliveryState,
  setPeerResolver,
  trackDelivery,
  type DeliveryEvent,
} from '../server/delivery.js';
import { relay } from '#core/relay.js';
import { deliveryReceipts, keepDelivered } from '../../../client/src/receipts.js';
import { useConnectorTraits } from '../../../client/src/connectors.js';
import { beeperTraits } from '../client/traits.js';
import type { Message } from '../../../client/src/types.js';
import { mockUpstream } from '../../../test/mock.js';
import './setup.js';

const PEER = '@whatsapp_lid-123:beeper.local';
const ME = '@me:beeper.com';
const NOW = Date.parse('2026-11-01T10:00:00Z');

// !c1: WhatsApp 1:1 (through the real upstream lookup, mocked); sg: Signal 1:1; grp: a group; tg: a 1:1 on another network.
const up = mockUpstream({
  'GET /v1/chats/!c1': () => [200, { id: '!c1', type: 'single', network: 'WhatsApp', participants: { items: [{ id: ME, isSelf: true }, { id: PEER }] } }],
  'GET /v1/chats/grp': () => [200, { id: 'grp', type: 'group', network: 'WhatsApp', participants: { items: [{ id: ME, isSelf: true }, { id: 'a' }, { id: 'b' }] } }],
  'GET /v1/chats/sg': () => [200, { id: 'sg', type: 'single', network: 'Signal', participants: { items: [{ id: ME, isSelf: true }, { id: 'sgpeer' }] } }],
  'GET /v1/chats/tg': () => [200, { id: 'tg', type: 'single', network: 'Telegram', participants: { items: [{ id: ME, isSelf: true }, { id: 'tgpeer' }] } }],
  'GET /v1/chats/!c1/messages': () => [200, { items: [msg({ id: 'm1' }), msg({ id: 'm0', isSender: false, senderID: PEER })], hasMore: false }],
  'GET /v1/chats/!c1/messages/m1': () => [200, msg({ id: 'm1' })],
});
before(() => up.start());
after(() => up.stop());

beforeEach(() => {
  resetDeliveryState();
  setPeerResolver(null);
  writeFileSync(join(process.env.KLATCHLY_DATA_DIR!, 'delivered.json'), '{"v":1,"items":[]}\n');
});

function msg(o: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'm1', chatID: '!c1', accountID: 'whatsapp', senderID: ME, isSender: true, type: 'TEXT', text: 'Salut', timestamp: new Date(NOW).toISOString(), sortKey: '1', ...o };
}
const pending = (o: Record<string, unknown> = {}) => msg({ sendStatus: { status: 'PENDING', deliveredToUsers: [] }, ...o });

/** Feeds upserts one by one, as the upstream socket does, at NOW + i seconds. */
async function feed(...list: Record<string, unknown>[]) {
  for (const [i, m] of list.entries()) await trackDelivery([m], NOW + i * 1000);
}

test('(a) pending, pending, confirmed, identical upsert: delivered at the last one, once', async () => {
  const events: DeliveryEvent[] = [];
  const off = onDeliveryEvent((e) => events.push(e));
  await feed(pending(), pending({ seen: { [ME]: 'x' } }), msg({ seen: { [ME]: 'x' } }));
  assert.equal(deliveredFor('!c1', 'm1'), undefined, 'not on the confirmation itself');
  await feed(pending(), pending({ seen: { [ME]: 'x' } }), msg({ seen: { [ME]: 'x' } }), msg({ seen: { [ME]: 'x' } }));
  assert.deepEqual(deliveredFor('!c1', 'm1'), { [PEER]: new Date(NOW + 3000).toISOString() });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'message.delivered', chatID: '!c1', messageID: 'm1', delivered: { [PEER]: new Date(NOW + 3000).toISOString() } });
  // More identical upserts change nothing.
  await feed(msg({ seen: { [ME]: 'x' } }), msg({ seen: { [ME]: 'x' } }));
  assert.equal(events.length, 1);
  off();
});

test('(a) a message first seen confirmed (ID changed, sent elsewhere) counts only when recent', async () => {
  await feed(msg({ id: 'fresh' }), msg({ id: 'fresh' }));
  assert.ok(deliveredFor('!c1', 'fresh'));
  const old = new Date(NOW - 3600_000).toISOString();
  await feed(msg({ id: 'old', timestamp: old }), msg({ id: 'old', timestamp: old }));
  assert.equal(deliveredFor('!c1', 'old'), undefined);
});

test('(a) Signal 1:1: the same sequence (pending, pending, confirmed, identical upsert ≈ 2.5 s later)', async () => {
  const o = { id: 's1', chatID: 'sg', accountID: 'local-signal_x' };
  await feed(pending(o), pending({ ...o, seen: { [ME]: 'x' } }), msg({ ...o, seen: { [ME]: 'x' } }));
  assert.equal(deliveredFor('sg', 's1'), undefined, 'not on the confirmation itself');
  await feed(msg({ ...o, seen: { [ME]: 'x' } }));
  assert.deepEqual(Object.keys(deliveredFor('sg', 's1') ?? {}), ['sgpeer']);
});

test('(b) after the confirmation, a changed upsert is not a delivery', async () => {
  const changes: Record<string, unknown>[] = [
    { links: [{ url: 'https://example.org', title: 'Example' }] },
    { reactions: [{ id: 'r', reactionKey: '👍', participantID: ME }] },
    { text: 'Salut !', editedTimestamp: new Date(NOW + 5000).toISOString() },
    { attachments: [{ type: 'img', srcURL: 'mxc://x/y' }] },
    { isDeleted: true },
  ];
  for (const [i, ch] of changes.entries()) {
    const id = `b${i}`;
    await feed(pending({ id }), msg({ id }), msg({ id, ...ch }));
    assert.equal(deliveredFor('!c1', id), undefined, JSON.stringify(ch));
  }
  // Volatile fields (sort key, timestamp) are not content.
  await feed(pending({ id: 'v' }), msg({ id: 'v', sortKey: '1' }), msg({ id: 'v', sortKey: '2' }));
  assert.ok(deliveredFor('!c1', 'v'));
  // Still pending twice in a row: not confirmed yet.
  await feed(pending({ id: 'p' }), pending({ id: 'p' }));
  assert.equal(deliveredFor('!c1', 'p'), undefined);
  // Others' messages and reaction events are never tracked.
  await feed(msg({ id: 'o', isSender: false, senderID: PEER }), msg({ id: 'o', isSender: false, senderID: PEER }));
  await feed(msg({ id: 'r', type: 'REACTION', isHidden: true }), msg({ id: 'r', type: 'REACTION', isHidden: true }));
  assert.equal(deliveredFor('!c1', 'o'), undefined);
  assert.equal(deliveredFor('!c1', 'r'), undefined);
});

test('(c) seen by the other participant: delivered (at the read time); our own seen is not', async () => {
  await feed(pending({ id: 's' }), msg({ id: 's', seen: { [ME]: 'x' } }));
  assert.equal(deliveredFor('!c1', 's'), undefined);
  await feed(msg({ id: 's', seen: { [ME]: 'x', [PEER]: '2026-11-01T10:05:00Z' } }));
  assert.deepEqual(deliveredFor('!c1', 's'), { [PEER]: '2026-11-01T10:05:00Z' });
  // A seen key that is not the chat's peer is ignored.
  await feed(msg({ id: 's2', seen: { stranger: 'x' } }));
  assert.equal(deliveredFor('!c1', 's2'), undefined);
});

test('(d) groups, other networks and chats upstream does not know: never', async () => {
  for (const chatID of ['grp', 'tg', 'other:u1']) {
    await feed(pending({ chatID }), msg({ chatID }), msg({ chatID }), msg({ chatID, seen: { a: 'x', tgpeer: 'x' } }));
    assert.equal(deliveredFor(chatID, 'm1'), undefined, chatID);
  }
  // A failed lookup (upstream error) marks nothing.
  setPeerResolver(async () => {
    throw new Error('down');
  });
  await feed(pending({ id: 'e' }), msg({ id: 'e' }), msg({ id: 'e' }));
  assert.equal(deliveredFor('!c1', 'e'), undefined);
});

test('(e) persistence: round trip, age and size bounds', async () => {
  const file = join(process.env.KLATCHLY_DATA_DIR!, 'delivered.json');
  markDelivered('!c1', 'p1', PEER, '2026-11-01T10:00:00Z');
  flushDelivered();
  resetDeliveryState();
  assert.deepEqual(deliveredFor('!c1', 'p1'), { [PEER]: '2026-11-01T10:00:00Z' });

  const now = Date.now();
  const items: unknown[] = [['!c1', 'ancient', { [PEER]: 'x' }, now - 61 * 24 * 3600_000], ['!c1', 'bad', 'nope', now], ['!c1', 'recent', { [PEER]: 'y' }, now]];
  for (let i = 0; i < 20_005; i++) items.push(['c2', `n${i}`, { [PEER]: 'z' }, now]);
  writeFileSync(file, JSON.stringify({ v: 1, items }));
  resetDeliveryState();
  assert.equal(deliveredFor('!c1', 'ancient'), undefined, 'older than 60 days');
  assert.equal(deliveredFor('!c1', 'bad'), undefined);
  assert.equal(deliveredFor('!c1', 'recent'), undefined, 'oldest out first beyond 20k');
  assert.ok(deliveredFor('c2', 'n20004'));
  flushDelivered();
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { items: unknown[] }).items.length, 20_000);

  writeFileSync(file, 'not json');
  resetDeliveryState();
  assert.equal(deliveredFor('c2', 'n1'), undefined, 'a broken file starts empty');
});

test('(f) relay pages and messages, forwarded upserts and the client cache keep delivered', async () => {
  markDelivered('!c1', 'm1', PEER, '2026-11-01T10:00:02Z');
  const app = new Hono().route('/api', relay);
  const page = (await (await app.request('/api/chats/!c1/messages')).json()) as { items: Message[] };
  assert.deepEqual(page.items[0]!.delivered, { [PEER]: '2026-11-01T10:00:02Z' });
  assert.equal(page.items[1]!.delivered, undefined);
  const one = (await (await app.request('/api/chats/!c1/messages/m1')).json()) as Message;
  assert.deepEqual(one.delivered, { [PEER]: '2026-11-01T10:00:02Z' });

  const frame = JSON.stringify({ type: 'message.upserted', chatID: '!c1', entries: [msg(), msg({ id: 'other' })] });
  const out = JSON.parse(enrichFrame(frame)) as { entries: Message[] };
  assert.deepEqual(out.entries[0]!.delivered, { [PEER]: '2026-11-01T10:00:02Z' });
  assert.equal(out.entries[1]!.delivered, undefined);
  const untouched = JSON.stringify({ type: 'message.upserted', chatID: '!c1', entries: [msg({ id: 'other' })] });
  assert.equal(enrichFrame(untouched), untouched);
  assert.equal(enrichFrame('{"type":"chat.upserted","entries":[]}'), '{"type":"chat.upserted","entries":[]}');

  // Client: a later copy without delivered keeps the cached one (its traits: no fullDelivery); the ticks show delivered.
  useConnectorTraits([beeperTraits]);
  const cached = { ...(msg() as unknown as Message), delivered: { [PEER]: 'x' } };
  const later = msg({ text: 'Salut' }) as unknown as Message;
  assert.deepEqual(keepDelivered(cached, later).delivered, { [PEER]: 'x' });
  assert.equal(deliveryReceipts([{ items: [keepDelivered(cached, later)] }], new Set([ME])).get('m1'), PEER);
});
