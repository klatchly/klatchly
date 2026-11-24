import { Hono } from 'hono';
import type { Env } from './context.js';
import { fail, validId } from './relay.js';
import { toPlainText } from './richtext.js';
import type { MediaTab } from './connector.js';
import type { ConnectorModule } from './registry.js';
import { connectorFor } from './sources.js';

// GET /api/chats/:id/media?tab=media|files|links: one chat's pictures and videos, files, or links, newest first
// (the "Media, links and files" page). The chat's connector finds the messages (mediaMessages; Beeper: the
// message search with its media filter) with the filter below. Only what the page needs goes back: messages without reactions, receipts or mentions, the links
// already extracted.

export type { MediaTab };
export const MEDIA_TABS: readonly MediaTab[] = ['media', 'files', 'links'];

const MAX_TEXT = 4000;
const MAX_URL = 2048;

type Att = { type?: string; mimeType?: string; isSticker?: boolean; isVoiceNote?: boolean; isGif?: boolean };
type Preview = { url?: unknown; originalURL?: unknown; title?: unknown; summary?: unknown; img?: unknown };
export interface SourceMessage {
  id: string;
  chatID: string;
  senderID?: string;
  senderName?: string;
  isSender?: boolean;
  isDeleted?: boolean;
  isHidden?: boolean;
  timestamp: string;
  sortKey?: string;
  type?: string;
  text?: string;
  attachments?: (Att & Record<string, unknown>)[] | null;
  links?: Preview[] | null;
}

/** Pictures (GIF images included) and videos, as the viewer opens them (client gallery.ts mediaKind); no stickers. */
export function isGalleryAttachment(a: Att): boolean {
  if (a.isSticker) return false;
  if (a.type === 'img') return !(a.mimeType ?? '').toLowerCase().includes('lottie');
  return a.type === 'video';
}

/** Documents and audio files (not voice notes, which are a conversation's, not files to find again). */
export function isFileAttachment(a: Att): boolean {
  if (a.isSticker) return false;
  return a.type === 'unknown' || a.type === 'file' || (a.type === 'audio' && !a.isVoiceNote);
}

