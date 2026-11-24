import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '#core/app.js';
import { config } from '#core/config.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { sha256 } from '#core/sessions.js';
import { fakeSource } from '../../../test/fakesource.js';
import { encodeWav } from '../audio.js';
import transcribePkg from '../server/index.js';
import { resetStore, setServerKey } from '../server/store.js';
import { fakeOpenAi, fakeRiva, oggOpus } from './fakes.js';

// The package in a registry, through the app: the session, the origin check and the step-up of the Settings routes,
// keys write-only (0600, never in an answer), the model and the default without step-up; under the voice notes, a
// note read by the core's reader and sent once (kept: a second tap sends nothing), a format the provider does not
// take answered 'convert', the bytes for the browser's conversion and the converted WAV; validation and the rate
// limit. All on in-process fakes: a chat source with a voice note, a Riva server, an OpenAI-compatible server.

const RIVA_KEY = 'riva-test-key';
const OAI_KEY = 'openai-test-key';
const ENV_KEY = 'env-test-key';
const riva = await fakeRiva();
const oai = await fakeOpenAi();
after(async () => {
  await riva.close();
  await oai.close();
});

const OGG = oggOpus(4000);
const M4A = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);
const src = fakeSource();
const served: string[] = [];
src.module.attachmentSource = (m, a) => () => {
  served.push(`${m.id}/${a.id}`);
  const ogg = a.id === 'v';
  return Promise.resolve({ status: 200, headers: { 'content-type': ogg ? 'audio/ogg' : 'audio/mp4' }, body: new Blob([ogg ? OGG : M4A]).stream() });
};
src.messages.set('c1', [
  {
    id: 'm1',
    chatID: 'c1',
    attachments: [
      { id: 'v', type: 'audio', mimeType: 'audio/ogg', isVoiceNote: true, duration: 3 },
      { id: 'a', type: 'audio', mimeType: 'audio/x-m4a', duration: 5 },
      { id: 'p', type: 'img', mimeType: 'image/png' },
    ],
  },
]);

resetStore();
delete process.env.KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE;
if (!store.read().credentials.length) store.mutate((s) => void s.credentials.push({ id: 'cred', publicKey: 'x', counter: 0, createdAt: '2026-01-01T00:00:00Z', label: 'test' }));
const sid = store.mutate((s) => sessions.create(s));
const registry = new Registry([src.pkg, transcribePkg]);
const app = createApp(registry);
await registry.start();
after(() => registry.stop());

