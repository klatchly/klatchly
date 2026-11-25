import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
import { resolvePreviewSender, useKnownNames } from './names';
import { UnreadFilter, useUnreadFilter } from './UnreadFilter';
import { NetworkFilter, useNetworkFilter } from './NetworkFilter';
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Virtuoso } from 'react-virtuoso';
import { Link, useLocation } from 'wouter';
import { fromListState } from './nav';
import { useToast } from './conn';
import { useSheetDrag } from './sheet';
import { ChatsSkeleton } from './Skeleton';
import { api } from './endpoints';
import { chatPlace, chatsQuery, filteredPlaceholder, keys, lowPriorityQuery, removeChat, upsertChat, type Pages } from './cache';
import { fillDone, shouldFill } from './refreshpolicy';
import { canArchive, canLowPriority } from './caps';
import { prefetchChat } from './prefetch';
import { opensOnPress } from './gestures';
import { bodyLine, displaySender, relativeTime, snippet, typeLabel } from './format';
import { localized, t as tr, useLang, useT } from './i18n';
import { useConnectorUIs } from './registry';
import { Lazy } from './lazy';
import { Avatar } from './Avatar';
import { refreshBadge, unreadChats, unreadTotal } from './badge';
import { useDrafts } from './drafts';
import { reactionView } from './reactions';
import { canSendReceipt, chatReading, sendReceipt, setChatDiscreet, useReading } from './reading';
import { membershipMode, setMembershipMode, useChatEvents } from './chatevents';
import { MoonIcon, QuietChatDialog, releaseQuiet, useHeld, useQuietOn, useQuietReturn } from './quiet';
import type { Chat, Message } from './types';
import { LOOKUP_STALE_MS } from './persistcut';

export function previewText(chat: Chat): string {
  const t = tr();
  const m: Message | undefined = chat.preview;
  if (!m) return '';
  if (m.isDeleted) return t.msg.deleted;
  const body = bodyLine(m) || typeLabel(m.type) || t.types.attachment;
  if (m.isSender) return t.list.youPrefix(body);
  const sender = chat.type === 'group' ? displaySender(m) : undefined;
  if (sender) return t.list.senderPrefix(sender, body);
  return body;
}

/**
 * A reaction is the chat's latest event: the list's preview is then a bare message (no text, type or
 * attachment). The event itself says only which message it points to; the key is on that message.
 * Two small cached GETs, only for rows on screen whose preview looks like that.
 */
function useReactionPreview(chat: Chat): string | undefined {
  const p = chat.preview;
  const bare = !!p && !p.isDeleted && !p.text && !p.attachments?.length && (!p.type || p.type === 'REACTION');
  const ev = useQuery({
    queryKey: ['message', chat.id, p?.id ?? ''],
    queryFn: () => api.message(chat.id, p!.id),
    enabled: bare,
    staleTime: LOOKUP_STALE_MS,
    retry: false,
  });
  const linked = ev.data?.type === 'REACTION' && !ev.data.isDeleted ? ev.data.linkedMessageID : undefined;
  const target = useQuery({
    queryKey: ['reaction-target', chat.id, linked ?? '', p?.id ?? ''],
    queryFn: () => api.message(chat.id, linked!),
    enabled: !!linked,
    staleTime: LOOKUP_STALE_MS,
    retry: false,
  });
  if (!bare || !p || ev.data?.type !== 'REACTION') return undefined;
  // A reaction since removed (or not found): nothing to say rather than a misleading "Attachment".
  if (!linked || target.isError) return '';
  if (!target.data) return undefined;
  const r = target.data.reactions?.find((x) => x.participantID === p.senderID);
  if (!r) return '';
  const t = tr();
  const v = reactionView(r);
  const what = v.kind === 'image' ? t.reactions.withCustom : v.text;
  const body = snippet(target.data, 60);
  if (p.isSender) return t.reactions.youReacted(what, body);
  return t.reactions.reacted(displaySender(p) || chat.title, what, body);
}

function PreviewLine({ chat }: { chat: Chat }) {
  const reaction = useReactionPreview(chat);
  return (
    <span className="chat-preview" data-testid={reaction !== undefined ? 'chat-preview-reaction' : undefined}>
      {reaction ?? previewText(chat)}
    </span>
  );
}

export type ListView = 'inbox' | 'archive' | 'lowPriority' | 'quiet';
export const ARCHIVED_KEY = ['chats-archived'] as const;

type MenuAt = { chat: Chat; x: number; y: number } | { chat: Chat; sheet: true };

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = window.setTimeout(() => setD(v), ms);
    return () => window.clearTimeout(t);
  }, [v, ms]);
  return d;
}

