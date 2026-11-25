import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Hono } from 'hono';
import { dataPath } from '../server/config.js';
import { chatEventsRoutes, resetChatEvents } from '../server/chatevents.js';
import { membershipOf, membershipRuns, summarize } from '../server/membership.js';

test('membershipOf: the arrivals and departures beeper-server sends (no type), nothing else', () => {
  assert.deepEqual(membershipOf({ text: 'Yuichiro joined the chat' }), { who: 'Yuichiro', kind: 'joined' });
  assert.deepEqual(membershipOf({ text: 'Thibault Enfiedjian was invited to the chat' }), { who: 'Thibault Enfiedjian', kind: 'invited' });
  assert.deepEqual(membershipOf({ text: 'Kai left the chat' }), { who: 'Kai', kind: 'left' });
  assert.deepEqual(membershipOf({ text: 'Kai was removed from the group' }), { who: 'Kai', kind: 'removed' });
  assert.equal(membershipOf({ text: 'Yuichiro joined the chat', type: 'IMAGE' }), null);
  assert.equal(membershipOf({ text: 'Dad left the group.', type: 'TEXT' }), null, 'typed by someone');
  assert.equal(membershipOf({ text: 'Yuichiro joined the chat', attachments: [{}] }), null);
  assert.equal(membershipOf({ text: 'I joined the chat late, sorry' }), null);
  assert.equal(membershipOf({ text: '<b>Ana</b> joined the chat' }), null);
  assert.equal(membershipOf({ text: 'line\nAna joined the chat' }), null);
  assert.equal(membershipOf({ text: 'Ana joined the chat', isDeleted: true }), null);
});

test('summarize: each person once, their last event; the invitation of someone who joined dropped', () => {
  assert.deepEqual(
    summarize([
      { who: 'A', kind: 'invited' },
      { who: 'A', kind: 'joined' },
      { who: 'B', kind: 'joined' },
      { who: 'B', kind: 'left' },
      { who: 'C', kind: 'invited' },
    ]),
    [
      { who: 'A', kind: 'joined' },
      { who: 'B', kind: 'left' },
      { who: 'C', kind: 'invited' },
    ],
  );
});

const msg = (id: string, text: string, ts = '2026-11-24T10:00:00Z') => ({ id, text, timestamp: ts });
const shape = (r: ReturnType<typeof membershipRuns>) => r.runs.map((x) => (Array.isArray(x) ? x.map((m) => m.id).join('') : `[${x.members.map((m) => m.id).join('')}]`)).join(' ');

test('membershipRuns: grouped runs, one by one, hidden; no mode leaves everything plain', () => {
  const ms = [msg('a', 'hello'), msg('b', 'Ana was invited to the chat'), msg('c', 'Ana joined the chat'), msg('d', 'Bao joined the chat'), msg('e', 'hi')];
  assert.equal(shape(membershipRuns(ms, undefined, 'group')), 'a [bcd] e');
  assert.equal(shape(membershipRuns(ms, undefined, 'each')), 'a [c] [d] e');
  assert.equal(shape(membershipRuns(ms, undefined, 'hide')), 'ae');
  assert.equal(shape(membershipRuns(ms, undefined, undefined)), 'abcde');
});

test('membershipRuns: a new day or the unread divider starts a new run; a hidden divider moves to the next message', () => {
  const ms = [msg('a', 'Ana joined the chat', '2026-11-23T10:00:00Z'), msg('b', 'Bao joined the chat', '2026-11-24T10:00:00Z'), msg('c', 'Kai joined the chat', '2026-11-24T10:01:00Z'), msg('d', 'hi', '2026-11-24T10:02:00Z')];
  assert.equal(shape(membershipRuns(ms, undefined, 'group')), '[a] [bc] d');
  assert.equal(shape(membershipRuns(ms, 'c', 'group')), '[a] [b] [c] d');
  assert.equal(membershipRuns(ms, 'b', 'hide').divider, 'd');
  assert.equal(membershipRuns(ms, 'd', 'hide').divider, 'd');
  assert.equal(membershipRuns(ms.slice(0, 3), 'b', 'hide').divider, undefined, 'all hidden from the divider on: none');
  const inv = [msg('a', 'hi'), msg('i', 'Ana was invited to the chat'), msg('j', 'Ana joined the chat')];
  assert.equal(membershipRuns(inv, 'i', 'each').divider, 'j', 'a folded invitation hands the divider to the arrival');
});

const app = new Hono().route('/api', chatEventsRoutes);
const put = (body: unknown) => app.request('/api/chat-events', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('chat-events: the mode for all chats and a chat\'s own, kept in the data volume', async () => {
  rmSync(dataPath('chatevents.json'), { force: true });
  resetChatEvents();
  assert.deepEqual(await (await app.request('/api/chat-events')).json(), { membership: 'group', chats: {} });
  assert.equal((await put({ membership: 'hide' })).status, 200);
  assert.equal((await put({ chat: '!a:b', membership: 'each' })).status, 200);
  resetChatEvents();
  assert.deepEqual(await (await app.request('/api/chat-events')).json(), { membership: 'hide', chats: { '!a:b': 'each' } });
  assert.equal((await put({ chat: '!a:b', membership: null })).status, 200);
  assert.deepEqual(await (await app.request('/api/chat-events')).json(), { membership: 'hide', chats: {} });
  for (const bad of [{ membership: 'loud' }, { membership: null }, { chat: 'a b', membership: 'hide' }, { membership: 'hide', extra: 1 }, [], 'x'])
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  rmSync(dataPath('chatevents.json'), { force: true });
  resetChatEvents();
});
