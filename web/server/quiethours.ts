// Quiet hours ("Heures calmes"): the pure part, shared by the server (server/quiet.ts: push, badge) and the client
// (client/src/quiet.ts: the inbox, the Quiet list). A rule is a daily window in a time zone, on chosen days; a
// network (account) may have one, and a chat may have its own or none at all, which wins over its account's. While a
// window is open, a chat that receives a message is held: no notification, not counted, out of the inbox, under
// Quiet. When the window closes it is back, unread. Nothing is stored per message: a chat is held when its window is
// open and its unread activity came after the window opened (and after the last "show them now").

/** A daily window: from `from` to `to` (minutes after midnight, local to `tz`), starting on `days` (0 = Sunday). */
export interface QuietRule {
  from: number;
  to: number;
  /** The days a window starts on (an overnight window that starts on Friday ends on Saturday morning). */
  days: number[];
  /** IANA time zone the times are in (the device's when the rule was saved). */
  tz: string;
}

/** Every rule: per account, per chat (a rule of its own, or `false`: never quiet, whatever its account's). */
export interface QuietRules {
  accounts: Record<string, QuietRule>;
  chats: Record<string, QuietRule | false>;
  /** "Show them now": chats held before this time (ms) are released; later messages are held again. */
  releasedAt?: number;
}

const MINUTES = 24 * 60;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Whether a time zone is one this runtime knows (Intl throws on an unknown one). */
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A stored or sent rule, checked and normalised (days sorted, unique); undefined when it is not one. */
export function validRule(v: unknown): QuietRule | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => !['from', 'to', 'days', 'tz'].includes(k))) return undefined;
  const minute = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < MINUTES;
  if (!minute(r.from) || !minute(r.to) || r.from === r.to || !validZone(r.tz)) return undefined;
  if (!Array.isArray(r.days) || !r.days.length || r.days.length > 7) return undefined;
  if (r.days.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6)) return undefined;
  return { from: r.from, to: r.to, days: [...new Set(r.days as number[])].sort(), tz: r.tz };
}

/** A rule for every day (the editors' default). */
export const everyDay = (from: number, to: number, tz: string): QuietRule => ({ from, to, days: [...ALL_DAYS], tz });

// One formatter per zone: building one is the slow part.
const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (formats.size > 50) formats.clear();
    formats.set(tz, f);
  }
  return f;
}
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall clock in a zone at `now`: the day of the week and the time of day in seconds. */
export function wallClock(tz: string, now: number): { day: number; seconds: number } {
  const parts: Record<string, string> = {};
  for (const p of format(tz).formatToParts(new Date(now))) parts[p.type] = p.value;
  return { day: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0, seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second) };
}

/**
 * When the window open at `now` opened (ms), or null when none is open. Counted back on the wall clock, so on the
 * night the clocks change the start may be off by that hour (the window itself opens and closes on time).
 */
export function windowStart(rule: QuietRule, now: number): number | null {
  const { day, seconds } = wallClock(rule.tz, now);
  const from = rule.from * 60;
  const to = rule.to * 60;
  const startsOn = (d: number) => rule.days.includes(((d % 7) + 7) % 7);
  if (from < to) return seconds >= from && seconds < to && startsOn(day) ? now - (seconds - from) * 1000 : null;
  // Overnight (22:00 → 07:00): the evening part starts today, the morning part started yesterday.
  if (seconds >= from && startsOn(day)) return now - (seconds - from) * 1000;
  if (seconds < to && startsOn(day - 1)) return now - (seconds + 24 * 3600 - from) * 1000;
  return null;
}

/** The rule that applies to a chat: its own (none when `false`), else its account's. */
export function ruleFor(rules: QuietRules | undefined, chatID: string, accountID: string | undefined): QuietRule | undefined {
  if (!rules) return undefined;
  const own = Object.hasOwn(rules.chats, chatID) ? rules.chats[chatID] : undefined;
  if (own === false) return undefined;
  if (own) return own;
  return accountID && Object.hasOwn(rules.accounts, accountID) ? rules.accounts[accountID] : undefined;
}

/** When the quiet time a chat is in now began (its window, or a later "show them now"), or null: not quiet now. */
export function quietSince(rules: QuietRules | undefined, chatID: string, accountID: string | undefined, now: number): number | null {
  const rule = ruleFor(rules, chatID, accountID);
  const start = rule ? windowStart(rule, now) : null;
  if (start === null) return null;
  return Math.max(start, rules?.releasedAt ?? 0);
}

const ms = (iso: unknown) => (typeof iso === 'string' ? Date.parse(iso) || 0 : typeof iso === 'number' ? iso : 0);

/**
 * Whether a chat is held now: quiet, with unread messages, its last activity since the quiet time began. A chat read
 * meanwhile (opened from the Quiet list) is not held any more.
 */
export function isHeld(
  rules: QuietRules | undefined,
  chat: { id: string; accountID?: string; unreadCount?: number; lastActivity?: string | number },
  now: number,
): boolean {
  if (!chat.unreadCount || chat.unreadCount <= 0) return false;
  const since = quietSince(rules, chat.id, chat.accountID, now);
  return since !== null && ms(chat.lastActivity) >= since;
}

/** Whether any rule exists (the Quiet tab shows then). */
export const anyRule = (rules: QuietRules | undefined): boolean =>
  !!rules && (Object.keys(rules.accounts).length > 0 || Object.values(rules.chats).some((r) => r !== false));

/** "22:00" from minutes after midnight. */
export const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Minutes after midnight from "22:00" (an <input type="time"> value), or undefined. */
export function minutesOf(v: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}
