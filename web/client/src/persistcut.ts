// What the stored copy of the query cache keeps (persist.ts). Pure functions (unit-tested in test/persistcut.test.ts):
// structural copies of TanStack Query's dehydrated shapes, no imports.

export interface CutQuery {
  queryKey: readonly unknown[];
  queryHash: string;
  state: { data?: unknown; dataUpdatedAt: number; status?: string };
}

export const MAX_CHAT_PAGES = 3;
export const MAX_CONVERSATIONS = 40;
export const MAX_MESSAGE_PAGES = 2;
/** Single messages (reply quotes, reaction previews), the most recently fetched first. */
export const MAX_LOOKUPS = 300;
/**
 * How long a single message looked up on its own stays fresh (its queries' staleTime: ChatList.tsx, MessageItem.tsx),
 * and how old it may be to be stored. The live events keep the cached copies current (cache.ts upsertMessages, an
 * edit; realtime.ts, a deletion), but an edit or a deletion made while this device was away is not pushed again: past
 * this age the copy is read again when shown, and a deleted message's text does not stay on the device longer.
 */
export const LOOKUP_STALE_MS = 6 * 3600_000;

const LOOKUPS = new Set<unknown>(['message', 'reaction-target']);

/** Whether a query's first key is one the stored copy keeps (a successful one only: persist.ts). */
export const keptKey = (k: unknown): boolean => k === 'chats' || k === 'chat' || k === 'messages' || k === 'accounts' || LOOKUPS.has(k);

/**
 * The stored copy: the top of the chat lists (MAX_CHAT_PAGES), the latest pages (MAX_MESSAGE_PAGES) of the
 * MAX_CONVERSATIONS conversations fetched last, every chat and the accounts, marked old (whatever shows them
 * refetches); and the MAX_LOOKUPS single messages fetched last within LOOKUP_STALE_MS, as they are (still fresh
 * when restored, until that age). `now`: Date.now() (tests).
 */
export function cutQueries<Q extends CutQuery>(queries: readonly Q[], now: number = Date.now()): Q[] {
  const newestOf = (pick: (k: unknown) => boolean, n: number) =>
    queries
      .filter((q) => pick(q.queryKey[0]))
      .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
      .slice(0, n)
      .map((q) => q.queryHash);
  const recent = new Set([...newestOf((k) => k === 'messages', MAX_CONVERSATIONS), ...newestOf((k) => LOOKUPS.has(k), MAX_LOOKUPS)]);
  const young = (q: Q) => now - q.state.dataUpdatedAt < LOOKUP_STALE_MS;
  const trim = (n: number) => (d: unknown) => {
    const inf = d as { pages: unknown[]; pageParams: unknown[] };
    return { pages: inf.pages.slice(0, n), pageParams: inf.pageParams.slice(0, n) };
  };
  return queries
    .filter((q) => keptKey(q.queryKey[0]) && ((q.queryKey[0] !== 'messages' && !LOOKUPS.has(q.queryKey[0])) || recent.has(q.queryHash)))
    .filter((q) => !LOOKUPS.has(q.queryKey[0]) || young(q))
    .map((q) => {
      const k = q.queryKey[0];
      if (LOOKUPS.has(k)) return q;
      const cut = k === 'chats' ? trim(MAX_CHAT_PAGES) : k === 'messages' ? trim(MAX_MESSAGE_PAGES) : undefined;
      // Restored copies count as old, so whatever shows them refetches.
      return { ...q, state: { ...q.state, data: cut ? cut(q.state.data) : q.state.data, dataUpdatedAt: 1 } };
    });
}
