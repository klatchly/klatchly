import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { clientIp, type Env } from './context.js';
import { jsonObject, MAX_TEXT, validId } from './relay.js';
import { RateLimiter } from './ratelimit.js';
import { log } from './log.js';
import { acceptsFiles, attachmentPlanFor, type AttachmentCaps } from './attachplan.js';
import { capped, isMime, MAX_UPLOAD_BYTES, sanitizeFileName, takesUploads, uploaderFor } from './upload.js';
import { toPlainText } from './richtext.js';
import { isFileAttachment, isGalleryAttachment } from './chatmedia.js';
import type { Upstream } from './ranges.js';
import type { Message } from './connector.js';
import type { ConnectorModule } from './registry.js';
import { connectorFor, failureOf, from } from './sources.js';

// POST /api/forward {from: [{chatID, messageID, attachment?}], to: [chatID]}: sends copies of messages to other
// chats. The browser names messages, never files or URLs: each source message is read from its connector in its
// own chat, which proves it exists there; its attachments are fetched by the connector's own allowlisted
// fetchers, the media relays' (attachmentSource; Beeper: strict mxc:// through beeper-server) and streamed into
// the target connector's uploads, then sent. Nothing goes through the browser. Every target is checked first
// (read-only, attachment capabilities, sizes, text length): a target that cannot take everything gets nothing.
// A target whose connector takes no uploads takes text only.

export const MAX_SOURCES = 10;
export const MAX_TARGETS = 5;
/** Bytes uploaded per request, all targets together (each target gets its own upload). */
export const MAX_FORWARD_BYTES = 300 * 1024 * 1024;
const FORWARD_TIMEOUT_MS = 15 * 60 * 1000;

const limiter = new RateLimiter(10 * 60 * 1000, 20, 40);
let active = 0;

export interface ForwardSource {
  chatID: string;
  messageID: string;
  attachment?: number;
}
export interface ForwardRequest {
  from: ForwardSource[];
  to: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict body check: known keys only, valid IDs, bounded lists, no duplicate targets or sources. */
export function parseForward(b: unknown): ForwardRequest | null {
  if (!isObj(b) || Object.keys(b).some((k) => k !== 'from' && k !== 'to')) return null;
  const { from, to } = b;
  if (!Array.isArray(from) || !from.length || from.length > MAX_SOURCES) return null;
  if (!Array.isArray(to) || !to.length || to.length > MAX_TARGETS) return null;
  const sources: ForwardSource[] = [];
  const seen = new Set<string>();
  for (const s of from) {
    if (!isObj(s) || Object.keys(s).some((k) => k !== 'chatID' && k !== 'messageID' && k !== 'attachment')) return null;
    if (typeof s.chatID !== 'string' || !validId(s.chatID) || typeof s.messageID !== 'string' || !validId(s.messageID)) return null;
    if (s.attachment !== undefined && (typeof s.attachment !== 'number' || !Number.isInteger(s.attachment) || s.attachment < 0 || s.attachment > 99)) return null;
    const key = `${s.chatID}\n${s.messageID}\n${s.attachment ?? ''}`;
    if (seen.has(key)) return null;
    seen.add(key);
    sources.push({ chatID: s.chatID, messageID: s.messageID, ...(s.attachment !== undefined ? { attachment: s.attachment } : {}) });
  }
  if (!to.every((t): t is string => typeof t === 'string' && validId(t)) || new Set(to).size !== to.length) return null;
  return { from: sources, to: [...to] };
}

type Att = {
  id?: string;
  type?: string;
  srcURL?: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  isGif?: boolean;
  isSticker?: boolean;
  isVoiceNote?: boolean;
  duration?: number;
  size?: { width?: number; height?: number };
};
type Msg = { id: string; chatID?: string; isDeleted?: boolean; text?: string; attachments?: Att[] | null };

export interface FilePiece {
  kind: 'file';
  mime: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  sendType?: 'gif' | 'voice-note';
  open: (signal: AbortSignal) => Promise<Upstream>;
}
export interface SourceParts {
  files: FilePiece[];
  text: string;
}

const dim = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000 ? v : undefined);
const forwardable = (a: Att) => isGalleryAttachment(a) || isFileAttachment(a) || a.type === 'audio' || (a.type === 'img' && !!a.isSticker);
function guessMime(a: Att): string {
  const m = a.mimeType?.split(';')[0]?.trim().toLowerCase();
  if (isMime(m)) return m;
  return a.type === 'img' ? 'image/jpeg' : a.type === 'video' ? 'video/mp4' : a.type === 'audio' ? 'audio/mpeg' : 'application/octet-stream';
}

