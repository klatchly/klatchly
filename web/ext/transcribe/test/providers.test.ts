import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { encodeWav, silenceWav } from '../audio.js';
import { acceptsMime, openAiLanguage, rivaLanguage, transcribe } from '../server/engine.js';
import { OpenAiError, transcribeOpenAi } from '../server/openai.js';
import { decodeResponse, encodeConfig, encodeRequest, fields, recognize, RIVA_PATH, RivaError } from '../server/riva.js';
import { addProvider, resetStore, setDefault, setModel } from '../server/store.js';
import { flac, fakeOpenAi, fakeRiva, grpcFrame, oggOpus, rivaResponse, type FakeOpenAi, type FakeRiva } from './fakes.js';

// The two kinds of provider against in-process fakes: Riva's Recognize request as NVIDIA's servers read it (gRPC
// over HTTP/2, the protobuf fields, the metadata), WAV cut into 60 s pieces, Ogg Opus sent as is; the OpenAI
// multipart request (file named by its type, model, language); and what each answers when it refuses.

let riva: FakeRiva;
let oai: FakeOpenAi;
let rivaId: string;
let oaiId: string;
before(async () => {
  riva = await fakeRiva();
  oai = await fakeOpenAi();
  resetStore();
  const a = addProvider({ kind: 'nvidia-riva', name: 'Riva', url: riva.url, key: 'nvapi-test-key', model: 'whisper-large-v3', language: '' });
  const b = addProvider({ kind: 'openai', name: 'Groq', url: oai.url, key: 'gsk-test', model: 'whisper-large-v3', language: 'fr-FR' });
  assert.ok('id' in a && 'id' in b);
  rivaId = a.id;
  oaiId = b.id;
});
after(async () => {
  await riva.close();
  await oai.close();
});

test('protobuf: RecognitionConfig bytes as riva_asr.proto numbers them', () => {
  // encoding 4 (OGGOPUS), 48000 Hz, 'multi', max_alternatives 1, 1 channel, automatic punctuation.
  assert.deepEqual(
    [...encodeConfig({ encoding: 4, sampleRate: 48_000, language: 'multi', channels: 1 })],
    [0x08, 0x04, 0x10, 0x80, 0xf7, 0x02, 0x1a, 0x05, ...new TextEncoder().encode('multi'), 0x20, 0x01, 0x38, 0x01, 0x58, 0x01],
  );
  // Encoding unset (WAV): field 1 left out, as proto3 does for a zero.
  assert.equal(encodeConfig({ encoding: 0, sampleRate: 16_000, language: 'fr-FR', channels: 1 })[0], 0x10);
  const req = fields(encodeRequest({ encoding: 1, sampleRate: 16_000, language: 'en-US', channels: 1 }, Uint8Array.from([1, 2, 3])));
  assert.deepEqual(req.map((f) => f.field), [1, 2]);
  assert.deepEqual([...req[1]!.b!], [1, 2, 3]);
  assert.deepEqual(decodeResponse(rivaResponse(['Bonjour.', ' ', 'Ça va ?'], 'fr-FR')), { text: 'Bonjour. Ça va ?', language: 'fr-FR' });
  assert.deepEqual(decodeResponse(new Uint8Array()), { text: '' });
  assert.throws(() => fields(Uint8Array.from([0x0a, 0x05, 1])), /truncated/);
});

test('languages: automatic is "multi" on models that detect it; ISO-639-1 for OpenAI', () => {
  assert.equal(rivaLanguage('whisper-large-v3', ''), 'multi');
  assert.equal(rivaLanguage('parakeet-1.1b-rnnt-multilingual', ''), 'multi');
  assert.equal(rivaLanguage('parakeet-ctc-0.6b-vi', ''), 'vi-VN');
  assert.equal(rivaLanguage('b702f636-f60c-4a3d-a6f4-f3568c13bd7d', ''), 'multi', 'a function id: automatic');
  assert.equal(rivaLanguage('canary-1b', 'fr-FR'), 'fr-FR');
  assert.equal(openAiLanguage('fr-FR'), 'fr');
  assert.equal(openAiLanguage(''), '');
});

