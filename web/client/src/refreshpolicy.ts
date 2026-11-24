// What the chat lists and a reconnect load (refresh.ts, ChatList.tsx, realtime.ts). Pure functions (unit-tested in
// test/refreshpolicy.test.ts), no imports.

/**
 * Query keys (their first element) a reconnect does not refetch on the generic path (refresh.ts refreshAfterReconnect):
 * single messages (reply quotes, reaction previews: kept current by the live events, read again once old), and what
 * it reloads its own way (the chat lists: their top, coalesced; conversations: the open one's newest page, the others marked
 * stale; the accounts: marked stale).
 */
const RECONNECT_OWN = new Set<unknown>(['message', 'reaction-target', 'messages', 'chats', 'chats-lowpri', 'accounts']);

/** Whether a reconnect refetches this query (when on screen) on the generic path. */
export const refetchedOnReconnect = (key: readonly unknown[]): boolean => !RECONNECT_OWN.has(key[0]);

/** "Unread only" pages through the list for matches, 10 pages at most (unread chats are the recent ones). */
export const UNREAD_PAGES = 10;
/**
 * The network filter's lists are filtered by the server, so a page is mostly matches; a connector that ignores the
 * filter gives its own chats whole (the client filters again). A few pages at most are loaded for matches; more while
 * none shows at all (the first pages may hold only chats of another view: low priority, held by quiet hours).
 */
export const FILTER_PAGES = 3;
export const FILTER_EMPTY_PAGES = 10;
/** Matches to show before a filtered list stops loading pages by itself (scrolling loads more). */
export const FILL_SHOWN = 20;

export interface FillState {
  /** The network filter's accounts (none: no filter). */
  accounts: readonly string[];
  unread: boolean;
  /** Pages loaded. */
  pages: number;
  /** Matching chats shown. */
  shown: number;
  hasNextPage: boolean;
  /** A page is loading, or the first one is not in yet (or shows a placeholder). */
  busy: boolean;
}

const capOf = (s: Pick<FillState, 'accounts' | 'unread' | 'shown'>): number =>
  Math.max(s.unread ? UNREAD_PAGES : 0, s.accounts.length ? (s.shown ? FILTER_PAGES : FILTER_EMPTY_PAGES) : 0);

/** Whether a filtered list loads its next page by itself: too few matches shown, pages left, within its cap. */
export function shouldFill(s: FillState): boolean {
  if (s.busy || !s.hasNextPage || s.shown >= FILL_SHOWN) return false;
  return s.pages < capOf(s);
}

/**
 * Whether an empty filtered list may say "nothing here": nothing more it would load by itself. With pages left (its
 * cap reached), it says none is among the recent chats and offers to look further back (ChatList.tsx EmptyFiltered).
 */
export function fillDone(s: Omit<FillState, 'busy'>): boolean {
  return !s.hasNextPage || s.pages >= capOf(s);
}

// ── The live socket's reconnections (realtime.ts) ──

/**
 * How long a connection must have lasted for the reconnect backoff to start over. Longer than the server takes to
 * drop a socket whose upstream stopped answering (server/ws.ts and the Beeper live feed: a ping every 25 s, dropped
 * after 2 unanswered, so 50 to 75 s): a server that accepts the socket and then loses it is not hammered every second.
 */
export const STABLE_MS = 2 * 60_000;
/** The longest wait between two tries. */
export const MAX_RETRY_MS = 30_000;

/** The live socket's reconnect delays: exponential, with jitter, started over only after a lasting connection. */
export class ReconnectBackoff {
  private attempt = 0;
  private readyAt: number | undefined;

  /** The connection is up (its 'ready'), at `now` (ms, any monotonic clock). */
  ready(now: number): void {
    this.readyAt = now;
  }

  /** It closed at `now`: how long to wait before the next try. `rand`: Math.random (tests). */
  next(now: number, rand: () => number = Math.random): number {
    if (this.readyAt !== undefined && now - this.readyAt >= STABLE_MS) this.attempt = 0;
    this.readyAt = undefined;
    const base = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.attempt++);
    return base / 2 + rand() * (base / 2);
  }

  /** Starting over on purpose (the app back from the background). */
  reset(): void {
    this.attempt = 0;
    this.readyAt = undefined;
  }
}

/**
 * Back from the background, the conversation on screen is read again without waiting for the new socket's 'ready'
 * only if that is slow to come (it reads it again itself: cache.ts refreshAfterReconnect): one read, not two.
 */
export const RESUME_REFRESH_MS = 2_000;