function dedupe(pages: { items: Chat[] }[] | undefined, keep: (c: Chat) => boolean): Chat[] {
  const seen = new Set<string>();
  const out: Chat[] = [];
  for (const p of pages ?? []) {
    for (const c of p.items) {
      if (seen.has(c.id) || !keep(c)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

export function ChatList({ activeID, view }: { activeID?: string; view: ListView }) {
  const t = useT();
  const [input, setInput] = useState('');
  const query = useDebounced(input.trim(), 250);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [toast, flash] = useToast();
  const accounts = useNetworkFilter();
  const unread = useUnreadFilter();
  const [quietFor, setQuietFor] = useState<Chat | null>(null);
  // An entry of a connector's own in the chat menu (ConnectorUI.chatActions): its dialog.
  const [actionFor, setActionFor] = useState<ConnectorActionAt | null>(null);
  const connectorUIs = useConnectorUIs();
  const ActionDialog = actionFor ? connectorUIs.find((k) => k.id === actionFor.connector)?.chatActions?.Dialog : undefined;
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  // Chats whose quiet hours just ended are back in the inbox: say so once.
  const inbox = useInfiniteQuery(chatsQuery()).data;
  const inboxChats = useMemo(() => dedupe(inbox?.pages, (c) => chatPlace(c) === 'inbox'), [inbox]);
  const onBack = useCallback((n: number) => flash(t.quiet.back(n)), [flash, t]);
  useQuietReturn(inboxChats, onBack);

  return (
    <div className="chat-list-wrap">
      <div className="search-bar">
        <input
          type="search"
          value={input}
          placeholder={t.list.search}
          aria-label={t.list.search}
          data-testid="search"
          enterKeyHint="search"
          maxLength={200}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setInput('')}
        />
        <UnreadFilter />
        <NetworkFilter />
      </div>
      {query ? (
        <SearchResults query={query} accounts={accounts} activeID={activeID} onMenu={setMenu} />
      ) : view === 'archive' ? (
        <ArchivedList accounts={accounts} unread={unread} activeID={activeID} onMenu={setMenu} />
      ) : view === 'lowPriority' ? (
        <LowPriorityList accounts={accounts} unread={unread} activeID={activeID} onMenu={setMenu} onToast={flash} />
      ) : view === 'quiet' ? (
        <QuietList accounts={accounts} unread={unread} activeID={activeID} onMenu={setMenu} onToast={flash} />
      ) : (
        <InboxList accounts={accounts} unread={unread} activeID={activeID} onMenu={setMenu} />
      )}
      {menu && <ChatMenu at={menu} onClose={() => setMenu(null)} onError={flash} onQuiet={setQuietFor} onAction={setActionFor} />}
      {quietFor && <QuietChatDialog chat={quietFor} onClose={() => setQuietFor(null)} onError={flash} />}
      {actionFor && ActionDialog && (
        <Lazy failed={null} onError={() => setActionFor(null)}>
          <ActionDialog
            action={actionFor.action}
            chat={{ id: actionFor.chat.id, title: actionFor.chat.title, accountID: actionFor.chat.accountID, network: actionFor.chat.network, type: actionFor.chat.type }}
            close={() => setActionFor(null)}
            notify={flash}
            gone={() => {
              const id = actionFor.chat.id;
              removeChat(qc, id);
              // The menu also opens from the archive and from search results: gone from those too.
              for (const key of [ARCHIVED_KEY, keys.searchChats]) {
                qc.setQueriesData<Pages<Chat>>({ queryKey: key }, (old) =>
                  old?.pages ? { ...old, pages: old.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== id) })) } : old,
                );
              }
              // The archive search index lags a few seconds behind (as after archiving): refetch later, not now.
              window.setTimeout(() => void qc.invalidateQueries({ queryKey: ARCHIVED_KEY }), 5000);
              qc.removeQueries({ queryKey: keys.chat(id) });
              if (activeID === id) navigate('/', { replace: true });
            }}
          />
        </Lazy>
      )}
      {toast && <div className="toast" role="status" data-testid="toast">{toast}</div>}
    </div>
  );
}

type RowProps = { activeID?: string; onMenu: (m: MenuAt) => void };
type Filtered = { accounts: string[] };
type Lists = Filtered & { unread: boolean };

const inAccounts = (chats: Chat[], accounts: string[]) =>
  accounts.length ? chats.filter((c) => accounts.includes(c.accountID)) : chats;

