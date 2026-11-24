import { log } from '#core/sdk.js';
import type { TranscribeAudio, TranscribeErrorCode, TranscribeFailure, TranscribeOptions, Transcript } from '../api.js';
import { baseMime, extensionFor, flacInfo, oggOpusHead, parseWav, plainPcm16, splitWav, TARGET_RATE, wavSeconds, type WavInfo } from '../audio.js';
import { MAX_SECONDS, rivaPreset, validLanguage } from '../kinds.js';
import { OpenAiError, transcribeOpenAi } from './openai.js';
import { ENCODING, GRPC, recognize, RivaError, type RecognitionConfig } from './riva.js';
import { defaultProvider, provider, type Provider } from './store.js';

// One sound to text on a provider (the TranscribeProvider of ../api.ts, and the route under the voice notes).
// What each kind takes as is:
// - nvidia-riva: WAV (16 kHz mono 16-bit PCM, what the browser converts to, cut into RIVA_CHUNK_SECONDS pieces:
//   NVIDIA's hosted endpoint limits a request's size, and Riva takes one channel only), and mono Ogg Opus or FLAC in
//   one request up to RIVA_MAX_COMPRESSED bytes (a voice note of several minutes); a bigger one, or one of several
//   channels, is 'unsupported_format', so the browser sends it again as 16 kHz mono WAV, in pieces.
// - openai: the usual containers up to OPENAI_MAX_BYTES (the OpenAI API's limit is 25 MB); a bigger WAV that is not
//   16 kHz mono yet is 'unsupported_format' (converted, it fits).
// Anything else is 'unsupported_format': the browser converts it to 16 kHz mono 16-bit WAV. A provider that refuses
// a compressed file as invalid (gRPC INVALID_ARGUMENT, HTTP 400/415) also answers 'unsupported_format', once: the
// WAV that follows is then refused as 'rejected'.

export const RIVA_CHUNK_SECONDS = 60;
export const RIVA_MAX_COMPRESSED = 2 * 1024 * 1024;
/** The rate given for Ogg Opus (Opus always decodes at 48 kHz, whatever the recording's rate). */
export const RIVA_OPUS_RATE = 48_000;
export const OPENAI_MAX_BYTES = 24 * 1024 * 1024;
/** What a provider is given per request (a piece of WAV for Riva). */
export const CALL_MS = 120_000;

const WAV = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);
const OGG = new Set(['audio/ogg', 'audio/opus', 'application/ogg']);
const FLAC = new Set(['audio/flac', 'audio/x-flac']);
const OPENAI = new Set([...WAV, ...OGG, ...FLAC, 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'video/mp4', 'audio/webm', 'video/webm']);

