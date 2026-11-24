import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byMonth, columnsFor, durationLabel, gridRows, monthKey, shareable, toggleSelected } from '../client/src/mediagrid.js';

// Local months (the tests run with the container's time zone); mid-month times avoid zone edges.
const it = (key: string, iso: string) => ({ key, timestamp: iso });

test('month keys and sections keep the newest-first order', () => {
  assert.equal(monthKey('2026-10-15T12:00:00Z'), '2026-10');
  assert.equal(monthKey('nope'), '0000-00');
  const s = byMonth([it('a', '2026-10-20T12:00:00Z'), it('b', '2026-10-02T12:00:00Z'), it('c', '2026-08-15T12:00:00Z'), it('d', '2025-08-15T12:00:00Z')]);
  assert.deepEqual(s.map((x) => [x.key, x.items.map((i) => i.key)]), [['2026-10', ['a', 'b']], ['2026-08', ['c']], ['2025-08', ['d']]]);
});

test('grid rows: a header per month, then rows of `cols`; months never share a row', () => {
  const items = ['1', '2', '3', '4', '5'].map((k) => it(k, '2026-10-10T12:00:00Z')).concat([it('6', '2026-09-10T12:00:00Z')]);
  const rows = gridRows(items, 3);
  assert.deepEqual(
    rows.map((r) => (r.kind === 'month' ? r.key : r.items.map((i) => i.key).join(''))),
    ['m:2026-10', '123', '45', 'm:2026-09', '6'],
  );
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'stable unique keys');
  assert.equal(gridRows(items, 0).filter((r) => r.kind === 'cells').length, 6);
  assert.deepEqual(gridRows([], 4), []);
});

test('columns, durations, selection limits, share size', () => {
  assert.deepEqual([320, 390, 480, 700, 1200].map(columnsFor), [3, 3, 4, 4, 5]);
  assert.equal(durationLabel(5), '0:05');
  assert.equal(durationLabel(65.4), '1:05');
  assert.equal(durationLabel(3725), '1:02:05');
  assert.equal(durationLabel(undefined), undefined);
  assert.equal(durationLabel(-1), undefined);
  assert.deepEqual(toggleSelected([], 'a'), ['a']);
  assert.deepEqual(toggleSelected(['a', 'b'], 'a'), ['b']);
  assert.equal(toggleSelected(['a', 'b'], 'c', 2), 'full');
  assert.deepEqual(toggleSelected(['a', 'b'], 'b', 2), ['a']);
  assert.ok(shareable([10, undefined, 20], 30));
  assert.ok(!shareable([10, 21], 30));
});
