import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay, shouldRetry } from '../client/src/retry.js';

// Failed queries tried again (client/src/retry.ts): not again and again against a busy server (2026-11-18).

const http = (status: number) => Object.assign(new Error(`http ${status}`), { status });

test('a network hiccup: twice; the session gone: never', () => {
  assert.equal(shouldRetry(0, new TypeError('Failed to fetch')), true);
  assert.equal(shouldRetry(1, new TypeError('Failed to fetch')), true);
  assert.equal(shouldRetry(2, new TypeError('Failed to fetch')), false);
  assert.equal(shouldRetry(0, http(302)), false);
  assert.equal(shouldRetry(0, http(500)), true);
});

test('busy or down (429, 502, 503, 504): once, late', () => {
  for (const s of [429, 502, 503, 504]) {
    assert.equal(shouldRetry(0, http(s)), true, String(s));
    assert.equal(shouldRetry(1, http(s)), false, String(s));
    const d = retryDelay(0, http(s), () => 0.5);
    assert.ok(d >= 8_000 && d <= 12_000, String(d));
  }
  assert.equal(retryDelay(0, new TypeError('x')), 1000);
  assert.equal(retryDelay(1, http(500)), 2000);
  assert.equal(retryDelay(10, http(500)), 30_000);
});
