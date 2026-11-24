// Cached pages brought up to date with the top of the list alone, instead of refetching every loaded page: a
// conversation with its newest page (a reconnect, a return to the app), a chat list with its first pages (a refresh
// of the lists): one request, or a few, whatever was scrolled. Pure functions (unit-tested in
// test/newest.test.ts): structural copies of the types.ts shapes, no imports.

export interface NewestMessage {
  id: string;
  timestamp?: string;
}
export interface NewestPage<M> {
  items: M[];
  hasMore: boolean;
  oldestCursor: string | null;
  newestCursor?: string | null;
}
export interface NewestPages<M, P extends NewestPage<M> = NewestPage<M>> {
  pages: P[];
  pageParams: unknown[];
}

const ts = (iso?: string) => (iso ? new Date(iso).getTime() || 0 : 0);

/** Where an item stands in its list, newest first: the higher, the nearer the top (Infinity: always on top). */
export type Rank<M> = (m: M) => number;

/**
 * The cached pages (newest first) with `page`, the top of the list as the server has it now (one page, or the first
 * few pages run together):
 * - no item in common with what is cached: the cached pages may miss what came in between, so the list starts again
 *   from that page alone;
 * - otherwise the first page becomes that page plus the cached items older than its oldest one (they keep their
 *   cursor), items of later pages it now holds leave those pages, and copies it carries replace the cached ones
 *   (`keep(old, fresh)`: what to keep of the old copy). A cached item within its range that it no longer has (deleted
 *   upstream, moved to another list) goes, whatever page held it.
 * Either way, cached items newer than anything the page holds stay on top: they came in while it was being read
 * (a live event), after the server answered.
 */
export function mergeHead<M extends { id: string }, P extends NewestPage<M>, D extends NewestPages<M, P>>(
  data: D,
  page: P,
  rank: Rank<M>,
  keep: (old: M, fresh: M) => M = (_, f) => f,
): D {
  const fresh = new Map(page.items.map((m) => [m.id, m]));
  const cached = data.pages.flatMap((p) => p.items);
  const ranks = page.items.map(rank);
  const finite = ranks.filter((r) => Number.isFinite(r));
  // Newer than the page's newest (a page of pinned chats only says nothing about that): came in meanwhile.
  const newest = finite.length ? Math.max(...finite) : Infinity;
  const oldest = ranks.length ? Math.min(...ranks) : -Infinity;
  const seen = new Set<string>();
  const above = cached.filter((m) => {
    if (fresh.has(m.id) || seen.has(m.id) || !(rank(m) > newest)) return false;
    seen.add(m.id);
    return true;
  });
  // Each of them in its place among the page's items (after pinned chats, before anything older).
  const withAbove = (items: M[]): M[] => {
    const out = [...items];
    for (const m of above) {
      const r = rank(m);
      let at = 0;
      while (at < out.length && rank(out[at]!) >= r) at++;
      out.splice(at, 0, m);
    }
    return out;
  };
  const first = data.pages[0];
  const overlaps = !!first && page.items.length > 0 && cached.some((m) => fresh.has(m.id));
  if (!first || !overlaps) return { ...data, pages: [{ ...page, items: withAbove(page.items) }], pageParams: [undefined] as D['pageParams'] };
  const old = new Map<string, M>();
  for (const m of cached) if (!old.has(m.id)) old.set(m.id, m);
  const items = withAbove(page.items.map((m) => (old.has(m.id) ? keep(old.get(m.id)!, m) : m)));
  const ids = new Set(items.map((m) => m.id));
  // What stays of a cached page: what the new top neither holds nor should hold (older than its oldest item). Nothing
  // when the page is the whole list.
  const left = (list: M[]) => (page.hasMore ? list.filter((m) => !ids.has(m.id) && rank(m) <= oldest) : []);
  const tail = left(first.items);
  const head: P = tail.length
    ? { ...first, items: [...items, ...tail], ...(page.newestCursor !== undefined ? { newestCursor: page.newestCursor } : {}) }
    : // Nothing of the old first page is left beyond the new one: the next page goes on from the new page's end.
      { ...page, items };
  if (!page.hasMore) return { ...data, pages: [head], pageParams: data.pageParams.slice(0, 1) as D['pageParams'] };
  const rest = data.pages.slice(1).map((p) => {
    const kept = left(p.items);
    return kept.length === p.items.length ? p : { ...p, items: kept };
  });
  return { ...data, pages: [head, ...rest] };
}

/** A conversation brought up to date with its newest page (messages by time). */
export function mergeNewest<M extends NewestMessage, P extends NewestPage<M>, D extends NewestPages<M, P>>(data: D, page: P, keep: (old: M, fresh: M) => M = (_, f) => f): D {
  return mergeHead<M, P, D>(data, page, (m) => ts(m.timestamp), keep);
}

/** A chat list's place: pinned chats first, then the latest activity first. */
export const chatRank = (c: { isPinned?: boolean; lastActivity?: string }): number => (c.isPinned ? Infinity : ts(c.lastActivity));

/** A chat list brought up to date with its first pages, the pages scrolled to beyond them kept. */
export function mergeListHead<C extends { id: string; isPinned?: boolean; lastActivity?: string }, P extends NewestPage<C>, D extends NewestPages<C, P>>(data: D, page: P): D {
  return mergeHead<C, P, D>(data, page, chatRank);
}
