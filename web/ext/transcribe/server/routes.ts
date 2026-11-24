import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { clientIp, fail, jsonObject, log, RateLimiter, requireStepUp, validId, type ChatReader, type Env } from '#core/sdk.js';
import type { Transcript, TranscribeFailure } from '../api.js';
import { baseMime, parseWav, plainPcm16, silenceWav, TARGET_RATE, wavSeconds } from '../audio.js';
import { defaultModel, isKind, MAX_SECONDS, validLanguage, validModel } from '../kinds.js';
import { acceptsMime, failure, isFailure, transcribe } from './engine.js';
import {
  addProvider,
  chosenDefault,
  cleanAddress,
  cleanName,
  clearTranscripts,
  defaultProvider,
  forgetTranscript,
  hasKey,
  keepTranscript,
  provider,
  providers,
  removeProvider,
  setDefault,
  setModel,
  transcriptCount,
  transcriptOf,
  transcriptsFor,
  updateProvider,
  validKey,
  validProviderId,
  type Problem,
  type Provider,
} from './store.js';

// The transcribe package's API, at /api/transcribe (its augmentation's routes).
// Settings → Transcription:
//   GET    /providers               the providers (never a key: `keySet` only), the default, the transcripts kept
//   POST   /providers               add one {kind, name, url, key?, model, language}               (step-up)
//   PUT    /providers/:id           {name?, url?, key?: string | null (clears)}                    (step-up)
//   DELETE /providers/:id                                                                          (step-up)
//   PUT    /providers/:id/model     {model, language}: which model, which language ('' : automatic)
//   POST   /providers/:id/test      one second of silence, generated here (never user data)
//   PUT    /default                 {provider: id | null}
//   DELETE /transcripts             forgets every transcript
// Under the voice notes:
//   GET    /status                  {ready, label?}: whether a provider is there (the button shows), and its name
//   GET    /transcripts?chatID=     the chat's transcripts, by '<message id>/<index>'
//   POST   /transcripts/forget      {chatID, messageID, index}: ✕ under one
//   POST   /message                 {chatID, messageID, index}: the attachment, read by the core's reader, to text
//                                   (kept, so it is never sent twice); 415 'convert' when the provider does not take
//                                   its format: the browser then reads it (GET /audio), converts it to 16 kHz mono
//                                   16-bit WAV and sends that (POST /wav).
//   GET    /audio?chatID&messageID&index   the attachment's bytes, for that conversion
//   POST   /wav?chatID&messageID&index     the converted WAV (audio/wav body) to text, kept the same way
// Adding, editing and removing a provider changes where the sound goes and with which key: a recent sign-in or
// step-up (the sdk's requireStepUp). Choosing the model, the language or the default provider does not. Ids go in
// the body or the query string, never in the path (the request log keeps the path only).

let reader: ChatReader | undefined;
/** The core's reader of this package's augmentation (start), or undefined while it is off. */
export function setReader(r: ChatReader | undefined): void {
  reader = r;
  if (!r) inflight.clear();
}

const view = (p: Provider) => ({ id: p.id, kind: p.kind, name: p.name, url: p.url, model: p.model, language: p.language, fromServer: p.fromServer, keySet: hasKey(p) });

/** Transcriptions per client: a voice note is a tap, a busy one a few dozen in ten minutes. */
const limiter = new RateLimiter(10 * 60 * 1000, 60, 300);
const testLimiter = new RateLimiter(10 * 60 * 1000, 20, 100);
const small = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });
/** A converted WAV: MAX_SECONDS of 16 kHz mono 16-bit, and its header. */
export const MAX_WAV_BYTES = MAX_SECONDS * TARGET_RATE * 2 + 1024;
const wavBody = bodyLimit({ maxSize: MAX_WAV_BYTES, onError: (c) => c.json({ error: 'too_long' }, 413) });
/** Sounds sent at once (each holds its bytes in memory). */
const CONCURRENCY = 3;
let busy = 0;
/** POST /wav requests between their gate and their run: a slot each while their body is read. */
let holding = 0;
/** GET /audio reads at once (each holds up to READ_AUDIO_MAX bytes). */
const AUDIO_CONCURRENCY = 3;
let reading = 0;
const inflight = new Map<string, Promise<Transcript>>();
type Target = { chatID: string; messageID: string; index: number };
const keyOf = (t: Target) => `${t.chatID}\n${t.messageID}\n${t.index}`;

