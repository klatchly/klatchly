import type { Context } from 'hono';
import { clientIp } from './context.js';
import { RateLimiter } from './ratelimit.js';
import { log } from './log.js';
import type { ConnectorModule } from './registry.js';
import type { UploadOutcome } from './connector.js';
import { connectorFor, plainUploader, plainUploaders } from './sources.js';

// POST /api/upload[?chatID=<chat>]: the browser sends the raw file bytes (application/octet-stream) with the name
// and type in headers; the body is streamed to the uploads of the chat's connector (no chat: the one connector on
// that takes uploads without a chat, its plain `upload`; several: the browser must name the chat), never buffered,
// and cut by the core at the declared length. The upload ID it answers is good for sends to that connector's chats
// only (uploadFits).

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ACTIVE = 4;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const limiter = new RateLimiter(10 * 60 * 1000, 60, 120);
let active = 0;

export function isMime(v: unknown): v is string {
  return typeof v === 'string' && MIME_RE.test(v);
}

/** Display name only: no control characters, no path separators, at most 255 characters. */
export function sanitizeFileName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '')
    .replace(/[/\\]/g, '_')
    .trim()
    .slice(0, 255);
  return s && s !== '.' && s !== '..' ? s : undefined;
}

function headerName(c: Context): string | undefined {
  const raw = c.req.header('x-upload-name');
  if (!raw || raw.length > 2048) return undefined;
  try {
    return sanitizeFileName(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
}

/**
 * The body as the connector reads it: at most `size` bytes (the declared length, never above the cap). A body
 * that goes on errors the stream there, so no connector ever streams more than the core allowed.
 */
export function capped(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  const max = Math.min(size, MAX_UPLOAD_BYTES);
  let n = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        n += chunk.byteLength;
        if (n > max) ctl.error(new Error('upload longer than declared'));
        else ctl.enqueue(chunk);
      },
    }),
  );
}

// Which connector took each recent upload (by its ID): a send checks it (relay.ts). Bounded, oldest out first.
const taken = new Map<string, string>();
const MAX_TAKEN = 500;

export function noteUpload(uploadID: string, source: ConnectorModule): void {
  taken.delete(uploadID);
  taken.set(uploadID, source.id);
  if (taken.size > MAX_TAKEN) taken.delete(taken.keys().next().value!);
}

/**
 * Whether a send to a chat of `source` may carry this upload: one it took. An ID it does not know (an upload
 * from before a restart) is taken for the one plain uploader's (where an upload without a chat went), and refused
 * when there is none or several: an upload never goes from one connector to another on a guess.
 */
export function uploadFits(uploadID: string, source: ConnectorModule): boolean {
  const by = taken.get(uploadID);
  return by ? by === source.id : source === plainUploader();
}

type UploadFile = Parameters<NonNullable<ConnectorModule['upload']>>[0];

/** Whether a connector takes uploads at all (for a chat, or without one). */
export const takesUploads = (source: ConnectorModule) => !!(source.upload || source.uploadFor);

/**
 * How a connector takes an upload: for this chat (its uploadFor, bound to the chat) when it has one, else its
 * plain upload; undefined when it takes none (or only for a chat, and there is none).
 */
export function uploaderFor(source: ConnectorModule, chatID?: string): ((file: UploadFile, signal: AbortSignal) => Promise<UploadOutcome>) | undefined {
  if (chatID !== undefined && source.uploadFor) return (file, signal) => source.uploadFor!(chatID, file, signal);
  return source.upload ? (file, signal) => source.upload!(file, signal) : undefined;
}

export async function handleUpload(c: Context): Promise<Response> {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const len = c.req.header('content-length');
  if (!len || !/^\d{1,12}$/.test(len)) return c.json({ error: 'length_required' }, 411);
  const size = Number(len);
  if (size === 0) return c.json({ error: 'bad_request' }, 400);
  if (size > MAX_UPLOAD_BYTES) return c.json({ error: 'too_large' }, 413);
  const typeHeader = c.req.header('x-upload-type')?.toLowerCase();
  const mime = isMime(typeHeader) ? typeHeader : undefined;
  const body = c.req.raw.body;
  if (!body) return c.json({ error: 'bad_request' }, 400);
  const query = c.req.query();
  const chatID = query.chatID;
  if (Object.keys(query).some((k) => k !== 'chatID') || (chatID !== undefined && (!chatID || chatID.length > 512 || /[\u0000-\u001f\u007f\s]/.test(chatID)))) {
    return c.json({ error: 'bad_request' }, 400);
  }
  // Without a chat: the one connector that takes uploads without one; several: which one is the chat's to say.
  if (chatID === undefined && plainUploaders().length > 1) return c.json({ error: 'chat_required' }, 400);
  const source = chatID === undefined ? plainUploader() : connectorFor(chatID);
  if (!source) return chatID === undefined ? c.json({ error: 'unsupported' }, 409) : c.json({ error: 'not_found' }, 404);
  const take = uploaderFor(source, chatID);
  if (!take) return c.json({ error: 'unsupported' }, 409);
  if (active >= MAX_ACTIVE) return c.json({ error: 'busy' }, 429);
  active++;
  try {
    const name = headerName(c);
    const r = await take({ body: capped(body, size), size, ...(name ? { name } : {}), ...(mime ? { mime } : {}) }, c.req.raw.signal);
    if (r.status === 499) log('upload', 'aborted');
    if (r.status === 200 && typeof r.body.uploadID === 'string') noteUpload(r.body.uploadID, source);
    return c.json(r.body, r.status as 200);
  } finally {
    active--;
  }
}
