import { log } from './log.js';
import type { Account, AccountStatus, Chat, LoginQR } from './connector.js';
import type { ConnectorModule } from './registry.js';
import { ms } from './merge.js';
import { connectorForAccount, connectors, failureOf, from } from './sources.js';

// What a space that shows the user's accounts (ext/accounts) reads of the chat sources: every connector's accounts
// with their status, every chat's figures (unread count, flags), an account's latest chats. Handed out by the
// registry to the spaces that declare it (ServerSpace.chatSources), bound to their package: every call is logged
// with its id and counts, never with names, numbers or ids. Read-only and content-free: no message, no preview,
// no avatar, no user id; nothing here sends or changes anything. Only the connectors that are on are asked.

/** An account as the space reads it: the declared fields of the connector's Account, checked. */
export interface SourceAccount {
  /** The connector it comes from (its module id). */
  source: string;
  accountID: string;
  network?: string;
  /** Absent when the source does not say. */
  status?: AccountStatus;
  statusText?: string;
  bridge?: { type?: string; provider?: string };
  /** The account's own name and handles (shown to the signed-in user; never logged). */
  user: { fullName?: string; username?: string; phoneNumber?: string; email?: string };
  /** What the network allows (chat and message features), as the source gives it. */
  capabilities?: Readonly<Record<string, unknown>>;
}

/** A chat as the space reads it: its account, title, type, time and flags. No message content. */
export interface SourceChat {
  id: string;
  accountID: string;
  title?: string;
  type?: string;
  lastActivity?: string;
  unreadCount?: number;
  isMarkedUnread?: boolean;
  isArchived?: boolean;
  isLowPriority?: boolean;
  isMuted?: boolean;
  /** Nothing can be sent there (an announcement channel, a group left). Since API 1.24. */
  isReadOnly?: boolean;
}

/** A connector that was asked: its id, its package's name (Settings), its reconnect hint, and whether it answered. */
export interface SourceInfo {
  id: string;
  name?: Readonly<Record<string, string>>;
  /** ConnectorShape.reconnectHint, when it has one. */
  hint?: Readonly<Record<string, string>>;
  /** It can show a sign-in QR code (ConnectorShape.loginQR, ChatSources.loginQR). (1.10.0) */
  qr?: boolean;
  ok: boolean;
}

export interface ChatSources {
  /** Every account of every connector that is on (one that fails is left out: `ok` false). Throws when all fail. */
  accounts(): Promise<{ accounts: SourceAccount[]; sources: SourceInfo[] }>;
  /**
   * Every chat of every connector that is on, CHATS_MAX a source at most. `complete` false when a source gave
   * CHATS_MAX or more (exactly CHATS_MAX may be all of them: the figures may then be higher, not are). Throws when
   * all fail.
   */
  chats(): Promise<{ chats: SourceChat[]; complete: boolean; sources: SourceInfo[] }>;
  /**
   * A connector's sign-in QR code (by its id), checked: a known state, and the picture only as a bounded PNG in
   * base64. Null when it has none. Throws its errors. (1.10.0)
   */
  loginQR(sourceID: string): Promise<LoginQR | null>;
  /**
   * The latest chats of an account, newest activity first (its connector's chat list, whatever order or length the
   * connector gives, sorted here; at most `limit`, 1 to 50). Throws upstream errors.
   */
  recentChats(accountID: string, limit: number): Promise<SourceChat[]>;
}

/** Chats counted at most per source (like the badge's seeding): past this, figures are lower bounds. */
export const CHATS_MAX = 5000;

const STATUSES = new Set<string>(['connected', 'connecting', 'backfilling', 'connection_required', 'reconnect_required', 'attention_required', 'disconnected', 'disabled']);
const USER = ['fullName', 'username', 'phoneNumber', 'email'] as const;
const CHAT_STRINGS = ['title', 'type', 'lastActivity'] as const;
const CHAT_FLAGS = ['isMarkedUnread', 'isArchived', 'isLowPriority', 'isMuted', 'isReadOnly'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

/** The declared fields of a connector's account; null without an account id. */
export function projectAccount(raw: Account | unknown, source: string): SourceAccount | null {
  if (!isObj(raw)) return null;
  const accountID = str(raw.accountID, 200);
  if (!accountID) return null;
  const out: SourceAccount = { source, accountID, user: {} };
  const network = str(raw.network, 100);
  if (network) out.network = network;
  if (typeof raw.status === 'string' && STATUSES.has(raw.status)) out.status = raw.status as AccountStatus;
  const statusText = str(raw.statusText, 1000);
  if (statusText) out.statusText = statusText;
  if (isObj(raw.bridge)) {
    const type = str(raw.bridge.type, 100);
    const provider = str(raw.bridge.provider, 40);
    if (type || provider) out.bridge = { ...(type ? { type } : {}), ...(provider ? { provider } : {}) };
  }
  if (isObj(raw.user)) for (const k of USER) if (str(raw.user[k], 300)) out.user[k] = raw.user[k] as string;
  if (isObj(raw.capabilities) && Object.keys(raw.capabilities).length) out.capabilities = raw.capabilities;
  return out;
}

/** The declared fields of a connector's chat; null without a chat id and an account id. */
export function projectChat(raw: Chat | unknown): SourceChat | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 512);
  const accountID = str(raw.accountID, 200);
  if (!id || !accountID) return null;
  const out: SourceChat = { id, accountID };
  for (const k of CHAT_STRINGS) if (str(raw[k], 500)) out[k] = raw[k] as string;
  if (typeof raw.unreadCount === 'number' && Number.isFinite(raw.unreadCount)) out.unreadCount = raw.unreadCount;
  for (const k of CHAT_FLAGS) if (typeof raw[k] === 'boolean') out[k] = raw[k] as boolean;
  return out;
}

