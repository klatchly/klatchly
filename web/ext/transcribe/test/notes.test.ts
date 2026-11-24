import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '#core/app.js';
import { config } from '#core/config.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { fakeSource } from '../../../test/fakesource.js';
import { silenceWav } from '../audio.js';
import transcribePkg from '../server/index.js';
import { addProvider, removeProvider, resetStore, setServerKey } from '../server/store.js';
import { fakeRiva, oggOpus, type RivaAnswer } from './fakes.js';

// The voice notes' routes under load (routes.ts), in a process of their own (a fresh rate limit): a note the source
// says is too long refused before any conversion, the cap of sounds sent at once (a note already being sent takes no
// slot: a second tap waits for it), POST /wav holding its slot while its body is read, the cap of GET /audio reads,
// and a run that ends after the package was turned off and on never breaks the newer run's dedup.

const riva = await fakeRiva();
after(() => riva.close());

const OGG = oggOpus(4000);
const src = fakeSource();
const served: string[] = [];
/** While set, the source holds its answers (GET /audio, the core's reader) until it resolves. */
let holdSource: Promise<void> | undefined;
src.module.attachmentSource = (m, a) => async () => {
  served.push(`${m.id}/${a.id}`);
  if (holdSource) await holdSource;
  const ogg = (a.id ?? '').startsWith('v');
  return { status: 200, headers: { 'content-type': ogg ? 'audio/ogg' : 'audio/mp4' }, body: new Blob([ogg ? OGG : Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])]).stream() };
};
const voice = (id: string) => ({ id, type: 'audio' as const, mimeType: 'audio/ogg', isVoiceNote: true, duration: 3 });
src.messages.set('c1', [
  { id: 'notes', chatID: 'c1', attachments: [0, 1, 2, 3, 4, 5].map((i) => voice(`v${i}`)) },
  { id: 'long', chatID: 'c1', attachments: [{ id: 'a', type: 'audio', mimeType: 'audio/x-m4a', duration: 2400 }] },
]);

resetStore();
delete process.env.KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE;
setServerKey(undefined);
const pid = addProvider({ kind: 'nvidia-riva', name: 'Riva', url: riva.url, key: null, model: 'whisper-large-v3', language: '' });
assert.ok('id' in pid);
if (!store.read().credentials.length) store.mutate((s) => void s.credentials.push({ id: 'cred', publicKey: 'x', counter: 0, createdAt: '2026-01-01T00:00:00Z', label: 'test' }));
const sid = store.mutate((s) => sessions.create(s));
const registry = new Registry([src.pkg, transcribePkg]);
const app = createApp(registry);
await registry.start();
after(() => registry.stop());

async function call(path: string, method = 'GET', body?: unknown) {
  const raw = body instanceof Uint8Array;
  const res = await app.request(`/api/transcribe${path}`, {
    method,
    headers: { cookie: `sid=${sid}`, ...(method !== 'GET' ? { origin: config().origin, 'content-type': raw ? 'audio/wav' : 'application/json' } : {}) },
    body: body === undefined ? undefined : raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> & { error?: string } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    // binary
  }
  return { status: res.status, body: json };
}
const note = (index: number, messageID = 'notes') => call('/message', 'POST', { chatID: 'c1', messageID, index });
const wav = (messageID: string) => call(`/wav?chatID=c1&messageID=${messageID}&index=0`, 'POST', silenceWav(1));

/** Until `cond` holds (a few seconds at most). */
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 300 && !cond(); i++) await sleep(10);
  assert.ok(cond(), what);
}

/** Riva answers held: each call waits until released (a text, or an error). */
const held: ((a: RivaAnswer) => void)[] = [];
const holdRiva = () => {
  held.length = 0;
  riva.answer = () => new Promise<RivaAnswer>((ok) => held.push(ok));
};

test('a note the source says is longer than 10 minutes: refused at once, never sent to the browser to convert', async () => {
  riva.calls.length = 0;
  const r = await note(0, 'long');
  assert.deepEqual([r.status, r.body.error], [422, 'too_long']);
  assert.equal(riva.calls.length, 0);
});

test('three sounds at once: a fourth is busy, a second tap on one being sent waits for it', async () => {
  riva.calls.length = 0;
  holdRiva();
  const running = [0, 1, 2].map((i) => note(i));
  await until(() => riva.calls.length === 3, 'three sent');
  assert.deepEqual((await note(3)).body.error, 'busy');
  assert.equal((await wav('w0')).body.error, 'busy', 'POST /wav too');
  const joiner = note(0);
  await sleep(30);
  assert.equal(riva.calls.length, 3, 'the second tap sends nothing');
  held.forEach((ok, i) => ok({ texts: [`text ${i}`] }));
  const done = await Promise.all(running);
  assert.deepEqual(done.map((r) => r.body.text), ['text 0', 'text 1', 'text 2']);
  assert.deepEqual((await joiner).body, { text: 'text 0', cached: false }, 'the same answer, not busy');
});

test('POST /wav: its slot is held while its body is read, so requests at once never pass the cap together', async () => {
  riva.calls.length = 0;
  holdRiva();
  const answered: { status: number; body: Record<string, unknown> }[] = [];
  const all = ['w1', 'w2', 'w3', 'w4'].map((m) => wav(m).then((r) => (answered.push(r), r)));
  await until(() => riva.calls.length === 3 && answered.length === 1, 'three sent, one refused');
  assert.deepEqual([answered[0]!.status, answered[0]!.body.error], [429, 'busy']);
  held.forEach((ok) => ok({ texts: ['ok'] }));
  const r = await Promise.all(all);
  assert.equal(r.filter((x) => x.status === 200).length, 3);
  assert.equal(riva.calls.length, 3);
});

test('GET /audio: three reads at once at most', async () => {
  served.length = 0;
  let release!: () => void;
  holdSource = new Promise((ok) => (release = ok));
  const reads = [0, 1, 2].map((i) => call(`/audio?chatID=c1&messageID=notes&index=${i}`));
  await until(() => served.length === 3, 'three reads');
  assert.deepEqual((await call('/audio?chatID=c1&messageID=notes&index=3')).body.error, 'busy');
  holdSource = undefined;
  release();
  assert.deepEqual((await Promise.all(reads)).map((r) => r.status), [200, 200, 200]);
  assert.equal((await call('/audio?chatID=c1&messageID=notes&index=3')).status, 200, 'room again');
});

test('a run that ends after the package was turned off and on leaves the newer run in place', async () => {
  riva.calls.length = 0;
  holdRiva();
  const first = note(4);
  await until(() => riva.calls.length === 1, 'first sent');
  await registry.setEnabled('transcribe', false);
  await registry.setEnabled('transcribe', true);
  const second = note(4);
  await until(() => riva.calls.length === 2, 'sent again: the package forgot the first');
  held[0]!({ grpcStatus: 14, message: 'unavailable' });
  assert.equal((await first).body.error, 'failed');
  const third = note(4);
  await sleep(30);
  assert.equal(riva.calls.length, 2, 'the third tap waits for the second run');
  held[1]!({ texts: ['at last'] });
  assert.deepEqual([(await second).body.text, (await third).body.text], ['at last', 'at last']);
});

test('POST /wav without a provider: unavailable, nothing read', async () => {
  assert.equal(removeProvider((pid as { id: string }).id), null);
  const r = await wav('w9');
  assert.deepEqual([r.status, r.body.error], [503, 'unavailable']);
});
