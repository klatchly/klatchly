import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutQueries, keptKey, LOOKUP_STALE_MS, MAX_CONVERSATIONS, MAX_LOOKUPS, type CutQuery } from '../client/src/persistcut.js';

// What the stored copy of the query cache keeps (client/src/persistcut.ts): single messages (reply quotes, reaction
// previews) too since 2026-11-18, bounded, as they are; the rest as before.

const q = (key: unknown[], at: number, data: unknown = { pages: [1, 2, 3, 4], pageParams: [0, 1, 2, 3] }): CutQuery => ({
  queryKey: key,
  queryHash: JSON.stringify(key),
  state: { data, dataUpdatedAt: at, status: 'success' },
});

test('kept keys: lists, chats, conversations, accounts, single messages; not search results or the low-priority inbox', () => {
  for (const k of ['chats', 'chat', 'messages', 'accounts', 'message', 'reaction-target']) assert.ok(keptKey(k), k);
  for (const k of ['chats-lowpri', 'search-chats', 'search-messages', 'extensions', 'quiet']) assert.ok(!keptKey(k), k);
});

test('single messages: the newest MAX_LOOKUPS, with their own time (fresh when restored, until their age)', () => {
  const lookups = Array.from({ length: MAX_LOOKUPS + 5 }, (_, i) => q(['message', 'c', `m${i}`], 100 + i, { id: `m${i}` }));
  const out = cutQueries([...lookups, q(['reaction-target', 'c', 'm1', 'r1'], 50, { id: 'm1' })], 10_000);
  const kept = out.filter((x) => x.queryKey[0] === 'message' || x.queryKey[0] === 'reaction-target');
  assert.equal(kept.length, MAX_LOOKUPS);
  assert.ok(!kept.some((x) => x.queryKey[0] === 'reaction-target'), 'the oldest go first');
  assert.ok(kept.every((x) => x.state.dataUpdatedAt >= 100), 'their time is kept');
  assert.deepEqual(kept.find((x) => x.queryKey[2] === `m${MAX_LOOKUPS + 4}`)?.state.data, { id: `m${MAX_LOOKUPS + 4}` });
});

test('lists and conversations: cut and marked old, as before; the network filter lists too', () => {
  const convs = Array.from({ length: MAX_CONVERSATIONS + 2 }, (_, i) => q(['messages', `c${i}`], i + 1));
  const out = cutQueries([q(['chats'], 5), q(['chats', 'acc1'], 5), ...convs, q(['search-chats', 'x'], 5)]);
  const lists = out.filter((x) => x.queryKey[0] === 'chats');
  assert.equal(lists.length, 2);
  for (const l of lists) {
    assert.equal((l.state.data as { pages: unknown[] }).pages.length, 3);
    assert.equal(l.state.dataUpdatedAt, 1);
  }
  const kept = out.filter((x) => x.queryKey[0] === 'messages');
  assert.equal(kept.length, MAX_CONVERSATIONS);
  assert.ok(kept.every((x) => (x.state.data as { pages: unknown[] }).pages.length === 2));
  assert.ok(!out.some((x) => x.queryKey[0] === 'search-chats'));
});

test('single messages older than LOOKUP_STALE_MS are not stored (an edit or a deletion made meanwhile is read again)', () => {
  const now = 100 * LOOKUP_STALE_MS;
  const out = cutQueries([q(['message', 'c', 'old'], now - LOOKUP_STALE_MS - 1, { id: 'old' }), q(['message', 'c', 'young'], now - 1000, { id: 'young' }), q(['reaction-target', 'c', 't', 'r'], now - LOOKUP_STALE_MS, { id: 't' })], now);
  assert.deepEqual(
    out.map((x) => x.queryKey[2]),
    ['young'],
  );
  assert.equal(out[0]!.state.dataUpdatedAt, now - 1000, 'as it is: still fresh when restored');
});