/** What one source message forwards: its attachments (all, or the one named) and its text. */
export function partsOf(m: Msg, attachment: number | undefined, open: (a: Att) => FilePiece['open'] | undefined): SourceParts | 'not_found' | 'empty' {
  if (m.isDeleted) return 'not_found';
  const all = m.attachments ?? [];
  if (attachment !== undefined && !all[attachment]) return 'not_found';
  const picked = attachment !== undefined ? [all[attachment]!] : all;
  const files: FilePiece[] = [];
  for (const a of picked) {
    if (!forwardable(a)) {
      if (attachment !== undefined) return 'empty';
      continue;
    }
    const opener = open(a);
    if (!opener) return 'empty';
    const name = sanitizeFileName(a.fileName?.normalize('NFC'));
    const w = dim(a.size?.width);
    const h = dim(a.size?.height);
    files.push({
      kind: 'file',
      mime: guessMime(a),
      ...(name ? { name } : {}),
      ...(typeof a.fileSize === 'number' && a.fileSize > 0 ? { size: a.fileSize } : {}),
      ...(w && h ? { width: w, height: h } : {}),
      ...(typeof a.duration === 'number' && Number.isFinite(a.duration) && a.duration >= 0 && a.duration <= 864_000 ? { duration: a.duration } : {}),
      ...(a.type === 'video' && a.isGif ? { sendType: 'gif' as const } : a.isVoiceNote ? { sendType: 'voice-note' as const } : {}),
      open: opener,
    });
  }
  const text = toPlainText(m.text).trim().slice(0, MAX_TEXT);
  if (!files.length && !text) return 'empty';
  return { files, text };
}

export type TargetError = 'read_only' | 'no_files' | 'unsupported_type' | 'too_large' | 'text_too_long' | 'text_only' | 'not_found' | 'upstream';

/** `textOnly`: its connector takes no uploads (files are refused whatever the chat's capabilities say). */
type Target = { id: string; textOnly?: boolean; source?: ConnectorModule; caps?: AttachmentCaps & { maxTextLength?: number }; readOnly?: boolean };

/** Can this target take every part? The first reason it cannot, else null; `caption`: the text rides on the file. */
export function checkTarget(t: Target, parts: SourceParts[]): { error: TargetError } | { caption: boolean[] } {
  if (t.readOnly) return { error: 'read_only' };
  const files = parts.flatMap((p) => p.files);
  if (t.textOnly && files.length) return { error: 'text_only' };
  const maxText = Math.min(MAX_TEXT, t.caps?.maxTextLength ?? MAX_TEXT);
  if (parts.some((p) => p.text.length > maxText)) return { error: 'text_too_long' };
  const caption: boolean[] = [];
  for (const p of parts) {
    for (const f of p.files) {
      if (f.size && f.size > MAX_UPLOAD_BYTES) return { error: 'too_large' };
      const plan = attachmentPlanFor(t.caps, f.mime, f.size ?? 0);
      if (!plan.ok) return { error: !acceptsFiles(t.caps) ? 'no_files' : plan.maxSize ? 'too_large' : 'unsupported_type' };
    }
    // One file and a text: a caption when the network takes one, as the composer does.
    const only = p.files.length === 1 ? p.files[0]! : undefined;
    caption.push(!!only && !!p.text && attachmentPlanFor(t.caps, only.mime, only.size ?? 0).caption);
  }
  return { caption };
}

/** The whole body when the source did not say its length (an upload needs it), up to the upload cap. */
async function withLength(up: Upstream, known?: number): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
  if (!up.body) return null;
  const len = Number(up.headers['content-length'] ?? '');
  if (Number.isInteger(len) && len > 0) return len > MAX_UPLOAD_BYTES ? (await up.body.cancel(), null) : { body: up.body, size: len };
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = up.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_UPLOAD_BYTES || (known && n > known * 2 + 1024 * 1024)) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (!n) return null;
  const buf = Buffer.concat(chunks);
  return { body: new Blob([buf]).stream(), size: n };
}

class ForwardError extends Error {
  constructor(public code: TargetError) {
    super(code);
  }
}

async function sendFile(t: Target, f: FilePiece, text: string | undefined, plan: { asFile?: boolean }, signal: AbortSignal, budget: { left: number }): Promise<void> {
  const take = t.source ? uploaderFor(t.source, t.id) : undefined;
  if (!t.source || !take) throw new ForwardError('no_files');
  const up = await f.open(signal);
  if (up.status !== 200) {
    await up.body?.cancel().catch(() => {});
    throw new ForwardError('upstream');
  }
  const src = await withLength(up, f.size);
  if (!src) throw new ForwardError('too_large');
  if (src.size > budget.left) {
    await src.body.cancel().catch(() => {});
    throw new ForwardError('too_large');
  }
  budget.left -= src.size;
  const r = await take({ body: capped(src.body, src.size), size: src.size, ...(f.name ? { name: f.name } : {}), mime: f.mime }, signal);
  const uploadID = r.status === 200 && typeof r.body.uploadID === 'string' ? r.body.uploadID : undefined;
  if (!uploadID) throw new ForwardError(r.status === 413 ? 'too_large' : 'upstream');
  const type = plan.asFile ? 'file' : f.sendType;
  await t.source.send(t.id, {
    ...(text ? { text } : {}),
    attachment: {
      uploadID,
      mimeType: f.mime,
      ...(f.name ? { fileName: f.name } : {}),
      ...(f.width && f.height ? { size: { width: f.width, height: f.height } } : {}),
      ...(f.duration !== undefined ? { duration: f.duration } : {}),
      ...(type ? { type } : {}),
    },
  });
}

