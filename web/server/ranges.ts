import { createHash } from 'node:crypto';

// Byte ranges for relayed media whose source may not support them (some CDNs answer Range with 206 for videos
// and files and ignore it for photos). iOS Safari plays a video only from a server that honours Range,
// and pdf.js / the share prefetch read whole files: a 200 answered to a Range request is read into memory
// (up to MAX_BUFFER) and sliced here, and kept in a small LRU so the next ranges of the same file are local.

export const MAX_BUFFER = 40 * 1024 * 1024;
const CACHE_BYTES = 160 * 1024 * 1024;

export interface Upstream {
  status: number;
  headers: Record<string, string | undefined>;
  body: ReadableStream<Uint8Array> | null;
}

interface Entry {
  body: Buffer;
  type: string;
  etag: string;
  lastModified?: string;
}

/** Whole files read for ranges, least recently used dropped first beyond CACHE_BYTES. */
export class RangeCache {
  private map = new Map<string, Entry>();
  private bytes = 0;
  constructor(private max = CACHE_BYTES) {}
  get(key: string): Entry | undefined {
    const e = this.map.get(key);
    if (e) {
      this.map.delete(key);
      this.map.set(key, e);
    }
    return e;
  }
  set(key: string, e: Entry): void {
    if (e.body.length > this.max) return;
    const old = this.map.get(key);
    if (old) this.bytes -= old.body.length;
    this.map.delete(key);
    this.map.set(key, e);
    this.bytes += e.body.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.max) break;
      this.map.delete(k);
      this.bytes -= v.body.length;
    }
  }
  get size(): number {
    return this.bytes;
  }
}

/**
 * One "bytes=" range against a file of `size` bytes: [start, end] inclusive, 'unsatisfiable' (416), or null
 * when the header is absent, malformed or asks for several ranges (then the whole file is served, as RFC 9110
 * allows).
 */
export function parseRange(header: string | undefined | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (m[2] && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

const etagOf = (b: Buffer) => `"z${createHash('sha256').update(b).digest('base64url').slice(0, 22)}"`;

/** If-Range: the range applies only when the validator still names this version of the file. */
function ifRangeMatches(v: string | undefined, e: Entry): boolean {
  if (!v) return true;
  if (v.startsWith('"') || v.startsWith('W/')) return v === e.etag;
  return !!e.lastModified && v === e.lastModified;
}

function fromEntry(e: Entry, req: Headers, base: Headers): Response {
  const h = new Headers(base);
  h.set('Content-Type', e.type);
  h.set('Accept-Ranges', 'bytes');
  h.set('ETag', e.etag);
  if (e.lastModified) h.set('Last-Modified', e.lastModified);
  const inm = req.get('if-none-match');
  if (inm && inm.split(',').some((x) => x.trim() === e.etag || x.trim() === '*')) {
    h.delete('Content-Type');
    return new Response(null, { status: 304, headers: h });
  }
  const r = ifRangeMatches(req.get('if-range') ?? undefined, e) ? parseRange(req.get('range'), e.body.length) : null;
  if (r === 'unsatisfiable') {
    h.set('Content-Range', `bytes */${e.body.length}`);
    h.delete('Content-Type');
    return new Response(null, { status: 416, headers: h });
  }
  if (r) {
    h.set('Content-Range', `bytes ${r.start}-${r.end}/${e.body.length}`);
    h.set('Content-Length', String(r.end - r.start + 1));
    return new Response(new Uint8Array(e.body.subarray(r.start, r.end + 1)), { status: 206, headers: h });
  }
  h.set('Content-Length', String(e.body.length));
  return new Response(new Uint8Array(e.body), { status: 200, headers: h });
}

export async function readAll(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Response for a relayed media request. `fetch` gets the validators to forward (Range, If-Range): a 206 (or
 * 304, 416) from the source passes through; a 200 to a Range request is buffered, cached and sliced. `type`
 * maps the source's Content-Type to the one to serve; `base` holds the security and cache headers.
 */
export async function rangedRelay(opts: {
  key: string;
  req: Headers;
  base: Headers;
  cache: RangeCache;
  fetch: (forward: Record<string, string>) => Promise<Upstream>;
  type: (upstream: string | undefined) => string;
  maxBuffer?: number;
}): Promise<Response> {
  const { key, req, base, cache } = opts;
  const max = opts.maxBuffer ?? MAX_BUFFER;
  const cached = cache.get(key);
  if (cached) return fromEntry(cached, req, base);
  const forward: Record<string, string> = {};
  for (const name of ['range', 'if-range']) {
    const v = req.get(name);
    if (v && v.length <= 256) forward[name] = v;
  }
  const up = await opts.fetch(forward);
  const h = new Headers(base);
  const status = up.status;
  if (status === 416) {
    await up.body?.cancel();
    if (up.headers['content-range']) h.set('Content-Range', up.headers['content-range']);
    return new Response(null, { status: 416, headers: h });
  }
  if (status !== 200 && status !== 206) {
    await up.body?.cancel();
    h.set('Content-Type', 'application/json');
    h.delete('Content-Disposition');
    return new Response('{"error":"not_found"}', { status: 404, headers: h });
  }
  const type = opts.type(up.headers['content-type']);
  const len = Number(up.headers['content-length'] || 0);
  const ranged = !!forward.range;
  // The source ignored the Range (or we may as well keep the file for the next ones): read it whole.
  if (status === 200 && up.body && ranged && (!len || len <= max)) {
    const body = await readAll(up.body, max);
    if (body) {
      const e: Entry = { body, type, etag: up.headers.etag || etagOf(body), lastModified: up.headers['last-modified'] };
      cache.set(key, e);
      return fromEntry(e, new Headers({ range: forward.range!, ...(forward['if-range'] ? { 'if-range': forward['if-range'] } : {}) }), base);
    }
    h.set('Content-Type', 'application/json');
    h.delete('Content-Disposition');
    return new Response('{"error":"too_large"}', { status: 502, headers: h });
  }
  h.set('Content-Type', type);
  if (len) h.set('Content-Length', String(len));
  for (const name of ['content-range', 'etag', 'last-modified'] as const) {
    const v = up.headers[name];
    if (v) h.set(name, v);
  }
  // Ranges are always possible: by the source, or here from memory for files up to MAX_BUFFER.
  if (up.headers['accept-ranges'] === 'bytes' || status === 206 || (len > 0 && len <= max)) h.set('Accept-Ranges', 'bytes');
  return new Response(up.body, { status, headers: h });
}