test('Riva: one call, the metadata NVCF reads, the answer and its errors', async () => {
  riva.calls.length = 0;
  riva.answer = () => ({ texts: ['hello'], language: 'en-US' });
  const r = await recognize({ endpoint: riva.url, functionId: 'fid', key: 'k1' }, { encoding: 0, sampleRate: 16_000, language: 'multi', channels: 1 }, silenceWav(1), 5000);
  assert.deepEqual(r, { text: 'hello', language: 'en-US' });
  const h = riva.calls[0]!.headers;
  assert.equal(h[':path'], RIVA_PATH);
  assert.equal(h['content-type'], 'application/grpc');
  assert.equal(h.te, 'trailers');
  assert.equal(h['function-id'], 'fid');
  assert.equal(h.authorization, 'Bearer k1');
  assert.deepEqual(riva.calls[0]!.config, { 2: 16_000, 3: 'multi', 4: 1, 7: 1, 11: 1 });

  riva.answer = () => ({ grpcStatus: 16, message: 'Unauthorized: bad key' });
  await assert.rejects(recognize({ endpoint: riva.url, key: null }, { encoding: 0, sampleRate: 16_000, language: 'multi', channels: 1 }, silenceWav(1), 5000), (e: unknown) => e instanceof RivaError && e.grpcStatus === 16 && e.message === 'Unauthorized: bad key');
  riva.answer = () => ({ http: 401 });
  await assert.rejects(recognize({ endpoint: riva.url, key: null }, { encoding: 0, sampleRate: 16_000, language: 'multi', channels: 1 }, silenceWav(1), 5000), (e: unknown) => e instanceof RivaError && e.httpStatus === 401);
  assert.equal(riva.calls.at(-1)!.headers.authorization, undefined, 'no key: no header');
  await assert.rejects(recognize({ endpoint: 'http://127.0.0.1:9', key: null }, { encoding: 0, sampleRate: 16_000, language: 'multi', channels: 1 }, silenceWav(1), 5000), RivaError);
});

test('Riva through the engine: WAV cut into 60 s pieces, Ogg Opus as is, too big or refused: convert', async () => {
  riva.calls.length = 0;
  riva.answer = (_c, n) => ({ texts: [`part${n}`], language: 'fr-FR' });
  setDefault(rivaId);
  // 130 s of 16 kHz mono: three requests, in order.
  const long = encodeWav(new Int16Array(16_000 * 130), 16_000);
  const r = await transcribe({ data: long, mime: 'audio/wav' });
  assert.equal(r.text, 'part1 part2 part3');
  assert.equal(r.language, 'fr-FR');
  assert.equal(r.provider, rivaId);
  assert.deepEqual(riva.calls.map((c) => c.audio.length), [44 + 16_000 * 60 * 2, 44 + 16_000 * 60 * 2, 44 + 16_000 * 10 * 2]);
  assert.equal(riva.calls[0]!.headers['function-id'], 'b702f636-f60c-4a3d-a6f4-f3568c13bd7d', 'the preset\'s NVCF function');
  assert.equal(riva.calls[0]!.headers.authorization, 'Bearer nvapi-test-key');
  assert.equal(riva.calls[0]!.config[1], undefined, 'WAV: encoding unset, the header says');

  riva.calls.length = 0;
  riva.answer = () => ({ texts: ['salut'] });
  const ogg = oggOpus(5000, 1);
  assert.equal((await transcribe({ data: ogg, mime: 'audio/ogg; codecs=opus', duration: 3 })).text, 'salut');
  assert.deepEqual(riva.calls[0]!.config, { 1: 4, 2: 48_000, 3: 'multi', 4: 1, 7: 1, 11: 1 });
  assert.deepEqual([...riva.calls[0]!.audio], [...ogg], 'the voice note as it is');

  // A language set on the provider; a model without automatic detection needs one.
  assert.equal(setModel(rivaId, 'canary-1b', ''), 'language_required');
  assert.equal(setModel(rivaId, 'canary-1b', 'fr-FR'), null);
  riva.calls.length = 0;
  await transcribe({ data: ogg, mime: 'audio/ogg' });
  assert.equal(riva.calls[0]!.config[3], 'fr-FR');
  assert.equal(riva.calls[0]!.headers['function-id'], 'b0e8b4a5-217c-40b7-9b96-17d84e666317');
  assert.equal(setModel(rivaId, 'whisper-large-v3', ''), null);

  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
  riva.calls.length = 0;
  assert.equal(await code(transcribe({ data: oggOpus(3 * 1024 * 1024), mime: 'audio/ogg' })), 'unsupported_format', 'too big for one request: the browser sends WAV pieces');
  assert.equal(await code(transcribe({ data: new Uint8Array(100), mime: 'audio/ogg' })), 'unsupported_format', 'not Opus');
  assert.equal(await code(transcribe({ data: new Uint8Array(100), mime: 'audio/mp4' })), 'unsupported_format');
  assert.equal(riva.calls.length, 0, 'nothing sent');
  assert.equal(await code(transcribe({ data: encodeWav(new Int16Array(16_000 * 602), 16_000), mime: 'audio/wav' })), 'too_long');
  assert.equal(await code(transcribe({ data: ogg, mime: 'audio/ogg', duration: 700 })), 'too_long');
  riva.answer = () => ({ grpcStatus: 3, message: 'Unsupported encoding' });
  assert.equal(await code(transcribe({ data: ogg, mime: 'audio/ogg' })), 'unsupported_format', 'refused compressed: convert');
  assert.equal(await code(transcribe({ data: silenceWav(1), mime: 'audio/wav' })), 'rejected', 'refused WAV: nothing more to try');
  riva.answer = () => ({ grpcStatus: 7, message: 'denied' });
  assert.equal(await code(transcribe({ data: silenceWav(1), mime: 'audio/wav' })), 'rejected');
  riva.answer = () => ({ grpcStatus: 14, message: 'unavailable' });
  assert.equal(await code(transcribe({ data: silenceWav(1), mime: 'audio/wav' })), 'failed');
  assert.equal(await code(transcribe({ data: silenceWav(1), mime: 'audio/wav' }, { provider: 'p-nothere' })), 'unavailable');
});

