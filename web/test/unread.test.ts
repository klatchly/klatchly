import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstUnreadIndex, oldestIncoming, openAtDivider, previewRange } from '../client/src/unread.js';

test('firstUnreadIndex: the N-th incoming message from the end, own messages skipped', () => {
  // oldest ... newest; true = incoming
  const rows = [true, true, false, true, false, true, true];
  assert.equal(firstUnreadIndex(rows, 1), 6);
  assert.equal(firstUnreadIndex(rows, 2), 5);
  assert.equal(firstUnreadIndex(rows, 3), 3);
  assert.equal(firstUnreadIndex(rows, 5), 0);
  assert.equal(firstUnreadIndex(rows, 6), -1); // not loaded far enough
  assert.equal(firstUnreadIndex(rows, 0), -1);
  assert.equal(firstUnreadIndex([], 2), -1);
  assert.equal(firstUnreadIndex([false, false], 1), -1);
});

test('oldestIncoming: fallback when the history ends first', () => {
  assert.equal(oldestIncoming([false, true, true]), 1);
  assert.equal(oldestIncoming([false, false]), -1);
});

test('openAtDivider: only when the unread part is taller than a screen', () => {
  assert.equal(openAtDivider(100, 95, 12), false); // 5 unread rows fit
  assert.equal(openAtDivider(100, 80, 12), true); // 20 rows
  assert.equal(openAtDivider(100, 88, 12), false); // exactly a screen
  assert.equal(openAtDivider(100, -1, 12), false);
});

test('previewRange: the last screen of rows, or from just above the divider when the list opens there', () => {
  assert.deepEqual(previewRange(100, 16), { lo: 84, hi: 100 });
  assert.deepEqual(previewRange(5, 16), { lo: 0, hi: 5 });
  assert.deepEqual(previewRange(0, 16), { lo: 0, hi: 0 });
  assert.deepEqual(previewRange(100, 16, 40), { lo: 38, hi: 56 });
  assert.deepEqual(previewRange(100, 16, 1), { lo: 0, hi: 17 });
  assert.deepEqual(previewRange(100, 16, 95), { lo: 93, hi: 100 });
  // No divider row (not found, or out of range): the bottom.
  assert.deepEqual(previewRange(100, 16, -1), { lo: 84, hi: 100 });
  assert.deepEqual(previewRange(100, 16, 100), { lo: 84, hi: 100 });
});
