import type { BrowserFrame } from './broadcast.js';
import type { Upstream } from './ranges.js';

// The connector contract: a chat source (a package such as ext/beeper; each owns its chats and accounts by their
// ids, none is privileged). The core keeps the public API (/api/chats/*, /api/media, /api/thumb, /api/upload…), its validation, limits and
// headers, and asks the connector that owns a chat (sources.ts) for the data. Everything crosses in the
// canonical model below: the Desktop API's shapes, which the client already speaks (client/src/types.ts); a
// connector converts its own. Methods throw on failure: a ConnectorError says what to answer, any other error is
// mapped by the connector's `failure` (else 502).

// ── Canonical model (loose on the server: what the core reads is typed, the rest passes through) ──

export interface Participant {
  id: string;
  fullName?: string;
  isSelf?: boolean;
  [k: string]: unknown;
}

export interface Attachment {
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
  [k: string]: unknown;
}

export interface Message {
  id: string;
  chatID: string;
  senderID?: string;
  senderName?: string;
  timestamp?: string;
  sortKey?: string;
  type?: string;
  text?: string | null;
  isSender?: boolean;
  isDeleted?: boolean;
  isHidden?: boolean;
  editedTimestamp?: string;
  attachments?: Attachment[] | null;
  [k: string]: unknown;
}

export interface Chat {
  id: string;
  accountID?: string;
  network?: string;
  title?: string;
  type?: string;
  unreadCount?: number;
  isPinned?: boolean;
  isMuted?: boolean;
  isArchived?: boolean;
  isLowPriority?: boolean;
  isReadOnly?: boolean;
  lastActivity?: string;
  participants?: { items?: Participant[]; hasMore?: boolean; total?: number };
  /** What the network allows in this chat (attachments, text length, reactions…), as the client reads it. */
  capabilities?: Record<string, unknown> | null;
  [k: string]: unknown;
}

/** How an account's connection stands (Desktop API Account.status). */
export type AccountStatus =
  | 'connected'
  | 'connecting'
  | 'backfilling'
  | 'connection_required'
  | 'reconnect_required'
  | 'attention_required'
  | 'disconnected'
  | 'disabled';

export interface Account {
  accountID: string;
  network?: string;
  /** Its connection, when the source tells (an accounts page reads it; absent: unknown). */
  status?: AccountStatus;
  /** The source's own words about the status. */
  statusText?: string;
  /** What carries it (Desktop API AccountBridge): its type ('whatsapp') and where it runs ('cloud', 'local'…). */
  bridge?: { id?: string; type?: string; provider?: string; [k: string]: unknown };
  /** The account's own identity on its network. */
  user?: { id?: string; fullName?: string; username?: string; phoneNumber?: string; email?: string; [k: string]: unknown };
  /** What the network allows (Desktop API Account.capabilities: chat and message features), as given. */
  capabilities?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  oldestCursor: string | null;
  newestCursor: string | null;
  [k: string]: unknown;
}

/** Paging of a list (validated by the core: cursor ≤ 512 characters, limit 1–200). */
export interface PageQuery {
  cursor?: string;
  direction?: 'before' | 'after';
  limit?: number;
}

export interface ChatListQuery extends PageQuery {
  /** Only these accounts (the network filter); absent: all of the source's. */
  accountIDs?: string[];
}

export interface ChatSearchQuery extends ChatListQuery {
  query?: string;
  inbox?: 'primary' | 'low-priority' | 'archive';
}

export interface MessageSearchQuery extends ChatListQuery {
  query: string;
  chatIDs?: string[];
}

/** A file sent with a message: an upload of the same source (POST /api/upload), validated by the core. */
export interface OutgoingAttachment {
  uploadID: string;
  mimeType?: string;
  fileName?: string;
  size?: { width: number; height: number };
  duration?: number;
  type?: 'image' | 'video' | 'audio' | 'file' | 'gif' | 'voice-note' | 'sticker';
}

export interface Outgoing {
  text?: string;
  replyToMessageID?: string;
  attachment?: OutgoingAttachment;
}

export type ChatFlag = 'isPinned' | 'isMuted' | 'isLowPriority';

/** The answer to an upload, as the browser gets it: 200 with what it needs to send the file, or an error. */
export type UploadOutcome = { status: number; body: Record<string, unknown> };

