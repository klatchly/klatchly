import { infiniteQueryOptions, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { learnNames } from './names';
import { api, type MediaPage, type MediaTab } from './endpoints';
import type { Chat, Message, Page } from './types';
import { chatPlace, findIn, patchIn, placeChat } from './chatplace';
import { keepDelivered } from './receipts';
import { lowPriorityShown } from './connectors';
import * as refresh from './refresh';
import { CHATS_KEY, LOWPRI_KEY, messagesKey, type RefreshApi } from './refresh';

export { chatPlace };

export type Pages<T> = InfiniteData<Page<T>, string | undefined>;

const accountKey = (accounts: readonly string[]) => [...new Set(accounts)].sort();

export const keys = {
  chats: CHATS_KEY,
  /**
   * The chat list of some accounts only (the network filter: the server filters, so the list is not paged through
   * for matches). Under 'chats': invalidated and persisted with it. No accounts: the whole list (keys.chats).
   */
  chatsFor: (accounts: readonly string[]): readonly string[] => ['chats', ...accountKey(accounts)],
  // The low-priority inbox (search inbox=low-priority, every connector's merged); not persisted (persist.ts keeps
  // 'chats' only).
  lowPriority: LOWPRI_KEY,
  /** The low-priority inbox of some accounts only (the network filter), under keys.lowPriority. */
  lowPriorityFor: (accounts: readonly string[]): readonly string[] => ['chats-lowpri', ...accountKey(accounts)],
  // Chat search results, per query and account filter (ChatList SearchResults): the prefix matches them all.
  searchChats: ['search-chats'] as const,
  chat: (id: string) => ['chat', id] as const,
  messages: messagesKey,
  chatMedia: (id: string, tab: MediaTab) => ['chat-media', id, tab] as const,
};

/** A conversation's message pages (newest first), shared by the conversation view and prefetching. */
export const messagesQuery = (chatID: string) =>
  infiniteQueryOptions({
    queryKey: keys.messages(chatID),
    queryFn: ({ pageParam }) => api.messages(chatID, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page<Message>) => (last.hasMore ? (last.oldestCursor ?? undefined) : undefined),
  });

/** The chat list (every chat, with its last message): the inbox view's source. `accounts`: the network filter's. */
export const chatsQuery = (accounts: readonly string[] = []) =>
  infiniteQueryOptions({
    queryKey: keys.chatsFor(accounts),
    queryFn: ({ pageParam }) => api.chats(pageParam, accounts.length ? accounts : undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page<Chat>) => (last.hasMore ? (last.oldestCursor ?? undefined) : undefined),
  });

/** One chat's media, files or links, newest first (the "Media, links and files" page; its viewer pages through it too). */
export const chatMediaQuery = (chatID: string, tab: MediaTab) =>
  infiniteQueryOptions({
    queryKey: keys.chatMedia(chatID, tab),
    queryFn: ({ pageParam }) => api.chatMedia(chatID, tab, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: MediaPage) => (last.hasMore ? (last.cursor ?? undefined) : undefined),
    staleTime: 60_000,
  });

/**
 * The low-priority inbox, shared by its list view and the header button's count: only in a build with a connector
 * that keeps one (connectors.ts lowPriorityShown), or, given `shown` (registry.ts useLowPriorityShown: the header's
 * count), only while one is on.
 */
export const lowPriorityQuery = (shown: boolean = lowPriorityShown(), accounts: readonly string[] = []) =>
  infiniteQueryOptions({
    queryKey: keys.lowPriorityFor(accounts),
    enabled: shown,
    queryFn: ({ pageParam }) => api.lowPriorityChats(pageParam, accounts.length ? accounts : undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page<Chat>) => (last.hasMore ? (last.oldestCursor ?? undefined) : undefined),
  });

const ts = (iso?: string) => (iso ? new Date(iso).getTime() || 0 : 0);

type ListEntry = { key: readonly unknown[]; data: Pages<Chat>; accounts: string[]; list: 'inbox' | 'lowPriority' };

/** The cached lists of the network filter (keys.chatsFor, keys.lowPriorityFor with accounts). */
function filteredLists(qc: QueryClient): ListEntry[] {
  const out: ListEntry[] = [];
  for (const [prefix, list] of [
    [keys.chats, 'inbox'],
    [keys.lowPriority, 'lowPriority'],
  ] as const) {
    for (const [key, data] of qc.getQueriesData<Pages<Chat>>({ queryKey: prefix })) {
      if (key.length > 1 && data?.pages) out.push({ key, data, accounts: key.slice(1) as string[], list });
    }
  }
  return out;
}

export function findChat(qc: QueryClient, id: string): Chat | undefined {
  return (
    findIn(qc.getQueryData<Pages<Chat>>(keys.chats), id) ??
    findIn(qc.getQueryData<Pages<Chat>>(keys.lowPriority), id) ??
    filteredLists(qc)
      .map((l) => findIn(l.data, id))
      .find(Boolean) ??
    qc.getQueryData<Chat>(keys.chat(id))
  );
}

/**
 * What a network filter's list shows while its first page loads: the matching chats of the whole list already cached
 * (one page, nothing more to load from it). Undefined when it has none (the list shows its skeleton).
 */
export function filteredPlaceholder(qc: QueryClient, accounts: readonly string[]): Pages<Chat> | undefined {
  if (!accounts.length) return undefined;
  const items = (qc.getQueryData<Pages<Chat>>(keys.chats)?.pages ?? []).flatMap((p) => p.items).filter((c) => accounts.includes(c.accountID));
  if (!items.length) return undefined;
  return { pages: [{ items, hasMore: false, oldestCursor: null, newestCursor: null }], pageParams: [undefined] };
}

// How the refreshes (refresh.ts) read the server: a chat list's page by its key, a conversation's newest page.
const refreshApi: RefreshApi = {
  listPage: (key, cursor) => {
    const accounts = key.slice(1) as string[];
    const filter = accounts.length ? accounts : undefined;
    return key[0] === LOWPRI_KEY[0] ? api.lowPriorityChats(cursor, filter) : api.chats(cursor, filter);
  },
  newestMessages: (chatID) => api.messages(chatID),
  keep: keepDelivered as unknown as RefreshApi['keep'],
};

/** Refreshes the chat lists once, shortly, however many times it is asked meanwhile (refresh.ts). */
export const refreshListsSoon = (qc: QueryClient): void => refresh.refreshListsSoon(qc, refreshApi);

/** Merge a chat into the inbox and low-priority lists: it moves between them as its flags change. */
export function upsertChat(qc: QueryClient, patch: Partial<Chat> & { id: string }): void {
  qc.setQueryData<Chat>(keys.chat(patch.id), (old) => (old ? { ...old, ...patch } : old));
  // Search results keep their own copy: a chat read from them must not keep its unread count there.
  qc.setQueriesData<Pages<Chat>>({ queryKey: keys.searchChats }, (old) => patchIn(old, patch));
  const inbox = qc.getQueryData<Pages<Chat>>(keys.chats);
  const low = qc.getQueryData<Pages<Chat>>(keys.lowPriority);
  const nets = filteredLists(qc);
  const inInbox = findIn(inbox, patch.id);
  const inLow = findIn(low, patch.id);
  // A filtered list holds its accounts' chats only (as the chat list it mirrors, low-priority ones leave the inbox's).
  // A chat only it holds is updated there, never added to the others from it.
  for (const l of nets) {
    const own = findIn(l.data, patch.id);
    if (!own && !inInbox && !inLow && !patch.title) continue;
    const m = { ...own, ...inInbox, ...inLow, ...patch } as Chat;
    qc.setQueryData<Pages<Chat>>(l.key, placeChat(l.data, m, chatPlace(m) === l.list && l.accounts.includes(m.accountID)));
  }
  if (!inbox && !low) return;
  if (!inInbox && !inLow && !patch.title) {
    refreshListsSoon(qc);
    return;
  }
  // Search results (the low-priority list) carry no preview: the chat list's copy provides it.
  const merged = { ...inInbox, ...inLow, ...patch } as Chat;
  const where = chatPlace(merged);
  if (inbox) qc.setQueryData<Pages<Chat>>(keys.chats, placeChat(inbox, merged, where === 'inbox'));
  if (low) qc.setQueryData<Pages<Chat>>(keys.lowPriority, placeChat(low, merged, where === 'lowPriority'));
}

export function removeChat(qc: QueryClient, id: string): void {
  for (const prefix of [keys.chats, keys.lowPriority]) {
    for (const [key, data] of qc.getQueriesData<Pages<Chat>>({ queryKey: prefix })) {
      if (!data?.pages || !findIn(data, id)) continue;
      qc.setQueryData<Pages<Chat>>(key, {
        ...data,
        pages: data.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== id) })),
      });
    }
  }
}

