import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dataPath, log, type Chat, type ReceiptSupport } from '#core/sdk.js';
import { api } from './upstream.js';

// Discreet reading on Beeper (ConnectorShape.receipts): the Desktop API has one way to mark a chat read, and it
// sends the network's read receipt (POST /v1/chats/{id}/read, no private option). So a discreet read never calls
// it: Klatchly remembers the chat's upstream unread count at that moment (`n`), its last activity (`last`) and whether it
// was marked unread (`marked`), and shows only what came after (upstream count − n, not marked unread) in every chat
// it hands on: lists, searches, one chat, the badge's chats (also the accounts dashboard's figures), the socket's
// chat upserts. Beeper itself (its other apps) still has the chat unread, which is the point: nothing moved there.
// The entry goes with a real read (the explicit "Mark as read", or reading with discreet reading off), and when
// upstream says the chat was read elsewhere: a count below `n`, or a count at most `n` with a new last activity
// (read there, then as many messages again). Kept in beeper-read.json (chat ids, counts, timestamps), written 2 s
// after a change and at stop; 5000 chats at most, the oldest read first out (that chat then shows Beeper's count).

const MAX = 5000;
const SAVE_DELAY_MS = 2000;
const file = () => dataPath('beeper-read.json');

/** What a discreet read hid: the upstream count, the last activity then, and a mark-unread it cleared. */
type Entry = { n: number; last?: string; marked?: true };

let entries: Map<string, Entry> | undefined;
let timer: NodeJS.Timeout | undefined;

function store(): Map<string, Entry> {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { v?: unknown; chats?: unknown };
    if (raw.v === 2 && raw.chats && typeof raw.chats === 'object' && !Array.isArray(raw.chats)) {
      for (const [id, e] of Object.entries(raw.chats as Record<string, unknown>).slice(-MAX)) {
        if (!e || typeof e !== 'object') continue;
        const { n, last, marked } = e as Record<string, unknown>;
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) continue;
        entries.set(id, { n, ...(typeof last === 'string' ? { last } : {}), ...(marked === true ? { marked: true as const } : {}) });
      }
    }
  } catch {
    // first run
  }
  return entries;
}

/** Writes the entries now (the debounced save; stop and tests call it directly). */
export function flushLocalRead(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!entries) return;
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 2, chats: Object.fromEntries(entries) })}\n`, { mode: 0o600 });
    renameSync(tmp, file());
  } catch {
    log('beeper', 'local read write failed');
  }
}

// Told of every change of the entries (inbox.ts: the shared chat scan, read against them, is read again).
const watchers = new Set<() => void>();
/** Calls `fn` whenever a chat is read here or upstream (the entries change). */
export function onLocalReadChange(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function changed(): void {
  for (const w of watchers) w();
  if (timer) return;
  timer = setTimeout(flushLocalRead, SAVE_DELAY_MS);
  timer.unref();
}

/** Forgets the entries in memory (tests: a fresh data file). */
export function resetLocalRead(): void {
  clearTimeout(timer);
  timer = undefined;
  entries = undefined;
}

/** The chat's last activity as upstream gives it (its time, else its last message's id). */
const activityOf = (c: Partial<Chat>): string | undefined => {
  if (typeof c.lastActivity === 'string') return c.lastActivity;
  const id = (c.preview as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
};

/** A discreet read of the chat as upstream has it now: its unread count and mark-unread are what Klatchly no longer shows. */
export function readLocally(chat: Partial<Chat> & { id: string }): void {
  const s = store();
  s.delete(chat.id);
  const n = typeof chat.unreadCount === 'number' && chat.unreadCount > 0 ? chat.unreadCount : 0;
  const marked = chat.isMarkedUnread === true;
  if (n > 0 || marked) {
    const last = activityOf(chat);
    s.set(chat.id, { n, ...(last ? { last } : {}), ...(marked ? { marked: true as const } : {}) });
    if (s.size > MAX) s.delete(s.keys().next().value!);
  }
  changed();
}

/** A real read (the network was told): nothing hidden any more. */
export function readUpstream(chatID: string): void {
  if (store().delete(chatID)) changed();
  else for (const w of watchers) w();
}

/** The chat as Klatchly shows it: without what was read discreetly. Same object when nothing changes. */
export function localChat<T extends Partial<Chat>>(chat: T): T {
  const s = store();
  if (!s.size || typeof chat?.id !== 'string') return chat;
  const e = s.get(chat.id);
  if (!e) return chat;
  const n = typeof chat.unreadCount === 'number' ? chat.unreadCount : undefined;
  if (n !== undefined) {
    const now = activityOf(chat);
    // Read elsewhere (Beeper's own apps): upstream knows better now.
    if (n < e.n || (n <= e.n && e.last && now && now !== e.last)) {
      s.delete(chat.id);
      changed();
      return chat;
    }
  }
  if (n === undefined && !(e.marked && chat.isMarkedUnread === true)) return chat;
  return {
    ...chat,
    ...(n !== undefined ? { unreadCount: n - e.n } : {}),
    ...(e.marked && chat.isMarkedUnread === true ? { isMarkedUnread: false } : {}),
  };
}

export const localChats = <T extends Partial<Chat>>(chats: T[]): T[] => (store().size ? chats.map(localChat) : chats);

/** A page whose items are chats. */
export function localPage<P extends { items?: Chat[] }>(page: P): P {
  return store().size && Array.isArray(page.items) ? { ...page, items: localChats(page.items) } : page;
}

/** A message search's `chats` (by id). */
export function localChatMap<P extends { chats?: Record<string, Chat> }>(page: P): P {
  if (!store().size || !page.chats || typeof page.chats !== 'object') return page;
  return { ...page, chats: Object.fromEntries(Object.entries(page.chats).map(([id, c]) => [id, localChat(c)])) };
}

/** A frame of the Desktop API's socket for a browser: its chat upserts as Klatchly shows them. */
export function localFrame(text: string): string {
  if (!store().size || !text.includes('"chat.upserted"')) return text;
  let ev: { type?: unknown; entries?: unknown };
  try {
    ev = JSON.parse(text) as typeof ev;
  } catch {
    return text;
  }
  if (ev.type !== 'chat.upserted' || !Array.isArray(ev.entries)) return text;
  const list = (ev.entries as Chat[]).map(localChat);
  return list.some((c, i) => c !== (ev.entries as Chat[])[i]) ? JSON.stringify({ ...ev, entries: list }) : text;
}

/**
 * The connector's receipts: a quiet read remembers the chat as upstream has it (one chat read upstream); the read
 * receipt is the Desktop API's read; "mark all read" in the low-priority inbox reads discreet chats quietly (their
 * own choice or their account's, inbox.ts).
 */
export const beeperReceipts = (note: ReceiptSupport['note'], readAll: NonNullable<ReceiptSupport['readAllLowPriorityByChat']>): ReceiptSupport => ({
  async readQuietly(chatID) {
    const chat = (await api().chats.retrieve(chatID, { maxParticipantCount: 0 })) as unknown as Chat;
    readLocally({ ...chat, id: chatID });
  },
  async send(chatID, messageID) {
    await api().chats.markRead(chatID, messageID ? { messageID } : {});
    readUpstream(chatID);
  },
  // Replying reads the chat for real (the core's readAfterReply calls `send` after a reply in a discreet chat: the
  // Desktop API's read, which also drops the chat's entry here); the mautrix bridges' implicit receipt with our own
  // message aside, that is what the owner wants on every network.
  replyTells: true,
  readAllLowPriorityByChat: readAll,
  note,
});
