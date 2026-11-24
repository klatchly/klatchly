// A chat's "Media, links and files" page (/chat/<id>/media|files|links): over the conversation, which stays
// mounted underneath (its scroll position, "Show in chat"). Back (button, Esc, the phone's Back, a swipe from
// the left edge) returns to it. Media: a virtualized grid of thumbnails by month; Files: the file list; Links:
// the links of the messages. Media and files can be selected (button, or a long press) to share, download
// or forward several at once. Data: server/chatmedia.ts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type ReactNode, type RefObject, type TouchEvent as RTouchEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Virtuoso } from 'react-virtuoso';
import { attachmentUrl, mediaUrl, type LinkItem, type MediaMessage, type MediaTab } from './endpoints';
import { chatMediaQuery } from './cache';
import { mediaTarget, type MediaTarget } from './attach';
import { galleryOf, mediaKey, type MediaItem } from './gallery';
import { byMonth, columnsFor, durationLabel, gridRows, MAX_SELECT, shareable, toggleSelected } from './mediagrid';
import { bubbleImage, smallImage } from './thumbs';
import { extOf, fileKind, normName, splitName } from './files';
import { FileIcon } from './FileIcon';
import { dateTimeOf, fileSize } from './format';
import { useLang, useT } from './i18n';
import { useToast } from './conn';
import { prefetchFile, saveFile, saveMany, shareMode } from './save';
import { SaveDock } from './SaveDock';
import { forwardJobOf, startForward } from './forward';
import { edgeAxis, isEdgeStart, swipeBackDecision } from './gestures';
import { phoneLayout, reducedMotion, slideOut } from './nav';
import { isIOS, isStandalone } from './push';
import type { Chat, Message } from './types';

const TABS: MediaTab[] = ['media', 'files', 'links'];
const LONG_PRESS_MS = 450;

type Picked = { m: MediaMessage; index: number };
const asMessage = (m: MediaMessage) => m as unknown as Message;
const isListedFile = (a: NonNullable<Message['attachments']>[number]) =>
  !a.isSticker && (a.type === 'unknown' || (a.type === 'audio' && !a.isVoiceNote));

/** A video's poster picture from the network, when it sends one. */
const posterOf = (a: { posterImg?: string }) => mediaUrl(a.posterImg);

export interface ChatMediaProps {
  chat?: Chat;
  chatID: string;
  tab: MediaTab;
  onTab: (tab: MediaTab) => void;
  onClose: () => void;
  onOpenMedia: (key: string, from: HTMLElement | null) => void;
  onOpenFile: (target: MediaTarget, from: HTMLElement | null) => void;
}