test('OpenAI-compatible: multipart file named by its type, model, language, key; refusals', async () => {
  oai.calls.length = 0;
  oai.answer = () => ({ status: 200, body: { text: ' hello there ' } });
  const r = await transcribe({ data: Uint8Array.from([1, 2, 3, 4]), mime: 'audio/x-m4a' }, { provider: oaiId });
  assert.equal(r.text, 'hello there');
  assert.deepEqual(oai.calls[0], { path: '/v1/audio/transcriptions', auth: 'Bearer gsk-test', model: 'whisper-large-v3', language: 'fr', format: 'json', fileName: 'audio.m4a', fileType: 'audio/x-m4a', size: 4, encoding: 'identity' });
  // Automatic language: none sent.
  await transcribe({ data: Uint8Array.from([1]), mime: 'audio/ogg' }, { provider: oaiId, language: '' });
  assert.equal(oai.calls[1]!.language, null);
  assert.equal(oai.calls[1]!.fileName, 'audio.ogg');

  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
  oai.answer = () => ({ status: 400, body: { error: { message: 'Invalid file format' } } });
  assert.equal(await code(transcribe({ data: Uint8Array.from([1]), mime: 'audio/ogg' }, { provider: oaiId })), 'unsupported_format');
  assert.equal(await code(transcribe({ data: silenceWav(1), mime: 'audio/wav' }, { provider: oaiId })), 'rejected');
  oai.answer = () => ({ status: 401, body: {} });
  assert.equal(await code(transcribe({ data: Uint8Array.from([1]), mime: 'audio/ogg' }, { provider: oaiId })), 'rejected');
  oai.answer = () => ({ status: 302, body: '', headers: { location: 'http://127.0.0.1:9/steal' } });
  assert.equal(await code(transcribe({ data: Uint8Array.from([1]), mime: 'audio/ogg' }, { provider: oaiId })), 'failed', 'a redirect is never followed');
  oai.answer = () => ({ status: 200, body: '<html>secret</html>' });
  const e = await transcribe({ data: Uint8Array.from([1]), mime: 'audio/ogg' }, { provider: oaiId }).catch((x: Error) => x);
  assert.ok(e instanceof Error && !e.message.includes('secret'), 'the answer\'s text never shows in an error');
  const before = oai.calls.length;
  assert.equal(await code(transcribe({ data: Uint8Array.from([1]), mime: 'audio/x-caf' }, { provider: oaiId })), 'unsupported_format');
  assert.equal(oai.calls.length, before, 'nothing sent');
});

