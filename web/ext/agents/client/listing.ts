// The Agents space's list, without React (unit-tested: ext/agents/test/listing.test.ts): title hygiene, one-line
// previews, source names and the list's filter (agent, sources, unread only, search).

/** What the list needs of a conversation (api.ts SpaceSession). */
export interface ListedSession {
  id: string;
  agent: string;
  title: string | null;
  preview: string | null;
  unread: number;
  /** Where it was started (absent: Klatchly). */
  source?: string;
}

// ── Titles ───────────────────────────────────────────────────────────────────

/** A run of emoji (pictographs, flags, keycaps, joiners, variation selectors) and the spaces after it. */
const LEADING_EMOJI = /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}‍️⃣]+\s*)+/u;
/** Hermes' title of a scheduled task's run: "name · Nov 12 07:20" (the time is already the row's). */
const TRAILING_DATE = /\s*·\s*[A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2}$/;
/** Hermes' suffix that makes a title unique: "name #2". */
const UNIQUE_SUFFIX = /\s+#(\d{1,4})$/;

/**
 * A stored title as the list shows it: without a leading emoji or a trailing "· Nov 12 07:20" date; Hermes' "#N"
 * kept apart (shown in grey, never lost in the ellipsis). null: no usable title (the row names the date instead,
 * never the preview again).
 */
export function cleanTitle(raw: string | null | undefined): { text: string; suffix: string | null } | null {
  if (!raw) return null;
  let t = raw.replace(/\s+/g, ' ').trim();
  let suffix: string | null = null;
  const m = UNIQUE_SUFFIX.exec(t);
  if (m) {
    suffix = `#${m[1]}`;
    t = t.slice(0, m.index);
  }
  t = t.replace(TRAILING_DATE, '').replace(LEADING_EMOJI, '').trim();
  if (!t) return null;
  return { text: t, suffix };
}

/** A preview as one line: no Markdown marks, no line breaks, at most `max` characters. */
export function previewLine(raw: string | null | undefined, max = 90): string {
  if (!raw) return '';
  const flat = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── Sources ──────────────────────────────────────────────────────────────────

/** The source of a conversation made here (the list's own source key). */
export const OWN_SOURCE = 'klatchly';
/** The same key before 0.26.1 (compatibility): a filter saved by then may still hide it. */
const LEGACY_OWN_SOURCE = 'beep';
/** The source of a conversation (OWN_SOURCE for one made here). */
export const sourceOf = (s: Pick<ListedSession, 'source'>): string => s.source ?? OWN_SOURCE;

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  [OWN_SOURCE]: 'Klatchly',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  whatsapp_cloud: 'WhatsApp',
  discord: 'Discord',
  slack: 'Slack',
  signal: 'Signal',
  matrix: 'Matrix',
  mattermost: 'Mattermost',
  email: 'E-mail',
  sms: 'SMS',
  bluebubbles: 'iMessage',
  weixin: 'WeChat',
  feishu: 'Feishu',
  dingtalk: 'DingTalk',
  qqbot: 'QQ',
};
/** A source's shown name ("cli": the caller's word for the terminal). Unknown: the name, capitalised. */
export function sourceLabel(source: string, cli = 'Terminal'): string {
  if (source === 'cli') return cli;
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1).replace(/_/g, ' ');
}

// ── The filter ───────────────────────────────────────────────────────────────

export interface ListFilter {
  /** Only this agent's conversations (null: every agent). */
  agent: string | null;
  /** Sources not shown (by default DEFAULT_HIDE). */
  hide: string[];
  /** Only conversations with something unread (the open one stays). */
  unread: boolean;
}
/** Sources hidden until the filter shows them: the terminal's (decision of 2026-11-12). */
export const DEFAULT_HIDE: readonly string[] = ['cli'];
export const defaultFilter = (): ListFilter => ({ agent: null, hide: [...DEFAULT_HIDE], unread: false });

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** The stored filter (JSON; before agents 3.1 an agent id alone), or the default. */
export function parseFilter(raw: string | null): ListFilter {
  if (!raw) return defaultFilter();
  if (NAME.test(raw)) return { ...defaultFilter(), agent: raw };
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof ListFilter, unknown>>;
    return {
      agent: typeof o.agent === 'string' && NAME.test(o.agent) ? o.agent : null,
      hide: Array.isArray(o.hide)
        ? [...new Set(o.hide.filter((x): x is string => typeof x === 'string' && NAME.test(x)).map((x) => (x === LEGACY_OWN_SOURCE ? OWN_SOURCE : x)))].slice(0, 32)
        : [...DEFAULT_HIDE],
      unread: o.unread === true,
    };
  } catch {
    return defaultFilter();
  }
}

/** Sources present in the list, Klatchly first, then by name. */
export function presentSources(sessions: readonly ListedSession[]): string[] {
  const set = new Set(sessions.map(sourceOf));
  return [...set].sort((a, b) => (a === OWN_SOURCE ? -1 : b === OWN_SOURCE ? 1 : a.localeCompare(b)));
}

/** How many choices differ from the default (the Filter button's count): agent, sources, unread only. */
export function activeFilterCount(f: ListFilter, present: readonly string[]): number {
  const hidden = (s: string, h: readonly string[]) => h.includes(s);
  const sourcesChanged = present.some((s) => hidden(s, f.hide) !== hidden(s, DEFAULT_HIDE));
  return (f.agent ? 1 : 0) + (sourcesChanged ? 1 : 0) + (f.unread ? 1 : 0);
}

/** Lower case, no accents: the search's comparison. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The conversations the list shows: the filter's agent, its sources, unread only (the open one `keep` stays), and
 * the search words, each found in the title, preview, agent or source name.
 */
export function applyFilter<S extends ListedSession>(sessions: readonly S[], f: ListFilter, query: string, names: { agent: (id: string) => string; source: (s: string) => string }, keep?: string): S[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return sessions.filter((s) => {
    if (f.agent && s.agent !== f.agent) return false;
    if (f.hide.includes(sourceOf(s))) return false;
    if (f.unread && !(s.unread > 0) && s.id !== keep) return false;
    if (!words.length) return true;
    const hay = fold([s.title ?? '', s.preview ?? '', names.agent(s.agent), names.source(sourceOf(s))].join(' '));
    return words.every((w) => hay.includes(w));
  });
}
