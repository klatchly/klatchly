import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../server/ratelimit.js';

test('one address refused again and again does not fill the global bucket', () => {
  const rl = new RateLimiter(600_000, 3, 10);
  const now = 1_000;
  let allowed = 0;
  for (let i = 0; i < 100; i++) if (rl.allow('203.0.113.9', now)) allowed++;
  assert.equal(allowed, 3, 'its own limit');
  assert.equal(rl.allow('198.51.100.1', now), true, 'another address still gets in');
});

test('the global bucket still caps many addresses together', () => {
  const rl = new RateLimiter(600_000, 3, 10);
  let allowed = 0;
  for (let i = 0; i < 20; i++) if (rl.allow(`192.0.2.${i}`, 1_000)) allowed++;
  assert.equal(allowed, 10);
  assert.equal(rl.allow('192.0.2.200', 1_000 + 600_001), true, 'a new window');
});
