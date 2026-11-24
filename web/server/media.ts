import type { Context } from 'hono';
import { log } from './log.js';
import type { MediaRef } from './connector.js';
import type { Upstream } from './ranges.js';
import type { ConnectorModule } from './registry.js';
import { connectors } from './sources.js';

// GET /api/media: a connector's media (Beeper: ?url=<mxc>, validated by the connector), relayed with Range, and
// served with the headers below whatever the source says: a type from an allowlist (never HTML, SVG, XML or
// scripts), a disposition, and a sandbox CSP. Nothing names a host or a file: only what a connector's
// media.parse accepts.

// Shown in place (Content-Disposition: inline): pictures, audio, video, PDF. Every other type is a download.
// PDFs are inline for the in-app viewer (pdf.js reads the bytes; nothing is rendered by the browser's own
// viewer from the app) and for "open in a new tab": the sandbox CSP still applies to that document.
export const INLINE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/wav', 'audio/x-m4a',
  'application/pdf',
]);

// Types the client may hint (from the message metadata) when upstream gives none: the inline ones plus common
// documents and archives, all served as downloads. Never HTML, SVG, XML or scripts.
export const HINT_TYPES = new Set([
  ...INLINE_TYPES,
  'text/plain', 'text/csv', 'application/rtf',
  'application/zip', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar-compressed', 'application/gzip', 'application/x-tar',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
]);

/**
 * A file name fit for a Content-Disposition header and a download: NFC (some networks send names decomposed),
 * no control or bidi-override characters, no path separators, at most 180 characters (extension kept).
 */
export function safeFileName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  let s = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!s) return undefined;
  const chars = [...s];
  if (chars.length > 180) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = chars.slice(0, 180 - [...ext].length).join('').trimEnd() + ext;
  }
  return s;
}

// RFC 5987 attr-char: everything else is percent-encoded (encodeURIComponent leaves ' ( ) * as they are).
const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Content-Disposition with the name in both forms (RFC 6266): an ASCII fallback, then the UTF-8 one. */
export function contentDisposition(kind: 'inline' | 'attachment', name?: string): string {
  const n = safeFileName(name);
  if (!n) return kind;
  const ascii = n.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${rfc5987(n)}`;
}

/** Content-Type to serve and its disposition, from upstream's type or else the client's allowlisted hint. */
export function mediaType(upstream: string | null | undefined, hint: string | undefined): { type: string; inline: boolean } {
  const raw = (upstream ?? '').split(';')[0]!.trim().toLowerCase();
  const h = hint?.toLowerCase();
  // Some CDNs label JPEGs "image/jpg", which browsers refuse to render with nosniff.
  let type = raw === 'image/jpg' ? 'image/jpeg' : raw;
  if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') type = h && HINT_TYPES.has(h) ? h : '';
  if (!type) return { type: 'application/octet-stream', inline: false };
  return { type: upstream && type === raw ? upstream : type, inline: INLINE_TYPES.has(type) };
}

/** Whether a query carries exactly these parameters (a source's own, nothing more). */
export const exactly = (query: Record<string, string>, params: readonly string[]): boolean =>
  Object.keys(query).sort().join(',') === [...params].sort().join(',');

const FORWARD_REQ = ['range', 'if-range', 'if-none-match'];
const FORWARD_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

export function mediaSecurityHeaders(h: Headers): void {
  h.set('Content-Security-Policy', "sandbox; default-src 'none'");
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  h.set('X-Robots-Tag', 'noindex, nofollow');
}

// The relay's own parameters, next to a source's: the client's type hint, the download name, its retry counter.
const OWN_PARAMS = new Set(['type', 'name', 'r']);

/**
 * The connector whose media these parameters name, with the media, or null (then 400): exactly its
 * media.params besides the relay's own (as thumbnails do), validated by its media.parse.
 */
export function mediaOf(query: Record<string, string>): { source: ConnectorModule; ref: MediaRef } | null {
  const named = Object.fromEntries(Object.entries(query).filter(([k]) => !OWN_PARAMS.has(k)));
  for (const source of connectors()) {
    if (!source.media || !exactly(named, source.media.params)) continue;
    const ref = source.media.parse(named);
    if (ref) return { source, ref };
  }
  return null;
}

export async function serveMedia(c: Context): Promise<Response> {
  const media = mediaOf(c.req.query());
  if (!media?.source.media) {
    const h = new Headers({ 'Content-Type': 'application/json' });
    mediaSecurityHeaders(h);
    return new Response('{"error":"bad_request"}', { status: 400, headers: h });
  }
  const reqHeaders: Record<string, string> = {};
  for (const name of FORWARD_REQ) {
    const v = c.req.header(name);
    if (v && v.length <= 256) reqHeaders[name] = v;
  }
  let up: Upstream;
  try {
    up = await media.source.media.fetch(media.ref, reqHeaders, c.req.raw.signal);
  } catch {
    log('media', 'upstream unreachable');
    return c.json({ error: 'upstream' }, 502);
  }
  if (up.status !== 200 && up.status !== 206 && up.status !== 304) {
    await up.body?.cancel();
    const status = up.status === 404 ? 404 : up.status === 416 ? 416 : 502;
    if (status === 502) log('media', 'upstream error', { status: up.status });
    const h = new Headers({ 'Content-Type': 'application/json' });
    mediaSecurityHeaders(h);
    return new Response(`{"error":"${status === 502 ? 'upstream' : 'not_found'}"}`, { status, headers: h });
  }
  const h = new Headers();
  for (const name of FORWARD_RES) {
    const v = up.headers[name];
    if (v) h.set(name, v);
  }
  h.set('Cache-Control', 'private, max-age=604800');
  mediaSecurityHeaders(h);
  // Upstream often omits the type for cached media: the client hints one from the message metadata
  // (allowlisted, never HTML/SVG); CSP sandbox + nosniff still apply.
  const { type, inline } = mediaType(h.get('content-type'), c.req.query('type'));
  h.set('Content-Type', type);
  h.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', c.req.query('name')?.slice(0, 400)));
  return new Response(up.status === 304 ? null : up.body, { status: up.status, headers: h });
}
