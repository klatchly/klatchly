import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prependedRows } from '../client/src/rowshift.js';

// Rows as the conversation lists them: the ids of the messages each holds (an album: several).
type R = string[];
const ids = (r: R) => r;
const rows = (...r: (string | string[])[]): R[] => r.map((x) => (Array.isArray(x) ? x : [x]));

test('the same top row: nothing prepended (a new message, an edit, an empty list)', () => {
  assert.equal(prependedRows(rows('a', 'b'), rows('a', 'b', 'c'), ids), 0);
  assert.equal(prependedRows(rows('a', 'b'), rows('a', 'b'), ids), 0);
  assert.equal(prependedRows([], rows('a', 'b'), ids), 0);
  assert.equal(prependedRows(rows('a'), [], ids), 0);
});

test('an older page: as many rows as it adds above the top row', () => {
  assert.equal(prependedRows(rows('c', 'd'), rows('a', 'b', 'c', 'd'), ids), 2);
  assert.equal(prependedRows(rows('c', 'd'), rows('a', 'b', 'c', 'd', 'e'), ids), 2, 'and a new message below');
});

test('a page that extends the top album adds no row; a top photo that became an album is still that row', () => {
  assert.equal(prependedRows(rows(['p2', 'p3'], 'x'), rows(['p1', 'p2', 'p3'], 'x'), ids), 0);
  assert.equal(prependedRows(rows('p3', 'x'), rows('a', ['p1', 'p2', 'p3'], 'x'), ids), 1);
});

test('the top row gone: the next row still listed is followed', () => {
  assert.equal(prependedRows(rows('a', 'b', 'c'), rows('b', 'c'), ids), -1, 'deleted: one row less above b');
  assert.equal(prependedRows(rows('a', 'b', 'c'), rows('z', 'b', 'c'), ids), 0, 'replaced: b stays second');
  assert.equal(prependedRows(rows(['p1', 'p2'], 'x'), rows('y', 'p2', 'x'), ids), 1, 'an album that lost its first photo');
  assert.equal(prependedRows(rows('a', 'b'), rows('x', 'y'), ids), 0, 'another list');
});

// The crash this guards against (Conversation: firstItemIndex). Pages are newest first; live messages grow the newest
// page, then a refetch returns pages of the normal size: the same messages, split elsewhere.
test('a refetch that moves messages to the next page prepends no row', () => {
  const PAGE = 3;
  const BASE = 1000;
  const listOf = (pages: string[][]) => [...pages].reverse().flatMap((p) => [...p].reverse()).map((id) => [id]);
  // Rows made only of older pages: what firstItemIndex was derived from.
  const older = (pages: string[][]) => pages.slice(1).flat().length;

  const cached = [['m6', 'm5', 'm4'], ['m3', 'm2', 'm1']];
  const live = [['m8', 'm7', ...cached[0]!], cached[1]!];
  const refetched = [['m8', 'm7', 'm6'], ['m5', 'm4', 'm3'], ['m2', 'm1']];
  assert.equal(refetched[0]!.length, PAGE);

  const before = listOf(live);
  const after = listOf(refetched);
  assert.deepEqual(after, before, 'the same rows');
  assert.equal(older(refetched) - older(live), 2, 'two messages changed page');
  assert.equal(prependedRows(before, after, ids), 0);

  // Virtuoso draws, for a couple of frames, the rows it held under the indexes it gave them (the old firstItemIndex)
  // with the new itemContent: the last row drawn, read from the new first index.
  const lastDrawn = BASE - older(live) + before.length - 1;
  assert.equal(after[lastDrawn - (BASE - older(refetched))], undefined, 'by page: past the last row');
  let first = BASE - prependedRows(cached.length ? listOf(cached) : [], before, ids);
  const drawn = first + before.length - 1;
  first -= prependedRows(before, after, ids);
  assert.deepEqual(after[drawn - first], ['m8'], 'by rows prepended: the same row');
});