const STATUS: Record<Problem, 400 | 404 | 409 | 500> = {
  bad_request: 400,
  too_many: 409,
  key_required: 400,
  key_reentry: 400,
  server_provider: 400,
  not_found: 404,
  language_required: 400,
  store_failed: 500,
};
const problem = (c: Context<Env>, p: Problem) => c.json({ error: p }, STATUS[p]);
const who = (c: Context<Env>) => ({ session: c.get('session')?.slice(0, 12) ?? '-', ip: clientIp(c) });

export const transcribeRoutes = new Hono<Env>();

// ── Settings ──────────────────────────────────────────────────────────────

transcribeRoutes.get('/providers', (c) =>
  c.json({ providers: providers().map(view), default: chosenDefault(), effective: defaultProvider()?.id ?? null, transcripts: transcriptCount() }),
);

transcribeRoutes.post('/providers', requireStepUp, small, async (c) => {
  const b = await jsonObject(c);
  if (!b || Object.keys(b).some((k) => !['kind', 'name', 'url', 'key', 'model', 'language'].includes(k)) || !isKind(b.kind)) return problem(c, 'bad_request');
  const kind = b.kind;
  const name = cleanName(b.name);
  const url = cleanAddress(kind, b.url);
  const key = b.key === undefined || b.key === null || b.key === '' ? null : validKey(b.key) ? b.key : undefined;
  const model = b.model === undefined ? defaultModel(kind) : b.model;
  const language = b.language === undefined ? '' : b.language;
  if (!name || !url || key === undefined || !validModel(kind, model) || !validLanguage(language)) return problem(c, 'bad_request');
  const r = addProvider({ kind, name, url, key, model, language });
  if ('error' in r) return problem(c, r.error);
  log('transcribe', 'provider added', { provider: r.id, kind, key: !!key, ...who(c) });
  return c.json(view(provider(r.id)!));
});

transcribeRoutes.put('/providers/:id', requireStepUp, small, async (c) => {
  const id = c.req.param('id');
  const b = await jsonObject(c);
  const p = provider(id);
  if (!validProviderId(id) || !b || !Object.keys(b).length || Object.keys(b).some((k) => !['name', 'url', 'key'].includes(k))) return problem(c, 'bad_request');
  if (!p) return problem(c, 'not_found');
  const name = b.name === undefined ? undefined : cleanName(b.name);
  const url = b.url === undefined ? undefined : cleanAddress(p.kind, b.url);
  const key = b.key === undefined ? undefined : b.key === null ? null : validKey(b.key) ? b.key : false;
  if (name === null || url === null || key === false) return problem(c, 'bad_request');
  const err = updateProvider(id, { ...(name !== undefined ? { name } : {}), ...(url !== undefined ? { url } : {}), ...(key !== undefined ? { key } : {}) });
  if (err) return problem(c, err);
  log('transcribe', 'provider changed', { provider: id, name: name !== undefined, url: url !== undefined, key: key === undefined ? 'kept' : key ? 'replaced' : 'cleared', ...who(c) });
  return c.json(view(provider(id)!));
});

transcribeRoutes.delete('/providers/:id', requireStepUp, (c) => {
  const id = c.req.param('id');
  if (!validProviderId(id)) return problem(c, 'bad_request');
  const err = removeProvider(id);
  if (err) return problem(c, err);
  log('transcribe', 'provider removed', { provider: id, ...who(c) });
  return c.json({ ok: true });
});

transcribeRoutes.put('/providers/:id/model', small, async (c) => {
  const id = c.req.param('id');
  const b = await jsonObject(c);
  if (!validProviderId(id) || !b || Object.keys(b).length !== 2 || typeof b.model !== 'string' || typeof b.language !== 'string') return problem(c, 'bad_request');
  const err = setModel(id, b.model, b.language);
  if (err) return problem(c, err);
  log('transcribe', 'model', { provider: id, model: b.model, language: b.language || 'auto' });
  return c.json(view(provider(id)!));
});