/** The list's filters: networks, and "unread only" (the open chat stays: it is read as it opens). */
const filtered = (chats: Chat[], accounts: string[], unread: boolean, activeID: string | undefined) => {
  const on = inAccounts(chats, accounts);
  return unread ? on.filter((c) => c.unreadCount > 0 || c.id === activeID) : on;
};

/**
 * With a filter, keep loading pages until enough matching chats show, within a few pages (refreshpolicy.ts): the
 * network filter's lists are filtered by the server, "unread only" pages through the recent chats.
 */
function useFillFilter(
  accounts: string[],
  shown: number,
  q: { hasNextPage: boolean; isFetchingNextPage: boolean; isPending: boolean; isPlaceholderData?: boolean; fetchNextPage: () => unknown; data?: { pages: unknown[] } },
  unread = false,
): void {
  const pages = q.data?.pages.length ?? 0;
  const busy = q.isFetchingNextPage || q.isPending || !!q.isPlaceholderData;
  useEffect(() => {
    if (shouldFill({ accounts, unread, pages, shown, hasNextPage: q.hasNextPage, busy })) void q.fetchNextPage();
  }, [accounts, unread, pages, shown, q.hasNextPage, busy]);
}

/** Whether an empty list under a filter may say so: loaded, and nothing more it would load by itself. */
const emptyDone = (q: { isSuccess: boolean; isPlaceholderData?: boolean; hasNextPage: boolean; data?: { pages: unknown[] } }, accounts: string[], unread: boolean) =>
  q.isSuccess && !q.isPlaceholderData && fillDone({ accounts, unread, pages: q.data?.pages.length ?? 0, shown: 0, hasNextPage: q.hasNextPage });

/**
 * What an empty filtered list says: no unread chats, or none on these networks. When it stopped loading pages by
 * itself with more left (refreshpolicy.ts: its cap), it says so and offers to look further back.
 */
function EmptyFiltered({ unread, q }: { unread: boolean; q?: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  const t = useT();
  if (q?.hasNextPage) {
    return (
      <div className="list-status" data-testid="no-filtered">
        <div>{t.list.noneRecent}</div>
        <button type="button" className="text-btn" data-testid="filtered-more" disabled={q.isFetchingNextPage} aria-busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? '…' : t.list.lookFurther}
        </button>
      </div>
    );
  }
  return (
    <div className="list-status" data-testid="no-filtered">
      {unread ? t.list.noUnread : t.list.noChatsForNetworks}
    </div>
  );
}

function InboxList({ activeID, onMenu, accounts, unread }: RowProps & Lists) {
  const qc = useQueryClient();
  // The whole list (the title and the badge count all of it), and the one shown: with a network filter, that
  // filter's own list, filtered by the server (no paging through the whole list for matches). The client filters
  // again: a connector may give its chats whatever the filter.
  const q = useInfiniteQuery(chatsQuery());
  const shownQ = useInfiniteQuery({ ...chatsQuery(accounts), placeholderData: () => filteredPlaceholder(qc, accounts) });
  // The chat list also carries low-priority chats: they have their own view.
  // Chats held by quiet hours (quiet.tsx) wait under their own tab until their window closes; the open one stays.
  const held = useHeld();
  const inboxOf = useCallback((c: Chat) => chatPlace(c) === 'inbox' && (!held(c) || c.id === activeID), [held, activeID]);
  const all = useMemo(() => dedupe(q.data?.pages, inboxOf), [q.data, inboxOf]);
  const list = useMemo(() => (accounts.length ? dedupe(shownQ.data?.pages, inboxOf) : all), [accounts.length, shownQ.data, inboxOf, all]);
  const chats = useMemo(() => filtered(list, accounts, unread, activeID), [list, accounts, unread, activeID]);
  useFillFilter(accounts, chats.length, shownQ, unread);

  // Title and app badge always count every inbox chat: a filter must not hide unread messages (held ones wait).
  useEffect(() => {
    const n = unreadChats(all);
    document.title = n > 0 ? `(${n})` : '•';
    refreshBadge(unreadTotal(all));
  }, [all]);

  if ((accounts.length || unread) && !chats.length && emptyDone(shownQ, accounts, unread)) {
    return <EmptyFiltered unread={unread} q={shownQ} />;
  }
  return <VirtualChats q={shownQ} chats={chats} activeID={activeID} onMenu={onMenu} />;
}

/**
 * The chats quiet hours hold now (from the inbox's pages, where new messages land): until their window closes, or
 * "Show them now". Opening one reads it, and it goes back to the inbox.
 */
