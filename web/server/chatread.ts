import { log } from './log.js';
import { ConnectorError, type Attachment, type Message, type Page } from './connector.js';
import type { Upstream } from './ranges.js';
import { connectorFor, from } from './sources.js';

// Reading a chat on demand, for the packages' augmentations: one message, or a chat's latest page, when the user
// acts on it (never a stream of events). Handed to augmentation modules only (ModuleContext.chats, at start), bound
// to their package: every call is logged with its package id, never with content. Results carry only the fields
// of ReadMessage. The chat's connector reads (message, messages); what it says does not exist (a ConnectorError
// 404) reads as nothing: no message, no messages. Its other errors go on, tagged with it (sources.ts from).

/** What an augmentation reads of a message: its text and who wrote it, nothing else. */
export interface ReadMessage {
  text?: string | null;
  isSender?: boolean;
  senderName?: string;
  timestamp?: string;
  isHidden?: boolean;
  isDeleted?: boolean;
  type?: string;
}

export interface ChatReader {
  /** One message (null when the source no longer has it). Throws upstream errors. */
  readMessage(chatID: string, messageID: string): Promise<ReadMessage | null>;
  /**
   * A picture of a message (its attachment at `index`), for the user who asked to translate or describe it: JPEG,
   * PNG, WebP or GIF (no sticker), at most READ_IMAGE_MAX bytes ('too_large' beyond). Null when the message has
   * no such picture or its source cannot read it. Throws upstream errors. (1.9.0)
   */
  readImage(chatID: string, messageID: string, index: number): Promise<ReadImage | 'too_large' | null>;
  /**
   * The sound of a message (its attachment at `index`: a voice note or another audio file), for the user who asked
   * to transcribe it: its bytes as the source serves them, at most READ_AUDIO_MAX bytes ('too_large' beyond). Null
   * when the message has no such attachment or its source cannot read it. Throws upstream errors. (1.23.0)
   */
  readAudio(chatID: string, messageID: string, index: number): Promise<ReadAudio | 'too_large' | null>;
  /** The chat's latest page of messages, newest first. Throws upstream errors. */
  recentMessages(chatID: string): Promise<ReadMessage[]>;
  /**
   * The chat's messages over a period, oldest first, for a question the user asks about it: those at or after
   * `since` (ISO) and at or before `until`, or from the message `fromMessageID` on (that one included), or after the
   * user's last own message (`afterOwn`). Read page by page backwards from the newest, at most `max` messages
   * (READ_RANGE_MAX at most): `truncated` when the period holds more (the newest are kept), `reached` false when the
   * start of the period was not found (the chat's history ended before it, or the message is not in reach).
   * Throws upstream errors. (1.21.0)
   */
  readRange(chatID: string, range: ReadRange): Promise<ReadRangeResult>;
}

/** What ChatReader.readRange reads. One of `since`, `fromMessageID`, `afterOwn` sets the start. (1.21.0) */
export interface ReadRange {
  since?: string;
  until?: string;
  fromMessageID?: string;
  afterOwn?: boolean;
  max?: number;
}

export interface ReadRangeResult {
  messages: ReadMessage[];
  truncated: boolean;
  reached: boolean;
}

export const READ_RANGE_MAX = 2000;
const RANGE_PAGE = 200;
const RANGE_PAGES = 40;

/** A message's picture as a package reads it. */
export interface ReadImage {
  mime: string;
  data: Uint8Array;
}

export const READ_IMAGE_MAX = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const READ_IMAGE_MS = 30_000;

/**
 * A message's sound as a package reads it (1.23.0): `mime` is the type it is served with when that is an audio
 * type, else the declared one, else 'application/octet-stream' (no parameters, lower case: 'audio/ogg', 'audio/mp4'…);
 * `duration` in seconds when the source declares it; `voiceNote` when the source says it is one.
 */
export interface ReadAudio {
  mime: string;
  data: Uint8Array;
  duration?: number;
  voiceNote?: boolean;
}