test('formats taken as is, per kind', async () => {
  const { provider } = await import('../server/store.js');
  const rp = provider(rivaId)!;
  const op = provider(oaiId)!;
  for (const m of ['audio/wav', 'audio/ogg; codecs=opus', 'audio/flac']) assert.ok(acceptsMime(rp, m), m);
  for (const m of ['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/x-caf']) assert.ok(!acceptsMime(rp, m), m);
  for (const m of ['audio/mp4', 'audio/x-m4a', 'audio/ogg', 'audio/mpeg', 'audio/webm', 'audio/wav']) assert.ok(acceptsMime(op, m), m);
  for (const m of ['audio/x-caf', 'audio/amr', 'audio/aac']) assert.ok(!acceptsMime(op, m), m);
});

const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
const RIVA_CFG = { encoding: 0, sampleRate: 16_000, language: 'multi', channels: 1 };

test('Riva: only 16 kHz mono WAV and mono Opus or FLAC go as they are; anything else is converted by the browser', async () => {
  setDefault(rivaId);
  riva.calls.length = 0;
  riva.answer = () => ({ texts: ['ok'] });
  // 2 min of 44.1 kHz stereo (Riva takes one channel; 60 s pieces of 10 MB), 44.1 kHz mono, 16 kHz stereo.
  for (const [rate, ch] of [[44_100, 2], [44_100, 1], [16_000, 2]] as const) {
    const wav = encodeWav(new Int16Array(rate * ch * (rate === 16_000 ? 2 : 120)), rate, ch);
    assert.equal(await code(transcribe({ data: wav, mime: 'audio/wav' })), 'unsupported_format', `${rate} Hz, ${ch} channel(s)`);
  }
  assert.equal(await code(transcribe({ data: oggOpus(5000, 2), mime: 'audio/ogg' })), 'unsupported_format', 'stereo Opus');
  assert.equal(await code(transcribe({ data: flac(44_100, 2), mime: 'audio/flac' })), 'unsupported_format', 'stereo FLAC');
  assert.equal(riva.calls.length, 0, 'nothing sent');
  // Mono FLAC: as it is, at its rate.
  const f = flac(44_100, 1, 3000);
  assert.equal((await transcribe({ data: f, mime: 'audio/x-flac' })).text, 'ok');
  assert.deepEqual(riva.calls[0]!.config, { 1: 2, 2: 44_100, 3: 'multi', 4: 1, 7: 1, 11: 1 });
  assert.deepEqual([...riva.calls[0]!.audio], [...f]);
});

test('a language the provider reports is kept only when it is a language code', async () => {
  setDefault(rivaId);
  riva.answer = () => ({ texts: ['hi'], language: 'multi' });
  const r = await transcribe({ data: silenceWav(1), mime: 'audio/wav' });
  assert.equal(r.language, undefined, "'multi' is not a language");
  riva.answer = () => ({ texts: ['xin chào'], language: 'vi-VN' });
  assert.equal((await transcribe({ data: silenceWav(1), mime: 'audio/wav' })).language, 'vi-VN');
});

test('Riva: a misbehaving server, a timeout, an abort', async () => {
  const call = (timeout = 5000, signal?: AbortSignal) => recognize({ endpoint: riva.url, key: null }, RIVA_CFG, silenceWav(1), timeout, signal);
  const reason = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof RivaError ? e.message : 'not a RivaError'));
  // No answer: the timeout (DEADLINE_EXCEEDED), then the session is let go.
  let release!: () => void;
  riva.answer = () => new Promise((ok) => (release = () => ok({ texts: ['late'] })));
  await assert.rejects(call(150), (e: unknown) => e instanceof RivaError && e.message === 'timeout' && e.grpcStatus === 4);
  release();
  riva.answer = () => new Promise((ok) => (release = () => ok({ texts: ['late'] })));
  const ac = new AbortController();
  const aborted = reason(call(5000, ac.signal));
  setTimeout(() => ac.abort(), 50);
  assert.equal(await aborted, 'aborted');
  release();
  assert.equal(await reason(call(5000, AbortSignal.abort())), 'aborted', 'aborted before it starts');
  // A compressed frame, a truncated one, no grpc-status, not gRPC at all, too big an answer.
  const ok200 = (body: Uint8Array, trailers = true) => (stream: import('node:http2').ServerHttp2Stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: trailers });
    if (trailers) stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(body);
  };
  const compressed = grpcFrame(rivaResponse(['x']));
  compressed[0] = 1;
  riva.answer = () => ({ raw: ok200(compressed) });
  assert.equal(await reason(call()), 'grpc: compressed answer');
  riva.answer = () => ({ raw: ok200(grpcFrame(rivaResponse(['hello world'])).subarray(0, 9)) });
  assert.equal(await reason(call()), 'grpc: truncated answer');
  riva.answer = () => ({ raw: ok200(grpcFrame(rivaResponse(['x'])), false) });
  assert.equal(await reason(call()), 'no grpc-status');
  riva.answer = () => ({
    raw: (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'text/html' });
      stream.end('<html>');
    },
  });
  assert.equal(await reason(call()), 'http 200');
  riva.answer = () => ({ raw: ok200(new Uint8Array(5 * 1024 * 1024)) });
  assert.equal(await reason(call()), 'answer too large');
});

