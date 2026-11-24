import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from 'hono';
import sharp, { type Metadata } from 'sharp';
import { config } from './config.js';
import { log } from './log.js';
import { exactly, mediaSecurityHeaders } from './media.js';
import { readAll, type Upstream } from './ranges.js';
import type { MediaRef } from './connector.js';

// Small WebP copies of pictures for chat bubbles (and mxc avatars): the bubbles show at most 280×320 CSS px,
// the originals are often 1080×1920 or more. GET /api/thumb/w<width>.webp with the same source parameters as
// the relays: those of a connector's media (exactly its media.params, validated by its media.parse; Beeper:
// ?url=<mxc>, fetched from beeper-server like /api/media). Nothing else can be named, so no other host or file
// is reachable from here. Originals stay on their own routes (viewer, save, copy, share).
//
// Sources are content-addressed: an mxc:// URI never changes content (Matrix media are immutable; encrypted
// ones carry their sha256), and a connector names only media fixed for good this way (MediaRef.key). So a
// thumbnail is keyed by source + width (+ the encoder version below), cached on disk and served `immutable`.
// Pictures that change behind one URL (some networks' avatars) have no thumbnail.
//
// Anything that cannot be made safely (HEIC: the prebuilt libvips has no HEVC decoder; too many pixels or
// frames; an unknown format; the box busy) is redirected to the original, which the browser decodes itself.

// 144: avatars (44 CSS px at DPR 3); 320 / 640 / 960: bubbles (≤ 280 CSS px at DPR 1 to 3).
export const THUMB_WIDTHS = [144, 320, 640, 960] as const;
const AVATAR_WIDTH = 144;
const VERSION = 1;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
// Decoded size limits (the container has 256 MB). JPEG decodes with shrink-on-load (1/2 to 1/8 scale), so a
// 48 MP photo costs little; PNG / WebP / GIF are decoded whole.
const MAX_JPEG_PIXELS = 60_000_000;
const MAX_PIXELS = 24_000_000;
const MAX_FRAMES = 400;
const MAX_ANIMATED_PIXELS = 60_000_000;

/** A thumbnail's source: a media reference (connector.ts MediaRef) and how to read its whole original. */
export type ThumbSource = MediaRef & { open: (signal: AbortSignal) => Promise<Upstream> };

/** The sources a thumbnail can name: each gets the query without `r`, and says whether it is one of its own. */
export type ThumbResolver = (query: Record<string, string>) => ThumbSource | null;

/** Width and source of a thumbnail request, or null when anything is off (then 400). */
export function parseThumbRequest(file: string | undefined, query: Record<string, string>, resolve: ThumbResolver): { width: number; source: ThumbSource } | null {
  const m = /^w(\d{3})\.webp$/.exec(file ?? '');
  const width = m ? Number(m[1]) : 0;
  if (!(THUMB_WIDTHS as readonly number[]).includes(width)) return null;
  // r: the client's retry counter (a new URL after a failure), ignored.
  if (query.r !== undefined && !/^\d{1,3}$/.test(query.r)) return null;
  const { r: _, ...rest } = query;
  const source = resolve(rest);
  return source ? { width, source } : null;
}

export { exactly };

/** Cache file name (and ETag) of a thumbnail: a hash of the encoder version, the width and the source. */
export function thumbName(width: number, s: Pick<MediaRef, 'key'>): string {
  return createHash('sha256').update(`v${VERSION}|${width}|${s.key}`).digest('base64url').slice(0, 32);
}

// ── Disk cache ─────────────────────────────────────────────────────────────

/**
 * Thumbnails on disk (<dir>/<name>.webp), least recently used removed first beyond `maxBytes`. The order lives
 * in memory (Map insertion order), rebuilt from the files' mtimes at start; a hit refreshes the mtime.
 */
