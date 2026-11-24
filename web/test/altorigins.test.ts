import { test } from 'node:test';
import assert from 'node:assert/strict';

// A move to a new address with the old one kept a while (KLATCHLY_ALT_ORIGINS, server/config.ts): both are our origin
// (CSRF, WebSocket), each with its own RP ID. Its own process: the config is read once, so set before the import.
process.env.KLATCHLY_ALT_ORIGINS = 'https://old.example.org, http://localhost:3095';
const { config, parseAltOrigins, siteOf } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');

test('KLATCHLY_ALT_ORIGINS: bare origins, each its host as RP ID; the primary and repeats dropped', () => {
  assert.deepEqual(parseAltOrigins(' https://a.example.org ,https://b.example.org:8443,https://a.example.org', 'https://p.example.org'), [
    { origin: 'https://a.example.org', rpID: 'a.example.org' },
    { origin: 'https://b.example.org:8443', rpID: 'b.example.org' },
  ]);
  assert.deepEqual(parseAltOrigins('https://p.example.org', 'https://p.example.org'), []);
  assert.deepEqual(parseAltOrigins(undefined, 'https://p.example.org'), []);
  assert.throws(() => parseAltOrigins('https://a.example.org/path', 'https://p.example.org'));
  assert.throws(() => parseAltOrigins('not a url', 'https://p.example.org'));
  assert.throws(() => parseAltOrigins('http://old.example.org', 'https://p.example.org'), /https only/);
  assert.deepEqual(parseAltOrigins('http://localhost:8080', 'https://p.example.org'), [{ origin: 'http://localhost:8080', rpID: 'localhost' }]);
});

test('siteOf: the primary first, then the alternative origins; anything else is not ours', () => {
  assert.equal(config().sites[0]!.origin, config().origin);
  assert.equal(config().sites.length, 2, 'the primary given again is not repeated');
  assert.deepEqual(siteOf('https://old.example.org'), { origin: 'https://old.example.org', rpID: 'old.example.org' });
  assert.equal(siteOf(config().origin)?.rpID, config().rpID);
  assert.equal(siteOf('https://evil.example.org'), undefined);
  assert.equal(siteOf(undefined), undefined);
});

test('CSRF: a POST from the alternative origin passes the origin check, another origin does not', async () => {
  const app = createApp();
  const post = (origin: string) => app.request('/api/auth/options', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' } });
  assert.notEqual((await post('https://old.example.org')).status, 400);
  const bad = await post('https://evil.example.org');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'bad_origin' });
});

test('passkey options: the RP ID of the page asking', async () => {
  const app = createApp();
  const opts = async (origin: string) => (await (await app.request('/api/auth/options', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' } })).json()) as { rpId?: string };
  assert.equal((await opts('https://old.example.org')).rpId, 'old.example.org');
  assert.equal((await opts(config().origin)).rpId, config().rpID);
});