test('OpenAI-compatible: WAV types named .wav, a big WAV converted, 413, answers capped as they stream, timeout', async () => {
  oai.calls.length = 0;
  oai.answer = () => ({ status: 200, body: { text: 'ok' } });
  await transcribe({ data: silenceWav(1), mime: 'audio/vnd.wave' }, { provider: oaiId });
  await transcribe({ data: oggOpus(100), mime: 'application/ogg' }, { provider: oaiId });
  assert.deepEqual(oai.calls.map((c) => c.fileName), ['audio.wav', 'audio.ogg']);

  // 24.5 MB of 44.1 kHz stereo (2 min 19 s): over the API's limit, but 4.5 MB once 16 kHz mono.
  const big = encodeWav(new Int16Array(Math.ceil((24.5 * 1024 * 1024) / 2)), 44_100, 2);
  assert.equal(await code(transcribe({ data: big, mime: 'audio/wav' }, { provider: oaiId })), 'unsupported_format');
  assert.equal(oai.calls.length, 2, 'nothing sent');

  oai.answer = () => ({ status: 413, body: {} });
  assert.equal(await code(transcribe({ data: Uint8Array.from([1]), mime: 'audio/ogg' }, { provider: oaiId })), 'too_large');

  const failure = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);
  // No content-length (chunked), past the cap.
  oai.answer = () => ({ status: 200, body: JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }), headers: { 'transfer-encoding': 'chunked' } });
  assert.equal(await failure(transcribe({ data: Uint8Array.from([1]), mime: 'audio/ogg' }, { provider: oaiId })), 'failed: answer too large');
  // Compressed though identity was asked: a few KB that inflate past the cap, read as it streams.
  const bomb = gzipSync(Buffer.from(JSON.stringify({ text: ' '.repeat(8 * 1024 * 1024) })));
  assert.ok(bomb.length < 64 * 1024);
  oai.answer = () => ({ status: 200, body: bomb, headers: { 'content-encoding': 'gzip', 'content-length': String(bomb.length) } });
  assert.equal(await failure(transcribe({ data: Uint8Array.from([1]), mime: 'audio/ogg' }, { provider: oaiId })), 'failed: answer too large');
  // A content-length past the cap: not read.
  const long = JSON.stringify({ text: 'y'.repeat(1024 * 1024 + 10) });
  oai.answer = () => ({ status: 200, body: long, headers: { 'content-length': String(Buffer.byteLength(long)) } });
  assert.equal(await failure(transcribe({ data: Uint8Array.from([1]), mime: 'audio/ogg' }, { provider: oaiId })), 'failed: answer too large');

  // No answer in time; aborted by the caller.
  oai.answer = () => new Promise((ok) => setTimeout(() => ok({ status: 200, body: { text: 'late' } }), 1000));
  const target = { url: oai.url, key: null, model: 'm' };
  const audio = { data: Uint8Array.from([1]), mime: 'audio/ogg', fileName: 'audio.ogg' };
  await assert.rejects(transcribeOpenAi(target, audio, '', 100), (e: unknown) => e instanceof OpenAiError && e.message === 'timeout' && e.status === null);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(transcribeOpenAi(target, audio, '', 5000, ac.signal), (e: unknown) => e instanceof OpenAiError && e.message === 'aborted');
});
