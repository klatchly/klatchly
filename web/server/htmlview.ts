import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './context.js';
import { log } from './log.js';

// An HTML file attachment opened in the app's file viewer. The browser already has the file's bytes (the media
// routes serve HTML only as a download): it POSTs them here, gets an id, and frames GET /api/htmlview/<id>. That
// document is served sandboxed: an opaque origin (no cookies, no API, no storage of the app), no scripts, no forms,
// nothing fetched (styles inline, images and fonts as data: URLs only, so no tracking pixel; DNS prefetch off, a
// preconnect hint may still resolve a name in some browsers); its links open in a new tab. A report reads as
// written; a hostile page can do nothing. Kept in memory for the session that sent it, ten minutes; 5 MB at most,
// a few per session.

export const HTML_VIEW_MAX = 5 * 1024 * 1024;
const TTL_MS = 10 * 60_000;
const PER_SESSION = 4;
const TOTAL = 32;

export const HTML_VIEW_PATH = /^\/api\/htmlview\/[a-f0-9]{32}$/;

export const HTML_VIEW_CSP =
  "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; frame-ancestors 'self'";

interface Kept {
  session: string;
  body: Buffer;
  until: number;
}
const kept = new Map<string, Kept>();

function sweep(now: number): void {
  for (const [id, k] of kept) if (k.until <= now) kept.delete(id);
}

/**
 * The document as served: `<base target="_blank">` first in its head (links leave the viewer for a new tab). Bytes
 * kept as they are (latin1 round trip): the file's own charset still applies.
 */
export function prepareHtml(buf: Buffer): Buffer {
  // UTF-16 (its BOM): left as it is, the browser reads it by that BOM; a <base> in latin1 would break it.
  if (utf16(buf)) return buf;
  const s = buf.toString('latin1');
  const base = '<base target="_blank">';
  const head = /<head(\s[^>]*)?>/i.exec(s);
  const doctype = /^(\xef\xbb\xbf)?\s*<!doctype[^>]*>/i.exec(s);
  const bom = s.startsWith('\xef\xbb\xbf') ? 3 : 0;
  const at = head ? head.index + head[0].length : doctype ? doctype[0].length : bom;
  return Buffer.from(s.slice(0, at) + base + s.slice(at), 'latin1');
}

const utf16 = (buf: Buffer): boolean => (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);

/** Whether the file says its encoding (a BOM, a meta tag early): otherwise it is read as UTF-8. */
const namesCharset = (buf: Buffer): boolean => utf16(buf) || /charset\s*=/i.test(buf.subarray(0, 2048).toString('latin1'));

export const htmlViewRoutes = new Hono<Env>();

htmlViewRoutes.post('/htmlview', bodyLimit({ maxSize: HTML_VIEW_MAX, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
  const session = c.get('session')!;
  const body = Buffer.from(await c.req.arrayBuffer());
  if (!body.length) return c.json({ error: 'bad_request' }, 400);
  const now = Date.now();
  sweep(now);
  const mine = [...kept].filter(([, k]) => k.session === session);
  for (const [id] of mine.slice(0, Math.max(0, mine.length - PER_SESSION + 1))) kept.delete(id);
  while (kept.size >= TOTAL) kept.delete(kept.keys().next().value!);
  const id = randomBytes(16).toString('hex');
  kept.set(id, { session, body: prepareHtml(body), until: now + TTL_MS });
  log('htmlview', 'kept', { bytes: body.length });
  return c.json({ id });
});

htmlViewRoutes.get('/htmlview/:id{[a-f0-9]{32}}', (c) => {
  sweep(Date.now());
  const k = kept.get(c.req.param('id'));
  const h = new Headers({
    'Content-Security-Policy': HTML_VIEW_CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-DNS-Prefetch-Control': 'off',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  if (!k || k.session !== c.get('session')) {
    h.set('Content-Type', 'text/plain; charset=utf-8');
    return new Response('not found', { status: 404, headers: h });
  }
  h.set('Content-Type', namesCharset(k.body) ? 'text/html' : 'text/html; charset=utf-8');
  return new Response(new Uint8Array(k.body), { status: 200, headers: h });
});

/** Tests: forget every kept document. */
export const resetHtmlViewForTests = (): void => kept.clear();