/** What an account allows when starting a conversation (GET /api/accounts/:id/new-chat). */
export interface NewChatCaps {
  accountID: string;
  network: string;
  connected: boolean;
  /** Direct chats can be started (chats/start). */
  start: boolean;
  /** Exact lookups the network runs on a contact search. */
  lookup: { phone: boolean; email: boolean; username: boolean };
  contactList: boolean;
  /** Group creation, when the network documents it. */
  group: null | { nameAllowed: boolean; nameRequired: boolean; nameMax: number; min: number; max: number };
  /** Only people with an existing conversation (nothing is created). */
  existingOnly?: boolean;
}

/** POST /api/chats/start, checked by the core (newchat.ts parseStart): someone identified by one of these. */
export interface StartUser {
  id?: string;
  username?: string;
  phoneNumber?: string;
  email?: string;
  fullName?: string;
}
export interface StartBody {
  accountID: string;
  user: StartUser;
}
/** POST /api/chats, checked by the core against the account's NewChatCaps. */
export interface CreateBody {
  accountID: string;
  type: 'single' | 'group';
  participantIDs: string[];
  title?: string;
}

/** A tab of a chat's "Media, links and files" page. */
export type MediaTab = 'media' | 'files' | 'links';

/**
 * One of a source's media, named by request parameters it validated: `key` identifies the bytes for good (the
 * thumbnail cache is keyed by it: content-addressed sources only), `original` is its own relay URL (a
 * thumbnail that cannot be made redirects there), `kind` a short label for logs.
 */
export interface MediaRef {
  kind: string;
  key: string;
  original: string;
}

// ── What flows from a connector into the core ──

/**
 * A source's events (ModuleContext.feed.event). The core fans them out: unread counts for the badge, push
 * notifications (with their suppression rules), and the 'events' augmentations' stream (message upserts,
 * projected, with the source's id).
 */
export type SourceEvent =
  /**
   * Connected (again): the core recounts the badge from unreadChats() now, unless its last recount is less than 5
   * minutes old (a socket that keeps dropping does not page through every chat each time), then every 5 minutes.
   */
  | { type: 'ready' }
  /** Disconnected: no recount until the next 'ready'. */
  | { type: 'closed' }
  | { type: 'chat.upserted'; entries: Chat[] }
  | { type: 'message.upserted'; entries: Message[] };

/** Frame types a connector may send to the browsers (ModuleContext.feed.toBrowsers, the per-browser live feed). */
export const SOURCE_FRAMES: ReadonlySet<string> = new Set([
  'ready',
  'subscriptions.updated',
  'chat.upserted',
  'chat.deleted',
  'message.upserted',
  'message.deleted',
  'message.delivered',
  'error',
]);

export interface SourceFeed {
  event(ev: SourceEvent): void;
  /** A frame for every open browser socket, of a SOURCE_FRAMES type (else dropped and logged). */
  toBrowsers(frame: BrowserFrame): void;
}

/**
 * One browser socket's live feed from a source that keeps one per browser (the Desktop API's WebSocket, with its
 * per-socket chat subscriptions). Frames go to `sink.frame` as JSON text; the core forwards only SOURCE_FRAMES
 * types. `sink.closed` when the source side ends (the core then closes the browser socket).
 */
export interface LiveSession {
  /** The chats whose message events this browser wants ('*': all), checked by the core (ws.ts). */
  subscribe(chatIDs: string[]): void;
  /**
   * Keepalive, every 25 s: false when the source counts as gone (the core drops the socket). Tolerate one late answer
   * (the Beeper connector: false after two pings in a row left unanswered): each drop costs the browser a reconnect.
   */
  ping(): boolean;
  close(): void;
}
export interface LiveSink {
  frame(text: string): void;
  closed(): void;
}

/** How a source's error is answered: a status safe for the browser (never 401/403) and a machine-readable code. */
export interface Failure {
  status: 400 | 404 | 409 | 413 | 422 | 429 | 502 | 504;
  code?: string;
}

/** An answer a connector chooses (e.g. 409 forbidden_message): the browser gets {error: code} with the status. */
export class ConnectorError extends Error {
  constructor(
    readonly status: Failure['status'],
    readonly code: string,
  ) {
    super(code);
    this.name = 'ConnectorError';
  }
}

/**
 * How reading a chat reaches its network (ConnectorShape.receipts, API 1.5). "Discreet reading" clears the unread
 * state in Klatchly (lists, badge, notifications) without telling the sender; the explicit "Mark as read" tells them.
 * With it, the core reads through these instead of markRead: readQuietly for an account that reads discreetly,
 * send otherwise (and for "Mark as read"); markRead stays the read of a connector that declares nothing.
 */
