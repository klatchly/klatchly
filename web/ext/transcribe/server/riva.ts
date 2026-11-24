import { connect, constants, type ClientHttp2Session } from 'node:http2';

// NVIDIA Riva's offline recognition, RivaSpeechRecognition/Recognize (proto/riva/proto/riva_asr.proto, MIT, NVIDIA),
// as a unary gRPC call over HTTP/2: no gRPC library, the two messages this call needs encoded and decoded here.
// NVIDIA's hosted models (grpc.nvcf.nvidia.com:443, TLS) are picked by an NVCF function id in the `function-id`
// metadata and paid with `authorization: Bearer <key>`; a self-hosted Riva server takes the same request (the
// metadata is then ignored). One HTTP/2 session per call, closed at the end: nothing stays open between calls.
//
// gRPC over HTTP/2 (https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md): POST /<service>/<method>,
// content-type application/grpc, te: trailers; the body is length-prefixed messages (1 byte compressed flag, 4 bytes
// big-endian length); the outcome is grpc-status (0: OK) and grpc-message in the trailers, or in the headers of a
// trailers-only answer.

export const RIVA_PATH = '/nvidia.riva.asr.RivaSpeechRecognition/Recognize';

/** riva_audio.proto AudioEncoding. Unset for WAV: the server reads its header (as NVIDIA's own clients do). */
export const ENCODING = { unspecified: 0, linearPcm: 1, flac: 2, oggOpus: 4 } as const;

export interface RecognitionConfig {
  encoding: number;
  sampleRate: number;
  /** BCP-47 ('fr-FR'), or 'multi' for a model that detects the language. */
  language: string;
  channels: number;
}

// ── Protocol Buffers: the few shapes these messages need ────────────────

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

const tag = (field: number, wire: number) => varint(field * 8 + wire);
const fieldVarint = (field: number, v: number): number[] => (v ? [...tag(field, 0), ...varint(v)] : []);
function fieldBytes(field: number, b: Uint8Array): Uint8Array {
  const head = Uint8Array.from([...tag(field, 2), ...varint(b.length)]);
  const out = new Uint8Array(head.length + b.length);
  out.set(head);
  out.set(b, head.length);
  return out;
}
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** RecognitionConfig: encoding 1, sample_rate_hertz 2, language_code 3, max_alternatives 4, audio_channel_count 7, enable_automatic_punctuation 11. */
export function encodeConfig(c: RecognitionConfig): Uint8Array {
  return concat([
    Uint8Array.from(fieldVarint(1, c.encoding)),
    Uint8Array.from(fieldVarint(2, c.sampleRate)),
    c.language ? fieldBytes(3, new TextEncoder().encode(c.language)) : new Uint8Array(),
    Uint8Array.from(fieldVarint(4, 1)),
    Uint8Array.from(fieldVarint(7, c.channels)),
    Uint8Array.from(fieldVarint(11, 1)),
  ]);
}

/** RecognizeRequest: config 1, audio 2. */
export const encodeRequest = (c: RecognitionConfig, audio: Uint8Array): Uint8Array => concat([fieldBytes(1, encodeConfig(c)), fieldBytes(2, audio)]);

interface Field {
  field: number;
  wire: number;
  /** Varint value (wire 0). */
  n?: number;
  /** Length-delimited bytes (wire 2). */
  b?: Uint8Array;
}

/** The fields of a message, in order; throws on a malformed one. */
export function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  const readVarint = (): number => {
    let n = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= b.length) throw new Error('protobuf: truncated varint');
      const x = b[at++]!;
      n += (x & 0x7f) * mul;
      if (x < 0x80) return n;
      mul *= 128;
    }
    throw new Error('protobuf: varint too long');
  };
  while (at < b.length) {
    const key = readVarint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) out.push({ field, wire, n: readVarint() });
    else if (wire === 2) {
      const len = readVarint();
      if (at + len > b.length) throw new Error('protobuf: truncated field');
      out.push({ field, wire, b: b.subarray(at, at + len) });
      at += len;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error(`protobuf: wire type ${wire}`);
    if (at > b.length) throw new Error('protobuf: truncated field');
  }
  return out;
}

const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : '');

/**
 * RecognizeResponse (results 1) → SpeechRecognitionResult (alternatives 1) → SpeechRecognitionAlternative
 * (transcript 1, language_code 4): the best alternative of each result, joined; the first language reported.
 */
