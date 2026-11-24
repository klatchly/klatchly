import type { SourceAccount as ReadAccount } from '#core/sdk.js';
import type {
  AccountStats,
  AccountStatus,
  AccountView,
  AttachmentKind,
  BridgeProvider,
  Capability,
  CapabilityKey,
  Health,
  RecentChat,
  SourceAccount,
} from '../shapes.js';

// What the dashboard derives from what the sources list, without any I/O: cleaned accounts, their health and
// since when, per-account figures from the chat list, capabilities in plain terms. The core's chatSources
// already keeps only declared fields of the right types; display strings are cleaned here, capabilities read
// field by field.

const PROVIDERS = new Set<BridgeProvider>(['cloud', 'self-hosted', 'local', 'platform-sdk']);
// Desktop API account ids (matrix, slackgo.TEAM-USER, local-whatsapp_ba_…) and other sources' plain ones.
const ACCOUNT_ID = /^[A-Za-z0-9._:@=+-]{1,200}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** A display string: trimmed, control characters out, bounded. */
function text(v: unknown, max = 200): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\p{Cc}/gu, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

/** An account as the core's chatSources gives it (its declared fields, checked), cleaned for display; null for an id it would not show. */
export function cleanAccount(raw: ReadAccount): SourceAccount | null {
  if (!ACCOUNT_ID.test(raw.accountID)) return null;
  const type = text(raw.bridge?.type, 60);
  const provider = PROVIDERS.has(raw.bridge?.provider as BridgeProvider) ? (raw.bridge!.provider as BridgeProvider) : undefined;
  const user: SourceAccount['user'] = {};
  for (const k of ['fullName', 'username', 'phoneNumber', 'email'] as const) {
    const v = text(raw.user[k], 120);
    if (v) user[k] = v;
  }
  const statusText = text(raw.statusText, 300);
  return {
    accountID: raw.accountID,
    source: raw.source,
    network: text(raw.network, 60) ?? type ?? raw.accountID,
    ...(type ? { bridge: { type, ...(provider ? { provider } : {}) } } : {}),
    user,
    status: raw.status ?? 'unknown',
    ...(statusText ? { statusText } : {}),
    ...(raw.capabilities ? { capabilities: raw.capabilities } : {}),
  };
}

/**
 * Past this, an account still connecting is stuck: in trouble. Backfilling may take long and stays busy; a status
 * the source does not give ('unknown') is never trouble.
 */
export const STUCK_MS = 15 * 60_000;

export function healthOf(status: AccountStatus, sinceMs: number, now: number): Health {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'backfilling':
    case 'unknown':
      return 'busy';
    case 'connecting':
      return now - sinceMs > STUCK_MS ? 'trouble' : 'busy';
    case 'disabled':
      return 'off';
    default:
      return 'trouble';
  }
}

/** Per account: the last status seen, since when, when it was last listed, and its source. */
export interface SinceEntry {
  status: AccountStatus;
  since: number;
  seen: number;
  source?: string;
}
export type SinceMap = Record<string, SinceEntry>;

/** An entry no source listed for this long is forgotten, even when its source never answers again. */
export const FORGET_MS = 30 * 24 * 3600_000;

const STATUSES = new Set<AccountStatus>(['connected', 'connecting', 'backfilling', 'connection_required', 'reconnect_required', 'attention_required', 'disconnected', 'disabled', 'unknown']);

/** A map read back from the data volume: entries of the right shape only (anything else is dropped). */
export function parseSince(raw: unknown): SinceMap {
  const out: SinceMap = {};
  const map = isObj(raw) && isObj(raw.since) ? raw.since : {};
  for (const [id, e] of Object.entries(map)) {
    if (!ACCOUNT_ID.test(id) || !isObj(e) || !STATUSES.has(e.status as AccountStatus)) continue;
    if (!Number.isFinite(e.since) || (e.seen !== undefined && !Number.isFinite(e.seen))) continue;
    const since = e.since as number;
    out[id] = { status: e.status as AccountStatus, since, seen: (e.seen as number | undefined) ?? since, ...(typeof e.source === 'string' && e.source.length <= 64 ? { source: e.source } : {}) };
  }
  return out;
}

/**
 * The statuses seen now against the previous map: an unchanged status keeps its time, a new one starts now.
 * Accounts gone from the list are dropped, except those of a source that did not answer (`down`): a source down
 * for a minute does not restart their "since", unless they were not listed for FORGET_MS. `changed`: something to
 * save.
 */
export function trackSince(prev: SinceMap, accounts: readonly SourceAccount[], down: ReadonlySet<string>, now: number): { next: SinceMap; changed: boolean } {
  const next: SinceMap = {};
  let changed = false;
  for (const a of accounts) {
    const p = prev[a.accountID];
    if (p && p.status === a.status && (p.source ?? a.source) === a.source) next[a.accountID] = { ...p, seen: now };
    else {
      next[a.accountID] = { status: a.status, since: now, seen: now, source: a.source };
      changed = true;
    }
  }
  for (const [id, p] of Object.entries(prev)) {
    if (id in next) continue;
    if (p.source && down.has(p.source) && now - p.seen < FORGET_MS) next[id] = p;
    else changed = true;
  }
  // Seen times are saved now and then (with a status change), not on every read.
  return { next, changed };
}

