import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatReader, project } from '../server/chatread.js';
import { fakeSource, withFake } from './fakesource.js';

// On-demand chat reads for augmentations (ModuleContext.chats): the declared fields only, each call logged with
// the package id and no content.

const msg = { id: 'm1', chatID: '!c:x', text: 'hello', isSender: false, senderName: 'Sam', timestamp: '2026-11-01T00:00:00Z', type: 'TEXT', attachments: [{ srcURL: 'mxc://x' }], senderID: '@sam:x', reactions: [] };
// The chat's connector reads (a fake one).
const src = fakeSource();
src.messages.set('!c:x', [msg, { ...msg, id: 'm0', text: null, isDeleted: true }]);
withFake(src);

test('project: the fields of ReadMessage, type-checked; nothing else', () => {
  assert.deepEqual(project(msg), { text: 'hello', isSender: false, senderName: 'Sam', timestamp: '2026-11-01T00:00:00Z', type: 'TEXT' });
  assert.deepEqual(project({ text: 42, isSender: 'yes', senderName: { x: 1 }, isHidden: true }), { isHidden: true });
  assert.deepEqual(project(null), {});
});

test('a package reader: projected results, one log line per call with the package id and no content', async () => {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stdout.write;
  try {
    const r = chatReader('demo');
    assert.deepEqual(await r.readMessage('!c:x', 'm1'), project(msg));
    const recent = await r.recentMessages('!c:x');
    assert.deepEqual(recent.map((m) => Object.keys(m).sort().join(',')), ['isSender,senderName,text,timestamp,type', 'isDeleted,isSender,senderName,text,timestamp,type']);
  } finally {
    process.stdout.write = write;
  }
  const reads = lines.filter((l) => l.includes(' chatread '));
  assert.equal(reads.length, 2);
  assert.match(reads[0]!, / chatread message pkg=demo\n$/);
  assert.match(reads[1]!, / chatread recent pkg=demo count=2\n$/);
  assert.ok(!lines.join('').includes('hello') && !lines.join('').includes('Sam'), 'no content in the logs');
});

test('readRange: a period read page by page backwards, oldest first, capped', async () => {
  // A paging source: 25 messages a minute apart, 10 a page, newest page first (cursor = index of the oldest).
  const all = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, chatID: '!r:x', text: `t${i}`, isSender: i === 5, senderName: 'Sam', timestamp: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() }));
  const paging = fakeSource(
    {
      async messages(_chatID, q) {
        const end = q.cursor ? Number(q.cursor) : all.length;
        const start = Math.max(0, end - 10);
        return { items: all.slice(start, end).reverse(), hasMore: start > 0, oldestCursor: start > 0 ? String(start) : null, newestCursor: null };
      },
    },
    'paging',
  );
  withFake(paging);
  const r = chatReader('demo');
  const texts = (x: { messages: { text?: string | null }[] }) => x.messages.map((m) => m.text).join(',');

  const since = await r.readRange('!r:x', { since: all[18]!.timestamp });
  assert.equal(texts(since), 't18,t19,t20,t21,t22,t23,t24');
  assert.deepEqual([since.truncated, since.reached], [false, true]);

  const between = await r.readRange('!r:x', { since: all[2]!.timestamp, until: all[4]!.timestamp });
  assert.equal(texts(between), 't2,t3,t4');

  const from = await r.readRange('!r:x', { fromMessageID: 'r21' });
  assert.equal(texts(from), 't21,t22,t23,t24');
  assert.equal(from.reached, true);

  const afterOwn = await r.readRange('!r:x', { afterOwn: true });
  assert.equal(afterOwn.messages.length, 19);
  assert.equal(afterOwn.messages[0]!.text, 't6');

  const capped = await r.readRange('!r:x', { since: all[0]!.timestamp, max: 4 });
  assert.equal(texts(capped), 't21,t22,t23,t24');
  assert.deepEqual([capped.truncated, capped.reached], [true, false]);

  const missing = await r.readRange('!r:x', { fromMessageID: 'nope' });
  assert.equal(missing.messages.length, 25);
  assert.equal(missing.reached, false);
  withFake(src);
});