function QuietList({ activeID, onMenu, accounts, unread, onToast }: RowProps & Lists & { onToast: (text: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const q = useInfiniteQuery(chatsQuery());
  const on = useQuietOn();
  const held = useHeld();
  const [busy, setBusy] = useState(false);
  const all = useMemo(() => dedupe(q.data?.pages, (c) => chatPlace(c) === 'inbox' && (held(c) || c.id === activeID)), [q.data, held, activeID]);
  const chats = useMemo(() => filtered(all, accounts, unread, activeID), [all, accounts, unread, activeID]);
  const release = async () => {
    setBusy(true);
    try {
      await releaseQuiet(qc);
      onToast(t.quiet.released);
    } catch {
      onToast(t.quiet.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="list-actions quiet-head" data-testid="quiet-head">
        <span className="quiet-head-text">{chats.length ? t.quiet.held(chats.length) : on ? t.quiet.empty : t.quiet.emptyNoRule}</span>
        {chats.length > 0 && (
          <button type="button" className="text-btn" data-testid="quiet-release" disabled={busy} aria-busy={busy} onClick={() => void release()}>
            {t.quiet.release}
          </button>
        )}
        <button type="button" className="icon-btn small" aria-label={t.quiet.openSettings} title={t.quiet.openSettings} data-testid="quiet-settings" onClick={() => navigate('/settings/quiet')}>
          <MoonIcon size={16} />
        </button>
      </div>
      {chats.length > 0 && <VirtualChats q={q} chats={chats} activeID={activeID} onMenu={onMenu} />}
    </>
  );
}

function ArchivedList({ activeID, onMenu, accounts, unread }: RowProps & Lists) {
  const t = useT();
  // With a network filter, that filter's own archive (filtered by the server), under ARCHIVED_KEY.
  const q = useInfiniteQuery({
    queryKey: [...ARCHIVED_KEY, ...[...new Set(accounts)].sort()],
    queryFn: ({ pageParam }) => api.archivedChats(pageParam, accounts.length ? accounts : undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? (last.oldestCursor ?? undefined) : undefined),
    staleTime: 0,
  });
  const chats = useMemo(() => filtered(dedupe(q.data?.pages, (c) => c.isArchived !== false), accounts, unread, activeID), [q.data, accounts, unread, activeID]);
  useFillFilter(accounts, chats.length, q, unread);
  if (!chats.length && (accounts.length || unread ? emptyDone(q, accounts, unread) : q.isSuccess && !q.hasNextPage)) return unread || q.hasNextPage ? <EmptyFiltered unread={unread} q={q} /> : <div className="list-status" data-testid="no-archived">{t.list.noArchived}</div>;
  return <VirtualChats q={q} chats={chats} activeID={activeID} onMenu={onMenu} />;
}

function LowPriorityList({ activeID, onMenu, accounts, unread, onToast }: RowProps & Lists & { onToast: (text: string) => void }) {
  const t = useT();
  // With a network filter, that filter's own low-priority inbox (filtered by the server).
  const q = useInfiniteQuery(lowPriorityQuery(undefined, accounts));
  // The chat list (which also carries low-priority chats) has their last message; search results do not.
  const inbox = useInfiniteQuery(chatsQuery()).data;
  const chats = useMemo(() => {
    const previews = new Map<string, Chat['preview']>();
    for (const p of inbox?.pages ?? []) for (const c of p.items) if (c.preview) previews.set(c.id, c.preview);
    const list = dedupe(q.data?.pages, (c) => chatPlace(c) === 'lowPriority').map((c) => (c.preview || !previews.has(c.id) ? c : { ...c, preview: previews.get(c.id) }));
    return filtered(list, accounts, unread, activeID);
  }, [q.data, inbox, accounts, unread, activeID]);
  useFillFilter(accounts, chats.length, q, unread);
  if (!chats.length && (accounts.length || unread ? emptyDone(q, accounts, unread) : q.isSuccess && !q.hasNextPage)) return unread || q.hasNextPage ? <EmptyFiltered unread={unread} q={q} /> : <div className="list-status" data-testid="no-lowpri">{t.list.noLowPriority}</div>;
  return (
    <>
      {q.isSuccess && <MarkAllRead onToast={onToast} />}
      <VirtualChats q={q} chats={chats} activeID={activeID} onMenu={onMenu} />
    </>
  );
}

/**
 * "Mark all as read" over the low-priority list: every low-priority chat, not only the loaded pages (the server
 * pages through the inbox: server/readall.ts), after a confirmation. Then the lists and the badge refresh.
 */
function MarkAllRead({ onToast }: { onToast: (text: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setAsking(false);
    setBusy(true);
    try {
      const r = await api.readAllLowPriority();
      onToast(r.failed ? `${t.list.markedRead(r.marked)} · ${t.list.markReadFailed}` : t.list.markedRead(r.marked));
    } catch {
      onToast(t.list.markReadFailed);
    } finally {
      setBusy(false);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.lowPriority }), qc.invalidateQueries({ queryKey: keys.chats })]);
      refreshBadge(0);
    }
  };
  return (
    <div className="list-actions">
      <button type="button" className="text-btn" data-testid="lowpri-read-all" disabled={busy} aria-busy={busy} onClick={() => setAsking(true)}>
        {busy ? t.list.markingRead : t.list.markAllRead}
      </button>
      {asking && <ConfirmReadAll onCancel={() => setAsking(false)} onConfirm={() => void run()} />}
    </div>
  );
}

function ConfirmReadAll({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="confirm" aria-label={t.list.markAllRead} data-testid="confirm-read-all" onCancel={onCancel} onClose={onCancel}>
      <p>{t.list.markAllReadConfirm}</p>
      <div className="confirm-actions">
        <button type="button" className="text-btn" onClick={onCancel} autoFocus>
          {t.common.cancel}
        </button>
        <button type="button" className="text-btn" data-testid="confirm-read-all-ok" onClick={onConfirm}>
          {t.list.markAllRead}
        </button>
      </div>
    </dialog>
  );
}

function VirtualChats({
  q,
  chats,
  activeID,
  onMenu,
}: RowProps & {
  chats: Chat[];
  q: { isPending: boolean; isError: boolean; hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown; refetch: () => unknown };
}) {
  const t = useT();
  if (q.isPending) return <ChatsSkeleton />;
  if (q.isError) {
    return (
      <div className="list-status">
        <button type="button" className="text-btn" data-testid="retry" onClick={() => q.refetch()}>
          {t.common.retry}
        </button>
      </div>
    );
  }
  return (
    <Virtuoso
      className="chat-list"
      data={chats}
      computeItemKey={(_, c) => c.id}
      endReached={() => {
        if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
      }}
      increaseViewportBy={400}
      itemContent={(_, chat) => <ChatRow chat={chat} active={chat.id === activeID} onMenu={onMenu} />}
    />
  );
}

function SearchResults({ query, accounts, activeID, onMenu }: RowProps & Filtered & { query: string }) {
  const t = useT();
  const chatsQ = useInfiniteQuery({
    queryKey: [...keys.searchChats, query, accounts],
    queryFn: () => api.searchChats(query, accounts),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: () => undefined,
    staleTime: 30_000,
  });
  const msgQ = useInfiniteQuery({
    queryKey: ['search-messages', query, accounts],
    queryFn: ({ pageParam }) => api.searchMessages(query, pageParam, accounts),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? (last.oldestCursor ?? undefined) : undefined),
    staleTime: 30_000,
  });
  const chats = useMemo(() => dedupe(chatsQ.data?.pages, () => true), [chatsQ.data]);
  const chatMap = useMemo(() => Object.assign({}, ...(msgQ.data?.pages ?? []).map((p) => p.chats)) as Record<string, Chat>, [msgQ.data]);
  const messages = useMemo(() => (msgQ.data?.pages ?? []).flatMap((p) => p.items), [msgQ.data]);
  const busy = chatsQ.isPending || msgQ.isPending;

  return (
    <div className="search-results" data-testid="search-results">
      <h3 className="search-h">{t.list.searchChats}</h3>
      {chatsQ.isPending ? (
        <div className="list-status">…</div>
      ) : chats.length ? (
        chats.map((c) => <ChatRow key={c.id} chat={c} active={c.id === activeID} onMenu={onMenu} />)
      ) : (
        <div className="search-empty">{t.list.noChats}</div>
      )}
      <h3 className="search-h">{t.list.searchMessages}</h3>
      {msgQ.isPending ? (
        <div className="list-status">…</div>
      ) : messages.length ? (
        messages.map((m) => <MessageResult key={`${m.chatID}/${m.id}`} m={m} chat={chatMap[m.chatID]} />)
      ) : (
        <div className="search-empty">{msgQ.isError ? t.list.searchUnavailable : t.list.noMessages}</div>
      )}
      {msgQ.hasNextPage && (
        <div className="list-status">
          <button type="button" className="text-btn" disabled={msgQ.isFetchingNextPage} onClick={() => void msgQ.fetchNextPage()}>
            {msgQ.isFetchingNextPage ? '…' : t.list.moreResults}
          </button>
        </div>
      )}
      {!busy && chatsQ.isError && msgQ.isError && <div className="list-status">{t.list.searchUnavailable}</div>}
    </div>
  );
}