export const READ_AUDIO_MAX = 25 * 1024 * 1024;
const READ_AUDIO_MS = 60_000;
/** Audio files some sources declare with a video container type (an .mp4 or .webm holding only sound). */
const AUDIO_AS_VIDEO = new Set(['video/mp4', 'video/webm', 'video/ogg']);

/** The body of an attachment's upstream, read up to `max` bytes: its bytes and served type, 'too_large', or null (gone). */
async function readCapped(open: (signal: AbortSignal) => Promise<Upstream>, ms: number, max: number, what: string): Promise<{ data: Uint8Array; served?: string } | 'too_large' | null> {
  const up = await open(AbortSignal.timeout(ms));
  if (up.status !== 200 || !up.body) {
    await up.body?.cancel();
    // Gone at its source: nothing to read (a retry would not help); other failures are the source's.
    if (up.status === 404 || up.status === 410) return null;
    throw new Error(`${what} ${up.status}`);
  }
  const len = Number(up.headers['content-length']);
  if (len > max) {
    await up.body.cancel();
    return 'too_large';
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = up.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }
  const served = up.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  return { data: Buffer.concat(chunks), ...(served ? { served } : {}) };
}

const STRINGS = ['senderName', 'timestamp', 'type'] as const;
const FLAGS = ['isSender', 'isHidden', 'isDeleted'] as const;

/** The declared fields of a source's message, checked; anything else (attachments, ids, raw events) left out. */
export function project(m: unknown): ReadMessage {
  const src = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
  const out: ReadMessage = {};
  if (typeof src.text === 'string' || src.text === null) out.text = src.text;
  for (const k of STRINGS) if (typeof src[k] === 'string') out[k] = src[k];
  for (const k of FLAGS) if (typeof src[k] === 'boolean') out[k] = src[k];
  return out;
}

/** The connector of a chat; none (no connector on claims it): a 404, as the chat routes answer. */
export function owner(chatID: string) {
  const source = connectorFor(chatID);
  if (!source) throw new ConnectorError(404, 'not_found');
  return source;
}

const absent = (e: unknown) => e instanceof ConnectorError && e.status === 404;

