// Scheduled calls (WhatsApp "call events") reach us as an ordinary TEXT message the bridge formats itself:
// a heading with the event name, "Start time: <RFC 1123 date>", the description, then "Join link: <url>".
// Message lists carry it as rich text (<h4>name</h4><p>Start time: …</p>…<p>Join link: <a href>…</a></p>),
// chat list previews as Markdown ("#### name\n\nStart time: …\n\n…Join link: &lt;url&gt;"). Pure functions
// shared by the server (push bodies) and the client (call card, previews). Only the bridge's exact shape with a
// WhatsApp call link matches; anything else returns null and the message renders as before.

import { decodeEntities, toPlainText } from './richtext.js';

export interface CallEvent {
  /** Event name; empty when the bridge's name is just "call" (the UI then says "Video call"/"Call"). */
  title: string;
  start: Date;
  video: boolean;
  /** Always an https://call.whatsapp.com/ URL. */
  link: string;
  location?: string;
  /**
   * What remains of the body. Rich text for the HTML shape (the only one the bubble shows as a card); for the
   * Markdown shape (previews only) the raw remainder, entities left as they are.
   */
  description: string;
  rich: boolean;
}

const FIELD = '(Start time|End time|Location|Join link)';
const HTML_FIELD = new RegExp(`<p>\\s*${FIELD}:\\s*([\\s\\S]*?)\\s*</p>`, 'gi');
const MD_FIELD = new RegExp(`^[ \\t]*${FIELD}:[ \\t]*(.*)$`, 'gim');
const HREF = /href="(https:\/\/[^"]+)"/i;
const GENERIC = /^(video |voice )?call$/i;
// The bridge's date format (Go's time.RFC1123 in UTC); looser dates are not trusted to Date's parser.
const RFC1123 = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} (UTC|GMT)$/;

function callLink(s: string | undefined): string | undefined {
  try {
    const u = new URL(s ?? '');
    return u.protocol === 'https:' && u.hostname === 'call.whatsapp.com' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function parseCallEvent(text: string | null | undefined): CallEvent | null {
  if (!text || !/^\s*(<h[1-6]>|#)/i.test(text)) return null;
  const fields = new Map<string, string>();
  let title: string;
  let description: string;
  let rich: boolean;
  const h = /^\s*<h([1-6])>([\s\S]*?)<\/h\1>([\s\S]*)$/i.exec(text);
  if (h) {
    title = toPlainText(`<p>${h[2]}</p>`);
    description = h[3]!.replace(HTML_FIELD, (_, k: string, v: string) => {
      fields.set(k.toLowerCase(), k.toLowerCase() === 'join link' ? (HREF.exec(v)?.[1] ?? toPlainText(`<p>${v}</p>`)) : toPlainText(`<p>${v}</p>`));
      return '';
    });
    description = description.replace(/<p>\s*<\/p>/gi, '').trim();
    rich = true;
  } else {
    const m = /^#{1,6}[ \t]+(.+)\n([\s\S]*)$/.exec(text);
    if (!m) return null;
    title = decodeEntities(m[1]!).trim();
    // Only field values are decoded; the description stays as received.
    description = m[2]!.replace(MD_FIELD, (_, k: string, v: string) => (fields.set(k.toLowerCase(), decodeEntities(v).trim().replace(/^<(.*)>$/, '$1')), '')).replace(/\n{3,}/g, '\n\n').trim();
    rich = false;
  }
  const when = fields.get('start time') ?? '';
  const link = callLink(fields.get('join link'));
  if (!RFC1123.test(when) || !link) return null;
  const start = new Date(when);
  if (Number.isNaN(start.getTime())) return null;
  return {
    title: GENERIC.test(title) ? '' : title,
    start,
    video: new URL(link).pathname.startsWith('/video/'),
    link,
    location: fields.get('location') || undefined,
    description,
    rich,
  };
}