/** Opening a chat from the list: marked in history so Back pops it (no new list entry). */
function useOpenFromList(href: string) {
  const [, navigate] = useLocation();
  // Without an event: open it now (a mouse button going down on the row).
  return (e?: MouseEvent) => {
    if (e?.defaultPrevented) return;
    e?.preventDefault();
    navigate(href, { state: fromListState() });
  };
}

function MessageResult({ m, chat }: { m: Message; chat?: Chat }) {
  const t = useT();
  const href = `/chat/${encodeURIComponent(m.chatID)}?m=${encodeURIComponent(m.id)}`;
  const openChat = useOpenFromList(href);
  const who = m.isSender ? t.common.you : displaySender(m);
  const body = snippet(m, 160);
  return (
    <Link href={href} className="chat-row result-row" data-testid="message-result" onClick={openChat}>
      {chat ? <Avatar chat={chat} /> : <span className="avatar" style={{ width: 44, height: 44 }} />}
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className="chat-title">{chat?.title ?? '…'}</span>
          <span className="chat-time">{relativeTime(m.timestamp)}</span>
        </span>
        <span className="chat-row-bottom">
          <span className="chat-preview">
            {who && chat?.type === 'group' ? t.list.senderPrefix(who, body) : m.isSender ? t.list.youPrefix(body) : body}
          </span>
        </span>
      </span>
    </Link>
  );
}