export function ChatMedia({ chat, chatID, tab, onTab, onClose, onOpenMedia, onOpenFile }: ChatMediaProps) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const picked = useRef(new Map<string, Picked>());
  const [toast, flash] = useToast(2600);
  const selectable = tab !== 'links';

  // Leaving: on a phone the page slides away to the right first.
  const leaving = useRef(false);
  const close = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    const el = root.current;
    if (!el || !phoneLayout()) return onClose();
    slideOut(el, onClose);
  }, [onClose]);

  const exitSelect = useCallback(() => {
    setSelecting(false);
    setSelected([]);
  }, []);
  useEffect(exitSelect, [tab, exitSelect]);

  // Escape: out of the selection, then out of the page (not while a dialog, menu or field has it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open], .menu-backdrop')) return;
      if ((e.target as Element | null)?.closest?.('input, select, textarea')) return;
      if (selecting) exitSelect();
      else close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting, exitSelect, close]);

  // Edge swipe (phone): this page follows the finger and goes back to the conversation; the shell's own swipe
  // (back to the list) never sees these touches.
  useEffect(() => {
    const el = root.current;
    if (!el || (isIOS() && !isStandalone())) return;
    type G = { x0: number; y0: number; axis?: 'x' | 'y'; dx: number; lastX: number; lastT: number; vx: number };
    let g: G | null = null;
    const reset = () => {
      el.style.transition = '';
      el.style.transform = '';
    };
    const onStart = (e: TouchEvent) => {
      g = null;
      const p = e.touches[0];
      if (!p || e.touches.length > 1 || !isEdgeStart(p.clientX) || !phoneLayout()) return;
      e.stopPropagation();
      g = { x0: p.clientX, y0: p.clientY, dx: 0, lastX: p.clientX, lastT: e.timeStamp, vx: 0 };
    };
    const onMove = (e: TouchEvent) => {
      const p = e.touches[0];
      if (!g || !p) return;
      e.stopPropagation();
      const dx = p.clientX - g.x0;
      if (!g.axis) {
        if (dx === 0 && p.clientY === g.y0) return;
        g.axis = edgeAxis(dx, p.clientY - g.y0);
        if (g.axis === 'y') {
          g = null;
          return;
        }
        el.style.transition = 'none';
      }
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - g.lastT;
      if (dt > 0) g.vx = (p.clientX - g.lastX) / dt;
      g.lastX = p.clientX;
      g.lastT = e.timeStamp;
      g.dx = Math.max(0, dx);
      el.style.transform = `translateX(${g.dx}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      const cur = g;
      g = null;
      if (!cur?.axis) return;
      e.stopPropagation();
      const vx = e.timeStamp - cur.lastT > 120 ? 0 : cur.vx;
      if (e.type !== 'touchcancel' && swipeBackDecision(cur.dx, el.offsetWidth, vx)) {
        leaving.current = true;
        slideOut(el, onClose);
        return;
      }
      if (reducedMotion()) return reset();
      el.style.transition = 'transform 0.2s ease-out';
      el.style.transform = 'translateX(0)';
      window.setTimeout(reset, 220);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [onClose]);

  const toggle = useCallback(
    (key: string, p: Picked) => {
      setSelected((sel) => {
        const next = toggleSelected(sel, key, MAX_SELECT);
        if (next === 'full') {
          flash(t.gallery.maxSelected(MAX_SELECT));
          return sel;
        }
        if (next.length > sel.length) {
          picked.current.set(key, p);
          // iOS: the share sheet needs the files in memory at the tap.
          prefetchFile(mediaTarget(asMessage(p.m), p.index));
        }
        return next;
      });
    },
    [flash, t],
  );
  const startSelect = useCallback(
    (key: string, p: Picked) => {
      setSelecting(true);
      toggle(key, p);
    },
    [toggle],
  );

  const targets = () => selected.flatMap((k) => {
    const p = picked.current.get(k);
    const tg = p && mediaTarget(asMessage(p.m), p.index);
    return tg ? [tg] : [];
  });
  const shareSelected = () => {
    const ts = targets();
    if (!ts.length) return;
    if (shareMode() && !shareable(ts.map((x) => x.size))) return flash(t.gallery.tooBig);
    saveMany(ts, 'gallery');
  };
  const forwardSelected = () => {
    const items = selected.flatMap((k) => {
      const p = picked.current.get(k);
      return p ? [{ m: p.m, att: p.index }] : [];
    });
    if (!items.length) return;
    startForward(forwardJobOf(items));
    exitSelect();
  };

  const subtitle = chat?.title;
  return (
    <div ref={root} className={`chat-media ${selecting ? 'selecting' : ''}`} data-testid="chat-media" data-tab={tab}>
      <header className="conv-header media-header">
        <button type="button" className="icon-btn back" aria-label={t.common.back} title={t.common.back} data-testid="media-back" onClick={close}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="conv-title">
          <h1 className="conv-name">{t.gallery.title}</h1>
          {subtitle && <span className="conv-sub">{subtitle}</span>}
        </div>
        {selectable && (
          <button type="button" className="text-btn media-select" data-testid="media-select" aria-pressed={selecting} onClick={() => (selecting ? exitSelect() : setSelecting(true))}>
            {selecting ? t.gallery.done : t.gallery.select}
          </button>
        )}
      </header>
      <div className="media-tabs" role="tablist" aria-label={t.gallery.title}>
        {TABS.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={x === tab} className={x === tab ? 'on' : ''} data-testid={`media-tab-${x}`} onClick={() => onTab(x)}>
            {t.gallery.tabs[x]}
          </button>
        ))}
      </div>
      <div className="media-body" role="tabpanel">
        {tab === 'media' ? (
          <MediaGrid chatID={chatID} selecting={selecting} selected={selected} onToggle={toggle} onLongPress={startSelect} onOpen={onOpenMedia} />
        ) : tab === 'files' ? (
          <FileList chatID={chatID} selecting={selecting} selected={selected} onToggle={toggle} onLongPress={startSelect} onOpen={onOpenFile} />
        ) : (
          <LinkList chatID={chatID} />
        )}
      </div>
      {selecting && (
        <div className="media-selbar" data-testid="media-selbar">
          <span className="media-selcount" data-testid="media-selcount">{t.gallery.selected(selected.length)}</span>
          <button type="button" className="text-btn" data-testid="media-share" disabled={!selected.length} onClick={shareSelected}>
            {shareMode() ? t.gallery.share : t.gallery.download}
          </button>
          <button type="button" className="text-btn" data-testid="media-forward" disabled={!selected.length} onClick={forwardSelected}>
            {t.gallery.forward}
          </button>
        </div>
      )}
      {toast && <div className="toast" role="status" data-testid="media-toast">{toast}</div>}
      <SaveDock scope="gallery" />
    </div>
  );
}

type ListProps = {
  chatID: string;
  selecting: boolean;
  selected: string[];
  onToggle: (key: string, p: Picked) => void;
  onLongPress: (key: string, p: Picked) => void;
};

/** Long press (touch) to start selecting; the click that follows it is swallowed. */
function usePress(onLong: () => void) {
  const st = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  return {
    onTouchStart: (e: RTouchEvent) => {
      const p = e.touches[0];
      if (!p || e.touches.length > 1) return;
      const s = { x: p.clientX, y: p.clientY, fired: false, timer: 0 };
      s.timer = window.setTimeout(() => {
        s.fired = true;
        window.getSelection()?.removeAllRanges();
        onLong();
      }, LONG_PRESS_MS);
      st.current = s;
    },
    onTouchMove: (e: RTouchEvent) => {
      const s = st.current;
      const p = e.touches[0];
      if (s && p && (Math.abs(p.clientX - s.x) > 8 || Math.abs(p.clientY - s.y) > 8)) window.clearTimeout(s.timer);
    },
    onTouchEnd: (e: RTouchEvent) => {
      const s = st.current;
      if (!s) return;
      window.clearTimeout(s.timer);
      if (s.fired && e.cancelable) e.preventDefault();
    },
    onContextMenu: (e: RMouseEvent) => {
      // A long press on iOS / Android also raises the context menu: never the browser's on a thumbnail.
      if (st.current?.fired) e.preventDefault();
    },
    swallow: () => {
      const s = st.current;
      if (s?.fired) {
        st.current = null;
        return true;
      }
      return false;
    },
  };
}

function usePages(chatID: string, tab: MediaTab) {
  const q = useInfiniteQuery(chatMediaQuery(chatID, tab));
  const messages = useMemo(() => {
    const seen = new Set<string>();
    const out: MediaMessage[] = [];
    for (const p of q.data?.pages ?? []) for (const m of p.items) if (!seen.has(m.id)) (seen.add(m.id), out.push(m));
    return out;
  }, [q.data]);
  const more = () => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  };
  return { q, messages, more };
}

function Status({ q, empty, count }: { q: { isPending: boolean; isError: boolean; refetch: () => unknown }; empty: string; count: number }) {
  const t = useT();
  if (q.isPending) return <div className="media-status" role="status">{t.common.loading}</div>;
  if (q.isError)
    return (
      <div className="media-status" role="alert">
        {t.gallery.loadFailed}{' '}
        <button type="button" className="text-btn" onClick={() => q.refetch()}>
          {t.common.retry}
        </button>
      </div>
    );
  if (!count) return <div className="media-status" data-testid="media-empty">{empty}</div>;
  return null;
}

function MonthHeader({ k }: { k: string }) {
  const t = useT();
  const lang = useLang();
  const [y, m] = k.split('-').map(Number);
  return <h2 className="media-month">{y ? t.gallery.month(new Date(y, (m ?? 1) - 1, 1), lang) : '…'}</h2>;
}

/** The grid's width, for its column count (and the thumbnails' size). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(() => (phoneLayout() ? window.innerWidth : 600));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || w);
    if (!('ResizeObserver' in window)) return;
    const ro = new ResizeObserver(([e]) => {
      const nw = Math.round(e?.contentRect.width ?? 0);
      if (nw) setW(nw);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
  return w;
}

function MediaGrid({ chatID, selecting, selected, onToggle, onLongPress, onOpen }: ListProps & { onOpen: (key: string, from: HTMLElement | null) => void }) {
  const t = useT();
  const { q, messages, more } = usePages(chatID, 'media');
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const cols = columnsFor(width);
  const cell = Math.floor((width - (cols - 1) * 2) / cols);
  const byID = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const items = useMemo(() => galleryOf(messages, attachmentUrl, posterOf), [messages]);
  const rows = useMemo(() => gridRows(items, cols), [items, cols]);
  return (
    <div ref={box} className="media-grid-box">
      <Status q={q} empty={t.gallery.empty.media} count={items.length} />
      {items.length > 0 && (
        <Virtuoso
          className="media-scroll"
          data={rows}
          computeItemKey={(_, r) => r.key}
          endReached={more}
          increaseViewportBy={{ top: 400, bottom: 800 }}
          components={{ Footer: () => <div className="media-foot">{q.isFetchingNextPage ? '…' : q.hasNextPage ? '' : t.gallery.end}</div> }}
          itemContent={(_, r) =>
            r.kind === 'month' ? (
              <MonthHeader k={r.key.slice(2)} />
            ) : (
              <div className="media-row" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
                {r.items.map((it) => (
                  <MediaCell key={it.key} it={it} size={cell} m={byID.get(it.messageID)!} selecting={selecting} on={selected.includes(it.key)} onToggle={onToggle} onLongPress={onLongPress} onOpen={onOpen} />
                ))}
              </div>
            )
          }
        />
      )}
    </div>
  );
}

function MediaCell({ it, m, size, selecting, on, onToggle, onLongPress, onOpen }: { it: MediaItem; m: MediaMessage; size: number; selecting: boolean; on: boolean } & Pick<ListProps, 'onToggle' | 'onLongPress'> & { onOpen: (key: string, from: HTMLElement | null) => void }) {
  const t = useT();
  const index = Number(it.key.slice(it.key.lastIndexOf(':') + 1));
  const p: Picked = { m, index };
  const press = usePress(() => onLongPress(it.key, p));
  const [failed, setFailed] = useState(false);
  const len = it.kind === 'video' ? durationLabel(it.duration) : undefined;
  const label = `${it.kind === 'video' ? t.media.video : t.media.photo}, ${dateTimeOf(it.timestamp)}`;
  let pic: ReactNode;
  if (it.kind === 'img') {
    const im = bubbleImage(it.src, it.width, size);
    pic = <img src={im.src} srcSet={im.srcSet} sizes={im.sizes} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
  } else if (it.poster) {
    pic = <img src={smallImage(it.poster, 320)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
  } else {
    // No poster from the network: the video's first frame (Safari draws it with the #t fragment).
    pic = <video src={`${it.src}#t=0.1`} preload="metadata" muted playsInline disablePictureInPicture tabIndex={-1} onError={() => setFailed(true)} />;
  }
  return (
    <button
      type="button"
      className={`media-cell ${on ? 'on' : ''} ${failed ? 'failed' : ''}`}
      style={{ height: size }}
      data-media-key={it.key}
      data-kind={it.kind}
      data-testid="media-cell"
      aria-label={selecting ? t.gallery.selectItem(label) : label}
      aria-pressed={selecting ? on : undefined}
      {...press}
      onClick={(e) => {
        if (press.swallow()) return;
        if (selecting) onToggle(it.key, p);
        else onOpen(it.key, e.currentTarget);
      }}
    >
      {!failed && pic}
      {it.kind === 'video' && (
        <span className="media-badge" aria-hidden="true">
          ▶{len ? ` ${len}` : ''}
        </span>
      )}
      {it.kind === 'gif' && <span className="media-badge" aria-hidden="true">GIF</span>}
      {selecting && <span className={`media-check ${on ? 'on' : ''}`} aria-hidden="true" />}
    </button>
  );
}

type FileRow = { kind: 'month'; key: string } | { kind: 'file'; key: string; m: MediaMessage; index: number };

function FileList({ chatID, selecting, selected, onToggle, onLongPress, onOpen }: ListProps & { onOpen: (target: MediaTarget, from: HTMLElement | null) => void }) {
  const t = useT();
  const { q, messages, more } = usePages(chatID, 'files');
  const rows = useMemo(() => {
    const out: FileRow[] = [];
    for (const s of byMonth(messages)) {
      out.push({ kind: 'month', key: `m:${s.key}` });
      for (const m of s.items) m.attachments?.forEach((a, i) => isListedFile(a) && out.push({ kind: 'file', key: mediaKey(m.id, i), m, index: i }));
    }
    return out;
  }, [messages]);
  const count = rows.filter((r) => r.kind === 'file').length;
  return (
    <div className="media-grid-box">
      <Status q={q} empty={t.gallery.empty.files} count={count} />
      {count > 0 && (
        <Virtuoso
          className="media-scroll"
          data={rows}
          computeItemKey={(_, r) => r.key}
          endReached={more}
          components={{ Footer: () => <div className="media-foot">{q.isFetchingNextPage ? '…' : q.hasNextPage ? '' : t.gallery.end}</div> }}
          itemContent={(_, r) =>
            r.kind === 'month' ? <MonthHeader k={r.key.slice(2)} /> : <FileEntry r={r} selecting={selecting} on={selected.includes(r.key)} onToggle={onToggle} onLongPress={onLongPress} onOpen={onOpen} />
          }
        />
      )}
    </div>
  );
}

function FileEntry({ r, selecting, on, onToggle, onLongPress, onOpen }: { r: Extract<FileRow, { kind: 'file' }>; selecting: boolean; on: boolean } & Pick<ListProps, 'onToggle' | 'onLongPress'> & { onOpen: (target: MediaTarget, from: HTMLElement | null) => void }) {
  const t = useT();
  const a = r.m.attachments![r.index]!;
  const p: Picked = { m: r.m, index: r.index };
  const press = usePress(() => onLongPress(r.key, p));
  const name = normName(a.fileName) || t.common.file;
  const { head, tail } = splitName(name);
  const target = useMemo(() => mediaTarget(asMessage(r.m), r.index), [r.m, r.index]);
  const share = shareMode();
  return (
    <div className={`media-file ${on ? 'on' : ''}`} data-testid="media-file" data-file-key={r.key}>
      <button
        type="button"
        className="media-file-main"
        aria-pressed={selecting ? on : undefined}
        {...press}
        onClick={(e) => {
          if (press.swallow()) return;
          if (selecting) onToggle(r.key, p);
          else if (target) onOpen(target, e.currentTarget);
        }}
      >
        {selecting && <span className={`media-check inline ${on ? 'on' : ''}`} aria-hidden="true" />}
        <FileIcon kind={fileKind(a.fileName, a.mimeType)} ext={extOf(a.fileName, a.mimeType)} size={40} />
        <span className="media-file-text">
          <span className="media-file-name" title={name}>
            {head && <span className="att-file-head">{head}</span>}
            <span className="att-file-tail">{tail}</span>
          </span>
          <span className="media-file-sub">{[fileSize(a.fileSize), r.m.isSender ? t.common.you : r.m.senderName, dateTimeOf(r.m.timestamp)].filter(Boolean).join(' · ')}</span>
        </span>
      </button>
      {!selecting && target && (
        <button
          type="button"
          className="icon-btn"
          aria-label={share ? t.media.saveShare : t.media.download}
          title={share ? t.media.saveShare : t.media.download}
          data-testid="media-file-save"
          onPointerDown={() => prefetchFile(target)}
          onClick={() => saveFile(target, 'gallery')}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            {share ? (
              <path d="M12 15V4M8 8l4-4 4 4M6 12v7h12v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M12 4v11M7 10l5 5 5-5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </button>
      )}
    </div>
  );
}

type LinkRow = { kind: 'month'; key: string } | { kind: 'link'; key: string; link: LinkItem; m: MediaMessage };

function LinkList({ chatID }: { chatID: string }) {
  const t = useT();
  const { q, messages, more } = usePages(chatID, 'links');
  const rows = useMemo(() => {
    const out: LinkRow[] = [];
    for (const s of byMonth(messages)) {
      out.push({ kind: 'month', key: `m:${s.key}` });
      for (const m of s.items) (m.urls ?? []).forEach((link, i) => out.push({ kind: 'link', key: `${m.id}:${i}`, link, m }));
    }
    return out;
  }, [messages]);
  const count = rows.filter((r) => r.kind === 'link').length;
  return (
    <div className="media-grid-box">
      <Status q={q} empty={t.gallery.empty.links} count={count} />
      {count > 0 && (
        <Virtuoso
          className="media-scroll"
          data={rows}
          computeItemKey={(_, r) => r.key}
          endReached={more}
          components={{ Footer: () => <div className="media-foot">{q.isFetchingNextPage ? '…' : q.hasNextPage ? '' : t.gallery.end}</div> }}
          itemContent={(_, r) => (r.kind === 'month' ? <MonthHeader k={r.key.slice(2)} /> : <LinkEntry link={r.link} m={r.m} />)}
        />
      )}
    </div>
  );
}

function LinkEntry({ link, m }: { link: LinkItem; m: MediaMessage }) {
  const t = useT();
  const img = link.img ? smallImage(mediaUrl(link.img), 144) : undefined;
  const [broken, setBroken] = useState(false);
  // A new browsing context (Safari, or SFSafariViewController from the Home Screen app): never this page.
  return (
    <a className="media-link" href={link.url} target="_blank" rel="noopener noreferrer" data-testid="media-link" aria-label={t.gallery.openLink(link.domain)}>
      <span className="media-link-pic" aria-hidden="true">
        {img && !broken ? <img src={img} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} /> : <span>{(link.domain[0] ?? '?').toUpperCase()}</span>}
      </span>
      <span className="media-link-text">
        <span className="media-link-title">{link.title || link.url}</span>
        <span className="media-link-sub">{[link.domain, m.isSender ? t.common.you : m.senderName, dateTimeOf(m.timestamp)].filter(Boolean).join(' · ')}</span>
      </span>
    </a>
  );
}