export interface ReceiptSupport {
  /** Clears the chat's unread state in Klatchly and tells the network nothing. */
  readQuietly(chatID: string): Promise<void>;
  /**
   * Marks the chat read and tells the network (its read receipt), up to a message when given. Absent: the network
   * cannot be told from Klatchly (reads are quiet whatever the setting; "Mark as read" is not offered). A ConnectorError
   * whose code starts with `receipt_` (receipt_unavailable: the network refuses it for now; receipt_skipped: nothing
   * could be sent) leaves the chat read in Klatchly: a read that was not "Mark as read" then counts as a quiet one.
   */
  send?(chatID: string, messageID?: string): Promise<void>;
  /** false while the network refuses Klatchly's receipts (learnt from a refusal): reads stay quiet, Settings says so. Absent: true. */
  sendAvailable?(): boolean;
  /**
   * Replying may tell the sender the chat was read whatever Klatchly does (a bridge's implicit receipt on send): the
   * composer says so once per chat that reads discreetly.
   */
  replyMayTell?: boolean;
  /**
   * Replying always tells: it marks every earlier message of the other side seen (the source does it on purpose, as
   * the network's own apps do). The composer and Settings say it as certain, not "may"; implies replyMayTell. (1.7.0)
   */
  replyTells?: boolean;
  /**
   * "Mark all read" for the low-priority inbox (ConnectorShape.readAllLowPriority) that keeps discreet accounts
   * quiet: `quiet(accountID)` says which (an unknown account: the core answers for its source, fail closed).
   * Absent: readAllLowPriority, and every chat it marks tells its network.
   */
  readAllLowPriority?(onRead: (chatID: string) => void, quiet: (accountID: string | undefined) => boolean): Promise<{ total: number; read: string[]; failed: number; complete: boolean }>;
  /**
   * The same, asked chat by chat (API 1.6): `quiet(chatID, accountID)` also honours a chat's own choice (its menu),
   * which wins over its account's. Preferred over readAllLowPriority when both are there.
   */
  readAllLowPriorityByChat?(
    onRead: (chatID: string) => void,
    quiet: (chatID: string, accountID: string | undefined) => boolean,
  ): Promise<{ total: number; read: string[]; failed: number; complete: boolean }>;
  /**
   * Discreet reading is on for its accounts until the user says otherwise (a source that never told the network
   * before: the setting keeps what it did). Absent: off.
   */
  byDefault?: boolean;
  /** What discreet reading covers here, by language code (fr, en): shown in Settings. */
  note?: Readonly<Record<string, string>>;
}

/** A session's sign-in QR code (ConnectorShape.loginQR). */
export interface LoginQR {
  status: 'generating' | 'waiting' | 'scanned' | 'logged_in' | 'expired' | 'declined' | 'none';
  /** The QR code, a PNG in base64 (no data: prefix), while it waits to be scanned. */
  image?: string;
}

/** What the core and the 'events' augmentations may do in a source's chats, beyond the methods it has. */
export interface ConnectorCapabilities {
  /** 'events' augmentations may send in its chats in the user's name (ChatActor.canSend / send). */
  actorSend: boolean;
  /** Chat flags PATCH /api/chats/:id may change (pin, mute, low priority); any other is answered 409. */
  flags: readonly ChatFlag[];
}

/**
 * The connector module (registry.ts ServerModule). Required: what every source has (its chats, messages, sends,
 * reads, its accounts and unread counts). Optional: what a source may lack; the core answers 409 unsupported
 * for it. Everything a method gets was validated by the core; what it returns is canonical.
 */