export class ThumbStore {
  private files = new Map<string, number>();
  private bytes = 0;
  private ready: Promise<void> | undefined;
  constructor(
    private dir: string,
    private maxBytes: number,
  ) {}

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.dir, { recursive: true });
      const found: { name: string; size: number; t: number }[] = [];
      for (const f of await readdir(this.dir)) {
        const p = join(this.dir, f);
        if (!/^[A-Za-z0-9_-]{32}\.webp$/.test(f)) {
          // Leftover temporary file of an interrupted write.
          if (f.includes('.tmp-')) await unlink(p).catch(() => {});
          continue;
        }
        const st = await stat(p).catch(() => null);
        if (st?.isFile()) found.push({ name: f.slice(0, -5), size: st.size, t: st.mtimeMs });
      }
      found.sort((a, b) => a.t - b.t);
      for (const f of found) {
        this.files.set(f.name, f.size);
        this.bytes += f.size;
      }
      await this.evict();
    })();
    return this.ready;
  }

  private path(name: string): string {
    return join(this.dir, `${name}.webp`);
  }

  async get(name: string): Promise<Buffer | null> {
    await this.init();
    const size = this.files.get(name);
    if (size === undefined) return null;
    const buf = await readFile(this.path(name)).catch(() => null);
    if (!buf) {
      this.files.delete(name);
      this.bytes -= size;
      return null;
    }
    this.files.delete(name);
    this.files.set(name, size);
    const now = new Date();
    void utimes(this.path(name), now, now).catch(() => {});
    return buf;
  }

  async put(name: string, data: Buffer): Promise<void> {
    await this.init();
    if (data.length > this.maxBytes) return;
    const tmp = join(this.dir, `${name}.tmp-${randomBytes(6).toString('hex')}`);
    await writeFile(tmp, data);
    await rename(tmp, this.path(name));
    const old = this.files.get(name);
    if (old !== undefined) this.bytes -= old;
    this.files.delete(name);
    this.files.set(name, data.length);
    this.bytes += data.length;
    await this.evict();
  }

  private async evict(): Promise<void> {
    if (this.bytes <= this.maxBytes) return;
    // Down to 90 %, so a full cache does not delete a file on every write.
    const target = this.maxBytes * 0.9;
    for (const [name, size] of this.files) {
      if (this.bytes <= target) break;
      this.files.delete(name);
      this.bytes -= size;
      await unlink(this.path(name)).catch(() => {});
    }
  }

  get size(): number {
    return this.bytes;
  }
  get count(): number {
    return this.files.size;
  }
}

// ── Limits ─────────────────────────────────────────────────────────────────

/** At most `n` tasks at a time, at most `queue` waiting; beyond that run() rejects with 'busy'. */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private n: number,
    private queue: number,
  ) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) {
      if (this.waiting.length >= this.queue) throw new Error('busy');
      await new Promise<void>((r) => this.waiting.push(r));
    } else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
  get pending(): number {
    return this.active + this.waiting.length;
  }
}

// ── Encoding ───────────────────────────────────────────────────────────────

/** Input formats decoded here, from their first bytes (sharp is never handed SVG, PDF, TIFF, HEIC…). */
export function sniff(b: Buffer): 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | undefined {
  if (b.length < 12) return undefined;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const brand = b.subarray(4, 12).toString('latin1');
  if (brand === 'ftypavif' || brand === 'ftypavis') return 'avif';
  return undefined;
}

export type Refusal = 'format' | 'pixels' | 'frames' | 'decode';

/** Whether a picture of this format and size may be decoded here (see the limits above). */
export function withinLimits(format: string, width: number, height: number, pages: number): Refusal | null {
  const px = width * height;
  if (!px) return 'decode';
  if (px > (format === 'jpeg' ? MAX_JPEG_PIXELS : MAX_PIXELS)) return 'pixels';
  if (pages > 1 && (pages > MAX_FRAMES || px * pages > MAX_ANIMATED_PIXELS)) return 'frames';
  return null;
}

// libvips: no operation cache (memory), two threads per image.
sharp.cache(false);
sharp.concurrency(2);

/**
 * WebP at most `width` px wide (never enlarged; avatars: the shorter side at most 144), upright (EXIF orientation applied, then dropped with the
 * other metadata), sRGB. Animated GIF / WebP stay animated (bubbles show them as pictures). A string says why
 * it was not made.
 */
export async function makeThumb(input: Buffer, width: number): Promise<Buffer | Refusal> {
  const format = sniff(input);
  if (!format) return 'format';
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    return 'decode';
  }
  const pages = meta.pages ?? 1;
  const refused = withinLimits(format, meta.width ?? 0, meta.pageHeight ?? meta.height ?? 0, pages);
  if (refused) return refused;
  const animated = pages > 1;
  try {
    let img = sharp(input, { animated, failOn: 'error', limitInputPixels: format === 'jpeg' ? MAX_JPEG_PIXELS : MAX_ANIMATED_PIXELS }).timeout({ seconds: 20 });
    if (!animated && (meta.orientation ?? 1) > 1) img = img.rotate();
    return await img
      // Avatars (144) are shown as cropped circles: at least 144 px on both sides.
      .resize(width === AVATAR_WIDTH ? { width, height: width, fit: 'outside', withoutEnlargement: true } : { width, withoutEnlargement: true })
      .webp({ quality: animated ? 70 : 74, effort: 4 })
      .toBuffer();
  } catch {
    return 'decode';
  }
}