transcribeRoutes.post('/providers/:id/test', async (c) => {
  const id = c.req.param('id');
  if (!provider(id)) return problem(c, 'not_found');
  if (!testLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const t0 = Date.now();
  try {
    await transcribe({ data: silenceWav(1), mime: 'audio/wav', duration: 1 }, { provider: id, feature: 'test' });
    return c.json({ ok: true, ms: Date.now() - t0 });
  } catch (e) {
    return c.json({ ok: false, ms: Date.now() - t0, error: isFailure(e) ? e.code : 'failed' });
  }
});

transcribeRoutes.put('/default', small, async (c) => {
  const b = await jsonObject(c);
  if (!b || Object.keys(b).length !== 1 || !(b.provider === null || validProviderId(b.provider))) return problem(c, 'bad_request');
  const err = setDefault(b.provider as string | null);
  if (err) return problem(c, err);
  log('transcribe', 'default', { provider: (b.provider as string | null) ?? 'first' });
  return c.json({ ok: true });
});

transcribeRoutes.delete('/transcripts', (c) => {
  const err = clearTranscripts();
  if (err) return problem(c, err);
  log('transcribe', 'transcripts cleared', who(c));
  return c.json({ ok: true });
});

// ── Under the voice notes ─────────────────────────────────────────────────

transcribeRoutes.get('/status', (c) => {
  const p = defaultProvider();
  // `label`: who the sound goes to (the provider's name), for the button's privacy line.
  return c.json(p ? { ready: true, label: p.name } : { ready: false });
});

transcribeRoutes.get('/transcripts', (c) => {
  const chatID = c.req.query('chatID');
  if (!validId(chatID)) return problem(c, 'bad_request');
  return c.json({ items: transcriptsFor(chatID) });
});

/** {chatID, messageID, index} from a body or a query string; null when malformed. */
function target(o: Record<string, unknown> | null): { chatID: string; messageID: string; index: number } | null {
  if (!o || Object.keys(o).some((k) => !['chatID', 'messageID', 'index'].includes(k))) return null;
  const { chatID, messageID } = o;
  const index = typeof o.index === 'string' && /^\d{1,2}$/.test(o.index) ? Number(o.index) : o.index;
  if (typeof chatID !== 'string' || !validId(chatID) || typeof messageID !== 'string' || !validId(messageID)) return null;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 50) return null;
  return { chatID, messageID, index };
}

transcribeRoutes.post('/transcripts/forget', small, async (c) => {
  const t = target(await jsonObject(c));
  if (!t) return problem(c, 'bad_request');
  forgetTranscript(t.chatID, t.messageID, t.index);
  return c.json({ ok: true });
});

const ERROR_STATUS: Record<TranscribeFailure['code'], 413 | 415 | 422 | 502 | 503> = {
  unavailable: 503,
  unsupported_format: 415,
  too_large: 413,
  too_long: 422,
  rejected: 502,
  failed: 502,
};
const failed = (c: Context<Env>, e: unknown) => {
  const code = isFailure(e) ? e.code : 'failed';
  return c.json({ error: code === 'unsupported_format' ? 'convert' : code }, ERROR_STATUS[code]);
};

/**
 * The guards of a transcription: a reader (the package on), a provider, the client's rate, the room to hold a sound
 * (a note already being transcribed takes none: its request waits for that run).
 */
function gate(c: Context<Env>, t: Target): Response | null {
  if (!reader || !defaultProvider()) return c.json({ error: 'unavailable' }, 503);
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  if (busy + holding >= CONCURRENCY && !inflight.has(keyOf(t))) return c.json({ error: 'busy' }, 429);
  return null;
}

/** Transcribes once per voice note: a second tap meanwhile waits for the first; the text is kept. */
async function once(t: Target, run: () => Promise<Transcript>): Promise<Transcript> {
  const k = keyOf(t);
  let p = inflight.get(k);
  if (!p) {
    busy++;
    const mine: Promise<Transcript> = run()
      .then((r) => {
        keepTranscript(t.chatID, t.messageID, t.index, { text: r.text, provider: r.provider, ...(r.language ? { language: r.language } : {}) });
        return r;
      })
      .finally(() => {
        busy--;
        // Its own entry only: the package turned off and on meanwhile may have a newer run for the same note.
        if (inflight.get(k) === mine) inflight.delete(k);
      });
    p = mine;
    inflight.set(k, p);
  }
  return p;
}