export function decodeResponse(b: Uint8Array): { text: string; language?: string } {
  const parts: string[] = [];
  let language: string | undefined;
  for (const r of fields(b)) {
    if (r.field !== 1 || !r.b) continue;
    const alt = fields(r.b).find((f) => f.field === 1 && f.b);
    if (!alt?.b) continue;
    const af = fields(alt.b);
    const t = text(af.find((f) => f.field === 1)?.b).trim();
    if (t) parts.push(t);
    language ??= af.filter((f) => f.field === 4).map((f) => text(f.b))[0] || undefined;
  }
  return { text: parts.join(' '), ...(language ? { language } : {}) };
}

// ── gRPC framing ─────────────────────────────────────────────────────────

export function frame(msg: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + msg.length);
  new DataView(out.buffer).setUint32(1, msg.length);
  out.set(msg, 5);
  return out;
}

/** The first message of a gRPC body (uncompressed); throws on anything else. */
export function unframe(body: Uint8Array): Uint8Array {
  if (body.length < 5) throw new Error('grpc: empty answer');
  if (body[0] !== 0) throw new Error('grpc: compressed answer');
  const len = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1);
  if (5 + len > body.length) throw new Error('grpc: truncated answer');
  return body.subarray(5, 5 + len);
}

/** A failed call: its gRPC status (or the HTTP status when the answer was not gRPC) and message, never a key. */
export class RivaError extends Error {
  constructor(
    readonly grpcStatus: number | null,
    readonly httpStatus: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** gRPC status codes this package tells apart. */
export const GRPC = { invalidArgument: 3, deadlineExceeded: 4, permissionDenied: 7, resourceExhausted: 8, unauthenticated: 16 } as const;

export interface RivaTarget {
  /** 'https://host:port' (TLS) or 'http://host:port'. */
  endpoint: string;
  functionId?: string;
  key: string | null;
}

const MAX_ANSWER = 4 * 1024 * 1024;

/** One Recognize call. Resolves to the text (and the language the model reported); rejects with a RivaError. */
export function recognize(t: RivaTarget, config: RecognitionConfig, audio: Uint8Array, timeoutMs: number, signal?: AbortSignal): Promise<{ text: string; language?: string }> {
  return new Promise((resolve, reject) => {
    let session: ClientHttp2Session | undefined;
    let done = false;
    const finish = (err: Error | null, value?: { text: string; language?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      session?.destroy();
      if (err) reject(err);
      else resolve(value!);
    };
    const onAbort = () => finish(new RivaError(null, null, 'aborted'));
    const timer = setTimeout(() => finish(new RivaError(GRPC.deadlineExceeded, null, 'timeout')), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    try {
      session = connect(t.endpoint, { maxSessionMemory: 64 });
    } catch (e) {
      return finish(new RivaError(null, null, e instanceof Error ? e.message : 'connect failed'));
    }
    session.on('error', (e: Error) => finish(new RivaError(null, null, `connection: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
    const req = session.request({
      ':method': 'POST',
      ':path': RIVA_PATH,
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-timeout': `${Math.max(1, Math.ceil(timeoutMs / 1000))}S`,
      'user-agent': 'klatchly-transcribe',
      ...(t.functionId ? { 'function-id': t.functionId } : {}),
      ...(t.key ? { authorization: `Bearer ${t.key}` } : {}),
    });
    let headers: Record<string, unknown> = {};
    let trailers: Record<string, unknown> = {};
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('response', (h) => (headers = h));
    req.on('trailers', (h) => (trailers = h));
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_ANSWER) {
        req.close(constants.NGHTTP2_CANCEL);
        finish(new RivaError(null, null, 'answer too large'));
      } else chunks.push(c);
    });
    req.on('error', (e: Error) => finish(new RivaError(null, null, `stream: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
    req.on('end', () => {
      const status = Number(headers[':status']);
      const type = String(headers['content-type'] ?? '');
      const gs = trailers['grpc-status'] ?? headers['grpc-status'];
      const gm = String(trailers['grpc-message'] ?? headers['grpc-message'] ?? '');
      let message = gm;
      try {
        message = decodeURIComponent(gm);
      } catch {
        // as sent
      }
      if (status !== 200 || !type.startsWith('application/grpc')) return finish(new RivaError(gs === undefined ? null : Number(gs), status || null, `http ${status}`));
      if (gs === undefined) return finish(new RivaError(null, status, 'no grpc-status'));
      if (Number(gs) !== 0) return finish(new RivaError(Number(gs), status, message.slice(0, 300) || `grpc ${String(gs)}`));
      try {
        finish(null, decodeResponse(unframe(Buffer.concat(chunks))));
      } catch (e) {
        finish(new RivaError(null, status, e instanceof Error ? e.message : 'bad answer'));
      }
    });
    req.end(frame(encodeRequest(config, audio)));
  });
}