/** Insert or replace messages in a chat's cached pages (pages are newest-first). */
export function upsertMessages(qc: QueryClient, chatID: string, msgs: Message[]): void {
  learnNames(msgs);
  // A fresh copy of a message makes a pending background refresh of it pointless.
  for (const m of msgs) if (m.type !== 'REACTION') cancelRefresh(chatID, m.id);
  updateLookups(qc, chatID, msgs);
  const data = qc.getQueryData<Pages<Message>>(keys.messages(chatID));
  if (data) {
    let pages = data.pages;
    for (const m of msgs) {
      let replaced = false;
      pages = pages.map((p) => {
        if (!p.items.some((x) => x.id === m.id)) return p;
        replaced = true;
        // Entries are whole messages: replace, never merge. A field missing from the new copy has been
        // cleared upstream (last reaction removed, sendStatus dropped once delivered, ...). Except the
        // delivered ticks the server infers for Beeper networks: upstream copies never carry them, and
        // delivery does not go back (a source that carries them whole moves its positions itself).
        return { ...p, items: p.items.map((x) => (x.id === m.id ? keepDelivered(x, m) : x)) };
      });
      if (replaced || !pages[0]) continue;
      const items = [...pages[0].items];
      const oldest = items[items.length - 1];
      if (oldest && ts(m.timestamp) < ts(oldest.timestamp)) continue;
      let at = 0;
      while (at < items.length && ts(items[at]!.timestamp) > ts(m.timestamp)) at++;
      items.splice(at, 0, m);
      pages = [{ ...pages[0], items }, ...pages.slice(1)];
    }
    qc.setQueryData<Pages<Message>>(keys.messages(chatID), { ...data, pages });
  }
  const newest = msgs.filter((m) => m.type !== 'REACTION' && !m.isHidden).sort((a, b) => ts(b.timestamp) - ts(a.timestamp))[0];
  const chat = findChat(qc, chatID);
  if (newest && chat && ts(newest.timestamp) >= ts(chat.preview?.timestamp)) {
    const later = ts(newest.timestamp) > ts(chat.lastActivity);
    upsertChat(qc, { id: chatID, preview: newest, ...(later ? { lastActivity: newest.timestamp } : {}) });
  }
}