const answer = (r: { text: string; language?: string }, cached: boolean) => ({ text: r.text, ...(r.language ? { language: r.language } : {}), cached });

transcribeRoutes.post('/message', small, async (c) => {
  const t = target(await jsonObject(c));
  if (!t) return problem(c, 'bad_request');
  const hit = transcriptOf(t.chatID, t.messageID, t.index);
  if (hit) return c.json(answer(hit, true));
  const refused = gate(c, t);
  if (refused) return refused;
  const r = reader!;
  try {
    const out = await once(t, async () => {
      const audio = await r.readAudio(t.chatID, t.messageID, t.index);
      if (audio === 'too_large') throw Object.assign(new Error('too_large'), { status: 413 });
      if (!audio) throw Object.assign(new Error('no_audio'), { status: 422 });
      // Longer than any transcription, as the source says: refused before the browser downloads and decodes it.
      if (audio.duration !== undefined && audio.duration > MAX_SECONDS + 1) throw failure('too_long');
      const p = defaultProvider()!;
      // Not a type the provider takes as is: the browser converts it (nothing is sent).
      if (!acceptsMime(p, audio.mime)) throw Object.assign(new Error('convert'), { status: 415 });
      return transcribe(audio, { feature: 'message' });
    });
    return c.json(answer(out, false));
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 413) return c.json({ error: 'too_large' }, 413);
    if (status === 422) return c.json({ error: 'no_audio' }, 422);
    if (status === 415) return c.json({ error: 'convert' }, 415);
    if (isFailure(e)) return failed(c, e);
    return fail(c, e, 'POST /transcribe/message (audio)');
  }
});

transcribeRoutes.get('/audio', async (c) => {
  const t = target(c.req.query());
  if (!t) return problem(c, 'bad_request');
  if (!reader) return c.json({ error: 'unavailable' }, 503);
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  if (reading >= AUDIO_CONCURRENCY) return c.json({ error: 'busy' }, 429);
  let audio: Awaited<ReturnType<ChatReader['readAudio']>>;
  reading++;
  try {
    audio = await reader.readAudio(t.chatID, t.messageID, t.index);
  } catch (e) {
    return fail(c, e, 'GET /transcribe/audio');
  } finally {
    reading--;
  }
  if (audio === 'too_large') return c.json({ error: 'too_large' }, 413);
  if (!audio) return c.json({ error: 'no_audio' }, 422);
  // Bytes for the page's script to decode, never a page: not sniffed, not cached, nothing runs.
  return c.body(audio.data as Uint8Array<ArrayBuffer>, 200, {
    'content-type': 'application/octet-stream',
    'x-audio-type': baseMime(audio.mime),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'no-store',
  });
});

transcribeRoutes.post('/wav', wavBody, async (c) => {
  const t = target(c.req.query());
  if (!t || baseMime(c.req.header('content-type') ?? '') !== 'audio/wav') return problem(c, 'bad_request');
  const hit = transcriptOf(t.chatID, t.messageID, t.index);
  if (hit) return c.json(answer(hit, true));
  const refused = gate(c, t);
  if (refused) return refused;
  // Its slot is held while the body is read (up to MAX_WAV_BYTES), so requests at once never pass the gate together.
  holding++;
  let held = true;
  const release = () => {
    if (held) holding--;
    held = false;
  };
  try {
    const data = new Uint8Array(await c.req.arrayBuffer());
    const w = parseWav(data);
    // What the page converts to: 16-bit PCM, one channel, 16 kHz.
    if (!w || !plainPcm16(w) || w.channels !== 1 || w.rate !== TARGET_RATE) return problem(c, 'bad_request');
    if (wavSeconds(w) > MAX_SECONDS + 1) return c.json({ error: 'too_long' }, 422);
    // The slot passes to the run (once counts it as busy), with no await in between.
    release();
    try {
      return c.json(answer(await once(t, () => transcribe({ data, mime: 'audio/wav', duration: wavSeconds(w) }, { feature: 'message-wav' })), false));
    } catch (e) {
      return failed(c, e);
    }
  } finally {
    release();
  }
});