/** A call as the browser makes it; every answer is checked for keys. */
async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const raw = body instanceof Uint8Array;
  const res = await app.request(`/api/transcribe${path}`, {
    method,
    headers: { cookie: `sid=${sid}`, ...(method !== 'GET' ? { origin: config().origin, 'content-type': raw ? 'audio/wav' : 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  for (const k of [RIVA_KEY, OAI_KEY, ENV_KEY]) assert.ok(!text.includes(k), `no key in ${method} ${path}`);
  let json: Record<string, unknown> & { error?: string } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    // binary
  }
  return { status: res.status, body: json, bytes: buf, headers: res.headers };
}
const setAuthAt = (at: number) => store.mutate((s) => void (s.sessions.find((x) => x.hash === sha256(sid))!.authAt = at));

test('settings: providers added with step-up, keys write-only and 0600, model and default without step-up', async () => {
  assert.deepEqual((await call('/status')).body, { ready: false });
  assert.equal((await call('/message', 'POST', { chatID: 'c1', messageID: 'm1', index: 0 })).status, 503, 'no provider: nothing sent');

  const added = await call('/providers', 'POST', { kind: 'nvidia-riva', name: 'Riva', url: riva.url, key: RIVA_KEY, model: 'whisper-large-v3', language: '' });
  assert.equal(added.status, 200);
  assert.equal(added.body.keySet, true);
  const rid = added.body.id as string;
  const o = await call('/providers', 'POST', { kind: 'openai', name: 'Groq', url: `${oai.url}/`, key: OAI_KEY, model: 'whisper-large-v3', language: 'fr' });
  assert.equal(o.status, 200);
  assert.equal(o.body.url, oai.url, 'trailing slash dropped');
  const oid = o.body.id as string;

  const dir = config().dataDir;
  const keys = JSON.parse(readFileSync(join(dir, 'transcribe-keys.json'), 'utf8')) as Record<string, string>;
  assert.deepEqual(keys, { [rid]: RIVA_KEY, [oid]: OAI_KEY });
  assert.equal(statSync(join(dir, 'transcribe-keys.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'transcribe.json')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(dir, 'transcribe.json'), 'utf8').includes(RIVA_KEY), 'no key among the settings');

  for (const bad of [
    { kind: 'nvidia-riva', name: 'x', url: 'https://grpc.nvcf.nvidia.com:443', model: 'whisper-large-v3', language: '' },
    { kind: 'nvidia-riva', name: 'x', url: riva.url, model: 'canary-1b', language: '' },
    { kind: 'nvidia-riva', name: 'x', url: `${riva.url}/path`, model: 'whisper-large-v3', language: '' },
    { kind: 'nvidia-riva', name: 'x', url: riva.url, model: 'not-a-model', language: '' },
    { kind: 'openai', name: 'x', url: 'ftp://x/v1', model: 'm', language: '' },
    { kind: 'openai', name: 'x', url: 'https://x.test/v1', model: 'm', language: 'french!' },
    { kind: 'other', name: 'x', url: 'https://x.test/v1' },
    { kind: 'openai', name: 'x', url: 'https://x.test/v1', extra: 1 },
  ]) {
    const r = await call('/providers', 'POST', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('/providers', 'POST', { kind: 'nvidia-riva', name: 'x', url: 'https://grpc.nvcf.nvidia.com:443' })).body.error, 'key_required');
  assert.equal((await call('/providers', 'POST', { kind: 'nvidia-riva', name: 'x', url: riva.url, model: 'canary-1b', language: '' })).body.error, 'language_required');

  // The list: no key, the default (the first), the transcripts kept.
  const list = await call('/providers');
  assert.deepEqual(
    (list.body.providers as { id: string; keySet: boolean }[]).map((p) => [p.id, p.keySet]),
    [[rid, true], [oid, true]],
  );
  assert.equal(list.body.effective, rid);
  assert.deepEqual((await call('/status')).body, { ready: true, label: 'Riva' });

  // Sensitive changes need a recent sign-in or step-up; the model and the default do not.
  setAuthAt(Date.now() - 3600_000);
  for (const [method, path, body] of [
    ['POST', '/providers', { kind: 'openai', name: 'x', url: 'https://x.test/v1' }],
    ['PUT', `/providers/${oid}`, { name: 'y' }],
    ['DELETE', `/providers/${oid}`, undefined],
  ] as const) {
    const r = await call(path, method, body);
    assert.deepEqual([r.status, r.body.error], [403, 'step_up'], `${method} ${path}`);
  }
  assert.equal((await call(`/providers/${oid}/model`, 'PUT', { model: 'whisper-1', language: '' })).status, 200);
  assert.equal((await call(`/providers/${rid}/model`, 'PUT', { model: 'canary-1b', language: '' })).body.error, 'language_required');
  assert.equal((await call(`/providers/${rid}/model`, 'PUT', { model: '71203149-d3b7-4460-8231-1be2543a1fca', language: '' })).status, 200, 'an NVCF function id');
  assert.equal((await call(`/providers/${rid}/model`, 'PUT', { model: 'whisper-large-v3', language: '' })).status, 200);
  assert.equal((await call('/default', 'PUT', { provider: oid })).status, 200);
  assert.equal((await call('/providers')).body.effective, oid);
  assert.equal((await call('/default', 'PUT', { provider: 'p-zzzzzzzz' })).status, 404);
  assert.equal((await call('/default', 'PUT', { provider: null })).status, 200);
  setAuthAt(Date.now());

  // Editing: another host drops the key unless a new one is given; clearing it.
  const moved = await call(`/providers/${oid}`, 'PUT', { url: 'https://other.test/v1' });
  assert.equal(moved.body.keySet, false, 'never sent to the new host');
  assert.equal((await call(`/providers/${oid}`, 'PUT', { url: oai.url, key: OAI_KEY })).body.keySet, true);
  assert.equal((await call(`/providers/${oid}`, 'PUT', { key: null })).body.keySet, false);
  assert.equal((await call(`/providers/${oid}`, 'PUT', { key: OAI_KEY })).body.keySet, true);
  assert.equal((await call(`/providers/${oid}`, 'PUT', { bogus: 1 })).status, 400);
  assert.equal((await call('/providers/p-zzzzzzzz', 'PUT', { name: 'x' })).status, 404);

  // Test: a second of silence, never user data.
  riva.calls.length = 0;
  const t = await call(`/providers/${rid}/test`, 'POST');
  assert.equal(t.body.ok, true);
  assert.equal(riva.calls[0]!.audio.length, 44 + 32_000);
});

test('a voice note: read by the core, sent once, kept; a format the provider does not take: converted by the browser', async () => {
  const list = (await call('/providers')).body.providers as { id: string; kind: string }[];
  const rid = list.find((p) => p.kind === 'nvidia-riva')!.id;
  await call('/default', 'PUT', { provider: rid });
  riva.calls.length = 0;
  served.length = 0;
  riva.answer = () => ({ texts: ['On se voit demain ?'], language: 'fr-FR' });

  const first = await call('/message', 'POST', { chatID: 'c1', messageID: 'm1', index: 0 });
  assert.deepEqual(first.body, { text: 'On se voit demain ?', language: 'fr-FR', cached: false });
  assert.deepEqual([...riva.calls[0]!.audio], [...OGG], 'the Ogg Opus note as it is');
  assert.equal(riva.calls[0]!.headers.authorization, `Bearer ${RIVA_KEY}`);
  // Twice at once, then again: one request only.
  const again = await Promise.all([call('/message', 'POST', { chatID: 'c1', messageID: 'm1', index: 0 }), call('/message', 'POST', { chatID: 'c1', messageID: 'm1', index: 0 })]);
  assert.deepEqual(again.map((r) => r.body.cached), [true, true]);
  assert.equal(riva.calls.length, 1);
  assert.deepEqual(served, ['m1/v']);
  // Kept on the server (0600), listed for the chat.
  const file = join(config().dataDir, 'transcripts.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual((await call('/transcripts?chatID=c1')).body, { items: { 'm1/0': { text: 'On se voit demain ?', language: 'fr-FR' } } });

  // m4a: Riva does not take it. Nothing is sent; the browser fetches it, converts it, sends WAV.
  const conv = await call('/message', 'POST', { chatID: 'c1', messageID: 'm1', index: 1 });
  assert.deepEqual([conv.status, conv.body.error], [415, 'convert']);
  assert.equal(riva.calls.length, 1);
  const bytes = await call('/audio?chatID=c1&messageID=m1&index=1');
  assert.equal(bytes.status, 200);
  assert.deepEqual([...bytes.bytes], [...M4A]);
  assert.equal(bytes.headers.get('content-type'), 'application/octet-stream');
  assert.equal(bytes.headers.get('x-audio-type'), 'audio/mp4');
  assert.equal(bytes.headers.get('x-content-type-options'), 'nosniff');
  riva.answer = (_c, n) => ({ texts: [`piece ${n}`] });
  const wav = encodeWav(new Int16Array(16_000 * 70), 16_000);
  const done = await call('/wav?chatID=c1&messageID=m1&index=1', 'POST', wav);
  assert.deepEqual(done.body, { text: 'piece 2 piece 3', cached: false });
  assert.equal(riva.calls.length, 3, 'two pieces of 60 s at most');
  assert.equal((await call('/wav?chatID=c1&messageID=m1&index=1', 'POST', wav)).body.cached, true);

  // Validation.
  assert.equal((await call('/message', 'POST', { chatID: 'c1', messageID: 'm1', index: 2 })).body.error, 'no_audio', 'a picture');
  assert.equal((await call('/message', 'POST', { chatID: 'c1', messageID: 'nope', index: 0 })).status, 404, 'the source says it has no such message');
  for (const b of [{ chatID: 'c1', messageID: 'm1' }, { chatID: 'c1', messageID: 'm1', index: -1 }, { chatID: 'c1', messageID: 'm1', index: 1.5 }, { chatID: 'c 1', messageID: 'm1', index: 0 }, { chatID: 'c1', messageID: 'm1', index: 0, x: 1 }]) {
    assert.equal((await call('/message', 'POST', b)).status, 400, JSON.stringify(b));
  }
  const stereo = encodeWav(new Int16Array(100), 16_000, 2);
  assert.equal((await call('/wav?chatID=c1&messageID=m2&index=0', 'POST', stereo)).status, 400, 'only what the page converts to');
  assert.equal((await call('/wav?chatID=c1&messageID=m2&index=0', 'POST', new TextEncoder().encode('not a wav at all, not at all, not at all, no'))).status, 400);
  assert.equal((await call('/wav?chatID=c1&messageID=m2&index=0', 'POST', wav, { 'content-type': 'audio/ogg' })).status, 400);
  assert.equal((await call('/wav?chatID=c1&messageID=m2&index=0', 'POST', encodeWav(new Int16Array(16_000 * 601), 16_000))).status, 413, 'past 10 minutes');
  assert.equal((await call('/transcripts?chatID=')).status, 400);

  // ✕ forgets one; Clear forgets all.
  assert.equal((await call('/transcripts/forget', 'POST', { chatID: 'c1', messageID: 'm1', index: 1 })).status, 200);
  assert.deepEqual(Object.keys((await call('/transcripts?chatID=c1')).body.items as object), ['m1/0']);
  assert.equal((await call('/providers')).body.transcripts, 1);
  assert.equal((await call('/transcripts', 'DELETE')).status, 200);
  assert.deepEqual((await call('/transcripts?chatID=c1')).body.items, {});
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);

  // A refused or failed provider: its code, no text kept.
  riva.answer = () => ({ grpcStatus: 16, message: 'bad key' });
  const refused = await call('/message', 'POST', { chatID: 'c1', messageID: 'm1', index: 0 });
  assert.deepEqual([refused.status, refused.body.error], [502, 'rejected']);
  assert.deepEqual((await call('/transcripts?chatID=c1')).body.items, {});

  // The OpenAI-compatible provider takes m4a as is.
  const oid = list.find((p) => p.kind === 'openai')!.id;
  await call('/default', 'PUT', { provider: oid });
  oai.calls.length = 0;
  const m4a = await call('/message', 'POST', { chatID: 'c1', messageID: 'm1', index: 1 });
  assert.equal(m4a.body.text, 'hello there');
  assert.equal(oai.calls[0]!.fileName, 'audio.m4a');
});

test('rate limit per client, and the routes leave with the package', async () => {
  let limited = 0;
  for (let i = 0; i < 70 && !limited; i++) if ((await call(`/audio?chatID=c1&messageID=m1&index=0`)).status === 429) limited = i;
  assert.ok(limited > 0 && limited <= 61, `limited at ${limited}`);
  await registry.setEnabled('transcribe', false);
  assert.equal((await call('/status')).status, 404);
  await registry.setEnabled('transcribe', true);
  assert.equal((await call('/status')).status, 200);
});

test('the server\'s provider from the environment: listed first, its key never shown; a missing key file keeps the package off', async () => {
  const dir = config().dataDir;
  const keyFile = join(dir, 'nvidia_key');
  writeFileSync(keyFile, `${ENV_KEY}\n`, { mode: 0o600 });
  process.env.KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE = keyFile;
  process.env.KLATCHLY_TRANSCRIBE_NVIDIA_MODEL = 'whisper-large-v3';
  setServerKey(undefined);
  await call('/default', 'PUT', { provider: null });
  const list = await call('/providers');
  const env = (list.body.providers as { id: string; fromServer: boolean; keySet: boolean; url: string; model: string; language: string }[])[0]!;
  assert.deepEqual(env, { id: 'env', kind: 'nvidia-riva', name: 'NVIDIA', url: 'https://grpc.nvcf.nvidia.com:443', model: 'whisper-large-v3', language: '', fromServer: true, keySet: true });
  assert.equal(list.body.effective, 'env');
  // Its name, model and language may change; its address and key not.
  assert.equal((await call('/providers/env', 'PUT', { key: 'x' })).body.error, 'server_provider');
  assert.equal((await call('/providers/env', 'PUT', { name: 'NVIDIA NIM' })).body.name, 'NVIDIA NIM');
  assert.equal((await call('/providers/env/model', 'PUT', { model: 'parakeet-ctc-0.6b-vi', language: 'vi-VN' })).body.model, 'parakeet-ctc-0.6b-vi');
  assert.equal((await call('/providers/env', 'DELETE')).body.error, 'server_provider');
  assert.ok(!readFileSync(join(dir, 'transcribe.json'), 'utf8').includes(ENV_KEY));

  // The package's check: a key file that is missing keeps it off with its reason.
  const check = transcribePkg.modules.find((m) => m.type === 'provider')!.check!;
  assert.equal(check(), null);

  // A model that needs a language: the environment's (KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE), still once chosen again in
  // Settings as the environment says (the choice then forgotten: the environment applies).
  process.env.KLATCHLY_TRANSCRIBE_NVIDIA_MODEL = 'canary-1b';
  process.env.KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE = 'fr-FR';
  const envView = async () => ((await call('/providers')).body.providers as { id: string; model: string; language: string }[])[0]!;
  assert.equal((await call('/providers/env/model', 'PUT', { model: 'canary-1b', language: 'fr-FR' })).body.language, 'fr-FR');
  assert.deepEqual([(await envView()).model, (await envView()).language], ['canary-1b', 'fr-FR']);
  assert.ok(!('language' in (JSON.parse(readFileSync(join(dir, 'transcribe.json'), 'utf8')) as { server: object }).server), 'the environment applies');
  assert.equal(check(), null);
  process.env.KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE = '';
  assert.match(String(check()), /KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE is required by canary-1b/);
  delete process.env.KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE;
  process.env.KLATCHLY_TRANSCRIBE_NVIDIA_MODEL = 'whisper-large-v3';
  process.env.KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE = join(dir, 'missing');
  setServerKey(undefined);
  assert.match(String(check()), /key file missing or empty/);
  process.env.KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE = keyFile;
  process.env.KLATCHLY_TRANSCRIBE_NVIDIA_MODEL = 'gpt-4';
  assert.match(String(check()), /KLATCHLY_TRANSCRIBE_NVIDIA_MODEL/);
  delete process.env.KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE;
  delete process.env.KLATCHLY_TRANSCRIBE_NVIDIA_MODEL;
  setServerKey(undefined);
  assert.equal(check(), null, 'no key file: no server provider, the package on');
  assert.ok(!readdirSync(dir).some((f) => f.startsWith('transcribe.json.bad')));
});
