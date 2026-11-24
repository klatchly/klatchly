import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataPath } from '#core/sdk.js';
import { rivaLanguage } from '../server/engine.js';
import transcribePkg from '../server/index.js';
import { addProvider, hasKey, MAX_PROVIDERS, provider, providers, resetStore, setModel, setServerKey, updateProvider } from '../server/store.js';

// The store by itself (store.ts): a key never follows a change of origin (host, scheme or port), the providers' cap,
// a file that cannot be read set aside, a write that fails, the stored entries checked on reading, and the server's
// provider from the environment with the language its model needs.

const fresh = () => {
  for (const f of ['transcribe.json', 'transcribe-keys.json']) writeFileSync(dataPath(f), '{}');
  resetStore();
};
const added = (r: ReturnType<typeof addProvider>): string => {
  assert.ok('id' in r, JSON.stringify(r));
  return r.id;
};
const keySet = (id: string) => hasKey(provider(id)!);

test('a key never follows a change of origin: host, scheme (https to http) or port', () => {
  fresh();
  const oai = added(addProvider({ kind: 'openai', name: 'OpenAI', url: 'https://api.example.test/v1', key: 'sk-1', model: 'whisper-1', language: '' }));
  assert.equal(updateProvider(oai, { url: 'https://api.example.test/v2' }), null);
  assert.ok(keySet(oai), 'same origin, another path: kept');
  assert.equal(updateProvider(oai, { url: 'http://api.example.test/v2' }), null);
  assert.ok(!keySet(oai), 'https to http: never sent in clear');
  assert.equal(updateProvider(oai, { url: 'https://api.example.test/v1', key: 'sk-1' }), null);
  assert.equal(updateProvider(oai, { url: 'https://api.example.test:8443/v1' }), null);
  assert.ok(!keySet(oai), 'another port');

  // Riva self-hosted, in the endpoint form ('scheme://host:port'): https:443 to http:80 is the same host.
  const self = added(addProvider({ kind: 'nvidia-riva', name: 'Riva', url: 'https://riva.example.test:443', key: 'k-1', model: 'whisper-large-v3', language: '' }));
  assert.equal(updateProvider(self, { url: 'http://riva.example.test:80' }), null);
  assert.ok(!keySet(self));

  // NVIDIA's hosted endpoint needs a key: another origin without a new one is typed again.
  const hosted = added(addProvider({ kind: 'nvidia-riva', name: 'NVIDIA', url: 'https://grpc.nvcf.nvidia.com:443', key: 'nvapi-1', model: 'whisper-large-v3', language: '' }));
  assert.equal(updateProvider(hosted, { url: 'https://other.nvidia.com:443' }), 'key_reentry');
  assert.ok(keySet(hosted) && provider(hosted)!.url === 'https://grpc.nvcf.nvidia.com:443', 'nothing changed');
  assert.equal(updateProvider(hosted, { url: 'https://other.nvidia.com:443', key: 'nvapi-2' }), null);
  assert.equal(provider(hosted)!.key(), 'nvapi-2');
});

test('at most MAX_PROVIDERS', () => {
  fresh();
  for (let i = 0; i < MAX_PROVIDERS; i++) added(addProvider({ kind: 'openai', name: `P${i}`, url: `https://p${i}.example.test/v1`, key: null, model: 'whisper-1', language: '' }));
  assert.deepEqual(addProvider({ kind: 'openai', name: 'one more', url: 'https://x.example.test/v1', key: null, model: 'whisper-1', language: '' }), { error: 'too_many' });
});