export interface ConnectorShape {
  /**
   * Whether a chat id is this source's (ids never overlap between sources). Every connector declares it. Absent
   * (legacy, deprecated since 1.25; at most one per build): it gets the chat ids no other connector claims, for chat
   * routing only; nothing else (unscoped routes, start rule) goes to a connector for lacking it.
   */
  owns?(chatID: string): boolean;
  /**
   * Whether an account id is this source's (the network filter, new chats, contacts, per-account settings): stable
   * while its upstream is down (e.g. the accounts it listed, kept on disk). Every connector declares it. Absent
   * (legacy, deprecated since 1.25): it gets the account ids no other connector claims.
   */
  ownsAccount?(accountID: string): boolean;
  /**
   * Whether it has not learned its accounts yet (e.g. a connector whose `ownsAccount` is the accounts it listed, on
   * its first start, before its upstream has listed them): meanwhile, account ids that no connector claims are its
   * own, as for a connector without `ownsAccount`, so that a network filter or a per-account setting on one of them
   * still reaches it. Absent: never. (1.25.0)
   */
  accountsPending?(): boolean;
  capabilities: ConnectorCapabilities;
  /** Maps one of its own errors (an upstream client's) to an answer; undefined: 502. */
  failure?(e: unknown): Failure | undefined;

  /** Its accounts (networks), for the network filter and new chats. */
  accounts(): Promise<Account[]>;
  /**
   * Its accounts as an accounts page shows them: with their status (Account.status), including one it cannot use
   * yet (still loading, signed out). Absent: accounts(), with the status it gives, if any.
   */
  accountStatus?(): Promise<Account[]>;
  /**
   * What tells the user how to reconnect one of its accounts, by language code (a sentence: where its session lives,
   * e.g. a bridge on the server), for an accounts page; Klatchly reconnects nothing. Absent: its package's name is used.
   */
  reconnectHint?: Readonly<Record<string, string>>;
  /**
   * The QR code that signs its session in again, scanned with the network's phone app (a session that lives in a
   * bridge on the server), for an accounts page: its state, and the picture while one waits to be scanned. Absent:
   * it has none. (1.10.0)
   */
  loginQR?(): Promise<LoginQR>;
  /** A page of the chat list, newest activity first (GET /api/chats). */
  listChats(q: ChatListQuery): Promise<Page<Chat>>;
  /** Chats by text or inbox (GET /api/chats/search). */
  searchChats(q: ChatSearchQuery): Promise<Page<Chat>>;
  /** Messages by text (GET /api/messages/search); `chats` describes the chats of the results. */
  searchMessages(q: MessageSearchQuery): Promise<Page<Message> & { chats?: Record<string, Chat> }>;
  /** One chat, with up to `maxParticipants` participants (0 to 500). */
  chat(chatID: string, maxParticipants: number): Promise<Chat>;
  /** A page of a chat's messages, newest first; no cursor: the latest page. */
  messages(chatID: string, q: PageQuery): Promise<Page<Message>>;
  /** One message of a chat (a ConnectorError 404 or the source's own error when it has none by that id). */
  message(chatID: string, messageID: string): Promise<Message>;
  send(chatID: string, m: Outgoing): Promise<{ chatID: string; pendingMessageID: string }>;
  /** Marks a chat read (up to a message when given). */
  markRead(chatID: string, messageID?: string): Promise<void>;
  /**
   * Reads that may stay unseen by the sender, and the read receipt on demand (API 1.5). Absent: reading is markRead,
   * whatever it tells the network; its accounts cannot read discreetly (Settings says so).
   */
  receipts?: ReceiptSupport;
  /**
   * Every chat with its unread count and flags (muted, archived, low priority), for the app icon badge and the
   * figures of an accounts page (ModuleContext.chatSources). Both ask it: a source whose list is costly to read may
   * share one read between them for a short while (the Beeper connector: a minute, kept current by its chat upserts
   * and read again after a change made through it).
   */
  unreadChats(): Promise<Chat[]>;