/**
 * Single messages looked up on their own (reply quotes, reaction previews: 'message', 'reaction-target') take a fresh
 * copy of theirs: they are kept long (persistcut.ts LOOKUP_STALE_MS) and not read again on a reconnect.
 */
function updateLookups(qc: QueryClient, chatID: string, msgs: Message[]): void {
  for (const m of msgs) {
    if (typeof m.id !== 'string') continue;
    // An updater that returns nothing leaves a query that does not exist uncreated.
    qc.setQueryData<Message>(['message', chatID, m.id], (old) => (old ? keepDelivered(old, m) : old));
    qc.setQueriesData<Message>({ queryKey: ['reaction-target', chatID, m.id] }, (old) => (old ? keepDelivered(old, m) : old));
  }
}

/**
 * Messages deleted upstream (message.deleted): their single-message lookups are read again when shown (a reply quote
 * then says it is unavailable; a reaction preview, that the reaction is gone). `chatID`: the event's (it may be an
 * alias); the lookups of any chat with these message IDs.
 */
export function dropLookups(qc: QueryClient, ids: readonly string[]): void {
  if (!ids.length) return;
  const gone = new Set(ids);
  void qc.invalidateQueries({ predicate: (q) => (q.queryKey[0] === 'message' || q.queryKey[0] === 'reaction-target') && gone.has(q.queryKey[2] as string) }, { cancelRefetch: false });
}

