// What the client reads again when something may have changed without saying what: a burst of events about chats no
// loaded page holds, an event with no entries, a reconnect of the live socket (cache.ts wires it to the API).
// Unit-tested in test/refresh.test.ts with a QueryClient of its own: no relative imports but the pure modules'.
//
// 2026-11-18, beeper-server saturated: every reconnect refetched the whole cache, and every refresh of an infinite
// query refetched every page it held, one request after the other. Now only the top of a list is read again; what
// was scrolled to beyond it is kept.

import type { QueryClient } from '@tanstack/query-core';
import { mergeListHead, mergeNewest, type NewestMessage, type NewestPage } from './newest.js';
import { refetchedOnReconnect } from './refreshpolicy.js';

/** The chat list, and the network filter's lists under it (cache.ts keys.chats, keys.chatsFor). */
export const CHATS_KEY = ['chats'] as const;
/** The low-priority inbox, and the network filter's under it (cache.ts keys.lowPriority, keys.lowPriorityFor). */
export const LOWPRI_KEY = ['chats-lowpri'] as const;
/** A conversation's message pages (cache.ts keys.messages). */
export const messagesKey = (id: string) => ['messages', id] as const;

export type ListChat = { id: string; isPinned?: boolean; lastActivity?: string };
type ListData = { pages: NewestPage<ListChat>[]; pageParams: unknown[] };
type MessageData = { pages: NewestPage<NewestMessage>[]; pageParams: unknown[] };

/** How the refreshes read the server (cache.ts: the API). */
export interface RefreshApi {
  /** One page of a cached chat list (its query key: CHATS_KEY or LOWPRI_KEY, then the filter's accounts). */
  listPage(key: readonly unknown[], cursor: string | undefined): Promise<NewestPage<ListChat>>;
  /** A conversation's newest page. */
  newestMessages(chatID: string): Promise<NewestPage<NewestMessage>>;
  /** What the cached copy of a message keeps when a fresh one replaces it. */
  keep?: (old: NewestMessage, fresh: NewestMessage) => NewestMessage;
}

/**
 * Pages of a chat list read again on a refresh: a list holding no more is refetched whole; one holding more (scrolled
 * further) has its top read again (this many pages on a reconnect, one for a burst) and keeps the rest; one not on
 * screen is cut to this many and marked stale.
 */
export const LIST_REFRESH_PAGES = 3;
export const LIST_REFRESH_MS = 1_500;
export const CONVERSATION_REFRESH_MS = 700;

// ── Chat lists ──

interface ListState {
  timer?: ReturnType<typeof setTimeout>;
  deep: boolean;
  running?: Promise<void>;
}
const listStates = new WeakMap<QueryClient, ListState>();

/**
 * Refreshes the chat lists (the inbox, the low-priority inbox, the network filter's) once, shortly, however many times
 * it is asked meanwhile: a burst of events used to refetch both lists once per event, each refetch cancelling the
 * previous one in the browser only, while the server kept every request running. `deep` (a reconnect): the top
 * LIST_REFRESH_PAGES pages of a list scrolled further are read again, not only its first.
 */
export function refreshListsSoon(qc: QueryClient, api: RefreshApi, deep = false): void {
  let s = listStates.get(qc);
  if (!s) listStates.set(qc, (s = { deep: false }));
  if (deep) s.deep = true;
  if (s.timer !== undefined) return;
  const st = s;
  st.timer = setTimeout(() => {
    st.timer = undefined;
    // A refresh still under way may predate what was asked: wait for it, then refresh once more.
    if (st.running || qc.isFetching({ queryKey: CHATS_KEY }) || qc.isFetching({ queryKey: LOWPRI_KEY })) return refreshListsSoon(qc, api);
    const pages = st.deep ? LIST_REFRESH_PAGES : 1;
    st.deep = false;
    st.running = refreshLists(qc, api, pages).finally(() => (st.running = undefined));
  }, LIST_REFRESH_MS);
}

const trim = (data: ListData, n: number): ListData => ({ ...data, pages: data.pages.slice(0, n), pageParams: data.pageParams.slice(0, n) });

/** One refresh of every cached chat list (refreshListsSoon). `pages`: how many pages the top of a long list has. */
export async function refreshLists(qc: QueryClient, api: RefreshApi, pages: number): Promise<void> {
  const heads: (readonly unknown[])[] = [];
  for (const prefix of [CHATS_KEY, LOWPRI_KEY]) {
    for (const q of qc.getQueryCache().findAll({ queryKey: prefix })) {
      const data = q.state.data as ListData | undefined;
      const n = data?.pages?.length ?? 0;
      if (!q.isActive()) {
        // Not on screen: whatever shows it next reloads its first pages only.
        if (data && n > LIST_REFRESH_PAGES) qc.setQueryData(q.queryKey, trim(data, LIST_REFRESH_PAGES));
        void qc.invalidateQueries({ queryKey: q.queryKey, exact: true, refetchType: 'none' });
      } else if (n <= LIST_REFRESH_PAGES) {
        void qc.invalidateQueries({ queryKey: q.queryKey, exact: true }, { cancelRefetch: false });
      } else {
        // On screen, scrolled further: the rows being read stay where they are.
        heads.push(q.queryKey);
      }
    }
  }
  for (const key of heads) await refreshHead(qc, api, key, pages);
}

