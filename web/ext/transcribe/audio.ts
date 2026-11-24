// Sound formats, as both halves need them: the browser turns a sound no provider takes into 16 kHz mono 16-bit WAV
// (mixdown, resample, encodeWav, after the Web Audio API decoded it); the server checks what it is given (parseWav,
// oggOpusHead, isFlac), cuts a long WAV into pieces a request can carry (splitWav), and names a file by its type
// (extensionFor). Pure functions over bytes and samples: no imports, no DOM, no Node (unit-tested in test/audio.test.ts).

/** The rate the browser converts to, what speech models are trained on. */
export const TARGET_RATE = 16_000;

/** A type without its parameters, lower case ('audio/ogg; codecs=opus' → 'audio/ogg'). */
export const baseMime = (mime: string): string => mime.split(';')[0]!.trim().toLowerCase();

// ── WAV ───────────────────────────────────────────────────────────────────

export interface WavInfo {
  /** 1: integer PCM (or WAVE_FORMAT_EXTENSIBLE holding PCM). */
  format: number;
  channels: number;
  rate: number;
  bits: number;
  /** Where the samples start and how many bytes they take (clamped to what is there). */
  dataOffset: number;
  dataLength: number;
}

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** A RIFF/WAVE file's format and where its samples are; null when it is not one (or has no 'fmt ' / 'data'). */
export function parseWav(b: Uint8Array): WavInfo | null {
  if (b.length < 44 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataLength'> | null = null;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= b.length) {
      let format = v.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of its sub-format GUID.
      if (format === 0xfffe && size >= 40 && body + 26 <= b.length) format = v.getUint16(body + 24, true);
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) return null;
      // A streamed WAV may say 0 or 0xffffffff: the rest of the file.
      const len = size === 0 || size === 0xffffffff ? b.length - body : Math.min(size, b.length - body);
      return { ...fmt, dataOffset: body, dataLength: Math.max(0, len) };
    }
    at = body + size + (size % 2);
  }
  return null;
}

/** Whether a WAV holds what speech models take as is: integer 16-bit PCM, 1 or 2 channels, 8 to 48 kHz. */
export const plainPcm16 = (w: WavInfo): boolean => w.format === 1 && w.bits === 16 && (w.channels === 1 || w.channels === 2) && w.rate >= 8000 && w.rate <= 48_000;

/** Its length in seconds (16-bit samples). */
export const wavSeconds = (w: WavInfo): number => w.dataLength / (w.channels * (w.bits / 8) * w.rate);

/** A 16-bit PCM WAV file of these interleaved samples. */
export function encodeWav(samples: Int16Array, rate: number, channels = 1): Uint8Array {
  const data = samples.length * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  put(36, 'data');
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i]!, true);
  return out;
}

/**
 * A 16-bit PCM WAV cut into WAVs of at most `seconds` each (on whole frames), for a provider whose requests have a
 * size limit (Riva: 60 s pieces, as NVIDIA's hosted endpoint takes them). The file itself when it is short enough.
 */
export function splitWav(b: Uint8Array, w: WavInfo, seconds: number): Uint8Array[] {
  const frame = w.channels * 2;
  const per = Math.max(1, Math.floor(seconds * w.rate)) * frame;
  const frames = w.dataLength - (w.dataLength % frame);
  if (frames <= per) return [b];
  const out: Uint8Array[] = [];
  for (let at = 0; at < frames; at += per) {
    const piece = b.subarray(w.dataOffset + at, w.dataOffset + Math.min(frames, at + per));
    const s = new Int16Array(piece.length / 2);
    const v = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
    for (let i = 0; i < s.length; i++) s[i] = v.getInt16(i * 2, true);
    out.push(encodeWav(s, w.rate, w.channels));
  }
  return out;
}

/** A WAV of silence (a provider's Test: never user data). */
export const silenceWav = (seconds: number, rate = TARGET_RATE): Uint8Array => encodeWav(new Int16Array(Math.round(seconds * rate)), rate);

// ── Conversion (the browser, after decodeAudioData) ──────────────────────

/** One channel: the average of the channels. */
export function mixdown(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i]! += c[i]! / channels.length;
  return out;
}

/**
 * Samples at another rate: averaged over each output sample's span when going down (a box filter, against
 * aliasing), linearly interpolated when going up.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !input.length) return input;
  const ratio = from / to;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  if (ratio > 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = a; j < b; j++) sum += input[j]!;
      out[i] = sum / (b - a);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const a = Math.floor(x);
      const f = x - a;
      const p = input[a]!;
      const q = input[Math.min(input.length - 1, a + 1)]!;
      out[i] = p + (q - p) * f;
    }
  }
  return out;
}

/** Float samples (-1…1) as 16-bit integers, clipped. */
export function toInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Decoded channels at their rate → the 16 kHz mono 16-bit WAV the server forwards. */
export const toSpeechWav = (channels: readonly Float32Array[], rate: number): Uint8Array => encodeWav(toInt16(resample(mixdown(channels), rate, TARGET_RATE)), TARGET_RATE);

// ── Ogg Opus, FLAC ────────────────────────────────────────────────────────

/** An Ogg Opus stream's header (its first page's OpusHead): channels and the rate it was recorded at; null otherwise. */
export function oggOpusHead(b: Uint8Array): { channels: number; inputRate: number } | null {
  if (b.length < 47 || ascii(b, 0, 4) !== 'OggS') return null;
  // The first page: 27 bytes of header, its segment table, then the OpusHead packet.
  const segs = b[26]!;
  const at = 27 + segs;
  if (b.length < at + 19 || ascii(b, at, 8) !== 'OpusHead') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { channels: b[at + 9]!, inputRate: v.getUint32(at + 12, true) };
}

/** A FLAC stream's rate and channels (its STREAMINFO block, first after 'fLaC'); null when it is not FLAC. */
export function flacInfo(b: Uint8Array): { rate: number; channels: number } | null {
  if (b.length < 42 || ascii(b, 0, 4) !== 'fLaC' || (b[4]! & 0x7f) !== 0) return null;
  // STREAMINFO from byte 8: block sizes (4), frame sizes (6), then 20 bits of rate, 3 of channels - 1.
  const rate = (b[18]! << 12) | (b[19]! << 4) | (b[20]! >> 4);
  return rate ? { rate, channels: ((b[20]! >> 1) & 7) + 1 } : null;
}

// ── Names ─────────────────────────────────────────────────────────────────

const EXT: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'application/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/** The file extension a server that guesses the format from the name expects (OpenAI's does); undefined: unknown. */
export const extensionFor = (mime: string): string | undefined => EXT[baseMime(mime)];
