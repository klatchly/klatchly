import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeCount } from '../server/badgecount.js';
import { reseedWait, sourceEvent, sourceOff } from '../server/pushwatch.js';
import { fakeSource, withFake } from './fakesource.js';

// The badge's recount on a connector's 'ready' (server/pushwatch.ts): at once on the first connection, but not again
// while the last one is less than 5 minutes old (2026-11-18: a socket that kept dropping paged through every chat on
// each reconnect).

test('reseedWait: now when never recounted or long ago, else when the last recount turns 5 minutes old', () => {
  const now = 10 * 60_000;
  assert.equal(reseedWait(0, now), 0);
  assert.equal(reseedWait(now - 6 * 60_000, now), 0);
  assert.equal(reseedWait(now - 60_000, now), 4 * 60_000);
  assert.equal(reseedWait(now, now), 5 * 60_000);
});

test("a 'ready' recounts at once the first time, not on every reconnect after", async () => {
  let seeds = 0;
  const src = fakeSource({
    owns: (id) => id.startsWith('r'),
    unreadChats: async () => {
      seeds++;
      return [{ id: 'r1', unreadCount: 3 }];
    },
  });
  withFake(src);
  const before = badgeCount();
  sourceEvent(src.module, { type: 'ready' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seeds, 1, 'first connection: recounted now');
  assert.equal(badgeCount(), before + 3);
  // Dropped and back, twice: nothing more until the last recount is 5 minutes old.
  for (let i = 0; i < 2; i++) {
    sourceEvent(src.module, { type: 'closed' });
    sourceEvent(src.module, { type: 'ready' });
  }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seeds, 1);
  sourceOff(src.module);
});

test('a failed recount is not counted as one: the next ready tries again', async () => {
  let seeds = 0;
  const src = fakeSource(
    {
      owns: (id) => id.startsWith('f'),
      unreadChats: async () => {
        seeds++;
        if (seeds === 1) throw new Error('upstream down');
        return [];
      },
    },
    'flaky',
  );
  withFake(src);
  sourceEvent(src.module, { type: 'ready' });
  await new Promise((r) => setTimeout(r, 10));
  sourceEvent(src.module, { type: 'closed' });
  sourceEvent(src.module, { type: 'ready' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seeds, 2);
  sourceOff(src.module);
});
