import type { QueryClient } from '@tanstack/react-query';
import { keys, messagesQuery, type Pages } from './cache';
import type { Chat, Message } from './types';

/**
 * Loads the latest messages of the chats most likely to be opened next (unread first, then the top of the
 * list) in the background, so opening them shows the conversation at once. The websocket keeps cached
 * conversations current; a reconnect marks them stale (they reload when opened), and the next pass reloads those
 * whose last message moved meanwhile (needsLoad: behind the list's preview).
 */
const TOP = 12;
const PARALLEL = 2;

const ts = (iso?: string) => (iso ? new Date(iso).getTime() || 0 : 0);

// Conversations fetched from the server in this page's life: live events keep those complete, and what a
// disconnect may have left out is caught by the preview check (needsLoad) or the reload on opening (the reconnect
// marks them stale: cache.ts refreshAfterReconnect). A restored copy (persist.ts) may have gaps, even after a live
// message landed in it.
const synced = new Set<string>();

/** True when the cached pages may miss messages: not loaded since the last connection, or behind the list's preview. */
export function needsLoad(qc: QueryClient, chat: Chat): boolean {
  const state = qc.getQueryState(keys.messages(chat.id));
  if (!state?.data || !synced.has(chat.id) || state.status === 'error') return true;
  const first = (state.data as Pages<Message>).pages[0]?.items ?? [];
  const p = chat.preview;
  if (!p || first.some((m) => m.id === p.id)) return false;
  return ts(p.timestamp) > Math.max(0, ...first.map((m) => ts(m.timestamp)));
}

const running = new Set<string>();
const queue: Chat[] = [];

function pump(qc: QueryClient) {
  while (running.size < PARALLEL && queue.length) {
    const chat = queue.shift()!;
    if (running.has(chat.id) || !needsLoad(qc, chat)) continue;
    running.add(chat.id);
    void qc
      .prefetchInfiniteQuery({ ...messagesQuery(chat.id), staleTime: 0 })
      .finally(() => {
        running.delete(chat.id);
        pump(qc);
      });
  }
}

/** Load one chat now (a pointer over its row or a finger on it). */
export function prefetchChat(qc: QueryClient, chat: Chat): void {
  if (running.has(chat.id) || !needsLoad(qc, chat)) return;
  queue.unshift(chat);
  pump(qc);
}

function candidates(qc: QueryClient): Chat[] {
  const seen = new Set<string>();
  const list: Chat[] = [];
  for (const p of qc.getQueryData<Pages<Chat>>(keys.chats)?.pages ?? []) {
    for (const c of p.items) {
      // Archived and low-priority chats are not worth a background load.
      if (seen.has(c.id) || c.isArchived || c.isLowPriority) continue;
      seen.add(c.id);
      list.push(c);
    }
  }
  const unread = list.filter((c) => c.unreadCount > 0 && !c.isMuted);
  const rest = list.filter((c) => !unread.includes(c));
  return [...unread, ...rest].slice(0, TOP);
}

/** Watches the chat list and keeps its top conversations loaded. Returns the stop function. */
export function startPrefetch(qc: QueryClient): () => void {
  let timer: number | undefined;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const pass = () => {
    timer = undefined;
    if (document.visibilityState !== 'visible' || conn?.saveData) return;
    const list = candidates(qc).filter((c) => needsLoad(qc, c));
    queue.splice(0, queue.length, ...list);
    pump(qc);
  };
  const schedule = () => {
    if (timer === undefined) timer = window.setTimeout(pass, 1500);
  };
  const unsub = qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success') return;
    const [k, id] = e.query.queryKey;
    if (k === 'chats') schedule();
    else if (k === 'messages' && typeof id === 'string' && !e.action.manual) synced.add(id);
  });
  const onVisible = () => document.visibilityState === 'visible' && schedule();
  document.addEventListener('visibilitychange', onVisible);
  schedule();
  return () => {
    unsub();
    document.removeEventListener('visibilitychange', onVisible);
    window.clearTimeout(timer);
    queue.length = 0;
  };
}