class Failure extends Error implements TranscribeFailure {
  constructor(
    readonly code: TranscribeErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}
export const failure = (code: TranscribeErrorCode, message?: string): TranscribeFailure => new Failure(code, message);
export const isFailure = (e: unknown): e is TranscribeFailure => e instanceof Failure;

/** Whether a provider kind takes this type as is (the bytes are checked when they come). */
export function acceptsMime(p: Provider, mime: string): boolean {
  const m = baseMime(mime);
  return p.kind === 'nvidia-riva' ? WAV.has(m) || OGG.has(m) || FLAC.has(m) : OPENAI.has(m);
}

/** The language a Riva model is asked for: the setting, else 'multi' (automatic) where the model detects it. */
export function rivaLanguage(model: string, language: string): string {
  if (language) return language;
  const preset = rivaPreset(model);
  return preset && !preset.auto ? (preset.lang ?? 'en-US') : 'multi';
}
/** The WAV the browser converts to (16 kHz mono 16-bit PCM): the only one Riva is sent as is. */
const speechWav = (w: WavInfo): boolean => plainPcm16(w) && w.channels === 1 && w.rate === TARGET_RATE;
const rivaFunctionId = (model: string): string => rivaPreset(model)?.functionId ?? model;

/** The language the OpenAI API takes: ISO-639-1, the first subtag of a BCP-47 tag ('fr-FR' → 'fr'); '' : automatic. */
export const openAiLanguage = (language: string): string => language.split('-')[0]!.toLowerCase();

function rivaFailure(e: unknown, compressed: boolean): TranscribeFailure {
  if (!(e instanceof RivaError)) return failure('failed', e instanceof Error ? e.message : 'unknown');
  if (e.grpcStatus === GRPC.invalidArgument) return failure(compressed ? 'unsupported_format' : 'rejected', e.message);
  if (e.grpcStatus === GRPC.unauthenticated || e.grpcStatus === GRPC.permissionDenied || e.httpStatus === 401 || e.httpStatus === 403) return failure('rejected', e.message);
  return failure('failed', e.message);
}

async function viaRiva(p: Provider, audio: TranscribeAudio, language: string, signal?: AbortSignal): Promise<{ text: string; language?: string }> {
  const m = baseMime(audio.mime);
  const target = { endpoint: p.url, functionId: rivaFunctionId(p.model), key: p.key() };
  const lang = rivaLanguage(p.model, language);
  if (WAV.has(m)) {
    const w = parseWav(audio.data);
    // Stereo or another rate: refused by Riva (one channel only) or too big a request; the browser makes it 16 kHz mono.
    if (!w || !speechWav(w)) throw failure('unsupported_format');
    if (wavSeconds(w) > MAX_SECONDS + 1) throw failure('too_long');
    const texts: string[] = [];
    let detected: string | undefined;
    for (const piece of splitWav(audio.data, w, RIVA_CHUNK_SECONDS)) {
      const cfg: RecognitionConfig = { encoding: ENCODING.unspecified, sampleRate: w.rate, language: lang, channels: w.channels };
      const r = await recognize(target, cfg, piece, CALL_MS, signal).catch((e: unknown) => {
        throw rivaFailure(e, false);
      });
      if (r.text) texts.push(r.text);
      detected ??= r.language;
    }
    return { text: texts.join(' '), ...(detected ? { language: detected } : {}) };
  }
  let cfg: RecognitionConfig;
  if (OGG.has(m)) {
    const head = oggOpusHead(audio.data);
    if (!head || head.channels > 1) throw failure('unsupported_format');
    cfg = { encoding: ENCODING.oggOpus, sampleRate: RIVA_OPUS_RATE, language: lang, channels: 1 };
  } else if (FLAC.has(m)) {
    const f = flacInfo(audio.data);
    if (!f || f.channels > 1) throw failure('unsupported_format');
    cfg = { encoding: ENCODING.flac, sampleRate: f.rate, language: lang, channels: 1 };
  } else throw failure('unsupported_format');
  if (audio.data.length > RIVA_MAX_COMPRESSED) throw failure('unsupported_format', 'too big for one request');
  return recognize(target, cfg, audio.data, CALL_MS, signal).catch((e: unknown) => {
    throw rivaFailure(e, true);
  });
}

async function viaOpenAi(p: Provider, audio: TranscribeAudio, language: string, signal?: AbortSignal): Promise<{ text: string; language?: string }> {
  const m = baseMime(audio.mime);
  if (!OPENAI.has(m)) throw failure('unsupported_format');
  if (WAV.has(m)) {
    const w = parseWav(audio.data);
    if (!w) throw failure('unsupported_format');
    if (wavSeconds(w) > MAX_SECONDS + 1) throw failure('too_long');
    // Too big: converted to 16 kHz mono it fits, unless it is that already.
    if (audio.data.length > OPENAI_MAX_BYTES) throw failure(speechWav(w) ? 'too_large' : 'unsupported_format', 'too big for one request');
  } else if (audio.data.length > OPENAI_MAX_BYTES) throw failure('unsupported_format', 'too big for one request');
  try {
    return await transcribeOpenAi({ url: p.url, key: p.key(), model: p.model }, { data: audio.data, mime: m, fileName: `audio.${extensionFor(m) ?? 'bin'}` }, openAiLanguage(language), CALL_MS, signal);
  } catch (e) {
    if (!(e instanceof OpenAiError)) throw failure('failed', e instanceof Error ? e.message : 'unknown');
    if (e.status === 400 || e.status === 415) throw failure(WAV.has(m) ? 'rejected' : 'unsupported_format', e.message);
    if (e.status === 401 || e.status === 403) throw failure('rejected', e.message);
    if (e.status === 413) throw failure('too_large', e.message);
    throw failure('failed', e.message);
  }
}

/** One sound to text (TranscribeProvider.transcribe); rejects with a TranscribeFailure. */
export async function transcribe(audio: TranscribeAudio, opts: TranscribeOptions = {}): Promise<Transcript> {
  const p = opts.provider ? provider(opts.provider) : defaultProvider();
  if (!p) throw failure('unavailable');
  if (!(audio.data instanceof Uint8Array) || !audio.data.length || typeof audio.mime !== 'string') throw failure('unsupported_format');
  if (typeof audio.duration === 'number' && audio.duration > MAX_SECONDS + 1) throw failure('too_long');
  const language = opts.language !== undefined && validLanguage(opts.language) ? opts.language : p.language;
  const t0 = Date.now();
  try {
    const r = p.kind === 'nvidia-riva' ? await viaRiva(p, audio, language, opts.signal) : await viaOpenAi(p, audio, language, opts.signal);
    const ms = Date.now() - t0;
    log('transcribe', 'ok', { feature: opts.feature ?? 'api', provider: p.id, kind: p.kind, type: baseMime(audio.mime), bytes: audio.data.length, ms });
    // The language the provider detected, when it is a language code (not 'multi', not anything else it echoes).
    const detected = r.language && validLanguage(r.language) ? r.language : undefined;
    return { text: r.text, provider: p.id, ms, ...(detected ? { language: detected } : {}) };
  } catch (e) {
    const f = isFailure(e) ? e : failure('failed', e instanceof Error ? e.message : 'unknown');
    // The provider's reason is logged (an error text, never a key or the sound's content).
    log('transcribe', 'failed', { feature: opts.feature ?? 'api', provider: p.id, kind: p.kind, type: baseMime(audio.mime), bytes: audio.data.length, code: f.code, error: f.message.slice(0, 200), ms: Date.now() - t0 });
    throw f;
  }
}
