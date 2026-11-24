import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addProvider, hasKey, provider, resetStore, updateProvider } from '../server/store.js';

// The store by itself (store.ts): a key never follows a change of origin, the scheme and the port included (https
// to http on the same host would send it in clear).

delete process.env.KLATCHLY_LLM_KEY_FILE;

test('a key never follows a change of origin: host, scheme (https to http) or port', () => {
  resetStore();
  const r = addProvider({ kind: 'openai', name: 'OpenAI', url: 'https://api.example.test/v1', key: 'sk-1' });
  assert.ok('id' in r);
  const id = r.id;
  assert.equal(updateProvider(id, { url: 'https://api.example.test/v2' }), null);
  assert.ok(hasKey(provider(id)!), 'same origin, another path: kept');
  assert.equal(updateProvider(id, { url: 'http://api.example.test/v2' }), null);
  assert.ok(!hasKey(provider(id)!), 'https to http: dropped');
  assert.equal(updateProvider(id, { url: 'https://api.example.test/v1', key: 'sk-1' }), null);
  assert.equal(updateProvider(id, { url: 'https://api.example.test:8443/v1' }), null);
  assert.ok(!hasKey(provider(id)!), 'another port: dropped');

  // A kind that needs a key: typed again rather than dropped.
  const or = addProvider({ kind: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.example.test/api/v1', key: 'sk-or-1' });
  assert.ok('id' in or);
  assert.equal(updateProvider(or.id, { url: 'http://openrouter.example.test/api/v1' }), 'key_reentry');
  assert.equal(provider(or.id)!.url, 'https://openrouter.example.test/api/v1', 'nothing changed');
  assert.equal(provider(or.id)!.key(), 'sk-or-1');
});
