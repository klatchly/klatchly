import type { Chat, ConnectorShape, MediaTab, Message } from '#core/sdk.js';
import { api } from './upstream.js';
import { localChats, onLocalReadChange, readLocally, readUpstream } from './localread.js';
import { noteChatAccounts } from './accounts.js';

// Reads that page through upstream lists: every chat for the badge, the low-priority inbox for "read all", and a
// chat's media through the message search (moved from the core's pushwatch, readall and chatmedia).

// ── Badge ──

// Every chat, not only the newest page: an older low-priority or archived chat that wakes up must already
// be known as such.
const SEED_MAX = 5000;

// One shared scan (2026-11-18: the badge's recount and the accounts page's figures each paged through every chat,
// up to 25 upstream calls of 200 chats, on every reconnect and every minute): one scan at a time, its chats kept
// SCAN_TTL and kept current by the persistent socket's chat upserts (patchScan). Forgotten whenever its figures may
// be off: a read (here or upstream: localread.ts), a flag or archive change made here, the persistent socket
// dropping or coming back (events may have been missed meanwhile). Kept as upstream gives them: discreet reads are
// applied on the way out, every time (localChats).
// Longer than the accounts page's figures (ext/accounts: kept a minute, polled every minute while open), so that
// page reads the kept scan rather than a new one each time; shorter than the badge's periodic recount (5 minutes),
// which then reads every chat again.
export const SCAN_TTL = 4 * 60_000;

type ScanRun = { done: Promise<Chat[]>; patches: Chat[][]; gen: number };
let scan: { at: number; chats: Map<string, Chat> } | undefined;
let scanning: ScanRun | undefined;
// After a drop during a scan: the one scan that follows it, shared by everyone asking meanwhile.
let following: Promise<Chat[]> | undefined;
let scanGen = 0;

/**
 * Forgets the shared scan (its figures may be off). A scan under way still answers those already waiting, but is not
 * kept; those asking afterwards get the scan that follows it (one, started once it is done: drops come often, and
 * each must not start another scan alongside).
 */
export function dropScan(): void {
  scanGen++;
  scan = undefined;
}

onLocalReadChange(dropScan);

/** Chats as upstream sends them in its upserts (whole chats): the shared scan takes their new fields. */
export function patchScan(entries: readonly Chat[]): void {
  const list = entries.filter((c) => c && typeof c.id === 'string');
  if (!list.length) return;
  // A scan under way may have read these chats before they changed: they are applied once it is done.
  scanning?.patches.push(list);
  if (scan) for (const c of list) scan.chats.set(c.id, { ...scan.chats.get(c.id), ...c });
}

async function scanAll(): Promise<Chat[]> {
  const seen: Chat[] = [];
  let cursor: string | undefined;
  do {
    const r = (await api().get('/v1/chats', { query: { limit: 200, ...(cursor ? { cursor, direction: 'before' } : {}) } })) as {
      items?: Chat[];
      hasMore?: boolean;
      oldestCursor?: string | null;
    };
    seen.push(...(r.items ?? []));
    cursor = r.hasMore && r.oldestCursor ? r.oldestCursor : undefined;
  } while (cursor && seen.length < SEED_MAX);
  noteChatAccounts(seen);
  return seen;
}

function startScan(): Promise<Chat[]> {
  const run: ScanRun = { patches: [], done: Promise.resolve([]), gen: scanGen };
  run.done = scanAll()
    .then((seen) => {
      const chats = new Map<string, Chat>();
      for (const c of seen) if (c && typeof c.id === 'string') chats.set(c.id, c);
      for (const list of run.patches) for (const c of list) chats.set(c.id, { ...chats.get(c.id), ...c });
      if (run.gen === scanGen) scan = { at: Date.now(), chats };
      return [...chats.values()];
    })
    .finally(() => {
      if (scanning === run) scanning = undefined;
    });
  scanning = run;
  return run.done;
}

const fresh = () => (scan && Date.now() - scan.at < SCAN_TTL ? [...scan.chats.values()] : undefined);

/** The chats of the scan to read now: the kept one, the one under way, or a new one (one at a time). */
function current(): Promise<Chat[]> {
  const kept = fresh();
  if (kept) return Promise.resolve(kept);
  if (!scanning) return startScan();
  if (scanning.gen === scanGen) return scanning.done;
  // The scan under way started before a drop: the next one waits for it.
  const stale = scanning.done;
  following ??= stale
    .catch(() => [])
    .then(() => {
      following = undefined;
      return current();
    });
  return following;
}