  /** Edits one of the user's own text messages (refuses others with a ConnectorError 409 forbidden_message). */
  edit?(chatID: string, messageID: string, text: string): Promise<void>;
  /** Deletes one of the user's own messages (same refusal as edit). */
  /** `forEveryone`: as the browser said it (?forEveryone=true / false); undefined when it did not say. */
  deleteMessage?(chatID: string, messageID: string, forEveryone: boolean | undefined): Promise<void>;
  react?(chatID: string, messageID: string, key: string): Promise<void>;
  unreact?(chatID: string, messageID: string, key: string): Promise<void>;
  /**
   * Whether a reaction key longer than the core's 64 characters (up to 255, no whitespace or control characters) is
   * one of its own, e.g. an image reaction's media URI. Absent: refused (400). (1.25.0)
   */
  longReactionKey?(key: string): boolean;
  archive?(chatID: string, archived: boolean): Promise<void>;
  /**
   * Changes chat flags (only those of capabilities.flags; isLowPriority always alone). Returns the chat and the
   * flags actually set (a move to low priority may mute too), which the badge takes at once.
   */
  update?(chatID: string, patch: Partial<Record<ChatFlag, boolean>>): Promise<{ chat: Chat; applied: Partial<Record<ChatFlag, boolean>> }>;
  /**
   * Marks every unread low-priority chat read (not only the pages a browser loaded): the ids it marked. `onRead`
   * as each one is marked (the badge follows at once). POST /api/inbox/low-priority/read-all asks every connector on
   * that has it (or its receipts' version), one after the other, and adds up their answers.
   */
  readAllLowPriority?(onRead?: (chatID: string) => void): Promise<{ total: number; read: string[]; failed: number; complete: boolean }>;
  /**
   * A page of a chat's messages for one tab of its media page, newest first: those `keep` accepts (the core's
   * filter), enough for a page (about 40), and where to go on.
   */
  mediaMessages?(chatID: string, tab: MediaTab, cursor: string | undefined, keep: (m: Message) => boolean): Promise<{ items: Message[]; hasMore: boolean; cursor: string | null }>;
  /**
   * Streams a file into the source's uploads: a body of `size` bytes at most (the core's cap), cut by the core
   * beyond that. Its uploadIDs are good for its own sends only (the core refuses them elsewhere). An upload without a
   * chat (POST /api/upload, no chatID) goes to the one connector on that has this method; with several, the browser
   * must name the chat (400 chat_required); with none, 409 unsupported.
   */
  upload?(file: { body: ReadableStream<Uint8Array>; size: number; name?: string; mime?: string }, signal: AbortSignal): Promise<UploadOutcome>;
  /**
   * As `upload`, for one chat (POST /api/upload?chatID=, a forward to it): the connector may bind the upload to
   * that chat and refuse it for another's send. Preferred over `upload` when there is a chat; a connector with
   * only this one takes no upload without a chat.
   */
  uploadFor?(chatID: string, file: { body: ReadableStream<Uint8Array>; size: number; name?: string; mime?: string }, signal: AbortSignal): Promise<UploadOutcome>;
  /** Its media, relayed by /api/media and made into thumbnails by /api/thumb. */
  media?: {
    /** The request parameters that name one of its media (thumbnails must carry exactly these). */
    params: readonly string[];
    /** The media those parameters name, validated; null when they name none of its own. */
    parse(query: Record<string, string>): MediaRef | null;
    /**
     * Its bytes. `headers`: the browser's Range / If-Range / If-None-Match (lower case), to forward; none for a
     * thumbnail's original. Status and headers as the source gave them (the core picks what goes on).
     */
    fetch(ref: MediaRef, headers: Record<string, string>, signal: AbortSignal): Promise<Upstream>;
  };
  /** How to read an attachment of one of its messages (forwarding), or undefined when it cannot be read. */
  attachmentSource?(m: Message, a: Attachment): ((signal: AbortSignal) => Promise<Upstream>) | undefined;
  /** Starting conversations on its accounts. */
  newChat?: {
    /** What the account allows; null when it has no such account. */
    caps(accountID: string): Promise<NewChatCaps | null>;
    /**
     * People found by a text (the core keeps only the documented fields: newchat.ts Contact; since 1.11.0 also
     * `inChats`, one already talks with them, and `chatID`, their direct chat, which the client opens instead of
     * starting one).
     */
    searchContacts(accountID: string, query: string): Promise<unknown[]>;
    /** A page of the account's contacts. */
    listContacts(accountID: string, cursor: string | undefined): Promise<{ items?: unknown; hasMore?: unknown; oldestCursor?: unknown }>;
    /** A direct chat (an existing one reused); the core checked caps.start. */
    start(body: StartBody): Promise<Record<string, unknown>>;
    /** A group or a direct chat, within the account's caps (checked by the core). */
    create(body: CreateBody): Promise<Record<string, unknown>>;
  };
  /** A live feed per browser socket (see LiveSession); without it, its browser frames go through feed.toBrowsers. */
  openLive?(sink: LiveSink): LiveSession;
  /**
   * Paths of its own routes that relay media (/api/<id>/<name>, and /api/<id>/<name>/<file>): they set the media
   * headers themselves (sdk mediaSecurityHeaders), so the core leaves its page headers off them, as off /api/media.
   * For media whose URLs a source already gives as its own paths (its routes), next to `media`.
   */
  mediaRoutes?: readonly string[];
}