/** One message of a chat from its connector (null: it says there is none). */
export async function sourceMessage(chatID: string, messageID: string): Promise<unknown> {
  const source = owner(chatID);
  try {
    return await from(source, () => source.message(chatID, messageID));
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** A chat's latest page of messages from its connector, newest first (none: it says there is no such chat). */
export async function sourceRecent(chatID: string): Promise<unknown[]> {
  const source = owner(chatID);
  try {
    return (await from(source, () => source.messages(chatID, {}))).items ?? [];
  } catch (e) {
    if (absent(e)) return [];
    throw e;
  }
}

const tsOf = (m: Message): number => {
  const t = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/**
 * A chat's messages over a period from its connector, oldest first (ReadRange): pages read backwards from the
 * newest until the start of the period, the end of the history, the cap or RANGE_PAGES pages.
 */
export async function sourceRange(chatID: string, range: ReadRange): Promise<{ items: Message[]; truncated: boolean; reached: boolean }> {
  const source = owner(chatID);
  const max = Math.max(1, Math.min(READ_RANGE_MAX, Math.floor(range.max ?? READ_RANGE_MAX)));
  const since = range.since ? Date.parse(range.since) : NaN;
  const until = range.until ? Date.parse(range.until) : NaN;
  const kept: Message[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let reached = false;
  let truncated = false;
  for (let page = 0; page < RANGE_PAGES && !reached && !truncated; page++) {
    let p: Page<Message>;
    try {
      p = await from(source, () => source.messages(chatID, cursor ? { cursor, direction: 'before', limit: RANGE_PAGE } : { limit: RANGE_PAGE }));
    } catch (e) {
      if (absent(e)) break;
      throw e;
    }
    // Newest first within what was read so far, whatever order the page has.
    const items = [...(p.items ?? [])].filter((m) => m && typeof m.id === 'string' && !seen.has(m.id)).sort((a, b) => tsOf(b) - tsOf(a));
    for (const m of items) {
      seen.add(m.id);
      const t = tsOf(m);
      if (Number.isFinite(until) && t > until) continue;
      if (Number.isFinite(since) && t < since) {
        reached = true;
        break;
      }
      if (range.afterOwn && m.isSender) {
        reached = true;
        break;
      }
      if (kept.length >= max) {
        truncated = true;
        break;
      }
      kept.push(m);
      if (range.fromMessageID && m.id === range.fromMessageID) {
        reached = true;
        break;
      }
    }
    if (!p.hasMore || !p.oldestCursor) {
      // The whole history was read: a period by date started inside it; a message or an own message was not found.
      if (!range.fromMessageID && !range.afterOwn) reached = true;
      break;
    }
    cursor = p.oldestCursor;
  }
  return { items: kept.reverse(), truncated, reached };
}

/** The reader of one package. */
export function chatReader(pkg: string): ChatReader {
  return {
    async readMessage(chatID, messageID) {
      log('chatread', 'message', { pkg });
      const m = await sourceMessage(chatID, messageID);
      return m ? project(m) : null;
    },
    async readImage(chatID, messageID, index) {
      const m = (await sourceMessage(chatID, messageID)) as Message | null;
      const a = Number.isInteger(index) && index >= 0 ? (m?.attachments as Attachment[] | undefined)?.[index] : undefined;
      const declared = a?.mimeType?.split(';')[0]?.trim().toLowerCase();
      // No declared type on a picture (some cached media): the type it is served with decides.
      if (!m || !a || a.isSticker || (declared ? !IMAGE_TYPES.has(declared) : a.type !== 'img')) return null;
      const open = owner(chatID).attachmentSource?.(m, a);
      if (!open) return null;
      const got = await readCapped(open, READ_IMAGE_MS, READ_IMAGE_MAX, 'image');
      if (got === null || got === 'too_large') return got;
      const mime = got.served && IMAGE_TYPES.has(got.served) ? got.served : declared;
      if (!mime) return null;
      log('chatread', 'image', { pkg, bytes: got.data.length });
      return { mime, data: got.data };
    },
    async readAudio(chatID, messageID, index) {
      const m = (await sourceMessage(chatID, messageID)) as Message | null;
      const a = Number.isInteger(index) && index >= 0 ? (m?.attachments as Attachment[] | undefined)?.[index] : undefined;
      const declared = a?.mimeType?.split(';')[0]?.trim().toLowerCase();
      const isAudio = (t: string | undefined) => !!t && (t.startsWith('audio/') || (a?.type === 'audio' && AUDIO_AS_VIDEO.has(t)));
      // An audio attachment (by its kind or its declared type); never a sticker or a video with pictures.
      if (!m || !a || a.isSticker || !(a.type === 'audio' || (declared?.startsWith('audio/') ?? false))) return null;
      const open = owner(chatID).attachmentSource?.(m, a);
      if (!open) return null;
      const got = await readCapped(open, READ_AUDIO_MS, READ_AUDIO_MAX, 'audio');
      if (got === null || got === 'too_large') return got;
      const mime = isAudio(got.served) ? got.served! : isAudio(declared) ? declared! : 'application/octet-stream';
      log('chatread', 'audio', { pkg, bytes: got.data.length });
      const duration = typeof a.duration === 'number' && Number.isFinite(a.duration) && a.duration > 0 ? a.duration : undefined;
      return { mime, data: got.data, ...(duration !== undefined ? { duration } : {}), ...(a.isVoiceNote === true ? { voiceNote: true } : {}) };
    },
    async recentMessages(chatID) {
      const items = await sourceRecent(chatID);
      log('chatread', 'recent', { pkg, count: items.length });
      return items.map(project);
    },
    async readRange(chatID, range) {
      const r = await sourceRange(chatID, range);
      log('chatread', 'range', { pkg, count: r.items.length, truncated: r.truncated, reached: r.reached });
      return { messages: r.items.map(project), truncated: r.truncated, reached: r.reached };
    },
  };
}
