import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumped, bumpOf, parseVersion, rangeProblem, satisfies } from '../server/semver.js';

// The packages' version ranges (server/semver.ts): npm's rules for plain x.y.z versions.

test('versions: plain x.y.z only', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('0.0.0'), [0, 0, 0]);
  for (const bad of ['1.2', '01.2.3', '1.2.3-beta', 'v1.2.3', '1.2.3.4', '', ' 1.2.3', '1.2.x']) assert.equal(parseVersion(bad), null, bad);
});

test('ranges: exact, comparisons, caret, tilde, x-ranges, AND, OR', () => {
  const yes: [string, string][] = [
    ['1.2.3', '1.2.3'],
    ['1.2.3', '=1.2.3'],
    ['1.2.3', '>=1.2.3'],
    ['1.2.4', '>1.2.3'],
    ['1.2.2', '<1.2.3'],
    ['1.2.3', '<=1.2.3'],
    ['1.9.0', '^1.2.3'],
    ['1.2.3', '^1.2'],
    ['1.0.0', '^1'],
    ['0.2.9', '^0.2.3'],
    ['0.0.3', '^0.0.3'],
    ['0.0.9', '^0.0'],
    ['1.2.9', '~1.2.3'],
    ['1.2.0', '~1.2'],
    ['1.9.9', '~1'],
    ['1.4.0', '1.x'],
    ['1.2.7', '1.2.*'],
    ['1.0.0', '1'],
    ['1.2.0', '1.2'],
    ['9.9.9', '*'],
    ['1.4.0', '>=1.2 <2'],
    ['1.3.0', '>1.2'],
    ['1.2.9', '<=1.2'],
    ['1.5.0', '>= 1.2.0 < 2.0.0'],
    ['2.1.0', '^1.0 || ^2.1'],
  ];
  const no: [string, string][] = [
    ['1.2.4', '1.2.3'],
    ['1.2.3', '>1.2.3'],
    ['1.2.3', '<1.2.3'],
    ['2.0.0', '^1.2.3'],
    ['1.2.2', '^1.2.3'],
    ['0.3.0', '^0.2.3'],
    ['0.0.4', '^0.0.3'],
    ['0.1.0', '^0.0'],
    ['1.3.0', '~1.2.3'],
    ['2.0.0', '~1'],
    ['2.0.0', '1.x'],
    ['1.3.0', '1.2.*'],
    ['2.0.0', '>=1.2 <2'],
    ['1.2.9', '>1.2'],
    ['1.3.0', '<=1.2'],
    ['1.0.0', '^1.1'],
    ['1.4.0', '^2'],
    ['2.0.5', '^1.0 || ^2.1'],
    ['1.2.3-beta', '*'],
  ];
  for (const [v, r] of yes) assert.ok(satisfies(v, r), `${v} ${r}`);
  for (const [v, r] of no) assert.ok(!satisfies(v, r), `${v} not ${r}`);
});

test('a malformed range is refused, never matched', () => {
  for (const bad of ['', '^', '1.x.3', '>>1', '^1.2.3.4', 'latest', '1.2.3 ||', '|| 1', '~>1', 'a.b.c', '^01.2']) {
    assert.ok(rangeProblem(bad), bad);
    assert.ok(!satisfies('1.2.3', bad), bad);
  }
  for (const ok of ['^1.0', '~1.2.3', '>=1 <2', '1.x || 2.x', '*']) assert.equal(rangeProblem(ok), null, ok);
});

test('bumps: what changed between two versions, and the next one', () => {
  assert.equal(bumpOf('1.0.0', '2.0.0'), 'major');
  assert.equal(bumpOf('1.0.0', '1.1.0'), 'minor');
  assert.equal(bumpOf('1.0.0', '1.0.1'), 'patch');
  assert.equal(bumpOf('1.2.0', '1.2.0'), 'none');
  assert.equal(bumpOf('1.2.0', '1.1.9'), 'down');
  assert.equal(bumped('1.4.2', 'minor'), '1.5.0');
  assert.equal(bumped('1.4.2', 'major'), '2.0.0');
  assert.equal(bumped('1.4.2', 'patch'), '1.4.3');
});