async function refreshHead(qc: QueryClient, api: RefreshApi, key: readonly unknown[], pages: number): Promise<void> {
  try {
    const got: NewestPage<ListChat>[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < pages; i++) {
      const p = await api.listPage(key, cursor);
      got.push(p);
      if (!p.hasMore || !p.oldestCursor) break;
      cursor = p.oldestCursor;
    }
    const last = got[got.length - 1];
    if (!last) return;
    const top: NewestPage<ListChat> = { ...last, items: got.flatMap((p) => p.items), newestCursor: got[0]!.newestCursor ?? null };
    const q = qc.getQueryCache().find({ queryKey: key, exact: true });
    const data = q?.state.data as ListData | undefined;
    if (!q || !data?.pages?.length) return;
    // A page being loaded meanwhile (scrolling) would write over the merge: once more, later.
    if (q.state.fetchStatus === 'fetching') return refreshListsSoon(qc, api, pages > 1);
    qc.setQueryData(key, mergeListHead(data, top));
  } catch {
    void qc.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
  }
}

// ── Conversations ──

type Run = { running: Promise<void>; queued?: Promise<void> };
const newestRuns = new WeakMap<QueryClient, Map<string, Run>>();

async function fetchNewest(qc: QueryClient, api: RefreshApi, chatID: string): Promise<void> {
  if (!qc.getQueryData(messagesKey(chatID))) return;
  try {
    const page = await api.newestMessages(chatID);
    const data = qc.getQueryData<MessageData>(messagesKey(chatID));
    if (!data?.pages) return;
    qc.setQueryData<MessageData>(messagesKey(chatID), mergeNewest(data, page, api.keep));
  } catch {
    void qc.invalidateQueries({ queryKey: messagesKey(chatID), refetchType: 'none' });
  }
}

function startNewest(qc: QueryClient, api: RefreshApi, chatID: string, runs: Map<string, Run>): Promise<void> {
  const run: Run = { running: Promise.resolve() };
  run.running = fetchNewest(qc, api, chatID).finally(() => {
    // A queued run takes over (it removes this one).
    if (!run.queued && runs.get(chatID) === run) runs.delete(chatID);
  });
  runs.set(chatID, run);
  return run.running;
}

/**
 * Brings a cached conversation up to date with its newest page alone (newest.ts mergeNewest), not every page it
 * holds: one request. Not cached: nothing to do (it loads when shown). A failure marks it stale (it reloads when
 * shown). Asked again while one runs: once more after it (that one may predate what was asked), and that one is
 * shared by everyone asking meanwhile.
 */
export function refreshNewest(qc: QueryClient, api: RefreshApi, chatID: string): Promise<void> {
  let runs = newestRuns.get(qc);
  if (!runs) newestRuns.set(qc, (runs = new Map()));
  const all = runs;
  const cur = all.get(chatID);
  if (!cur) return startNewest(qc, api, chatID, all);
  cur.queued ??= cur.running
    .catch(() => {})
    .then(() => {
      if (all.get(chatID) === cur) all.delete(chatID);
      return startNewest(qc, api, chatID, all);
    });
  return cur.queued;
}

const conversationTimers = new WeakMap<QueryClient, Map<string, ReturnType<typeof setTimeout>>>();

/**
 * "Something changed in this conversation" (an event with no entries), once, shortly, however many times it is asked
 * meanwhile: the conversation on screen has its newest page read again (refreshNewest), another cached one is marked
 * stale (it reloads when shown).
 */
export function refreshConversationSoon(qc: QueryClient, api: RefreshApi, chatID: string): void {
  let timers = conversationTimers.get(qc);
  if (!timers) conversationTimers.set(qc, (timers = new Map()));
  if (timers.has(chatID)) return;
  const all = timers;
  all.set(
    chatID,
    setTimeout(() => {
      all.delete(chatID);
      const q = qc.getQueryCache().find({ queryKey: messagesKey(chatID), exact: true });
      if (!q) return;
      if (q.isActive()) void refreshNewest(qc, api, chatID);
      else void qc.invalidateQueries({ queryKey: messagesKey(chatID), exact: true, refetchType: 'none' });
    }, CONVERSATION_REFRESH_MS),
  );
}

// ── Reconnect ──

/**
 * After the live socket reconnected (delivery is at-most-once, without replay: what happened meanwhile was not
 * pushed). Only what may have changed and is on screen is read again, not the whole cache (2026-11-18: every
 * reconnect refetched every list page, every page of the open conversation, every quoted message…):
 * - the chat lists: once, their top (refreshListsSoon, deep, coalesced with the event bursts);
 * - the conversation on screen: its newest page (refreshNewest); the other cached ones are marked stale and reload
 *   when opened (prefetch.ts still loads those whose last message moved);
 * - the rest of what is shown (the chat on screen, the archive, a package's space…): refetched when on screen,
 *   marked stale otherwise; the accounts are marked stale (read again in the foreground, and every 5 minutes);
 * - single messages (reply quotes, reaction previews): left as they are (kept current by the live events, read again
 *   once old: persistcut.ts LOOKUP_STALE_MS).
 */
export function refreshAfterReconnect(qc: QueryClient, api: RefreshApi, openChatID: string | undefined): void {
  void qc.invalidateQueries({ predicate: (q) => refetchedOnReconnect(q.queryKey), refetchType: 'active' }, { cancelRefetch: false });
  void qc.invalidateQueries({ queryKey: ['accounts'], refetchType: 'none' });
  refreshListsSoon(qc, api, true);
  void qc.invalidateQueries({ queryKey: ['messages'], refetchType: 'none', predicate: (q) => !openChatID || q.queryKey[1] !== openChatID });
  if (openChatID) void refreshNewest(qc, api, openChatID);
}
