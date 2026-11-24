import type { Page } from './connector.js';

// One list over several connectors (GET /api/chats, /api/chats/search, /api/messages/search): each pages on its
// own, newest first, and the core merges their pages by time. Pure: no I/O here (relay.ts asks the connectors).
//
// A page of the merged list covers a span of time [lower, upper): `upper` is where the previous page ended,
// `lower` the oldest item of the source that limits this page (among those with more to give, the one whose page
// reaches the least far back). Every item of the span is shown once: a source whose page went below `lower`
// keeps its cursor and is asked the same page again next time (its items from `upper` on are left out then); a
// source whose page was shown whole goes on from its own cursor, or is done. Pinned items (chats) come on the
// page that first fetched them, on top. The merged cursor carries `upper` and each source's state; with a
// single source in play, the list is that source's own, cursors untouched.

/** One source's page for a merged list. `again`: the page asked last time too (its pinned items were shown). */
export interface SourcePage<T> {
  id: string;
  page: Page<T>;
  again: boolean;
}

/** Where each source of a merged list stands: its cursor (null: its first page) and whether that page was asked. */
export interface MergeState {
  upper?: number;
  sources: Record<string, { cursor: string | null; again: boolean }>;
}

export interface MergeItem {
  at: number;
  pinned: boolean;
}

const PREFIX = 'mx1:';
/** Longest merged cursor: what the core accepts back (relay.ts pageQuery). */
export const MAX_CURSOR = 512;

/** A merged list's first page: every source from its start. */
export const firstState = (ids: readonly string[]): MergeState => ({ sources: Object.fromEntries(ids.map((id) => [id, { cursor: null, again: false }])) });

export function encodeState(s: MergeState): string {
  const src = Object.fromEntries(Object.entries(s.sources).map(([id, v]) => [id, v.again ? [v.cursor, 1] : [v.cursor]]));
  return PREFIX + JSON.stringify({ ...(s.upper === undefined ? {} : { u: s.upper }), s: src });
}

/** A merged cursor of these sources (any other source in it: not one of ours), or null. */
export function decodeState(v: string, ids: readonly string[]): MergeState | null {
  if (!v.startsWith(PREFIX)) return null;
  let j: unknown;
  try {
    j = JSON.parse(v.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const { u, s } = j as { u?: unknown; s?: unknown };
  if (u !== undefined && (typeof u !== 'number' || !Number.isSafeInteger(u) || u < 0)) return null;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const sources: MergeState['sources'] = {};
  for (const [id, x] of Object.entries(s)) {
    if (!ids.includes(id) || !Array.isArray(x) || x.length < 1 || x.length > 2) return null;
    const [cursor, again] = x as unknown[];
    // Each source gets its cursor back only as the core checks any cursor (relay.ts pageQuery).
    if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR || /[\u0000-\u001f]/.test(cursor))) return null;
    if (again !== undefined && again !== 1) return null;
    sources[id] = { cursor: cursor as string | null, again: again === 1 };
  }
  return { ...(u === undefined ? {} : { upper: u as number }), sources };
}

/**
 * One merged page from the sources' pages (in the order of the sources: the registry's, by the packages' declared order), and where
 * the next one starts (null: the list is done). `item` tells an item's time and whether it is pinned.
 */
export function mergePages<T>(pages: readonly SourcePage<T>[], state: MergeState, item: (x: T) => MergeItem): { items: T[]; next: MergeState | null } {
  const upper = state.upper ?? Infinity;
  // The limit of this page: the source with more to give that reaches the least far back.
  let lower = -Infinity;
  for (const p of pages) {
    if (!p.page.hasMore) continue;
    const times = p.page.items.filter((x) => !item(x).pinned).map((x) => item(x).at);
    if (times.length) lower = Math.max(lower, Math.min(...times));
  }
  const pinned: T[] = [];
  let rest: T[] = [];
  const next: MergeState = { ...(Number.isFinite(lower) ? { upper: Math.round(lower) } : {}), sources: {} };
  pages.forEach((p, i) => {
    let held = false;
    const own: T[] = [];
    for (const x of p.page.items) {
      const { at, pinned: pin } = item(x);
      if (pin) {
        if (!p.again) pinned.push(x);
      } else if (p.again && at >= upper) {
        // Shown on an earlier page.
      } else if (at >= lower) own.push(x);
      else held = true;
    }
    if (i === 0) rest = own;
    else {
      // Each item before the first of the list that is older (ties stay behind the earlier sources').
      for (const x of own) {
        const t = item(x).at;
        const k = rest.findIndex((y) => item(y).at < t);
        rest.splice(k < 0 ? rest.length : k, 0, x);
      }
    }
    const from = state.sources[p.id]!;
    if (held) next.sources[p.id] = { cursor: from.cursor, again: true };
    else if (p.page.hasMore && p.page.oldestCursor) next.sources[p.id] = { cursor: p.page.oldestCursor, again: false };
  });
  return { items: [...pinned, ...rest], next: Object.keys(next.sources).length ? next : null };
}

/** Milliseconds of an ISO time (0 when absent or invalid). */
export const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) || 0 : 0);