export interface TargetResult {
  chatID: string;
  ok: boolean;
  sent: number;
  error?: TargetError;
}

async function loadSource(s: ForwardSource): Promise<SourceParts | 'not_found' | 'empty'> {
  const source = connectorFor(s.chatID);
  if (!source) return 'not_found';
  let m: Message;
  try {
    m = await from(source, () => source.message(s.chatID, s.messageID));
  } catch (e) {
    if (gone(e)) return 'not_found';
    throw e;
  }
  if (!m || (m.chatID !== undefined && m.chatID !== s.chatID)) return 'not_found';
  return partsOf(m as Msg, s.attachment, (a) => source.attachmentSource?.(m, a));
}

/** A source's "no such chat or message" (404, or 400 for an id it cannot take). */
const gone = (e: unknown) => [400, 404].includes(failureOf(e).status);

async function loadTarget(id: string): Promise<Target | null> {
  const source = connectorFor(id);
  if (!source) return null;
  try {
    const chat = await from(source, () => source.chat(id, 0));
    return { id, ...(takesUploads(source) ? {} : { textOnly: true }), source, caps: (chat.capabilities as Target['caps']) ?? undefined, readOnly: !!chat.isReadOnly };
  } catch (e) {
    if (gone(e)) return null;
    throw e;
  }
}

/** Sends every part to one target, in order; stops at the first failure (what was sent stays sent). */
async function forwardTo(t: Target, parts: SourceParts[], caption: boolean[], signal: AbortSignal, budget: { left: number }): Promise<TargetResult> {
  let sent = 0;
  try {
    for (const [i, p] of parts.entries()) {
      for (const [j, f] of p.files.entries()) {
        const plan = attachmentPlanFor(t.caps, f.mime, f.size ?? 0);
        await sendFile(t, f, j === 0 && caption[i] ? p.text : undefined, plan, signal, budget);
        sent++;
      }
      if (p.text && !caption[i]) {
        await t.source!.send(t.id, { text: p.text });
        sent++;
      }
    }
    return { chatID: t.id, ok: true, sent };
  } catch (e) {
    const error = e instanceof ForwardError ? e.code : 'upstream';
    log('forward', 'send failed', { error, status: e instanceof ForwardError ? 0 : failureOf(e, t.source).status });
    return { chatID: t.id, ok: false, sent, error };
  }
}

const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

export const forwardRoutes = new Hono<Env>();

forwardRoutes.post('/forward', small, async (c: Context) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const req = parseForward(await jsonObject(c));
  if (!req) return c.json({ error: 'bad_request' }, 400);
  if (active >= 1) return c.json({ error: 'busy' }, 429);
  active++;
  try {
    const parts: SourceParts[] = [];
    for (const s of req.from) {
      const p = await loadSource(s);
      if (p === 'not_found') return c.json({ error: 'source_not_found' }, 404);
      if (p === 'empty') return c.json({ error: 'nothing_to_forward' }, 422);
      parts.push(p);
    }
    const targets: Target[] = [];
    for (const id of req.to) {
      const t = await loadTarget(id);
      if (!t) return c.json({ error: 'target_not_found' }, 404);
      targets.push(t);
    }
    // Not tied to the request: a forward started goes to its end even if the page goes away (iOS backgrounding).
    const signal = AbortSignal.timeout(FORWARD_TIMEOUT_MS);
    const budget = { left: MAX_FORWARD_BYTES };
    const results: TargetResult[] = [];
    for (const t of targets) {
      const check = checkTarget(t, parts);
      if ('error' in check) results.push({ chatID: t.id, ok: false, sent: 0, error: check.error });
      else results.push(await forwardTo(t, parts, check.caption, signal, budget));
    }
    log('forward', 'done', { sources: parts.length, targets: targets.length, ok: results.filter((r) => r.ok).length });
    return c.json({ results });
  } catch (e) {
    const { status } = failureOf(e);
    log('forward', 'error', { status });
    return c.json({ error: 'upstream' }, status);
  } finally {
    active--;
  }
});