function ChatRow({ chat, active, onMenu }: { chat: Chat; active: boolean; onMenu: (m: MenuAt) => void }) {
  const t = useT();
  const qc = useQueryClient();
  // A pointer resting on the row (or a finger on it) starts loading the conversation before the click.
  const hover = useRef<number>(undefined);
  // The chat was opened as the mouse button went down (onPointerDown): the click that follows does nothing more.
  const down = useRef(false);
  useKnownNames();
  useEffect(() => resolvePreviewSender(chat), [chat.id, chat.preview?.id]);
  const draft = useDrafts()[chat.id];
  const unread = chat.unreadCount > 0;
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const href = `/chat/${encodeURIComponent(chat.id)}`;
  const openChat = useOpenFromList(href);
  const touch = {
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      prefetchChat(qc, chat);
      const p = { x: t.clientX, y: t.clientY, fired: false, timer: 0 };
      p.timer = window.setTimeout(() => {
        p.fired = true;
        navigator.vibrate?.(10);
        // iOS may already have started a text selection under the finger.
        window.getSelection()?.removeAllRanges();
        onMenu({ chat, sheet: true });
      }, 500);
      press.current = p;
    },
    onTouchMove: (e: TouchEvent) => {
      const p = press.current;
      const t = e.touches[0];
      if (p && t && (Math.abs(t.clientX - p.x) > 8 || Math.abs(t.clientY - p.y) > 8)) window.clearTimeout(p.timer);
    },
    onTouchEnd: (e: TouchEvent) => {
      const p = press.current;
      if (!p) return;
      window.clearTimeout(p.timer);
      // The menu sheet now lies under the finger: no synthetic click on it (nor on the row).
      if (p.fired && e.cancelable) e.preventDefault();
    },
  };
  return (
    <Link
      href={href}
      className={`chat-row ${active ? 'active' : ''} ${unread ? 'unread' : ''}`}
      data-testid="chat-row"
      data-chat-id={chat.id}
      {...touch}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') hover.current = window.setTimeout(() => prefetchChat(qc, chat), 80);
      }}
      onPointerLeave={() => window.clearTimeout(hover.current)}
      onFocus={() => prefetchChat(qc, chat)}
      onPointerDown={(e: PointerEvent) => {
        // A mouse opens the chat as its button goes down (gestures.ts opensOnPress); its click then does nothing more.
        down.current = opensOnPress(e, active);
        if (down.current) openChat();
      }}
      onClick={(e: MouseEvent) => {
        // A long-press opened the menu: do not also open the chat.
        if (press.current?.fired) {
          e.preventDefault();
          press.current = null;
          return;
        }
        // Already opened as the mouse button went down.
        if (down.current) {
          down.current = false;
          e.preventDefault();
          return;
        }
        openChat(e);
      }}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        if (press.current?.fired) return;
        onMenu({ chat, x: e.clientX, y: e.clientY });
      }}
    >
      <Avatar chat={chat} />
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className="chat-title">{chat.title || '…'}</span>
          <span className="chat-time">{relativeTime(chat.preview?.timestamp ?? chat.lastActivity)}</span>
        </span>
        <span className="chat-row-bottom">
          {draft && !active ? (
            <span className="chat-preview" data-testid="chat-draft">
              <span className="draft-label">{t.list.draft}</span> {draft.text.replace(/\s+/g, ' ').slice(0, 160)}
            </span>
          ) : (
            <PreviewLine chat={chat} />
          )}
          {chat.isMuted && (
            <svg className="muted-icon" viewBox="0 0 24 24" width="14" height="14" aria-label={t.list.muted} role="img">
              <path d="M11 5 6 9H3v6h3l5 4V5zM22 9l-6 6M16 9l6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {chat.isPinned && <span className="pin" aria-label={t.list.pinned} title={t.list.pinned}>📌</span>}
          {chat.isArchived && <span className="arch-tag">{t.list.archived}</span>}
          {unread && <span className={`badge ${chat.isMuted ? 'badge-muted' : ''}`} aria-label={t.list.unreadCount(chat.unreadCount)}>{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</span>}
        </span>
      </span>
    </Link>
  );
}

/** Replace a chat's flags in the cached archive list (the archive search index lags behind). */
function patchArchived(qc: QueryClient, id: string, flags: Partial<Chat>): void {
  qc.setQueriesData<Pages<Chat>>({ queryKey: ARCHIVED_KEY }, (arch) =>
    arch?.pages ? { ...arch, pages: arch.pages.map((p) => ({ ...p, items: p.items.map((c) => (c.id === id ? { ...c, ...flags } : c)) })) } : arch,
  );
}

/** Apply a chat action upstream, then mirror it in the cached lists. */
async function chatAction(qc: QueryClient, chat: Chat, action: 'pin' | 'mute' | 'archive' | 'lowPriority', value: boolean): Promise<void> {
  if (action === 'lowPriority') {
    // The server also mutes a chat moved in, and unmutes it on the way back if that move had muted it.
    const updated = await api.patchChat(chat.id, { isLowPriority: value });
    const flags: Partial<Chat> = {
      isLowPriority: typeof updated?.isLowPriority === 'boolean' ? updated.isLowPriority : value,
      ...(typeof updated?.isMuted === 'boolean' ? { isMuted: updated.isMuted } : {}),
    };
    // The whole chat (title included): it can move into a list that has not loaded it.
    upsertChat(qc, { ...chat, ...flags });
    patchArchived(qc, chat.id, flags);
    // Upstream lists lag a few seconds behind the change: refetch later (the inbox for its order), not now.
    window.setTimeout(() => {
      void qc.invalidateQueries({ queryKey: keys.lowPriority });
      if (!value) void qc.invalidateQueries({ queryKey: keys.chats });
    }, 5000);
    return;
  }
  if (action === 'archive') {
    await api.archive(chat.id, value);
    // Unarchived, the whole chat goes back to the inbox or the low-priority list.
    upsertChat(qc, value ? { id: chat.id, isArchived: true } : { ...chat, isArchived: false });
    if (!value) void qc.invalidateQueries({ queryKey: keys.chats });
    if (!value) {
      qc.setQueriesData<Pages<Chat>>({ queryKey: ARCHIVED_KEY }, (arch) =>
        arch?.pages ? { ...arch, pages: arch.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== chat.id) })) } : arch,
      );
    }
    // The archive search index lags a few seconds behind: refetch later, not now.
    window.setTimeout(() => void qc.invalidateQueries({ queryKey: ARCHIVED_KEY }), 5000);
    return;
  }
  const patch = action === 'pin' ? { isPinned: value } : { isMuted: value };
  const updated = await api.patchChat(chat.id, patch);
  upsertChat(qc, { id: chat.id, ...patch, ...(typeof updated?.isPinned === 'boolean' ? { isPinned: updated.isPinned } : {}), ...(typeof updated?.isMuted === 'boolean' ? { isMuted: updated.isMuted } : {}) });
  void qc.invalidateQueries({ queryKey: ARCHIVED_KEY });
}