/** The connector's unreadChats: every chat (SEED_MAX at most), from the shared scan. */
export async function unreadChats(): Promise<Chat[]> {
  return localChats(await current());
}

// ── Read all (low priority) ──

// The inbox is paged through upstream (50 chats a page, at most MAX_PAGES), then each unread chat is marked
// read with a small concurrency.
const PAGE = 50;
const MAX_PAGES = 40;
const CONCURRENCY = 3;

type ChatLite = { id?: unknown; unreadCount?: unknown; isLowPriority?: unknown };
type Page = { items?: ChatLite[]; hasMore?: boolean; oldestCursor?: string | null };

/** IDs of the unread low-priority chats of one search page. */
export function unreadLowPriority(items: ChatLite[] | undefined): string[] {
  return (items ?? [])
    .filter((c) => typeof c.id === 'string' && typeof c.unreadCount === 'number' && c.unreadCount > 0 && c.isLowPriority !== false)
    .map((c) => c.id as string);
}

/** Runs `fn` over the items, at most `n` at a time. */
export async function eachLimited<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * Marks every unread low-priority chat read. `quiet(chatID, accountID)`: the chats that read discreetly (their own
 * choice or their account's) are read in Klatchly only (localread.ts, from the chat as upstream gives it: its raw count), never through the Desktop API.
 */
export async function readAllLowPriority(
  onRead?: (chatID: string) => void,
  quiet?: (chatID: string, accountID: string | undefined) => boolean,
): Promise<{ total: number; read: string[]; failed: number; complete: boolean }> {
  const chats = new Map<string, Chat>();
  let cursor: string | undefined;
  let complete = false;
  for (let p = 0; p < MAX_PAGES; p++) {
    const page = (await api().get('/v1/chats/search', {
      query: { inbox: 'low-priority', limit: PAGE, ...(cursor ? { cursor, direction: 'before' } : {}) },
    })) as Page;
    const raw = (page.items ?? []) as Chat[];
    // What Klatchly shows as unread: a chat already read discreetly is not marked again.
    for (const id of unreadLowPriority(localChats(raw))) chats.set(id, raw.find((c) => c.id === id)!);
    if (!page.hasMore || !page.oldestCursor || page.oldestCursor === cursor) {
      complete = true;
      break;
    }
    cursor = page.oldestCursor;
  }
  const read: string[] = [];
  let failed = 0;
  await eachLimited([...chats.values()], CONCURRENCY, async (chat) => {
    try {
      if (quiet?.(chat.id, typeof chat.accountID === 'string' ? chat.accountID : undefined)) readLocally(chat);
      else {
        await api().chats.markRead(chat.id, {});
        readUpstream(chat.id);
      }
      read.push(chat.id);
      // The badge drops it now, not once every chat is done.
      onRead?.(chat.id);
    } catch {
      failed++;
    }
  });
  return { total: chats.size, read, failed, complete };
}

// ── Media page ──

/** The Desktop API's mediaTypes filter for each tab. */
export const UPSTREAM_MEDIA_TYPES: Record<MediaTab, string[]> = { media: ['image', 'video'], files: ['file'], links: ['link'] };

/** Upstream calls per request (20 messages each) and the items after which a page is enough. */
const MAX_UPSTREAM_PAGES = 4;
const PAGE_ITEMS = 40;

/** The message search with its media filter (chatIDs + mediaTypes: one indexed query, 20 messages per call, no scan of the whole history), a few pages at once until there is enough to show. */
export const mediaMessages: NonNullable<ConnectorShape['mediaMessages']> = async (chatID, tab, cursor, keep) => {
  const items: Message[] = [];
  let next = cursor;
  let hasMore = true;
  for (let i = 0; i < MAX_UPSTREAM_PAGES && items.length < PAGE_ITEMS && hasMore; i++) {
    const page = (await api().get('/v1/messages/search', {
      query: {
        chatIDs: [chatID],
        mediaTypes: UPSTREAM_MEDIA_TYPES[tab],
        limit: 20,
        // The defaults leave out low-priority chats: this is one chat, whatever its inbox.
        excludeLowPriority: false,
        includeMuted: true,
        ...(next ? { cursor: next, direction: 'before' } : {}),
      },
    })) as { items?: Message[]; hasMore?: boolean; oldestCursor?: string | null };
    for (const m of page.items ?? []) if (m && m.chatID === chatID && typeof m.id === 'string' && keep(m)) items.push(m);
    hasMore = !!page.hasMore && !!page.oldestCursor && page.oldestCursor !== next;
    next = page.oldestCursor ?? undefined;
  }
  return { items, hasMore, cursor: hasMore ? (next ?? null) : null };
};