const ORDER: Record<Health, number> = { trouble: 0, busy: 1, ok: 2, off: 3 };

/** The accounts as the dashboard shows them: in trouble first, then by network and name. */
export function viewsOf(accounts: readonly SourceAccount[], since: SinceMap, now: number): AccountView[] {
  return accounts
    .map(({ capabilities: _, ...a }): AccountView => {
      const at = since[a.accountID]?.since ?? now;
      return { ...a, health: healthOf(a.status, at, now), since: new Date(at).toISOString() };
    })
    .sort((x, y) => ORDER[x.health] - ORDER[y.health] || x.network.localeCompare(y.network) || x.accountID.localeCompare(y.accountID));
}

const emptyStats = (): AccountStats => ({ chats: 0, groups: 0, unreadChats: 0, unreadMessages: 0, lowPriority: 0, archived: 0, muted: 0, lastActivity: null });

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 1e6) : 0);
const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);

/** Adds chats (the core's SourceChat: the Desktop API Chat's fields) to the figures of their accounts. */
export function addChats(stats: Record<string, AccountStats>, chats: readonly unknown[]): void {
  for (const c of chats) {
    if (!isObj(c) || typeof c.accountID !== 'string' || typeof c.id !== 'string') continue;
    const s = (stats[c.accountID] ??= emptyStats());
    s.chats++;
    if (c.type === 'group') s.groups++;
    const unread = count(c.unreadCount);
    if (unread || c.isMarkedUnread === true) s.unreadChats++;
    s.unreadMessages += unread;
    // Archived wins over low priority, as in the chat lists.
    if (c.isArchived === true) s.archived++;
    else if (c.isLowPriority === true) s.lowPriority++;
    if (c.isMuted === true) s.muted++;
    const at = iso(c.lastActivity);
    if (at && (!s.lastActivity || at > s.lastActivity)) s.lastActivity = at;
  }
}

/** Chats as an account's recent list (newest first, at most n): ids, titles and flags, no message content. */
export function recentOf(chats: readonly unknown[], n: number): RecentChat[] {
  const out: RecentChat[] = [];
  for (const c of chats) {
    if (!isObj(c) || typeof c.id !== 'string' || c.id.length > 512) continue;
    const at = iso(c.lastActivity);
    out.push({
      id: c.id,
      title: text(c.title, 120) ?? '',
      type: c.type === 'group' ? 'group' : 'single',
      ...(at ? { lastActivity: at } : {}),
      unreadCount: count(c.unreadCount),
      isArchived: c.isArchived === true,
      isLowPriority: c.isLowPriority === true,
      isMuted: c.isMuted === true,
    });
  }
  return out.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '')).slice(0, n);
}

// Chat and message features of Desktop API ChatCapabilities, in the order shown. Levels (CapabilitySupportLevel,
// -2…2) count from 1; booleans as given.
const LEVELS: CapabilityKey[] = ['reply', 'edit', 'delete', 'reaction', 'thread', 'poll', 'locationMessage'];
const FLAGS: CapabilityKey[] = ['readReceipts', 'typingNotifications', 'archive', 'markAsUnread', 'deleteChat'];
const KINDS: Record<string, AttachmentKind> = {
  'm.image': 'image',
  'm.video': 'video',
  'm.audio': 'audio',
  'org.matrix.msc3245.voice': 'voice',
  'm.file': 'file',
  'm.sticker': 'sticker',
  'fi.mau.gif': 'gif',
};

/** An account's capabilities in plain terms; empty when it reports none. */
export function capabilitiesOf(raw: Readonly<Record<string, unknown>> | undefined): Capability[] {
  if (!raw || !Object.keys(raw).length) return [];
  const out: Capability[] = [];
  for (const key of LEVELS) if (typeof raw[key] === 'number') out.push({ key, supported: (raw[key] as number) >= 1 });
  for (const key of FLAGS) if (typeof raw[key] === 'boolean') out.push({ key, supported: raw[key] as boolean });
  if (isObj(raw.disappearingTimer)) {
    const types = raw.disappearingTimer.types;
    out.push({ key: 'disappearingTimer', supported: Array.isArray(types) ? types.length > 0 : true });
  }
  if (isObj(raw.attachments)) {
    const kinds = new Set<AttachmentKind>();
    let max = 0;
    for (const [type, c] of Object.entries(raw.attachments)) {
      const kind = KINDS[type];
      if (!kind || !isObj(c)) continue;
      kinds.add(kind);
      if (typeof c.maxSize === 'number' && c.maxSize > max) max = c.maxSize;
    }
    const order = Object.values(KINDS);
    out.push({ key: 'attachments', supported: kinds.size > 0, kinds: [...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b)), ...(max ? { limit: max } : {}) });
  }
  if (typeof raw.maxTextLength === 'number' && raw.maxTextLength > 0) out.push({ key: 'maxTextLength', supported: true, limit: raw.maxTextLength });
  return out;
}