export function findMessage(qc: QueryClient, chatID: string, id: string): Message | undefined {
  for (const p of qc.getQueryData<Pages<Message>>(keys.messages(chatID))?.pages ?? []) {
    const m = p.items.find((x) => x.id === id);
    if (m) return m;
  }
  return qc.getQueryData<Message>(['message', chatID, id]);
}

/** Local edit of one cached message (optimistic updates); the websocket brings the real state. */
export function patchMessage(qc: QueryClient, chatID: string, id: string, fn: (m: Message) => Message): void {
  const data = qc.getQueryData<Pages<Message>>(keys.messages(chatID));
  if (!data) return;
  qc.setQueryData<Pages<Message>>(keys.messages(chatID), {
    ...data,
    pages: data.pages.map((p) => (p.items.some((x) => x.id === id) ? { ...p, items: p.items.map((x) => (x.id === id ? fn(x) : x)) } : p)),
  });
}

// Reactions in flight per message (optimistic state): background refreshes wait until they are done, so a
// slightly older server copy does not flash over the user's latest taps.
const reacting = new Map<string, number>();
export const reactionOps = {
  begin(id: string) {
    reacting.set(id, (reacting.get(id) ?? 0) + 1);
  },
  end(id: string) {
    const n = (reacting.get(id) ?? 1) - 1;
    if (n > 0) reacting.set(id, n);
    else reacting.delete(id);
  },
  busy: (id: string) => (reacting.get(id) ?? 0) > 0,
};

/** Fetch one message and merge it (reaction changes that arrive without the message itself). */
export async function refreshMessage(qc: QueryClient, chatID: string, id: string): Promise<boolean> {
  try {
    const m = await api.message(chatID, id);
    if (!m?.id || reactionOps.busy(id)) return false;
    upsertMessages(qc, m.chatID || chatID, [m]);
    return true;
  } catch {
    return false;
  }
}

const refreshTimers = new Map<string, number>();
function cancelRefresh(chatID: string, id: string) {
  const k = `${chatID}\n${id}`;
  const t = refreshTimers.get(k);
  if (t === undefined) return;
  window.clearTimeout(t);
  refreshTimers.delete(k);
}
/** Debounced refreshMessage (several reaction events for one message → one GET). */
export function refreshMessageSoon(qc: QueryClient, chatID: string, id: string, ms = 600): void {
  const k = `${chatID}\n${id}`;
  window.clearTimeout(refreshTimers.get(k));
  refreshTimers.set(
    k,
    window.setTimeout(() => {
      refreshTimers.delete(k);
      if (reactionOps.busy(id)) return refreshMessageSoon(qc, chatID, id, 1000);
      void refreshMessage(qc, chatID, id);
    }, ms),
  );
}

// ── Refreshes (refresh.ts) ──

/** Brings a cached conversation up to date with its newest page alone (refresh.ts refreshNewest). */
export const refreshNewest = (qc: QueryClient, chatID: string): Promise<void> => refresh.refreshNewest(qc, refreshApi, chatID);

/** "Something changed in this conversation", once for a burst (refresh.ts refreshConversationSoon). */
export const refreshConversationSoon = (qc: QueryClient, chatID: string): void => refresh.refreshConversationSoon(qc, refreshApi, chatID);

/** After the live socket reconnected: what may have changed and is on screen (refresh.ts refreshAfterReconnect). */
export const refreshAfterReconnect = (qc: QueryClient, openChatID: string | undefined): void => refresh.refreshAfterReconnect(qc, refreshApi, openChatID);
