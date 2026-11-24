// The shapes the accounts package's two halves exchange, and what its dashboard reads of the chat sources
// (AccountsSource: server/source.ts, on the core's ModuleContext.chatSources). Types only. Not a public entry
// (api.ts): no other package uses it.

/** Desktop API Account.status (the connector contract's AccountStatus), and 'unknown' when a source does not say. */
export type AccountStatus =
  | 'connected'
  | 'connecting'
  | 'backfilling'
  | 'connection_required'
  | 'reconnect_required'
  | 'attention_required'
  | 'disconnected'
  | 'disabled'
  | 'unknown';

/** What the dashboard makes of a status: fine, on its way, needs the user, turned off. */
export type Health = 'ok' | 'busy' | 'trouble' | 'off';

/** Where an account runs (Desktop API AccountBridge.provider), when known. */
export type BridgeProvider = 'cloud' | 'self-hosted' | 'local' | 'platform-sdk';

/** An account as a source lists it, cleaned: no avatar URL, no user id, nothing but what the dashboard shows. */
export interface SourceAccount {
  accountID: string;
  /** The connector it comes from (its id): where the dashboard says to reconnect it (SourceName). */
  source: string;
  /** Network name as the source gives it ('WhatsApp'); the bridge type when it gives none. */
  network: string;
  bridge?: { type: string; provider?: BridgeProvider };
  /** The account's own identity. Phone numbers and emails: shown to the signed-in user only, never logged. */
  user: { fullName?: string; username?: string; phoneNumber?: string; email?: string };
  status: AccountStatus;
  /** The source's own words about the status, if any. */
  statusText?: string;
  /** Desktop API Account.capabilities as given (chat and message features); absent when unknown. */
  capabilities?: Readonly<Record<string, unknown>>;
}

/** An account's figures, from the chats the sources list. */
export interface AccountStats {
  chats: number;
  groups: number;
  /** Chats with something unread, and their unread messages. */
  unreadChats: number;
  unreadMessages: number;
  lowPriority: number;
  archived: number;
  muted: number;
  /** Latest activity of any of its chats (ISO), or null. */
  lastActivity: string | null;
}

export interface StatsResult {
  byAccount: Readonly<Record<string, AccountStats>>;
  /** False when the chat list was longer than what is counted (the figures are then lower bounds). */
  complete: boolean;
  /** When they were counted (ISO). */
  at: string;
}

/** A chat in an account's recent list: no message content. */
export interface RecentChat {
  id: string;
  title: string;
  type: 'single' | 'group';
  lastActivity?: string;
  unreadCount: number;
  isArchived: boolean;
  isLowPriority: boolean;
  isMuted: boolean;
}

/** A chat source (a connector that is on): its id, its name and its reconnect hint by language code, whether it answered. */
export interface SourceName {
  id: string;
  name?: Readonly<Record<string, string>>;
  hint?: Readonly<Record<string, string>>;
  /** It can show the QR code that signs its session in again (GET /networks/qr/:source). */
  qr?: boolean;
  ok: boolean;
}

/** A source's sign-in QR code: its state, and the PNG (base64) while it waits to be scanned. */
export interface QrReply {
  status: 'generating' | 'waiting' | 'scanned' | 'logged_in' | 'expired' | 'declined' | 'none';
  image?: string;
}

/** What the dashboard reads of the chat sources (read-only). */
export interface AccountsSource {
  /** Every account of every connector that is on, and those connectors. */
  listAccounts(): Promise<{ accounts: SourceAccount[]; sources: SourceName[] }>;
  /** Figures per account id. */
  accountStats(): Promise<StatsResult>;
  /** The `n` most recently active chats of an account, newest first. */
  recentChats(accountID: string, n: number): Promise<RecentChat[]>;
  /** A source's sign-in QR code (null: it has none). */
  loginQR(sourceID: string): Promise<QrReply | null>;
}

// ── What the server half answers (GET /api/networks/…) ──

/** An account as the dashboard shows it. */
export interface AccountView extends Omit<SourceAccount, 'capabilities'> {
  health: Health;
  /** Since when Klatchly has seen this status (ISO): Klatchly's own observation, the sources give no time. */
  since: string;
}

/** GET /api/networks/overview */
export interface OverviewReply {
  accounts: AccountView[];
  /** How many accounts are in trouble, plus the sources that do not answer (the space's badge). */
  trouble: number;
  /** The connectors asked (one that did not answer: ok false, its accounts missing). */
  sources: SourceName[];
}

/** A feature in plain words: its key (translated by the client), whether the account has it, a limit. */
export interface Capability {
  key: CapabilityKey;
  supported: boolean;
  /** maxTextLength (characters), maximum file size (bytes)… */
  limit?: number;
  /** For 'attachments': the kinds of files it takes. */
  kinds?: AttachmentKind[];
}

export type CapabilityKey =
  | 'reply'
  | 'edit'
  | 'delete'
  | 'reaction'
  | 'thread'
  | 'poll'
  | 'locationMessage'
  | 'readReceipts'
  | 'typingNotifications'
  | 'archive'
  | 'markAsUnread'
  | 'deleteChat'
  | 'disappearingTimer'
  | 'attachments'
  | 'maxTextLength';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'file' | 'sticker' | 'gif';

/** GET /api/networks/account/<slug> */
export interface AccountReply {
  account: AccountView;
  /** Its connector. */
  source?: SourceName;
  stats: AccountStats | null;
  /** Empty when the source reports none (native Beeper chats: no restriction known). */
  capabilities: Capability[];
  recent: RecentChat[];
}