test('files: unreadable ones set aside as .bad-<time>, entries checked on reading, a failed write reported', () => {
  const dir = dirname(dataPath('transcribe.json'));
  writeFileSync(dataPath('transcribe.json'), '{ not json');
  resetStore();
  assert.deepEqual(providers(), []);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('transcribe.json.bad-')), 'settings set aside');
  writeFileSync(dataPath('transcribe.json'), JSON.stringify({ providers: [{ id: 'p-ffffffff', kind: 'openai', name: 'F', url: 'https://f.example.test/v1', model: 'whisper-1', language: '' }] }));
  writeFileSync(dataPath('transcribe-keys.json'), 'nope');
  resetStore();
  assert.equal(provider('p-ffffffff')!.key(), null);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('transcribe-keys.json.bad-')), 'keys set aside');

  writeFileSync(
    dataPath('transcribe.json'),
    JSON.stringify({
      providers: [
        { id: 'p-aaaaaaaa', kind: 'openai', name: 'Good', url: 'https://ok.example.test/v1/', model: 'bad model!', language: 'french' },
        { id: 'p-aaaaaaaa', kind: 'openai', name: 'Duplicate', url: 'https://ok.example.test/v1' },
        { id: 'env', kind: 'nvidia-riva', name: 'Not here', url: 'https://x.example.test:443' },
        { id: 'p-bbbbbbbb', kind: 'other', name: 'Kind', url: 'https://x.example.test/v1' },
        { id: 'p-cccccccc', kind: 'openai', name: '', url: 'https://x.example.test/v1' },
        { id: 'p-dddddddd', kind: 'openai', name: 'Bad URL', url: 'ftp://x.example.test/v1' },
        'junk',
      ],
      server: { name: 'x'.repeat(80), model: 'gpt-4', language: 'nope!' },
      default: '../etc',
    }),
  );
  writeFileSync(dataPath('transcribe-keys.json'), JSON.stringify({ 'p-aaaaaaaa': 'sk-ok', env: 'stolen', 'p-eeeeeeee': 'two words' }));
  resetStore();
  const all = providers();
  assert.deepEqual(
    all.map((p) => [p.id, p.name, p.url, p.model, p.language]),
    [['p-aaaaaaaa', 'Good', 'https://ok.example.test/v1', 'whisper-1', '']],
  );
  assert.equal(all[0]!.key(), 'sk-ok');

  // The data folder read-only: the change is refused and nothing is half-saved.
  chmodSync(dir, 0o500);
  try {
    assert.deepEqual(addProvider({ kind: 'openai', name: 'Late', url: 'https://late.example.test/v1', key: 'sk-2', model: 'whisper-1', language: '' }), { error: 'store_failed' });
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.deepEqual(providers().map((p) => p.id), ['p-aaaaaaaa'], 'read again from disk');
});

test("the server's provider: the language from the environment, which some models need", () => {
  fresh();
  const check = transcribePkg.modules.find((m) => m.type === 'provider')!.check!;
  const saved = { ...process.env };
  try {
    process.env.KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE = join(dirname(dataPath('transcribe.json')), 'nvidia_key_not_read');
    setServerKey('nvapi-env-key');
    process.env.KLATCHLY_TRANSCRIBE_NVIDIA_MODEL = 'canary-1b';
    process.env.KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE = 'fr-FR';
    assert.equal(check(), null);
    const env = provider('env')!;
    assert.deepEqual([env.model, env.language], ['canary-1b', 'fr-FR']);
    assert.equal(rivaLanguage(env.model, env.language), 'fr-FR', 'what Riva is asked for, not en-US');
    // Chosen again in Settings as the environment says: still French.
    assert.equal(setModel('env', 'canary-1b', 'fr-FR'), null);
    assert.equal(provider('env')!.language, 'fr-FR');
    assert.equal(setModel('env', 'whisper-large-v3', ''), null);
    assert.deepEqual([provider('env')!.model, provider('env')!.language], ['whisper-large-v3', '']);
    // A model that needs a language, and none: the package off with that reason.
    process.env.KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE = '';
    assert.match(String(check()), /KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE is required by canary-1b/);
    process.env.KLATCHLY_TRANSCRIBE_NVIDIA_MODEL = 'whisper-large-v3';
    assert.equal(check(), null, 'automatic detection: none needed');
  } finally {
    for (const k of ['KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE', 'KLATCHLY_TRANSCRIBE_NVIDIA_MODEL', 'KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setServerKey(undefined);
  }
});
