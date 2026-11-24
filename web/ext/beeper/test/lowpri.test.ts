import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { relay } from '#core/relay.js';
import { lowPriorityPlan, mutedByMove } from '../server/lowpri.js';
import { mockUpstream } from '../../../test/mock.js';
import './setup.js';
import { badgeCount, noteChat } from '#core/badgecount.js';

// Upstream state of the two chats (Matrix room ids: '!' and the name below); PATCH applies the body and answers with
// the chat.
const chats: Record<string, { id: string; isMuted: boolean; isLowPriority: boolean }> = {
  quiet: { id: '!quiet', isMuted: false, isLowPriority: false },
  muted: { id: '!muted', isMuted: true, isLowPriority: false },
};
const routes: Parameters<typeof mockUpstream>[0] = {};
for (const id of Object.keys(chats)) {
  routes[`GET /v1/chats/!${id}`] = () => [200, chats[id]];
  routes[`PATCH /v1/chats/!${id}`] = (_req, body) => {
    Object.assign(chats[id]!, JSON.parse(body));
    return [200, chats[id]];
  };
}
const up = mockUpstream(routes);
const app = new Hono().route('/api', relay);
const patch = (id: string, body: unknown) =>
  app.request(`/api/chats/!${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const lastPatch = () => JSON.parse(up.calls.filter((c) => c.method === 'PATCH').pop()!.body) as Record<string, unknown>;

before(() => up.start());
after(() => up.stop());

test('plan: moving in mutes; moving back unmutes only what the move muted', () => {
  assert.deepEqual(lowPriorityPlan(true, false, false), { patch: { isLowPriority: true, isMuted: true }, mutedByMove: true });
  assert.deepEqual(lowPriorityPlan(true, true, false), { patch: { isLowPriority: true }, mutedByMove: false });
  assert.deepEqual(lowPriorityPlan(true, true, true), { patch: { isLowPriority: true }, mutedByMove: true });
  assert.deepEqual(lowPriorityPlan(false, true, true), { patch: { isLowPriority: false, isMuted: false }, mutedByMove: false });
  assert.deepEqual(lowPriorityPlan(false, true, false), { patch: { isLowPriority: false }, mutedByMove: false });
});

test('an unmuted chat is muted by the move and unmuted on the way back', async () => {
  let r = await patch('quiet', { isLowPriority: true });
  assert.equal(r.status, 200);
  assert.deepEqual(lastPatch(), { isLowPriority: true, isMuted: true });
  assert.ok(mutedByMove('!quiet'));
  r = await patch('quiet', { isLowPriority: false });
  assert.equal(r.status, 200);
  assert.deepEqual(lastPatch(), { isLowPriority: false, isMuted: false });
  assert.deepEqual(await r.json(), { id: '!quiet', isMuted: false, isLowPriority: false });
  assert.ok(!mutedByMove('!quiet'));
});

test('a chat the user muted stays muted', async () => {
  await patch('muted', { isLowPriority: true });
  assert.deepEqual(lastPatch(), { isLowPriority: true });
  await patch('muted', { isLowPriority: false });
  assert.deepEqual(lastPatch(), { isLowPriority: false });
  assert.equal(chats.muted!.isMuted, true);
});

test('an explicit mute choice while in low priority is kept on the way back', async () => {
  await patch('quiet', { isLowPriority: true });
  await patch('quiet', { isMuted: true });
  assert.deepEqual(lastPatch(), { isMuted: true });
  assert.ok(!mutedByMove('!quiet'));
  await patch('quiet', { isLowPriority: false });
  assert.deepEqual(lastPatch(), { isLowPriority: false });
  assert.equal(chats.quiet!.isMuted, true);
});

test('low priority is a boolean sent alone', async () => {
  const before = up.calls.length;
  for (const b of [{ isLowPriority: 'yes' }, { isLowPriority: true, isPinned: true }, { isLowPriority: true, isMuted: false }, { isLowPriority: null }]) {
    assert.equal((await patch('quiet', b)).status, 400, JSON.stringify(b));
  }
  assert.equal(up.calls.length, before);
});

test('the badge follows Klatchly\'s own moves at once, without waiting for chat.upserted', async () => {
  chats.badged = { id: '!badged', isMuted: false, isLowPriority: false };
  routes['GET /v1/chats/!badged'] = () => [200, chats.badged];
  routes['PATCH /v1/chats/!badged'] = (_req, body) => [200, Object.assign(chats.badged!, JSON.parse(body))];
  routes['POST /v1/chats/!badged/archive'] = () => [200, {}];
  noteChat({ id: '!badged', unreadCount: 3, isMuted: false, isArchived: false, isLowPriority: false });
  const base = badgeCount();
  await patch('badged', { isLowPriority: true });
  assert.equal(badgeCount(), base - 3, 'low priority leaves the badge');
  await patch('badged', { isLowPriority: false });
  assert.equal(badgeCount(), base, 'and comes back');
  const r = await app.request('/api/chats/!badged/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
  assert.equal(r.status, 200);
  assert.equal(badgeCount(), base - 3, 'archived leaves the badge');
});
