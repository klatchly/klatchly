import { lang, t } from './i18n';
import type { Message } from './types';
import { oneLine } from '../../server/richtext';
import { parseCallEvent, type CallEvent } from '../../server/callevent';
import { kindLine } from '../../server/msgkind';
import { isRawUserID, senderLabel } from '../../server/names';
import { knownName } from './names';

export function typeLabel(type: string | undefined): string | undefined {
  const types = t().types as Record<string, string>;
  return type && type !== 'attachment' ? types[type] : undefined;
}

/** One-line summary of a message (reply quotes, previews). */
export function snippet(m: Message, max = 120): string {
  if (m.isDeleted) return t().msg.deleted;
  const s = bodyLine(m);
  if (s) return s.length > max ? `${s.slice(0, max)}…` : s;
  return typeLabel(m.type) ?? t().types.attachment;
}

/** A message's body on one line: a call, a contact… as their kind and detail (server/msgkind.ts), else its text. */
export const bodyLine = (m: Pick<Message, 'type' | 'text' | 'attachments'>): string => kindLine(m, t().types) ?? textLine(m.text);

/** A body on one line: a scheduled call as "📞 Video call · Tue 3 Nov, 14:00", other text without markup. */
export function textLine(text: string | undefined): string {
  const call = parseCallEvent(text);
  return call ? t().call.preview(callName(call), f().when.format(call.start)) : oneLine(text);
}

export const callName = (c: CallEvent) => c.title || (c.video ? t().call.video : t().call.voice);

/** Start of a call, relative when coming soon ("tomorrow at 14:00", "Thursday at 09:30"), else the date. */
export function callWhen(d: Date): string {
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  // Past calls beyond yesterday: the date (a bare weekday would read as the coming one).
  if (days < -1 || days > 6) return f().when.format(d);
  const day = Math.abs(days) <= 1 ? f().rel.format(days, 'day') : f().weekdayLong.format(d);
  return t().call.when(day, f().time.format(d));
}
export const callFull = (d: Date) => f().callFull.format(d);

// Intl formatters for the current interface language (rebuilt when it changes).
let fmtLang = '';
let fmt: {
  time: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
  short: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  full: Intl.DateTimeFormat;
  rel: Intl.RelativeTimeFormat;
  when: Intl.DateTimeFormat;
  weekdayLong: Intl.DateTimeFormat;
  callFull: Intl.DateTimeFormat;
};
function f() {
  const l = lang();
  if (l !== fmtLang) {
    fmtLang = l;
    fmt = {
      time: new Intl.DateTimeFormat(l, { hour: '2-digit', minute: '2-digit' }),
      weekday: new Intl.DateTimeFormat(l, { weekday: 'short' }),
      short: new Intl.DateTimeFormat(l, { day: '2-digit', month: '2-digit', year: '2-digit' }),
      day: new Intl.DateTimeFormat(l, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      full: new Intl.DateTimeFormat(l, { dateStyle: 'medium', timeStyle: 'short' }),
      rel: new Intl.RelativeTimeFormat(l, { numeric: 'auto' }),
      when: new Intl.DateTimeFormat(l, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
      weekdayLong: new Intl.DateTimeFormat(l, { weekday: 'long' }),
      callFull: new Intl.DateTimeFormat(l, { dateStyle: 'full', timeStyle: 'short' }),
    };
  }
  return fmt;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function relativeTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return f().time.format(d);
  if (days === 1) return f().rel.format(-1, 'day');
  if (days < 7) return f().weekday.format(d);
  return f().short.format(d);
}

/** Date and time (lightbox caption). */
export const dateTimeOf = (iso: string) => f().full.format(new Date(iso));
export const timeOf = (iso: string) => f().time.format(new Date(iso));
export const dayKey = (iso: string) => startOfDay(new Date(iso));
export function dayLabel(iso: string): string {
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000);
  if (days === 0 || days === 1) return f().rel.format(-days, 'day');
  return f().day.format(new Date(iso));
}

/** Duration as m:ss (voice notes, recordings). */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
export function fileSize(n?: number): string {
  if (!n) return '';
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return new Intl.NumberFormat(lang(), { style: 'unit', unit: UNITS[i], unitDisplay: 'short', maximumFractionDigits: i ? 1 : 0 }).format(n);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : (parts[0] ?? '?').slice(0, 2);
  return s.toUpperCase();
}

export function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Well-separated hues for group senders (green, orange, purple, pink, teal, amber, red, lime). No blue: that
// is the colour of our own bubbles.
const SENDER_HUES = [150, 28, 280, 335, 180, 45, 0, 95];
const huesByList = new WeakMap<object, Map<string, number>>();

/**
 * Colour of a group member's bubbles: the member's place among the chat's participants (sorted by ID, so
 * the same on every device and stable while history loads), which keeps small groups free of repeats.
 * Members missing from a partial list (big groups) fall back to a hash.
 */
export function senderHue(senderID: string, participants?: { items: { id: string; isSelf?: boolean }[] }): number {
  let byID = participants ? huesByList.get(participants) : undefined;
  if (participants && !byID) {
    const ids = participants.items.filter((p) => !p.isSelf).map((p) => p.id).sort();
    byID = new Map(ids.map((id, i) => [id, SENDER_HUES[i % SENDER_HUES.length]!]));
    huesByList.set(participants, byID);
  }
  return byID?.get(senderID) ?? SENDER_HUES[hue(senderID) % SENDER_HUES.length]!;
}

/** Sender name to display: raw IDs Beeper uses for unknown members become "Member ·1234". */
export const displaySender = (m: { senderName?: string; senderID?: string }) =>
  ((!m.senderName || isRawUserID(m.senderName)) && knownName(m.senderID)) ||
  senderLabel(m.senderName, m.senderID, t().common.member);
