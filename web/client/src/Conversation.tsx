import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type TouchEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useLocation } from 'wouter';
import { backToList, replaceKeepState } from './nav';
import { ConnBar } from './ConnBar';
import { MessagesSkeleton } from './Skeleton';
import { useToast } from './conn';
import { api, attachmentUrl, mediaUrl, upload, type MediaTab, type SendBody } from './endpoints';
import { canSendVoice, type Recorded } from './recorder';
import { Composer, useTray, type TrayItem } from './Composer';
import { chatMediaQuery, findChat, findMessage, keys, messagesQuery, patchMessage, reactionOps, refreshMessageSoon, upsertMessages } from './cache';
import { forwardJobOf, startForward, useForward } from './forward';
import { canAttach, canDelete, canEdit, canMention, canReply, chatNetwork } from './caps';
import { ConvContext, type Conv, type MenuMode } from './convctx';
import { planToggle, rememberReaction } from './reactions';
import { displaySender } from './format';
import { isRawUserID } from '../../server/names';
import { useAugmentations } from './registry';
import type { MenuState } from './MessageMenu';
import { Avatar } from './Avatar';
import { NetworkBadge, networkName } from './networks';
import { MessageItem, QuoteThumb, quoteText, rowKey, rowMsgs, type Row } from './MessageItem';
import { groupAlbums, isAlbum } from './albums';
import { deliveryReceipts, readReceipts } from './receipts';
import type { LightboxItem } from './Lightbox';
import { Lazy, lazyChunk } from './lazy';
import { galleryOf } from './gallery';
import { outgoing, useOutgoing, type Outgoing } from './pending';
import { markChatRead } from './read';
import { DiscreetMark, MarkReadButton, ReplyHint } from './reading';
import { firstUnreadIndex, oldestIncoming, openAtDivider, previewRange } from './unread';
import { prependedRows } from './rowshift';
import { t as tr, useT } from './i18n';
import type { Chat, Message } from './types';
import type { MediaTarget } from './attach';
import { SaveDock } from './SaveDock';

// Opened on demand (long-press, a tap on a picture): own chunks, fetched once a conversation has settled so
// the first long-press does not wait.
const MessageMenu = lazyChunk(() => import('./MessageMenu'), 'MessageMenu');
const Lightbox = lazyChunk(() => import('./Lightbox'), 'Lightbox');
const FileViewer = lazyChunk(() => import('./FileViewer'), 'FileViewer');
const ChatMedia = lazyChunk(() => import('./ChatMedia'), 'ChatMedia');
const ForwardHost = lazyChunk(() => import('./Forward'), 'ForwardHost');
function preloadExtras(): () => void {
  const run = () => {
    MessageMenu.preload();
    Lightbox.preload();
    FileViewer.preload();
  };
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 3000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}

const BASE = 1_000_000;
// The ids a row is followed by from one list of rows to the next (rowshift.ts).
const rowIDs = (r: Row): string[] => (r.kind === 'out' ? [r.o.localId] : rowMsgs(r).map((m) => m.id));
const REACTION_TIMEOUT_MS = 15_000;
const MIN_ROWS = 15;
const MAX_FILL_PAGES = 10;
// Rows Virtuoso draws above the screen (increaseViewportBy.top), in px.
const OVERSCAN_TOP = 600;
// And below it: as much as Virtuoso may scroll at once to keep the reader's place when rows above it take their real
// height (the difference with its estimate: up to a screen in a chat of long texts). Its range of drawn rows is the
// one of the position before that scroll, for the frame: rows within less than that were missing for a frame (blank
// under the messages, a flash while scrolling up).
const OVERSCAN_BOTTOM = 1000;
// On iOS, while rows not measured yet are drawn to be measured (Conversation: `measuring`): every loaded row above.
const MEASURE_ALL = 1_000_000;
// Virtuoso's own test for iOS, where it keeps the scroll position untouched while the page scrolls (a momentum
// scroll stops when it is set) and holds its corrections in an offset of the list instead, applied once it stops.
const IOS_WEBKIT = /iP(ad|od|hone)/i.test(navigator.userAgent) && /WebKit/i.test(navigator.userAgent);
// Unread messages looked for at most this far back (the divider), and a rough row height for "a screen".
const MAX_UNREAD = 300;
const ROW_PX = 64;
const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (window.clearTimeout(t), resolve(v)),
      (e) => (window.clearTimeout(t), reject(e)),
    );
  });
const visible = (m: Message) => m.type !== 'REACTION' && !m.isHidden;
const isGroupChat = (c: Chat | undefined) => c?.type === 'group';

// Row wrappers are cached per message object so unchanged messages keep the same props (MessageItem is
// memoized): a websocket event only re-renders the rows it actually changed.
const msgRows = new WeakMap<Message, Row>();
const outRows = new WeakMap<Outgoing, Row>();
const rowFor = (m: Message): Row => {
  let r = msgRows.get(m);
  if (!r) msgRows.set(m, (r = { kind: 'msg', m }));
  return r;
};
// Albums (albums.ts): the same row object while its messages are the same objects.
const albumRows = new WeakMap<Message, Row & { kind: 'album' }>();
const albumRowFor = (ms: Message[]): Row => {
  const r = albumRows.get(ms[0]!);
  if (r && r.ms.length === ms.length && r.ms.every((m, i) => m === ms[i])) return r;
  const n = { kind: 'album' as const, ms };
  albumRows.set(ms[0]!, n);
  return n;
};
const outRowFor = (o: Outgoing): Row => {
  let r = outRows.get(o);
  if (!r) outRows.set(o, (r = { kind: 'out', o }));
  return r;
};

type ListCtx = { fetching: boolean; hasMore: boolean };
const ListHeader = ({ context }: { context?: ListCtx }) => (
  <div className="older">{context?.fetching ? '…' : context?.hasMore ? '' : ' '}</div>
);
const ListFooter = () => <div className="list-foot" />;
const LIST_COMPONENTS = { Header: ListHeader, Footer: ListFooter };
/** The message list while Virtuoso places its first rows (Conversation: `placed`). */
const UNPLACED = { visibility: 'hidden' } as const;

/**
 * The messages a list about to show will show, while Virtuoso places it (hidden, over a few frames): the rows of one
 * screen, laid out as the list lays them out (a block scroller, the same rows and header/footer), scrolled to the
 * bottom or to the unread divider as the list opens. A conversation in the cache thus shows its messages on the first
 * frame, and the list replaces this in place once placed.
 */
