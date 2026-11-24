import { createServer as createH2, type Http2Server, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2';
import { createServer as createHttp, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fields, unframe } from '../server/riva.js';

// In-process fakes of the two kinds of provider, for the package's tests: a Riva server (gRPC over cleartext HTTP/2:
// the same protocol as NVIDIA's TLS endpoint) and an OpenAI-compatible transcription server (HTTP, multipart).

// ── Protocol Buffers, the other way: a RecognizeResponse as a server writes it ──
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const ld = (field: number, b: Uint8Array): Uint8Array => Uint8Array.from([...varint(field * 8 + 2), ...varint(b.length), ...b]);
const str = (field: number, s: string) => ld(field, new TextEncoder().encode(s));
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));

/** RecognizeResponse with one result per text (alternatives[0].transcript, language_code). */
export function rivaResponse(texts: string[], language?: string): Uint8Array {
  return cat(...texts.map((t) => ld(1, ld(1, cat(str(1, t), ...(language ? [str(4, language)] : []))))));
}

export function grpcFrame(msg: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + msg.length);
  new DataView(out.buffer).setUint32(1, msg.length);
  out.set(msg, 5);
  return out;
}

/** What the fake Riva got: the headers, and the request's config fields and audio. */
export interface RivaCall {
  headers: IncomingHttpHeaders;
  config: Record<number, number | string>;
  audio: Uint8Array;
}

/** A text per call, a gRPC error, a plain HTTP status, or a misbehaving server's own answer (`raw`). */
export type RivaAnswer = { texts: string[]; language?: string } | { grpcStatus: number; message: string } | { http: number } | { raw: (stream: ServerHttp2Stream) => void };

export interface FakeRiva {
  url: string;
  calls: RivaCall[];
  /** The answer to the next calls: a text per call, or a gRPC error, or a plain HTTP status (now, or later: a promise). */
  answer: (call: RivaCall, n: number) => RivaAnswer | Promise<RivaAnswer>;
  close(): Promise<void>;
}

export async function fakeRiva(): Promise<FakeRiva> {
  const fake: FakeRiva = { url: '', calls: [], answer: () => ({ texts: ['hello'] }), close: async () => {} };
  const server: Http2Server = createH2();
  server.on('stream', (stream, headers) => {
    // A client that gives up (a timeout, a cap) resets the stream: not the fake's failure.
    stream.on('error', () => {});
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', async () => {
      const req = fields(unframe(Buffer.concat(chunks)));
      const cfgBytes = req.find((f) => f.field === 1)?.b ?? new Uint8Array();
      const config: Record<number, number | string> = {};
      for (const f of fields(cfgBytes)) config[f.field] = f.n ?? new TextDecoder().decode(f.b);
      const call: RivaCall = { headers, config, audio: req.find((f) => f.field === 2)?.b ?? new Uint8Array() };
      fake.calls.push(call);
      const a = await fake.answer(call, fake.calls.length);
      if (stream.destroyed) return;
      if ('raw' in a) return a.raw(stream);
      if ('http' in a) {
        stream.respond({ ':status': a.http, 'content-type': 'text/plain' });
        return stream.end('denied');
      }
      if ('grpcStatus' in a) {
        // A trailers-only answer, as servers send errors.
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': String(a.grpcStatus), 'grpc-message': encodeURIComponent(a.message) }, { endStream: true });
        return;
      }
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(grpcFrame(rivaResponse(a.texts, a.language)));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((ok) => server.close(() => ok()));
  return fake;
}

/** What the fake OpenAI-compatible server got. */
export interface OpenAiCall {
  path: string;
  auth: string | undefined;
  model: string | null;
  language: string | null;
  format: string | null;
  fileName: string | undefined;
  fileType: string | undefined;
  size: number;
  /** The accept-encoding the client sent. */
  encoding: string | undefined;
}

export interface OpenAiAnswer {
  status: number;
  /** A string or JSON, or bytes as they are (e.g. gzip). */
  body: unknown;
  headers?: Record<string, string>;
}

export interface FakeOpenAi {
  url: string;
  calls: OpenAiCall[];
  answer: (call: OpenAiCall) => OpenAiAnswer | Promise<OpenAiAnswer>;
  close(): Promise<void>;
}

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((ok) => {
    const c: Buffer[] = [];
    req.on('data', (b: Buffer) => c.push(b)).on('end', () => ok(Buffer.concat(c)));
  });

export async function fakeOpenAi(): Promise<FakeOpenAi> {
  const fake: FakeOpenAi = { url: '', calls: [], answer: () => ({ status: 200, body: { text: ' hello there ' } }), close: async () => {} };
  const server: Server = createHttp(async (req, res) => {
    res.on('error', () => {});
    const raw = await body(req);
    // The multipart body read back by the platform's own parser.
    const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: raw }).formData();
    const file = form.get('file');
    const call: OpenAiCall = {
      path: req.url ?? '',
      auth: req.headers.authorization,
      model: form.get('model') as string | null,
      language: form.get('language') as string | null,
      format: form.get('response_format') as string | null,
      fileName: file instanceof File ? file.name : undefined,
      fileType: file instanceof File ? file.type : undefined,
      size: file instanceof File ? file.size : 0,
      encoding: req.headers['accept-encoding'],
    };
    fake.calls.push(call);
    const a = await fake.answer(call);
    if (res.destroyed) return;
    res.writeHead(a.status, { 'content-type': 'application/json', ...a.headers });
    res.end(typeof a.body === 'string' || a.body instanceof Uint8Array ? a.body : JSON.stringify(a.body));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  fake.close = () => new Promise((ok) => server.close(() => ok()));
  return fake;
}

/** A minimal FLAC file: 'fLaC', then its STREAMINFO (rate, channels), then some bytes. */
export function flac(rate = 16_000, channels = 1, size = 200): Uint8Array {
  const b = new Uint8Array(Math.max(size, 42));
  b.set(new TextEncoder().encode('fLaC'), 0);
  b[7] = 34;
  b[18] = rate >> 12;
  b[19] = (rate >> 4) & 0xff;
  b[20] = ((rate & 0xf) << 4) | ((channels - 1) << 1);
  return b;
}

/** A minimal Ogg Opus file: its first page (OpusHead), then some bytes. */
export function oggOpus(size = 200, channels = 1): Uint8Array {
  const b = new Uint8Array(Math.max(size, 47));
  b.set(new TextEncoder().encode('OggS'), 0);
  b[26] = 1;
  b[27] = 19;
  b.set(new TextEncoder().encode('OpusHead'), 28);
  b[36] = 1;
  b[37] = channels;
  new DataView(b.buffer).setUint32(40, 48_000, true);
  return b;
}