// ── Route ──────────────────────────────────────────────────────────────────

let store: ThumbStore | undefined;
const thumbStore = () =>
  (store ??= new ThumbStore(join(config().dataDir, 'thumbs'), Number(process.env.KLATCHLY_THUMB_CACHE_MB || 300) * 1024 * 1024));
// Fetching waits on the network (some sources: seconds), encoding on the CPU: separate limits.
const fetches = new Limiter(4, 150);
const encodes = new Limiter(2, 150);
const inflight = new Map<string, Promise<Buffer | Refusal | number>>();
// Sources found unfit (format, size): straight to the original for a day.
const refusedAt = new Map<string, number>();

const etagOf = (name: string) => `"t${name}"`;

function errorResponse(status: number, error: string): Response {
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  mediaSecurityHeaders(h);
  return new Response(JSON.stringify({ error }), { status, headers: h });
}

function toOriginal(s: ThumbSource): Response {
  // The source's own relay URL, built from validated values only.
  const h = new Headers({ Location: s.original, 'Cache-Control': 'no-store' });
  mediaSecurityHeaders(h);
  return new Response(null, { status: 307, headers: h });
}

function thumbResponse(name: string, data: Buffer, hit: boolean): Response {
  const h = new Headers({
    'Content-Type': 'image/webp',
    'Content-Length': String(data.length),
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: etagOf(name),
    'Content-Disposition': 'inline',
    'X-Thumb': hit ? 'hit' : 'miss',
  });
  mediaSecurityHeaders(h);
  return new Response(new Uint8Array(data), { status: 200, headers: h });
}

/** Original bytes (status number on a source error), then the thumbnail. */
async function generate(source: ThumbSource, width: number): Promise<Buffer | Refusal | number> {
  const input = await fetches.run(async () => {
    const up = await source.open(AbortSignal.timeout(90_000));
    if (up.status !== 200 || !up.body) {
      await up.body?.cancel().catch(() => {});
      return up.status === 404 ? 404 : 502;
    }
    const len = Number(up.headers['content-length'] || 0);
    if (len > MAX_INPUT_BYTES) {
      await up.body.cancel().catch(() => {});
      return 'pixels' as const;
    }
    return (await readAll(up.body, MAX_INPUT_BYTES)) ?? ('pixels' as const);
  });
  if (!Buffer.isBuffer(input)) return input;
  return encodes.run(() => makeThumb(input, width));
}

export function thumbHandler(resolve: ThumbResolver) {
  return async (c: Context): Promise<Response> => {
    const req = parseThumbRequest(c.req.param('file'), c.req.query(), resolve);
    if (!req) return errorResponse(400, 'bad_request');
    const { width, source } = req;
    const name = thumbName(width, source);
    const inm = c.req.header('if-none-match');
    if (inm && inm.split(',').some((x) => x.trim() === etagOf(name))) {
      const h = new Headers({ ETag: etagOf(name), 'Cache-Control': 'private, max-age=31536000, immutable' });
      mediaSecurityHeaders(h);
      return new Response(null, { status: 304, headers: h });
    }
    const until = refusedAt.get(name);
    if (until && until > Date.now()) return toOriginal(source);
    const cached = await thumbStore().get(name).catch(() => null);
    if (cached) return thumbResponse(name, cached, true);
    let job = inflight.get(name);
    if (!job) {
      // Not tied to this request: a picture scrolled away still gets its thumbnail cached for the next view.
      job = generate(source, width).finally(() => inflight.delete(name));
      inflight.set(name, job);
    }
    let out: Buffer | Refusal | number;
    try {
      out = await job;
    } catch (e) {
      if ((e as Error).message === 'busy') return toOriginal(source);
      log('thumb', 'failed', { kind: source.kind, error: (e as Error).name });
      return errorResponse(502, 'upstream');
    }
    if (typeof out === 'number') return errorResponse(out, out === 404 ? 'not_found' : 'upstream');
    if (typeof out === 'string') {
      if (refusedAt.size >= 2000) refusedAt.delete(refusedAt.keys().next().value!);
      refusedAt.set(name, Date.now() + 86_400_000);
      log('thumb', 'original kept', { kind: source.kind, reason: out });
      return toOriginal(source);
    }
    await thumbStore().put(name, out).catch((e: Error) => log('thumb', 'cache write failed', { error: e.name }));
    return thumbResponse(name, out, false);
  };
}