function ListPreview({ count, from, rowKey, renderRow, header }: { count: number; from?: number; rowKey: (i: number) => string; renderRow: (i: number) => ReactNode; header: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const at = from !== undefined && from >= 0 ? from : undefined;
  const [n, setN] = useState(() => Math.ceil(window.innerHeight / 56) + 2);
  const { lo, hi } = previewRange(count, n, at);
  // At the bottom, the layout itself keeps it there (column-reverse: a picture or a video taking its size grows the
  // rows upwards, in the same frame); at the divider, the row is put back in place as rows change height.
  const place = useCallback(() => {
    const el = ref.current;
    const row = at !== undefined ? el?.querySelector<HTMLElement>(`[data-preview-row="${at}"]`) : null;
    if (el && row) el.scrollTop = row.offsetTop - 8;
  }, [at]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A picture of the list, not the list: nothing looking for a message, a control or an id (the menu, the viewer,
    // scripts) finds its copies, only the list's own (the same render task, before anything else runs).
    for (const node of el.querySelectorAll<HTMLElement>('[data-testid], [data-mid], [id]')) {
      node.removeAttribute('data-testid');
      node.removeAttribute('id');
      if (node.dataset.mid) {
        node.dataset.previewMid = node.dataset.mid;
        delete node.dataset.mid;
      }
    }
    // Not a screen of rows (below the divider when it opens there): twice as many, before this frame is painted.
    const row = at !== undefined ? el.querySelector<HTMLElement>(`[data-preview-row="${at}"]`) : null;
    const short = el.scrollHeight - (row ? row.offsetTop - 8 : 0) <= el.clientHeight + 40;
    if (short && (at !== undefined ? hi < count : lo > 0) && n < 200) return setN(n * 2);
    place();
  });
  useEffect(() => {
    const rows = ref.current?.firstElementChild;
    if (at === undefined || !rows || !('ResizeObserver' in window)) return;
    const obs = new ResizeObserver(place);
    obs.observe(rows);
    return () => obs.disconnect();
  }, [at, place]);
  const items: ReactNode[] = [];
  for (let i = lo; i < hi; i++)
    items.push(
      <div key={rowKey(i)} data-preview-row={i}>
        {renderRow(i)}
      </div>,
    );
  return (
    <div ref={ref} className={`list-preview ${at === undefined ? 'at-bottom' : ''}`} data-list-preview aria-hidden="true" inert>
      <div className="list-preview-rows">
        {lo === 0 && header}
        {items}
        {hi === count && <ListFooter />}
      </div>
    </div>
  );
}

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function sameMap(a: Map<string, string>, b: Map<string, string>) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export function Conversation({ chatID, focus, compose, sub }: { chatID: string; focus?: string; compose?: boolean; sub?: MediaTab }) {
  const qc = useQueryClient();
  const t = useT();
  const [, navigate] = useLocation();
  // "Reply" from a notification (no inline reply on this platform): focus the composer once.
  const [composeKey, setComposeKey] = useState<string>();
  useEffect(preloadExtras, []);
  useEffect(() => {
    if (!compose) return;
    setComposeKey(`compose-${Date.now()}`);
    replaceKeepState(navigate, `/chat/${encodeURIComponent(chatID)}`);
  }, [compose, chatID, navigate]);
  const chatQ = useQuery({
    queryKey: keys.chat(chatID),
    queryFn: () => api.chat(chatID),
    placeholderData: () => findChat(qc, chatID),
  });
  const chat: Chat | undefined = chatQ.data;

  // Rows only read the chat's type, capabilities and read-only flag: keep the same object while those
  // are unchanged (a new preview or unread count must not re-render every message).
  const chatSig = chat ? JSON.stringify([chat.type, chat.isReadOnly, chat.capabilities ?? null, chat.network]) : '';
  const stableChat = useRef<{ sig: string; chat?: Chat }>({ sig: '' });
  if (stableChat.current.sig !== chatSig) stableChat.current = { sig: chatSig, chat };
  const rowChat = stableChat.current.chat;

  // Unread count when the chat opened, read before mark-read clears it: where the divider goes. Not in the
  // cache (opened from a notification): the first copy fetched from the server.
  const unreadAt = useRef<number | undefined>(findChat(qc, chatID)?.unreadCount);
  if (unreadAt.current === undefined && chatQ.data && !chatQ.isPlaceholderData) unreadAt.current = chatQ.data.unreadCount;
  const unreadOpen = Math.min(MAX_UNREAD, unreadAt.current ?? 0);

  const msgQ = useInfiniteQuery({ ...messagesQuery(chatID), staleTime: 0 });

  const pending = useOutgoing(chatID);
  // Packages' actions in the conversation (extension.ts AugmentationUI): header, rows, menu, composer, cards above it.
  const augmentations = useAugmentations();
  const [fill, setFill] = useState<{ key: number; text: string }>();
  const fillField = useCallback((text: string) => setFill({ key: Date.now(), text }), []);

  // On iOS, an older page waits for the scroll to stop before it shows: Virtuoso, prepending rows while it holds a
  // correction (IOS_WEBKIT), drops that correction and the messages jump by it. `heldPages`: the pages shown while
  // the list scrolls (set when it starts), null when it is still. Before the list is placed, every page shows.
  const [heldPages, setHeldPages] = useState<number | null>(null);
  const loadedPages = msgQ.data?.pages.length ?? 0;
  const loadedRef = useRef(loadedPages);
  loadedRef.current = loadedPages;
  const shownPages = heldPages === null ? loadedPages : Math.min(heldPages, loadedPages);
  const holding = useRef(false);
  holding.current = shownPages < loadedPages;
  // Virtuoso calls it again with the same state when it re-subscribes (a new list of rows): the count already held
  // stays. Released a moment after the scroll stops, once Virtuoso has applied its correction (a millisecond later).
  const release = useRef(0);
  const scrolling = useRef(false);
  // iOS, the list still: the message under the reader, noted, held while an older page shows (`holdPlace`, below),
  // from `holdFrom` until `holdUntil` (ms; Infinity while its rows are measured).
  const still = useRef<{ id: string; y: number } | null>(null);
  const holdFrom = useRef(0);
  const holdUntil = useRef(0);
  // Frames since the place is held, and the scroll position holdPlace left.
  const holdFrames = useRef(0);
  const holdTop = useRef(0);
  const stillAnchor = useRef<() => { id: string; y: number } | null>(() => null);
  const onScrolling = useCallback((on: boolean) => {
    scrolling.current = on;
    // Stopped: the place noted (not while a page shows: Virtuoso's own scroll after it stops too).
    if (!on && performance.now() > holdUntil.current) still.current = stillAnchor.current();
    window.clearTimeout(release.current);
    if (on) setHeldPages((h) => (placedRef.current ? (h ?? loadedRef.current) : null));
    else releaseHeld();
  }, []);
  // Not while a finger is on the list either: between two drags (the list stopped a moment), a page shown as the next
  // drag starts was placed while it scrolled (and the reader found other messages under the finger).
  const touching = useRef(false);
  const releaseHeld = useCallback(() => {
    window.clearTimeout(release.current);
    release.current = window.setTimeout(() => !touching.current && !scrolling.current && setHeldPages(null), 50);
  }, []);
  // Followed on the element the finger went down on: the list may drop that row while the finger moves (it is no
  // longer drawn), and its later touch events then reach no ancestor (the container's handlers missed the moves and the
  // finger lifting: pages held for good, no older page asked for).
  const onTouchStart = useCallback(
    (e: TouchEvent<HTMLElement>) => {
      markInput();
      if (touching.current) return;
      touching.current = true;
      const el = e.target;
      const end = (ev: Event) => {
        if ((ev as globalThis.TouchEvent).touches?.length) return;
        el.removeEventListener('touchmove', markMove);
        el.removeEventListener('touchend', end);
        el.removeEventListener('touchcancel', end);
        touching.current = false;
        if (!scrolling.current) releaseHeld();
      };
      el.addEventListener('touchmove', markMove, { passive: true });
      el.addEventListener('touchend', end, { passive: true });
      el.addEventListener('touchcancel', end, { passive: true });
    },
    [releaseHeld],
  );
  useEffect(() => () => window.clearTimeout(release.current), []);

  // The pages shown, the same array while they are the same pages: a page loaded while it waits (heldPages) changes
  // no row. A new list of the same rows reads as "a message changed height" (the layout effect below: keepAnchor),
  // which held the reading place, with no input for a while, against a momentum scroll for 800 ms (iOS: messages
  // pulled back up, again and again, as older pages arrived while the history scrolled).
  const allPages = msgQ.data?.pages;
  const shownRef = useRef<NonNullable<typeof allPages>>([]);
  const shownList = (allPages ?? []).slice(0, shownPages);
  if (shownList.length !== shownRef.current.length || shownList.some((p, i) => p !== shownRef.current[i])) shownRef.current = shownList;
  const shown = shownRef.current;

  // One entry per message (oldest first), then the messages being sent.
  const flat = useMemo(() => {
    const pages = shown;
    const seen = new Set<string>();
    const flat: Row[] = [];
    for (let p = pages.length - 1; p >= 0; p--) {
      const items = pages[p]!.items;
      for (let i = items.length - 1; i >= 0; i--) {
        const m = items[i]!;
        if (!visible(m) || seen.has(m.id)) continue;
        seen.add(m.id);
        flat.push(rowFor(m));
      }
    }
    for (const o of pending) flat.push(outRowFor(o));
    return flat;
  }, [shown, pending]);

  // A page can hold nothing to show (20 reaction events in a row): load older pages until there is enough
  // to fill the screen, before mounting the list (Virtuoso mounted empty never asks for more).
  const pageCount = msgQ.data?.pages.length ?? 0;
  const incoming = useMemo(() => flat.map((r) => r.kind === 'msg' && !r.m.isSender), [flat]);
  const divider = useRef<{ id: string; atOpen: boolean } | null | undefined>(undefined);
  // Older pages until the first unread message is loaded (the list waits for it, to open at the right place).
  const needUnread =
    divider.current === undefined && unreadOpen > 0 && msgQ.isSuccess && !!msgQ.hasNextPage && pageCount < MAX_FILL_PAGES && firstUnreadIndex(incoming, unreadOpen) < 0;
  const needMore =
    msgQ.isSuccess && !!msgQ.hasNextPage && (flat.length - pending.length < MIN_ROWS || needUnread) && pageCount < MAX_FILL_PAGES;
  useEffect(() => {
    if (needMore && !msgQ.isFetchingNextPage) void msgQ.fetchNextPage();
  }, [needMore, msgQ]);
  // Decided once, when the list first shows: later messages (or mark-read) do not move it.
  if (divider.current === undefined && msgQ.isSuccess && !needUnread && (!needMore || flat.length >= MIN_ROWS)) {
    let index = firstUnreadIndex(incoming, unreadOpen);
    if (index < 0 && unreadOpen > 0) index = oldestIncoming(incoming);
    const r = index >= 0 ? flat[index] : undefined;
    divider.current = r?.kind === 'msg' ? { id: r.m.id, atOpen: openAtDivider(flat.length, index, Math.floor(window.innerHeight / ROW_PX)) } : null;
  }
  const dividerID = divider.current?.id;

  // Rows of the list: photo albums grouped (albums.ts; the divider starts a new one).
  const rows = useMemo(() => {
    const msgs = flat.flatMap((r) => (r.kind === 'msg' ? [r.m] : []));
    const rows: Row[] = [];
    for (const run of groupAlbums(msgs, dividerID)) rows.push(isAlbum(run) ? albumRowFor(run) : rowFor(run[0]!));
    for (const r of flat) if (r.kind === 'out') rows.push(r);
    return rows;
  }, [flat, dividerID]);
  // Virtuoso's firstItemIndex moves by the rows really added above those it lists, found by following its top row
  // (rowshift.ts): a page prepended that extends the top album adds no row. Not by which page a message is in:
  // live messages grow the newest page (cache.ts upsertMessages), and the refetch that follows hands its oldest
  // messages to the next page, with no row added. Virtuoso, told of rows prepended, keeps the rows it drew for a
  // couple of frames under their old indexes, which then pointed past the last row (the screen crashed).
  const firstItem = useRef<{ rows: Row[]; index: number }>({ rows: [], index: BASE });
  if (firstItem.current.rows !== rows) firstItem.current = { rows, index: firstItem.current.index - prependedRows(firstItem.current.rows, rows, rowIDs) };
  const firstItemIndex = firstItem.current.index;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const qRef = useRef(msgQ);
  qRef.current = msgQ;

  // Mark read on open and when the tab becomes visible again.
  useEffect(() => {
    const run = () => {
      if (document.visibilityState === 'visible') markChatRead(qc, chatID);
    };
    run();
    document.addEventListener('visibilitychange', run);
    return () => document.removeEventListener('visibilitychange', run);
  }, [qc, chatID, chat?.unreadCount]);

  const virtuoso = useRef<VirtuosoHandle>(null);
  const isGroup = chat?.type === 'group';

  // Item heights are only known after render (images, long texts): stay pinned to the bottom while
  // content grows. Only a scroll *up* (the user reading history) unpins; reaching the bottom pins again.
  // Content growth or older pages being prepended never move the scroll position up, so they cannot.
  const stick = useRef(true);
  const [editing, setEditing] = useState<string>();
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Many unread messages: the list opens at the first of them, not pinned to the bottom (once, when decided).
  const stickDecided = useRef(false);
  if (!stickDecided.current && divider.current !== undefined) {
    stickDecided.current = true;
    if (divider.current?.atOpen) stick.current = false;
  }
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const toBottom = () => virtuoso.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
  // New rows are first laid out with an estimated height, then measured: a single scroll lands short of
  // the real bottom. While pinned, keep re-pinning for a moment after every change until it settles.
  const settleUntil = useRef(0);
  const settleRaf = useRef(0);
  const settle = useCallback((ms = 1200) => {
    settleUntil.current = Math.max(settleUntil.current, performance.now() + ms);
    if (settleRaf.current) return;
    const tick = () => {
      const el = scroller.current;
      if (!stick.current || performance.now() > settleUntil.current) {
        settleRaf.current = 0;
        return;
      }
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 1) toBottom();
      settleRaf.current = requestAnimationFrame(tick);
    };
    settleRaf.current = requestAnimationFrame(tick);
  }, []);
  useEffect(() => () => cancelAnimationFrame(settleRaf.current), []);
  /** Explicit intent (sending, "jump to latest"): re-attach to the bottom whatever the position. */
  const pinBottom = useCallback(() => {
    stick.current = true;
    setUnseen(0);
    toBottom();
    settle(1500);
  }, [settle]);
  const scroller = useRef<HTMLElement | null>(null);
  // Virtuoso itself moves scrollTop while measuring rows: only an upward move right after user input
  // (wheel, touch, keys, scrollbar) counts as the user leaving the bottom.
  // -Infinity, not 0: performance.now() starts at 0 on page load, so 0 would read as "input just now".
  const inputAt = useRef(-Infinity);
  const markInput = () => (inputAt.current = performance.now());
  // The last wheel turn or finger move (a scroll of the reader's, not a tap).
  const moveAt = useRef(-Infinity);
  const markMove = () => (moveAt.current = inputAt.current = performance.now());
  // Reading position (first message on screen, its offset), tracked while scrolling.
  const anchor = useRef<{ id: string; y: number } | null>(null);
  const keepUntil = useRef(0);
  const keepRaf = useRef(0);
  const anchorRaf = useRef(0);
  const readAnchor = useCallback((id?: string) => {
    const el = scroller.current;
    if (!el) return null;
    const top = el.getBoundingClientRect().top;
    if (id) {
      const n = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
      return n ? { id, y: n.getBoundingClientRect().top - top } : null;
    }
    for (const n of el.querySelectorAll<HTMLElement>('[data-mid]')) {
      const r = n.getBoundingClientRect();
      if (r.bottom > top + 4) return { id: n.dataset.mid!, y: r.top - top };
    }
    return null;
  }, []);
  stillAnchor.current = () => readAnchor();
  // The oldest loaded row within a screen and the rows drawn above it, an older page to ask for (and none on its way).
  const nearTop = () => {
    const el = scroller.current;
    const q = qRef.current;
    return !!el && el.scrollTop < OVERSCAN_TOP + el.clientHeight && !!q.hasNextPage && !q.isFetchingNextPage && !holding.current;
  };
  // iOS, while an older page shows and its rows are measured (`measuring`, the list still and not pinned to the
  // bottom): the message under the reader stays where it is, put back by the scroll position in the frame the list
  // changed size (a resize observer, called before the frame is painted, after Virtuoso's own). Virtuoso places an
  // older page by estimated heights and corrects nothing while the first row of the list is drawn: the remainder (up
  // to a screen in a chat of long texts) moved the messages. Outside that window the place is only noted (the app's
  // own scrolls, a jump to a message, stay theirs); never during a scroll (iOS stops a momentum when it is set).
  const holdPlace = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const holding = performance.now() <= holdUntil.current;
    // The reader's own scroll (a finger move or wheel turn since the window opened) ends it. Virtuoso's own scroll does
    // not: it scrolls after showing a page (by the estimated heights), which reads as scrolling (isScrolling).
    if (holding && moveAt.current > holdFrom.current) holdUntil.current = 0;
    if (performance.now() > holdUntil.current) {
      if (!scrolling.current) still.current = readAnchor();
      return;
    }
    const a = still.current;
    const now = a && readAnchor(a.id);
    if (!a || !now || stick.current || editingRef.current) {
      still.current = readAnchor();
      return;
    }
    if (Math.abs(now.y - a.y) >= 1) el.scrollTop += now.y - a.y;
    holdTop.current = el.scrollTop;
  }, [readAnchor]);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // A scroll while the place is held, once Virtuoso's own scroll after the page is done (two frames), that holdPlace
    // did not make: the reader's (a momentum that went on): the place is theirs.
    if (performance.now() <= holdUntil.current && holdFrames.current >= 2 && Math.abs(el.scrollTop - holdTop.current) > 1) holdUntil.current = 0;
    const reading = performance.now() - inputAt.current < 1000;
    if (el.scrollTop < lastTop.current - 2 && reading) {
      // Leaving the bottom: the list's foot two pixels taller or shorter. Virtuoso keeps the last "jump due to an item
      // resize" (the list growing while at the bottom: a new message, the rows measured as it opens, up to a page) until
      // the scroll height next changes away from the bottom, and adds it to its next correction of the reader's place
      // (rows above that take their height): kept stale while the history scrolls, it threw the list by that much,
      // or to the top, the first time a row above changed by a pixel. Changed now, away from the bottom, it is zero.
      if (stick.current) el.querySelector<HTMLElement>('.list-foot')?.classList.toggle('nudge');
      stick.current = false;
    }
    // The reader scrolling up: the older page asked for while the oldest loaded row is still more than the rows drawn
    // above the screen away (a screen and the overscan). Virtuoso keeps the messages on screen in place when a row
    // above them takes its real height, except once the first row of the list is drawn (nothing above to make up
    // for, it assumes): rows then measured or growing move everything under the reader until the page is prepended
    // (startReached, only then: the jumps of a busy chat just before an older page shows).
    // A momentum (iOS: the list scrolling on after the finger left, with no input for a while) is the reader's scroll
    // too; not Virtuoso's own scrolls (placing the list at the unread divider) with no input at all.
    const momentum = scrolling.current && performance.now() - inputAt.current < 4000;
    if ((reading || momentum) && el.scrollTop < lastTop.current && nearTop()) void qRef.current.fetchNextPage();
    lastTop.current = el.scrollTop;
    if (!anchorRaf.current)
      anchorRaf.current = requestAnimationFrame(() => {
        anchorRaf.current = 0;
        // While the position is being held, only the user moves the anchor (not Virtuoso's own fixes).
        if (keepRaf.current && performance.now() - inputAt.current > 300) return;
        anchor.current = readAnchor();
      });
  }, [readAnchor]);
  // A message above the screen that grows or shrinks (a reaction, an edit) would move everything under the
  // reader (Virtuoso only compensates prepended items): while reading history, put the anchor back.
  const keepAnchor = useCallback(() => {
    keepUntil.current = performance.now() + 800;
    if (keepRaf.current) return;
    const tick = () => {
      const el = scroller.current;
      const a = anchor.current;
      // An open editor keeps itself in view as it grows (MessageItem): holding the anchor would fight it.
      if (!el || !a || stick.current || editingRef.current || performance.now() > keepUntil.current) {
        keepRaf.current = 0;
        return;
      }
      // A momentum scroll (iOS: no input, the list still moving) is the reader's: it moves the anchor, never fought.
      if (scrolling.current && performance.now() - inputAt.current > 300) anchor.current = readAnchor();
      else if (performance.now() - inputAt.current > 300) {
        const now = readAnchor(a.id);
        if (now && Math.abs(now.y - a.y) >= 1) el.scrollTop += now.y - a.y;
      }
      keepRaf.current = requestAnimationFrame(tick);
    };
    keepRaf.current = requestAnimationFrame(tick);
  }, [readAnchor]);
  useEffect(
    () => () => {
      cancelAnimationFrame(keepRaf.current);
      cancelAnimationFrame(anchorRaf.current);
    },
    [],
  );
  // The scroller itself changes height (keyboard up or down, composer growing, reply bar): a list pinned to
  // the bottom stays there.
  const resizeObs = useRef<ResizeObserver>(undefined);
  const setScroller = useCallback(
    (el: HTMLElement | Window | null) => {
      scroller.current?.removeEventListener('scroll', onScroll);
      resizeObs.current?.disconnect();
      scroller.current = el instanceof HTMLElement ? el : null;
      scroller.current?.addEventListener('scroll', onScroll, { passive: true });

      if (scroller.current && 'ResizeObserver' in window) {
        let h = scroller.current.clientHeight;
        resizeObs.current = new ResizeObserver(([e]) => {
          const nh = Math.round(e?.contentRect.height ?? 0);
          if (nh === h) return;
          h = nh;
          if (!stick.current) return;
          toBottom();
          settle(400);
        });
        resizeObs.current.observe(scroller.current);
      }
    },
    [onScroll, settle],
  );
  useEffect(() => () => resizeObs.current?.disconnect(), []);
  // New incoming messages while reading history: counted for the "jump to latest" button.
  const lastRow = flat[flat.length - 1];
  const lastKey = lastRow && rowKey(lastRow);
  const prevLast = useRef(lastKey);
  useEffect(() => {
    if (prevLast.current && lastKey !== prevLast.current && !stick.current && lastRow?.kind === 'msg') {
      setUnseen((n) => n + 1);
    }
    prevLast.current = lastKey;
  }, [lastKey, lastRow]);
  const jumpLatest = pinBottom;
  // Any change to the rows (new message, echo replacing the optimistic bubble, refetched pages, reactions)
  // keeps a pinned list at the bottom.
  // Same rows, changed content (reactions, edits): keep the reading position. Added/prepended rows are
  // handled by Virtuoso (firstItemIndex) and by the pinned-bottom logic.
  const rowsSig = useRef('');
  useLayoutEffect(() => {
    const key = (r: Row | undefined) => (r ? rowKey(r) : '');
    const sig = `${rows.length}|${key(rows[0])}|${key(rows[rows.length - 1])}`;
    const sameRows = sig === rowsSig.current;
    rowsSig.current = sig;
    if (stick.current) settle();
    else if (sameRows) keepAnchor();
  }, [rows, settle, keepAnchor]);
  // Virtuoso follows the output on any change in the number of rows, older rows prepended included (startReached
  // on a chat whose cache holds only its newest page): it then scrolls to the last row by estimated heights, a frame
  // above the bottom (≈ 120 px) before measuring them. Prepended rows keep their place (firstItemIndex): follow only
  // a new last row. `followedLast`: the last row of the previous render (Virtuoso decides in its own layout effects,
  // before this one).
  const followedLast = useRef('');
  useLayoutEffect(() => {
    followedLast.current = rowsRef.current.length ? rowKey(rowsRef.current[rowsRef.current.length - 1]!) : '';
  });
  const followOutput = useCallback(() => {
    const r = rowsRef.current;
    return stick.current && (r.length ? rowKey(r[r.length - 1]!) : '') !== followedLast.current ? 'auto' : false;
  }, []);
  const loaded = msgQ.isSuccess && !(needMore && rows.length === 0) && !needUnread;
  useEffect(() => {
    if (!loaded) return;
    const timers = [0, 120, 400].map((ms) =>
      window.setTimeout(() => {
        if (stick.current) toBottom();
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [loaded]);
  // Virtuoso places the rows over a few frames once it mounts (estimated heights, the first rows from the top, then
  // measured and scrolled to the last row or the divider). A loaded device paints those frames: older messages
  // show, then the whole list jumps (a layout shift of ~0.3). It stays invisible meanwhile (its layout and scroll
  // unchanged, the skeleton over it) until its rows are drawn (at the bottom when pinned) and its scroll position
  // and height hold for three frames. The reveal is done on the DOM in the frame that saw it still (a React render
  // paints a frame or more later, after a possible move); `placed` only tidies up after. At most 1.5 s and 10 frames
  // after the first row is drawn (then, pinned but above the bottom: to the bottom first, shown on the next frame),
  // 5 s in all.
  const [placed, setPlaced] = useState(false);
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const placing = useRef<HTMLDivElement>(null);
  // iOS: every loaded row is measured while the list is still, never for the first time while it scrolls. Virtuoso,
  // drawing a row above the screen whose real height differs from its estimate, moves the rows under the reader by
  // the difference; it puts them back by the scroll position at once (same frame, skipAnimationFrameInResizeObserver),
  // except on iOS while the page scrolls (IOS_WEBKIT: a finger or a momentum), where it holds the correction in an
  // offset of the list that a React render applies, a painted frame later: the messages jumped down, then back up,
  // by up to a screen in a chat of long texts (a Zalo one: rows of 60 to 1000 px against an estimate of one height).
  // So every row above the screen is drawn (and measured) while the list places itself (hidden; at the divider: once
  // placed), and again for a few frames from the render that shows an older page (the list still: pages wait for the
  // scroll to stop and the finger to lift); drawn again later, a row takes the height Virtuoso already knows. Virtuoso
  // compensates nothing while the first row of the list is drawn (nothing above to make up for, it assumes):
  // holdPlace keeps the reader's place meanwhile.
  const [measuring, setMeasuring] = useState(false);
  const shownBefore = useRef(shownPages);
  const placedBefore = useRef(placed);
  const measureAll = () => {
    // The reader's place as the rows are drawn (the DOM is the one before this render's).
    if (!scrolling.current) still.current = stillAnchor.current();
    holdUntil.current = Infinity;
    holdFrom.current = performance.now();
    holdFrames.current = 0;
    holdTop.current = scroller.current?.scrollTop ?? 0;
    if (!measuring) setMeasuring(true);
  };
  // Opening at the unread divider, the rows are measured once placed, not while it places itself: Virtuoso, drawing
  // every row while it scrolls to the divider, no longer ends there.
  const atDivider = !!divider.current?.atOpen;
  if (placed !== placedBefore.current) {
    placedBefore.current = placed;
    if (IOS_WEBKIT && placed && atDivider) measureAll();
  }
  if (shownPages !== shownBefore.current) {
    if (IOS_WEBKIT && placed && shownPages > shownBefore.current) measureAll();
    shownBefore.current = shownPages;
  }
  useEffect(() => {
    if (!measuring) return;
    let raf = 0;
    let n = 0;
    const tick = () => {
      holdFrames.current++;
      if (++n < 4) return void (raf = requestAnimationFrame(tick));
      if (holdUntil.current === Infinity) holdUntil.current = performance.now() + 120;
      setMeasuring(false);
      // Virtuoso's startReached did not count meanwhile (startReached, below) and is not said again for the same
      // first row: asked here if the reader is near the top.
      if (nearTop()) void qRef.current.fetchNextPage();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [measuring]);
  const overscanTop = IOS_WEBKIT && ((!placed && !atDivider) || measuring) ? MEASURE_ALL : OVERSCAN_TOP;
  const overscanRef = useRef(overscanTop);
  overscanRef.current = overscanTop;
  const hasRows = rows.length > 0;
  // holdPlace watches Virtuoso's item list (its height changes with any row drawn, measured or resized), by an
  // observer made after the list's own: called after them, it sees their corrections.
  useEffect(() => {
    if (!IOS_WEBKIT || !placed || !hasRows || !('ResizeObserver' in window)) return;
    const items = scroller.current?.querySelector('[data-testid=virtuoso-item-list]');
    if (!items) return;
    const ro = new ResizeObserver(holdPlace);
    ro.observe(items);
    return () => ro.disconnect();
  }, [placed, hasRows, holdPlace]);
  useEffect(() => {
    if (!loaded || placed) return;
    const end = performance.now() + 5000;
    let drawnAt = 0;
    let frames = 0;
    let last = '';
    let same = 0;
    let revealNext = false;
    let raf = 0;
    const reveal = (el: HTMLElement | null) => {
      const list = el?.closest<HTMLElement>('.message-list');
      if (list) list.style.visibility = '';
      if (placing.current) placing.current.style.display = 'none';
      setPlaced(true);
    };
    const tick = () => {
      const el = scroller.current;
      if (revealNext) return reveal(el);
      // Virtuoso's first frames are empty (no row drawn yet), and a list pinned to the bottom may rest a moment above
      // it before the re-pins (settle, the timers above) take it there: not placed then.
      // Virtuoso also keeps its rows hidden itself (visibility on its inner list) until it has scrolled them into
      // place: not drawn until it shows them, or the preview would give way to a blank list for a few frames.
      const item = el?.querySelector<HTMLElement>('[data-item-index]');
      let shown = !!item;
      for (let x = item?.parentElement; x && x !== el; x = x.parentElement) if (x.style.visibility === 'hidden') shown = false;
      const drawn = !!el && (!hasRows || shown);
      const down = !!el && (!stick.current || el.scrollHeight - el.scrollTop - el.clientHeight <= 2);
      const now = performance.now();
      if (drawn && !drawnAt) drawnAt = now;
      if (drawnAt) frames++;
      const k = el && drawn && down ? `${el.scrollTop}|${el.scrollHeight}` : '';
      same = k && k === last ? same + 1 : 0;
      last = k;
      if (same >= 3) return reveal(el);
      if ((drawnAt && now - drawnAt > 1500 && frames >= 10) || now > end) {
        if (!el || down) return reveal(el);
        toBottom();
        revealNext = true;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loaded, placed, hasRows]);

  // One API call per message, in order. Attachments go first; the text rides along as a caption when the
  // network supports it for a single attachment, otherwise it follows as its own message.
  const sendOne = useCallback(
    (o: Outgoing, body: SendBody) =>
      api
        .send(chatID, body)
        .then(async (r) => {
          outgoing.update(o.localId, { pendingID: r.pendingMessageID });
          // The echo often arrives before this response and carries the final ID, not the pending one;
          // the API resolves the pending ID to the stored message, so look it up until it shows.
          for (const ms of [700, 2000, 5000, 12_000]) {
            await new Promise((res) => window.setTimeout(res, ms));
            if (!outgoing.has(o.localId)) return;
            try {
              const m = await api.message(chatID, r.pendingMessageID);
              if (m?.id && m.id !== r.pendingMessageID) {
                upsertMessages(qc, chatID, [m]);
                outgoing.remove(o.localId);
                return;
              }
            } catch {
              // not stored yet
            }
          }
          if (!outgoing.has(o.localId)) return;
          await qc.invalidateQueries({ queryKey: keys.messages(chatID) });
          if (outgoing.has(o.localId)) outgoing.update(o.localId, { status: 'unknown' });
        })
        .catch(() => outgoing.update(o.localId, { status: 'failed' })),
    [chatID, qc],
  );

  const bodies = useRef(new Map<string, SendBody>());

  const [replyTo, setReplyTo] = useState<Message | null>(null);

  const send = useCallback(
    async (text: string, atts: TrayItem[] = [], wire?: string) => {
      const reply = replyTo?.id;
      const sendText = wire ?? text;
      setReplyTo(null);
      pinBottom();
      const caption = atts.length === 1 && atts[0]!.caption && !!text;
      const queue: { o: Outgoing; body: SendBody }[] = [];
      for (const a of atts) {
        const r = a.result!;
        const withText = caption ? sendText : '';
        const o = outgoing.add(chatID, caption ? text : '', {
          attachment: { name: r.fileName ?? a.file.name, mime: r.mimeType ?? a.file.type, size: a.file.size, previewURL: a.previewURL },
        });
        const attachment: SendBody['attachment'] = { uploadID: r.uploadID };
        if (a.asFile) attachment.type = 'file';
        queue.push({ o, body: { ...(withText ? { text: withText } : {}), attachment } });
      }
      if (text && !caption) {
        const o = outgoing.add(chatID, text);
        queue.push({ o, body: { text: sendText } });
      }
      if (reply && queue[0]) {
        queue[0].body.replyToMessageID = reply;
        outgoing.update(queue[0].o.localId, { replyTo: reply });
      }
      for (const { o, body } of queue) {
        bodies.current.set(o.localId, body);
        await sendOne(o, body);
      }
    },
    [chatID, sendOne, replyTo, pinBottom],
  );

  // Voice message: upload the recording, then send it as a voice note (or audio, per network).
  const voiceJobs = useRef(new Map<string, Recorded>());
  const sendVoiceAs = useCallback(
    async (o: Outgoing, r: Recorded, reply?: string) => {
      try {
        const up = await upload(r.file, () => {}, chatID).promise;
        const body: SendBody = {
          attachment: { uploadID: up.uploadID, mimeType: r.plan.mime, type: r.plan.type, duration: r.duration },
          ...(reply ? { replyToMessageID: reply } : {}),
        };
        bodies.current.set(o.localId, body);
        voiceJobs.current.delete(o.localId);
        await sendOne(o, body);
      } catch {
        outgoing.update(o.localId, { status: 'failed' });
        flash(tr().composer.voiceFailed);
      }
    },
    [chatID, sendOne],
  );
  const sendVoice = useCallback(
    (r: Recorded) => {
      const reply = replyTo?.id;
      setReplyTo(null);
      pinBottom();
      const o = outgoing.add(chatID, '', { attachment: { name: r.file.name, mime: r.file.type, size: r.file.size, voice: r.duration }, ...(reply ? { replyTo: reply } : {}) });
      voiceJobs.current.set(o.localId, r);
      void sendVoiceAs(o, r, reply);
    },
    [chatID, replyTo, sendVoiceAs, pinBottom],
  );

  const retry = useCallback(
    (o: Outgoing) => {
      outgoing.update(o.localId, { status: 'pending' });
      const job = voiceJobs.current.get(o.localId);
      if (job) return void sendVoiceAs(o, job, o.replyTo);
      const body = bodies.current.get(o.localId) ?? { text: o.text };
      void sendOne(o, body);
    },
    [sendOne, sendVoiceAs],
  );

  // Participants for @mentions: the chat comes with up to 100; fetch the rest once when needed.
  const [allParticipants, setAllParticipants] = useState<Chat['participants']>();
  const fetchingParticipants = useRef(false);
  const needParticipants = useCallback(() => {
    if (fetchingParticipants.current || !chat?.participants?.hasMore) return;
    fetchingParticipants.current = true;
    api.chat(chatID, true).then((c) => setAllParticipants(c.participants), () => {});
  }, [chat, chatID]);
  const mentionList = isGroupChat(chat) && canMention(chat) ? (allParticipants ?? chat?.participants)?.items : undefined;

  const tray = useTray(chat);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const readOnly = !!chat?.isReadOnly;
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const dropHandlers = readOnly
    ? {}
    : {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        },
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          tray.add([...e.dataTransfer.files]);
        },
      };

  // Who is who: our own IDs (one per network) and display names for reaction tooltips. Kept identical
  // while their content is unchanged, so the context does not re-render every row on each event.
  const people = useRef<{ selfIDs: Set<string>; names: Map<string, string> }>(undefined);
  const { selfIDs, names } = useMemo(() => {
    const selfIDs = new Set<string>();
    const names = new Map<string, string>();
    for (const p of (allParticipants ?? chat?.participants)?.items ?? []) {
      if (p.isSelf) selfIDs.add(p.id);
      const n = p.fullName || p.username;
      if (n) names.set(p.id, n);
    }
    for (const r of flat) {
      if (r.kind !== 'msg') continue;
      if (r.m.isSender) selfIDs.add(r.m.senderID);
      else if (r.m.senderName && !isRawUserID(r.m.senderName) && !names.has(r.m.senderID)) names.set(r.m.senderID, r.m.senderName);
    }
    const prev = people.current;
    if (prev && sameSet(prev.selfIDs, selfIDs) && sameMap(prev.names, names)) return prev;
    people.current = { selfIDs, names };
    return people.current;
  }, [chat, flat, allParticipants]);

  // Read and delivery receipts per own message (receipts.ts).
  const receipts = useMemo(() => readReceipts(msgQ.data?.pages ?? [], selfIDs), [msgQ.data, selfIDs]);
  const deliveries = useMemo(() => deliveryReceipts(msgQ.data?.pages ?? [], selfIDs), [msgQ.data, selfIDs]);

  // Reactions: optimistic, serialised per message (removals before the add, so a network allowing one
  // reaction per user ends with the new one whatever its bridge does), confirmed from the server
  // afterwards, reverted with a toast on error or after 15 s without an answer.
  const reactQueue = useRef(new Map<string, Promise<void>>());
  const toggleReaction = useCallback(
    (m: Message, key: string) => {
      const cur = findMessage(qc, chatID, m.id) ?? m;
      if (cur.isDeleted || cur.sendStatus?.status === 'PENDING' || cur.id.startsWith('~')) return;
      const self = (cur.reactions ?? []).find((r) => selfIDs.has(r.participantID))?.participantID ?? [...selfIDs][0];
      if (!self) return;
      const plan = planToggle(cur.reactions, key, selfIDs, self, rowChat?.capabilities?.reactionCount);
      const before = cur.reactions;
      patchMessage(qc, chatID, m.id, (x) => ({ ...x, reactions: plan.next }));
      if (plan.add) rememberReaction(plan.add);
      reactionOps.begin(m.id);
      const run = async () => {
        for (const k of plan.remove) await api.unreact(chatID, m.id, k);
        if (plan.add) await api.react(chatID, m.id, plan.add);
      };
      const prev = reactQueue.current.get(m.id) ?? Promise.resolve();
      const job = prev.then(() => withTimeout(run(), REACTION_TIMEOUT_MS));
      const tail = job.then(
        () => {
          reactionOps.end(m.id);
          // Removals come back without the updated message: confirm from the server if no event did.
          refreshMessageSoon(qc, chatID, m.id, 1500);
        },
        () => {
          reactionOps.end(m.id);
          if (!reactionOps.busy(m.id)) patchMessage(qc, chatID, m.id, (x) => ({ ...x, reactions: before }));
          refreshMessageSoon(qc, chatID, m.id, 300);
          flash(tr().conv.reactionFailed);
        },
      );
      reactQueue.current.set(m.id, tail);
      void tail.finally(() => {
        if (reactQueue.current.get(m.id) === tail) reactQueue.current.delete(m.id);
      });
    },
    [rowChat, chatID, qc, selfIDs],
  );
  const nameOf = useCallback((id: string) => (selfIDs.has(id) ? tr().common.you : (names.get(id) ?? id)), [selfIDs, names]);
  const needNames = useCallback(
    (ids: string[]) => {
      if (ids.some((id) => !selfIDs.has(id) && !names.has(id))) needParticipants();
    },
    [selfIDs, names, needParticipants],
  );

  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [highlight, setHighlight] = useState<string>();
  const [toast, flash] = useToast();
  const fw = useForward();

  // Scroll to a message, loading older pages until it shows up (the API has no "around" query).
  const jumping = useRef(false);
  const jumpTo = useCallback(async (id: string) => {
    if (jumping.current) return;
    jumping.current = true;
    try {
      for (let i = 0; i < 40; i++) {
        const has = (r: Row) => rowMsgs(r).some((m) => m.id === id);
        const idx = rowsRef.current.findIndex(has);
        if (idx >= 0) {
          stick.current = false;
          // Prepending a page shifts the list after render: scroll again once the layout settles.
          const go = () => {
            const i2 = rowsRef.current.findIndex(has);
            if (i2 >= 0) virtuoso.current?.scrollToIndex({ index: i2, align: 'center' });
          };
          go();
          [120, 350, 800].forEach((ms) => window.setTimeout(go, ms));
          setHighlight(id);
          window.setTimeout(() => setHighlight((h) => (h === id ? undefined : h)), 3000);
          return;
        }
        const q = qRef.current;
        if (!q.hasNextPage) break;
        await q.fetchNextPage();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      flash(tr().conv.notFound);
    } finally {
      jumping.current = false;
    }
  }, []);

  useEffect(() => {
    if (focus && loaded) void jumpTo(focus);
  }, [focus, loaded, jumpTo]);
  useEffect(() => {
    const id = pendingJump.current;
    if (sub || !id || !loaded) return;
    pendingJump.current = undefined;
    void jumpTo(id);
  }, [sub, loaded, jumpTo]);

  const reply = useCallback(
    (m: Message) => {
      if (!canReply(rowChat)) return;
      setReplyTo(m);
    },
    [rowChat],
  );

  const [confirm, setConfirm] = useState<Message | null>(null);

  // An edit started with ↑ from the field gives the focus back to the field when it ends.
  const editFromKey = useRef(false);
  const endEdit = useCallback(() => {
    setEditing(undefined);
    if (editFromKey.current) setComposeKey(`edit-${Date.now()}`);
    editFromKey.current = false;
  }, []);
  const startEdit = useCallback((m: Message) => {
    editFromKey.current = false;
    setReplyTo(null);
    setEditing(m.id);
  }, []);
  // ↑ in the empty field: our newest editable message among the loaded ones (as in Slack or Telegram).
  const editLast = useCallback(() => {
    const list = rowsRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i]!;
      if (r.kind === 'out') continue;
      const m = rowMsgs(r).findLast((x) => x.isSender && canEdit(rowChat, x));
      if (!m) continue;
      startEdit(m);
      editFromKey.current = true;
      stick.current = false;
      // Rendered by the list first, then the editor itself in view with its buttons (Virtuoso's estimate of the
      // row's end is short of them).
      virtuoso.current?.scrollToIndex({ index: i, align: 'end' });
      [60, 250].forEach((ms) => window.setTimeout(() => document.querySelector('[data-testid=inline-edit]')?.closest('.msg')?.scrollIntoView({ block: 'nearest' }), ms));
      return true;
    }
    return false;
  }, [rowChat, startEdit]);
  const cancelEdit = endEdit;
  const saveEdit = useCallback(
    (m: Message, text: string) => {
      endEdit();
      const before = m.text;
      patchMessage(qc, chatID, m.id, (x) => ({ ...x, text, editedTimestamp: new Date().toISOString() }));
      api.edit(chatID, m.id, text).catch(() => {
        patchMessage(qc, chatID, m.id, (x) => ({ ...x, text: before }));
        void qc.invalidateQueries({ queryKey: keys.messages(chatID) });
        flash(tr().conv.editFailed);
      });
    },
    [chatID, qc, endEdit],
  );
  const doDelete = useCallback(
    (m: Message, forEveryone: boolean) => {
      setConfirm(null);
      patchMessage(qc, chatID, m.id, (x) => ({ ...x, isDeleted: true }));
      api.remove(chatID, m.id, forEveryone).then(
        () => window.setTimeout(() => void qc.invalidateQueries({ queryKey: keys.messages(chatID) }), 1500),
        () => {
          patchMessage(qc, chatID, m.id, (x) => ({ ...x, isDeleted: false }));
          flash(tr().conv.deleteFailed);
        },
      );
    },
    [chatID, qc],
  );

  const menuExtra = useCallback(
    (m: Message) => {
      const out: { id: string; label: string; danger?: boolean; run: () => void }[] = [];
      if (canEdit(rowChat, m)) out.push({ id: 'edit', label: tr().conv.edit, run: () => startEdit(m) });
      if (canDelete(rowChat, m)) out.push({ id: 'delete', label: tr().conv.delete, danger: true, run: () => setConfirm(m) });
      return out;
    },
    [rowChat, startEdit],
  );


  // Image lightbox and file viewer. Opening pushes a history entry so the phone's Back button closes it;
  // closing it any other way pops that entry again (only if it is still the current one).
  // `exiting`: Back was pressed; the lightbox plays its closing animation, then calls closeViewer.
  // `gallery`: opened from the chat's media page, over the whole chat's media list (not the loaded messages).
  type Viewer = { key: string; from: HTMLElement | null; file?: MediaTarget; exiting?: boolean; gallery?: boolean };
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const openViewer = useCallback((v: Viewer) => {
    if (viewerRef.current) return;
    for (const el of document.querySelectorAll<HTMLMediaElement>('.messages video, .messages audio')) if (!el.muted && !el.paused) el.pause();
    try {
      history.pushState({ ...(history.state ?? {}), klatchlyLightbox: true }, '');
    } catch {
      // history unavailable: Back simply leaves the chat
    }
    setViewer(v);
  }, []);
  const openMedia = useCallback((key: string, from: HTMLElement | null) => openViewer({ key, from }), [openViewer]);
  const openFile = useCallback((file: MediaTarget, from: HTMLElement | null) => openViewer({ key: file.key, from, file }), [openViewer]);
  const openGalleryMedia = useCallback((key: string, from: HTMLElement | null) => openViewer({ key, from, gallery: true }), [openViewer]);
  const closeViewer = useCallback((viaHistory = false) => {
    const v = viewerRef.current;
    if (!v) return;
    viewerRef.current = null;
    setViewer(null);
    if (!viaHistory && (history.state as { klatchlyLightbox?: boolean } | null)?.klatchlyLightbox) history.back();
    const target = v.from?.isConnected ? v.from : document.querySelector<HTMLElement>(`[data-media-key="${CSS.escape(v.key)}"], [data-file-key="${CSS.escape(v.key)}"]`);
    requestAnimationFrame(() => target?.focus({ preventScroll: true }));
  }, []);
  const viewerOpen = !!viewer;
  useEffect(() => {
    if (!viewerOpen) return;
    const onPop = () => {
      if ((history.state as { klatchlyLightbox?: boolean } | null)?.klatchlyLightbox) return;
      const v = viewerRef.current;
      if (v && !v.file && !v.exiting) setViewer({ ...v, exiting: true });
      else closeViewer(true);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [viewerOpen, closeViewer]);
  const closeLightbox = useCallback(() => closeViewer(), [closeViewer]);
  const lightboxOpen = !!viewer && !viewer.file;
  // The media page's list (newest first there; the viewer goes oldest to newest like the conversation).
  const fromGallery = lightboxOpen && !!viewer?.gallery;
  const mediaQ = useInfiniteQuery({ ...chatMediaQuery(chatID, 'media'), enabled: fromGallery });
  const viewerMsgs = useMemo(() => {
    if (!lightboxOpen) return [];
    if (fromGallery) return (mediaQ.data?.pages ?? []).flatMap((p) => p.items).reverse() as unknown as Message[];
    return flat.flatMap((r) => (r.kind === 'msg' ? [r.m] : []));
  }, [lightboxOpen, fromGallery, mediaQ.data, flat]);
  const gallery = useMemo<LightboxItem[]>(() => {
    const byID = new Map(viewerMsgs.map((m) => [m.id, m]));
    const seen = new Set<string>();
    return galleryOf(viewerMsgs, attachmentUrl, (a) => mediaUrl(a.posterImg)).flatMap((it) => {
      if (seen.has(it.key)) return [];
      seen.add(it.key);
      const m = byID.get(it.messageID)!;
      return [{ ...it, sender: m.isSender ? tr().common.you : (displaySender(m) ?? '') }];
    });
  }, [viewerMsgs]);
  // Swiping toward the oldest item of the media page loads the next older page.
  const mediaQRef = useRef(mediaQ);
  mediaQRef.current = mediaQ;
  const onViewerIndex = useCallback((i: number) => {
    const q = mediaQRef.current;
    if (i < 4 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, []);
  const forwardItem = useCallback(
    (it: LightboxItem) => {
      const m = viewerMsgs.find((x) => x.id === it.messageID);
      if (!m) return;
      const att = Number(it.key.slice(it.key.lastIndexOf(':') + 1));
      // The viewer is a modal dialog (the page under it is inert): close it, then pick the chats.
      closeViewer();
      startForward(forwardJobOf([{ m, att: (m.attachments?.length ?? 0) > 1 ? att : undefined }]));
    },
    [viewerMsgs, closeViewer],
  );

  // The "Media, links and files" page (/chat/<id>/media|files|links), over this conversation.
  const chatPath = `/chat/${encodeURIComponent(chatID)}`;
  const openMediaPage = useCallback(() => {
    navigate(`${chatPath}/media`, { state: { ...((history.state as object | null) ?? {}), fromChat: true } });
  }, [navigate, chatPath]);
  const closeMediaPage = useCallback(() => {
    if ((history.state as { fromChat?: boolean } | null)?.fromChat) history.back();
    else navigate(chatPath, { replace: true });
  }, [navigate, chatPath]);
  const setMediaTab = useCallback((tab: MediaTab) => replaceKeepState(navigate, `${chatPath}/${tab}`), [navigate, chatPath]);
  // "Show in chat" from the media page's viewer: back to the conversation (both history entries), then the jump.
  const pendingJump = useRef<string>(undefined);
  const showInChat = useCallback(
    (it: LightboxItem) => {
      pendingJump.current = it.messageID;
      const st = history.state as { klatchlyLightbox?: boolean; fromChat?: boolean } | null;
      viewerRef.current = null;
      setViewer(null);
      if (st?.fromChat) history.go(st.klatchlyLightbox ? -2 : -1);
      else navigate(chatPath, { replace: true });
    },
    [navigate, chatPath],
  );

  // One row of the list (index in `rows`), for the list and its preview while it is placed. `drawn`: the row Virtuoso
  // drew at that index, shown from where it is now when the index points at no row (its indexes and the rows out of
  // step for a moment must not take the screen down); nothing when it is no longer listed.
  const renderRow = (index: number, drawn?: Row) => {
    let i = index;
    if (!rows[i]) {
      const key = drawn && rowKey(drawn);
      i = key === undefined ? -1 : rows.findIndex((r) => rowKey(r) === key);
      if (i < 0) return null;
    }
    const row = rows[i]!;
    const unread = divider.current && row.kind !== 'out' && rowKey(row) === divider.current.id ? unreadOpen : undefined;
    // Albums: the receipts of their last message (read up to it = read up to the whole album).
    const ms = rowMsgs(row);
    const lastID = ms[ms.length - 1]?.id;
    return <MessageItem row={row} prev={i > 0 ? rows[i - 1] : undefined} isGroup={isGroup} onRetry={retry} unread={unread} readBy={lastID ? receipts.get(lastID) : undefined} deliveredTo={lastID ? deliveries.get(lastID) : undefined} />;
  };

  const selfName = chat?.participants?.items.find((p) => p.isSelf)?.fullName;
  const conv: Conv = useMemo(
    () => ({
      chatID,
      chat: rowChat,
      selfIDs,
      names,
      selfName,
      highlight,
      augmentations,
      reply,
      toggleReaction,
      nameOf,
      needNames,
      openMenu: (m: Message, at: { x: number; y: number; corner?: boolean } | null, mode: MenuMode, key?: string, link?: string, att?: number) =>
        setMenu({ m, at, mode, key, link, att }),
      jumpTo,
      editing,
      startEdit,
      saveEdit,
      cancelEdit,
      remove: (m: Message) => setConfirm(m),
      openMedia,
      openFile,
    }),
    [chatID, rowChat, selfIDs, names, selfName, highlight, augmentations, reply, toggleReaction, nameOf, needNames, jumpTo, editing, startEdit, saveEdit, cancelEdit, openMedia, openFile],
  );

  return (
    <ConvContext.Provider value={conv}>
    <div className={`conversation ${dragging ? 'dragging' : ''}`} data-testid="conversation" {...dropHandlers}>
      {dragging && <div className="drop-hint">{t.conv.dropToAttach}</div>}
      <header className="conv-header">
        <button type="button" className="icon-btn back" aria-label={t.common.back} data-testid="conv-back" onClick={() => backToList(navigate)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {/* The chat's details: its "Media, links and files" page. */}
        <button type="button" className="conv-info" data-testid="conv-info" aria-label={`${chat?.title ?? ''} · ${t.gallery.open}`} title={t.gallery.open} onPointerDown={ChatMedia.preload} onClick={openMediaPage}>
          {chat && <Avatar chat={chat} size={36} />}
          <span className="conv-title">
            <span className="conv-name" data-testid="conv-name">{chat?.title ?? '…'}</span>
            {chat && (
              <span className="conv-sub">
                <NetworkBadge network={chat.network} size={12} />
                <span>{networkName(chat.network)}</span>
                <DiscreetMark chat={chat} />
                {isGroup && chat.participants?.total ? <span title={t.conv.members(chat.participants.total)}>· {chat.participants.total}</span> : null}
              </span>
            )}
          </span>
        </button>
        <div className="conv-tools">
          <MarkReadButton chat={chat} notify={flash} />
          {augmentations.map((a) => {
            const Header = a.Header;
            return (
              Header && (
                <Lazy key={a.id} failed={null}>
                  <Header chatID={chatID} readOnly={readOnly} />
                </Lazy>
              )
            );
          })}
        </div>
      </header>
      <ConnBar />

      <div
        className="messages"
        data-testid="messages"
        onWheel={markMove}
        onTouchMove={markMove}
        onKeyDown={markInput}
        onPointerDown={markInput}
        onTouchStart={onTouchStart}
      >
        {msgQ.isPending || (needMore && rows.length === 0) || needUnread ? (
          <MessagesSkeleton />
        ) : msgQ.isError ? (
          <div className="list-status">
            <button type="button" className="text-btn" data-testid="retry" onClick={() => msgQ.refetch()}>
              {t.common.retry}
            </button>
          </div>
        ) : (
          <Virtuoso
            ref={virtuoso}
            className="message-list"
            style={placed ? undefined : UNPLACED}
            data={rows}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={
              divider.current?.atOpen ? { index: Math.max(0, rows.findIndex((r) => rowKey(r) === dividerID)), align: 'start', offset: -8 } : { index: 'LAST', align: 'end' }
            }
            computeItemKey={(_, r) => rowKey(r)}
            startReached={() => {
              // Not because every row is drawn to be measured (iOS, measuring): the first row is then drawn wherever
              // the reader is, and each page shown would ask for the next, down to the start of the chat.
              if (overscanRef.current !== OVERSCAN_TOP) return;
              if (msgQ.hasNextPage && !msgQ.isFetchingNextPage && !holding.current) void msgQ.fetchNextPage();
            }}
            isScrolling={IOS_WEBKIT ? onScrolling : undefined}
            scrollerRef={setScroller}
            followOutput={followOutput}
            atBottomThreshold={80}
            atBottomStateChange={(bottom) => {
              setAtBottom(bottom);
              if (bottom) {
                // Not while the list places itself: Virtuoso first lays out an empty list (as tall as the screen,
                // so "at the bottom") and reports it 50 ms later when its first rows take longer than that to be
                // measured. Opening at the unread divider, that re-pinned the list and took it to the bottom.
                if (placedRef.current) stick.current = true;
                setUnseen(0);
              }
            }}
            totalListHeightChanged={() => {
              if (stick.current) settle();
            }}
            alignToBottom
            increaseViewportBy={{ top: overscanTop, bottom: OVERSCAN_BOTTOM }}
            // Rows measured in the frame they change height in (by default a frame later): Virtuoso's correction of the
            // scroll position (a row above the screen drawn or grown) lands in the same frame as the change, not one
            // painted frame after it, in which the messages on screen moved down then back up ("they vibrate"). Once
            // placed only: while it places itself (hidden), Virtuoso measuring in the same frame never reaches the
            // unread divider it opens at (its rows stay hidden). The price: a benign "ResizeObserver loop" notice in
            // the console now and then.
            skipAnimationFrameInResizeObserver={placed}
            components={LIST_COMPONENTS}
            context={{ fetching: msgQ.isFetchingNextPage, hasMore: msgQ.hasNextPage }}
            itemContent={(index, row) => renderRow(index - firstItemIndex, row)}
          />
        )}
        {/* Over the list while it is placed (still hidden): its messages already, laid out where the list will show them
            (ListPreview), so a chat in the cache shows at once; the skeleton only when there is nothing to show. */}
        {loaded && !placed && (
          <div ref={placing} className="list-placing">
            {rows.length > 0 ? (
              <ListPreview count={rows.length} from={divider.current?.atOpen ? rows.findIndex((r) => rowKey(r) === dividerID) : undefined} rowKey={(i) => rowKey(rows[i]!)} renderRow={renderRow} header={<ListHeader context={{ fetching: false, hasMore: msgQ.hasNextPage }} />} />
            ) : (
              <MessagesSkeleton />
            )}
          </div>
        )}
        {!atBottom && !msgQ.isPending && (
          <button
            type="button"
            className={`jump-latest ${unseen ? 'has-new' : ''}`}
            data-testid="new-messages"
            data-unseen={unseen}
            aria-label={unseen ? t.conv.newMessages(unseen) : t.conv.jumpToLatest}
            title={unseen ? t.conv.newMessages(unseen) : t.conv.jumpToLatest}
            onClick={jumpLatest}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {unseen > 0 && <span className="jump-count">{unseen > 99 ? '99+' : unseen}</span>}
          </button>
        )}
      </div>

      <Composer
        disabled={readOnly}
        tray={tray}
        onSend={send}
        draftKey={chatID}
        participants={mentionList}
        onNeedParticipants={needParticipants}
        onVoice={readOnly || !canSendVoice(chat) ? undefined : sendVoice}
        noFiles={!canAttach(chat)}
        augmentations={augmentations}
        fill={fill}
        network={chatNetwork(chat)}
        voiceChat={chat}
        onError={flash}
        focusKey={replyTo?.id ?? composeKey}
        onEscape={() => setReplyTo(null)}
        onEditLast={readOnly ? undefined : editLast}
        maxLength={Math.min(20_000, chat?.capabilities?.maxTextLength ?? 20_000)}
        top={
          <>
          {augmentations.map((a) => {
            const Slot = a.Conversation;
            return (
              Slot && (
                <Lazy key={`${a.id}-${chatID}`} failed={null}>
                  <Slot chatID={chatID} readOnly={readOnly} fill={fillField} notify={flash} />
                </Lazy>
              )
            );
          })}
          <ReplyHint key={chatID} chat={chat} />
          {replyTo && (
            <div className="reply-bar" data-testid="reply-bar">
              <div className="reply-bar-main">
                <span className="quote-name">{t.conv.replyingTo(replyTo.isSender ? t.conv.yourself : (displaySender(replyTo) ?? '…'))}</span>
                <span className="quote-text">{quoteText(replyTo)}</span>
              </div>
              <QuoteThumb m={replyTo} />
              <button type="button" className="icon-btn small" aria-label={t.conv.cancelReply} data-testid="cancel-reply" onClick={() => setReplyTo(null)}>
                ×
              </button>
            </div>
          )}
          </>
        }
      />
      {viewer && !viewer.file && (
        <Lazy failed={null} onError={closeLightbox}>
          <Lightbox
            items={gallery}
            startKey={viewer.key}
            from={viewer.from}
            exiting={!!viewer.exiting}
            onClose={closeLightbox}
            scope={viewer.gallery ? '.chat-media' : '.messages'}
            onShowInChat={viewer.gallery ? showInChat : undefined}
            onForward={forwardItem}
            onIndex={viewer.gallery ? onViewerIndex : undefined}
          />
        </Lazy>
      )}
      {viewer?.file && (
        <Lazy failed={null} onError={closeLightbox}>
          <FileViewer target={viewer.file} onClose={closeLightbox} />
        </Lazy>
      )}
      {sub && (
        <Lazy key="media" fallback={<div className="chat-media" />}>
          <ChatMedia chat={chat} chatID={chatID} tab={sub} onTab={setMediaTab} onClose={closeMediaPage} onOpenMedia={openGalleryMedia} onOpenFile={openFile} />
        </Lazy>
      )}
      {(fw.job || fw.outcome) && (
        <Lazy failed={null}>
          <ForwardHost />
        </Lazy>
      )}
      {menu && (
        <Lazy failed={null} onError={closeMenu}>
          <MessageMenu state={menu} onClose={closeMenu} extra={menuExtra} />
        </Lazy>
      )}
      {confirm && (
        <ConfirmDelete
          deleteForMe={!!chat?.capabilities?.deleteForMe}
          onCancel={() => setConfirm(null)}
          onConfirm={(forEveryone) => doDelete(confirm, forEveryone)}
        />
      )}
      {toast && <div className="toast" role="status" data-testid="toast">{toast}</div>}
      <SaveDock scope="conv" />
    </div>
    </ConvContext.Provider>
  );
}


function ConfirmDelete({ deleteForMe, onCancel, onConfirm }: { deleteForMe: boolean; onCancel: () => void; onConfirm: (forEveryone: boolean) => void }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="confirm" aria-label={t.conv.deleteTitle} data-testid="confirm-delete" onCancel={onCancel} onClose={onCancel}>
      <p>{t.conv.deleteConfirm}</p>
      <div className="confirm-actions">
        <button type="button" className="text-btn" onClick={onCancel} autoFocus>
          {t.common.cancel}
        </button>
        {deleteForMe && (
          <button type="button" className="text-btn" data-testid="delete-for-me" onClick={() => onConfirm(false)}>
            {t.conv.deleteForMe}
          </button>
        )}
        <button type="button" className="text-btn danger" data-testid="delete-for-everyone" onClick={() => onConfirm(true)}>
          {deleteForMe ? t.conv.deleteForEveryone : t.conv.delete}
        </button>
      </div>
    </dialog>
  );
}