/** A connector's entry chosen in a chat's menu (ConnectorUI.chatActions): which, for which chat. */
type ConnectorActionAt = { connector: string; action: string; chat: Chat };
const ACTION_ID = /^[a-z][a-z0-9-]{0,31}$/;

function ChatMenu({ at, onClose, onError, onQuiet, onAction }: { at: MenuAt; onClose: () => void; onError: (t: string) => void; onQuiet: (chat: Chat) => void; onAction: (a: ConnectorActionAt) => void }) {
  const qc = useQueryClient();
  const t = useT();
  const lang = useLang();
  const connectorUIs = useConnectorUIs();
  const { chat } = at;
  const reading = useReading().data;
  const chatEvents = useChatEvents().data;
  const sheet = 'sheet' in at;
  const ref = useSheetDrag(sheet, onClose);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (sheet || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)),
    });
  }, [at, sheet]);

  const items: { id: string; label: string; run: () => Promise<void>; checked?: boolean }[] = [
    { id: 'pin', label: chat.isPinned ? t.chatMenu.unpin : t.chatMenu.pin, run: () => chatAction(qc, chat, 'pin', !chat.isPinned) },
    { id: 'mute', label: chat.isMuted ? t.chatMenu.unmute : t.chatMenu.mute, run: () => chatAction(qc, chat, 'mute', !chat.isMuted) },
  ];
  if (canLowPriority(chat)) {
    items.push({
      id: 'lowpri',
      label: chat.isLowPriority ? t.chatMenu.toInbox : t.chatMenu.toLowPriority,
      run: () => chatAction(qc, chat, 'lowPriority', !chat.isLowPriority),
    });
  }
  if (canArchive(chat)) {
    items.push({ id: 'archive', label: chat.isArchived ? t.chatMenu.unarchive : t.chatMenu.archive, run: () => chatAction(qc, chat, 'archive', !chat.isArchived) });
  }
  // Discreet reading: the read receipt only when asked (its outcome as a toast, success too).
  if (canSendReceipt(reading, chat)) items.push({ id: 'mark-read', label: t.reading.markRead, run: async () => onError(await sendReceipt(qc, chat.id, t)) });
  // This chat's own choice, shown checked as it applies now (its own, else its account's); "back to the account's"
  // once it has one. Only where the choice changes something (a receipt can go now).
  const r = chatReading(reading, chat);
  if (r.choosable) {
    items.push({ id: 'discreet', label: t.reading.title, checked: r.discreet, run: () => setChatDiscreet(qc, chat.id, !r.discreet) });
    if (r.own !== undefined) items.push({ id: 'discreet-reset', label: t.reading.useAccount, run: () => setChatDiscreet(qc, chat.id, null) });
  }
  // Arrivals and departures in a group: hidden here, or shown again (as for all chats, else grouped).
  if (chat.type === 'group' && chatEvents) {
    const mode = membershipMode(chatEvents, chat.id);
    items.push(
      mode === 'hide'
        ? { id: 'members-show', label: t.members.show, run: () => setMembershipMode(qc, chatEvents.membership === 'hide' ? 'group' : null, chat.id) }
        : { id: 'members-hide', label: t.members.hide, run: () => setMembershipMode(qc, chatEvents.membership === 'hide' ? null : 'hide', chat.id) },
    );
  }
  // Quiet hours: its own, its network's, or never (a dialog).
  items.push({ id: 'quiet', label: t.quiet.menu, run: async () => onQuiet(chat) });
  // The connectors' own entries for this chat (leaving a Matrix room…), each a dialog of theirs.
  for (const k of connectorUIs) {
    if (!k.chatActions || !k.owns?.(chat.id)) continue;
    for (const a of k.chatActions.list(chat)) {
      if (!ACTION_ID.test(a.id) || items.some((x) => x.id === a.id)) continue;
      items.push({ id: a.id, label: localized(a.label, lang), run: async () => onAction({ connector: k.id, action: a.id, chat }) });
    }
  }

  return (
    <div className={`menu-backdrop ${sheet ? 'sheet-backdrop' : ''}`} onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className={`msg-menu ${sheet ? 'sheet' : 'popover'}`}
        role="menu"
        aria-label={t.chatMenu.actions(chat.title)}
        data-testid="chat-menu"
        style={sheet ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
        onClick={(e) => e.stopPropagation()}
      >
        {sheet && <div className="sheet-grab" aria-hidden="true" />}
        <div className="menu-title">{chat.title}</div>
        <ul className="menu-list">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={it.checked}
                className={it.checked === undefined ? undefined : 'menu-check'}
                data-testid={`chat-menu-${it.id}`}
                onClick={() => {
                  onClose();
                  it.run().catch(() => onError(t.chatMenu.failed));
                }}
              >
                {it.label}
                {it.checked !== undefined && <span className="menu-check-mark" aria-hidden="true">{it.checked ? '✓' : ''}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