/**
 * Asks every connector that is on, together: what each answered, and which did not (logged with their answer's
 * status). All failing: the first failure, tagged with its connector (the route's answer asks that one).
 */
async function everyConnector<T>(what: string, call: (k: ConnectorModule) => Promise<T>, nameOf: (k: ConnectorModule) => SourceInfo['name']) {
  const list = connectors();
  const got = await Promise.allSettled(list.map((k) => from(k, () => call(k))));
  const sources: SourceInfo[] = list.map((k, i) => ({
    id: k.id,
    ...(nameOf(k) ? { name: nameOf(k) } : {}),
    ...(k.reconnectHint ? { hint: k.reconnectHint } : {}),
    ...(k.loginQR ? { qr: true } : {}),
    ok: got[i]!.status === 'fulfilled',
  }));
  got.forEach((r, i) => {
    if (r.status === 'rejected') log('chatsources', `${what} failed`, { id: list[i]!.id, status: failureOf(r.reason, list[i]).status });
  });
  const bad = got.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (bad && sources.every((s) => !s.ok)) throw bad.reason;
  const answers = got.flatMap((r, i) => (r.status === 'fulfilled' ? [{ k: list[i]!, v: r.value }] : []));
  return { answers, sources };
}

const QR_STATES: readonly LoginQR['status'][] = ['generating', 'waiting', 'scanned', 'logged_in', 'expired', 'declined', 'none'];
const QR_MAX = 400_000;

/** A connector's QR answer, checked: a known state; the picture only as a PNG in base64 of bounded size. */
export function checkQR(q: unknown): LoginQR {
  const src = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
  const status = QR_STATES.find((x) => x === src.status) ?? 'none';
  const img = src.image;
  const png = typeof img === 'string' && img.length <= QR_MAX && img.startsWith('iVBORw0KGgo') && /^[A-Za-z0-9+/]+={0,2}$/.test(img);
  return { status, ...(png && status === 'waiting' ? { image: img } : {}) };
}

/**
 * The capability of one package's space. `active`: whether the package is on (a call after it went off reads
 * nothing). `nameOf`: a connector's package name.
 */
export function chatSources(pkg: string, active: () => boolean, nameOf: (k: ConnectorModule) => SourceInfo['name']): ChatSources {
  return {
    async accounts() {
      if (!active()) return { accounts: [], sources: [] };
      const { answers, sources } = await everyConnector('accounts', (k) => (k.accountStatus ? k.accountStatus() : k.accounts()), nameOf);
      const accounts = answers.flatMap(({ k, v }) => (Array.isArray(v) ? v : []).flatMap((a) => projectAccount(a, k.id) ?? []));
      log('chatsources', 'accounts', { pkg, count: accounts.length });
      return { accounts, sources };
    },
    async chats() {
      if (!active()) return { chats: [], complete: true, sources: [] };
      const { answers, sources } = await everyConnector('chats', (k) => k.unreadChats(), nameOf);
      let complete = true;
      const chats = answers.flatMap(({ v }) => {
        const list = Array.isArray(v) ? v : [];
        if (list.length >= CHATS_MAX) complete = false;
        return list.slice(0, CHATS_MAX).flatMap((c) => projectChat(c) ?? []);
      });
      log('chatsources', 'chats', { pkg, count: chats.length });
      return { chats, complete, sources };
    },
    async loginQR(sourceID) {
      if (!active()) return null;
      const k = connectors().find((x) => x.id === sourceID);
      if (!k?.loginQR) return null;
      const q = await from(k, () => k.loginQR!());
      log('chatsources', 'login qr', { pkg, id: k.id, status: q?.status });
      return checkQR(q);
    },
    async recentChats(accountID, limit) {
      if (!active()) return [];
      const k = connectorForAccount(accountID);
      if (!k) return [];
      const n = Math.max(1, Math.min(50, Math.floor(limit) || 1));
      const page = await from(k, () => k.listChats({ accountIDs: [accountID], limit: n }));
      const chats = (page.items ?? [])
        .flatMap((c) => projectChat(c) ?? [])
        .filter((c) => c.accountID === accountID)
        .sort((a, b) => ms(b.lastActivity) - ms(a.lastActivity))
        .slice(0, n);
      log('chatsources', 'recent', { pkg, count: chats.length });
      return chats;
    },
  };
}