export interface LinkItem {
  url: string;
  domain: string;
  title?: string;
  summary?: string;
  /** Preview picture: a media reference as the chat's connector gives it (shown only through that connector's media). */
  img?: string;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// A link preview's picture as a connector names its media (e.g. a content URI), never a web or local URL: the client
// shows it only through that connector's media (its relay or its own route), the server never fetches it.
const mediaRefShape = (v: string) => !/[\p{Cc}\s]/u.test(v) && !/^(https?|file|data|javascript|blob):/i.test(v);
const HREF_RE = /<a\s[^<>]*?href="(https?:\/\/[^"<>\s]+)"/gi;
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** A web link worth listing (http/https, a real host), with trailing punctuation and unbalanced brackets cut. */
export function cleanUrl(raw: string): string | undefined {
  let u = raw.replace(/&amp;/g, '&');
  for (;;) {
    const last = u[u.length - 1];
    if (!last) return undefined;
    if ('.,;:!?\'"»”’'.includes(last)) u = u.slice(0, -1);
    else if (last === ')' && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
    else if (last === ']' && (u.match(/\[/g)?.length ?? 0) < (u.match(/\]/g)?.length ?? 0)) u = u.slice(0, -1);
    else break;
  }
  if (u.length > MAX_URL) return undefined;
  try {
    const p = new URL(u);
    if ((p.protocol !== 'http:' && p.protocol !== 'https:') || !p.hostname.includes('.') || p.username || p.password) return undefined;
    return p.href;
  } catch {
    return undefined;
  }
}

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * The links of a message, in order, once each: the network's previews first (title, summary, picture), then the
 * URLs in the text (plain or rich: hrefs and visible text).
 */
export function extractLinks(text: string | undefined, previews?: Preview[] | null): LinkItem[] {
  const out = new Map<string, LinkItem>();
  for (const p of previews ?? []) {
    const url = cleanUrl(str(p.url, MAX_URL) ?? str(p.originalURL, MAX_URL) ?? '');
    if (!url || out.has(url)) continue;
    const img = str(p.img, 6144);
    out.set(url, {
      url,
      domain: domainOf(url),
      ...(str(p.title, 300) ? { title: str(p.title, 300) } : {}),
      ...(str(p.summary, 400) ? { summary: str(p.summary, 400) } : {}),
      ...(img && mediaRefShape(img) ? { img } : {}),
    });
  }
  if (text) {
    const found = [...text.matchAll(HREF_RE)].map((m) => m[1]!).concat(toPlainText(text).match(URL_RE) ?? []);
    for (const raw of found) {
      const url = cleanUrl(raw);
      if (url && !out.has(url) && out.size < 20) out.set(url, { url, domain: domainOf(url) });
    }
  }
  return [...out.values()];
}

export function matchesTab(m: SourceMessage, tab: MediaTab): boolean {
  if (m.isDeleted || m.isHidden) return false;
  if (tab === 'links') return extractLinks(m.text, m.links).length > 0;
  return !!m.attachments?.some(tab === 'media' ? isGalleryAttachment : isFileAttachment);
}

const ATT_KEYS = ['id', 'type', 'srcURL', 'mimeType', 'fileName', 'fileSize', 'isGif', 'isSticker', 'isVoiceNote', 'duration', 'posterImg', 'size'];

/** What the page shows of a message: attachments kept whole and in place (their index is the viewer's key). */
export function slimMessage(m: SourceMessage, tab: MediaTab): Record<string, unknown> {
  const out: Record<string, unknown> = { id: m.id, chatID: m.chatID, timestamp: m.timestamp };
  for (const k of ['senderID', 'senderName', 'sortKey'] as const) if (typeof m[k] === 'string') out[k] = m[k];
  if (m.isSender) out.isSender = true;
  if (m.text) out.text = m.text.length > MAX_TEXT ? m.text.slice(0, MAX_TEXT) : m.text;
  if (tab === 'links') out.urls = extractLinks(m.text, m.links);
  else if (m.attachments?.length) out.attachments = m.attachments.map((a) => Object.fromEntries(ATT_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])));
  return out;
}

export interface MediaPage {
  items: Record<string, unknown>[];
  hasMore: boolean;
  cursor: string | null;
}

/** A connector's messages for one tab, filtered by matchesTab and slimmed. */
export async function sourceMediaPage(source: ConnectorModule, chatID: string, tab: MediaTab, cursor?: string): Promise<MediaPage | null> {
  if (!source.mediaMessages) return null;
  const r = await source.mediaMessages(chatID, tab, cursor, (m) => matchesTab(m as SourceMessage, tab));
  return { items: r.items.map((m) => slimMessage(m as SourceMessage, tab)), hasMore: r.hasMore, cursor: r.cursor };
}

const validCursor = (v: string) => v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f\s]/.test(v);

export const chatMediaRoutes = new Hono<Env>();

chatMediaRoutes.get('/chats/:id/media', async (c) => {
  const id = c.req.param('id');
  const tab = (c.req.query('tab') ?? 'media') as MediaTab;
  const cursor = c.req.query('cursor');
  const extra = Object.keys(c.req.queries()).filter((k) => k !== 'tab' && k !== 'cursor');
  if (!validId(id) || !MEDIA_TABS.includes(tab) || (cursor !== undefined && !validCursor(cursor)) || extra.length) {
    return c.json({ error: 'bad_request' }, 400);
  }
  const source = connectorFor(id);
  if (!source) return c.json({ error: 'not_found' }, 404);
  try {
    const page = await sourceMediaPage(source, id, tab, cursor);
    return page ? c.json(page) : c.json({ error: 'not_found' }, 404);
  } catch (e) {
    return fail(c, e, '/chats/:id/media', source);
  }
});
