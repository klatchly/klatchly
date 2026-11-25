import { memo, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type TouchEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, attachmentUrl, HttpError, mediaUrl } from './endpoints';
import { findMessage } from './cache';
import { canReact, canReply, chatNetwork } from './caps';
import { useConv, type Conv } from './convctx';
import { defaultReaction, DOUBLE_TAP_REACTION, groupReactions, sendableKey, type ReactionGroup } from './reactions';
import { allowedReactions } from './caps';
import { dayKey, dayLabel, displaySender, fileSize, senderHue, snippet, timeOf } from './format';
import { knownName } from './names';
import type { Outgoing } from './pending';
import type { Attachment, Message } from './types';
import { t, useLang, useT } from './i18n';
import { membershipOf, summarize } from '../../server/membership';
import { linkify, RichText } from './richtext';
import { LinkPreviews } from './LinkPreview';
import { VoicePlayer } from './VoicePlayer';
import { isHtmlBody, toPlainText } from '../../server/richtext';
import { FormatHelp, useFormatter } from './formatting';
import { htmlToMarkdown } from './textformat';
import { parseCallEvent } from '../../server/callevent';
import { isKindCard } from '../../server/msgkind';
import { CallCard } from './CallCard';
import { KindCard } from './KindCard';
import { ChannelsCard } from './ChannelsCard';
import { parseChannelsShare } from '../../server/wechatshare';
import { mediaKey, mediaKind } from './gallery';
import { coverWidth, durationLabel, mosaic, tileKind, type MosaicTile } from './albums';
import { Lazy } from './lazy';
import { AiMenu } from './Composer';
import type { ComposerApi, RewriteNote } from './extension';
import { mediaTarget, saveName } from './attach';
import { extLabel, fileKind, extOf, middleTruncate, normName, splitName } from './files';
import { FileIcon } from './FileIcon';
import { saveFile, shareMode, useFileEntry } from './save';
import { bubbleImage, smallImage } from './thumbs';
import { LOOKUP_STALE_MS } from './persistcut';

/** Display names of the users a plain-text message mentions (rich bodies carry their own pills). */
function mentionNames(conv: Conv, m: Message): string[] | undefined {
  if (!m.mentions?.length) return undefined;
  const out: string[] = [];
  for (const id of m.mentions) {
    const n = conv.names.get(id) ?? (conv.selfIDs.has(id) ? conv.selfName : undefined);
    if (n) out.push(n);
  }
  return out.length ? out : undefined;
}

/**
 * A list row: one message, a photo album (several messages drawn as one bubble, albums.ts), arrivals and departures
 * in a group (one discreet line, server/membership.ts), or one being sent.
 */
export type Row = { kind: 'msg'; m: Message } | { kind: 'album'; ms: Message[] } | { kind: 'members'; ms: Message[] } | { kind: 'out'; o: Outgoing };
/** Virtuoso key: an album keeps its first message's (the bubble it grew from). */
export const rowKey = (r: Row) => (r.kind === 'msg' ? r.m.id : r.kind === 'out' ? r.o.localId : r.ms[0]!.id);
export const rowMsgs = (r: Row): Message[] => (r.kind === 'msg' ? [r.m] : r.kind === 'out' ? [] : r.ms);


function fit(a: Attachment, maxW = 280, maxH = 320): { width?: number; height?: number } {
  const w = a.size?.width;
  const h = a.size?.height;
  if (!w || !h) return {};
  const r = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * r), height: Math.round(h * r) };
}

// Set when a long-press opened the action sheet: the click that may follow must not open the lightbox.
let longPressAt = -Infinity;

/**
 * A plain primary click / tap on a picture opens the lightbox; middle-click, ctrl/cmd/shift-click and
 * "open in new tab" keep the link's own behaviour (the original in a new tab).
 */
function lightboxClick(open: ((el: HTMLElement) => void) | undefined) {
  if (!open) return undefined;
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (performance.now() - longPressAt < 900) return;
    open(e.currentTarget);
  };
}

/** A message that is only a sticker picture: drawn without the bubble's background. */
function stickerOnly(m: Message): boolean {
  const a = m.attachments;
  return !m.text && !!a?.length && a.every((x) => x.isSticker && x.type === 'img' && !!attachmentUrl(x));
}

/** Retry URL after a failed load (the relays ignore the extra parameter; a new URL skips the failed entry). */
const retryUrl = (src: string, n: number) => (n ? `${src}${src.includes('?') ? '&' : '?'}r=${n}` : src);

/**
 * A bubble picture that fades in once decoded, over the tinted box of its frame (the frame has its final size
 * from the start: no layout shift). Already decoded at mount (cache, scrolled back in): shown at once.
 */
function FadeImg(props: { src: string; srcSet?: string; sizes?: string; alt: string; width?: number; height?: number; onError: () => void }) {
  const [state, setState] = useState<'wait' | 'fade' | 'now'>('wait');
  return (
    <img
      {...props}
      draggable={false}
      ref={(el) => {
        if (state === 'wait' && el?.complete && el.naturalWidth) setState('now');
      }}
      className={`att-pic ${state}`}
      loading="lazy"
      decoding="async"
      data-testid="att-pic"
      onLoad={(e) => {
        // Fade in once decoded (load can come before the decode of an async-decoded picture).
        const el = e.currentTarget;
        void el
          .decode()
          .catch(() => {})
          .then(() => setState((s) => (s === 'wait' ? 'fade' : s)));
      }}
    />
  );
}

/**
 * A picture or video that failed to load (an expired CDN link, network): a tidy tile with Retry. In a bubble, `box`
 * is the room the picture had (its size, else the fixed square of a picture without one): the tile keeps it, so a
 * failure never changes the row's height (it arrives late, often while the history scrolls: Zalo's links expire after
 * two weeks, and a row that shrank above the screen moved the messages under the reader).
 */
function MediaError({ label, onRetry, index, box }: { label: string; onRetry: () => void; index: number; box?: { width?: number; height?: number; side: number; ratio?: string } }) {
  const t = useT();
  const style = box && (box.width && box.height ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : { width: box.side, aspectRatio: box.ratio ?? '1' });
  return (
    <div className={`att-broken ${box ? 'boxed' : ''}`} style={style} data-att={index} data-testid="media-error">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M9.5 9.5h.01" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span>{label}</span>
      <button type="button" className="text-btn" data-testid="media-retry" onClick={onRetry}>
        {t.common.retry}
      </button>
    </div>
  );
}

/** Save / share button of a file bubble, with the fetch's progress (iOS) as a ring. */
function FileSaveButton({ m, index, name }: { m: Message; index: number; name: string }) {
  const t = useT();
  const target = mediaTarget(m, index);
  const entry = useFileEntry(target?.src);
  if (!target) return null;
  const loading = entry?.status === 'loading';
  const pct = loading && entry.total ? entry.loaded / entry.total : 0;
  const share = shareMode();
  return (
    <button
      type="button"
      className={`att-file-save ${loading ? 'loading' : ''}`}
      aria-label={t.media.saveFile(name)}
      title={share ? t.media.saveShare : t.media.download}
      data-testid="att-file-save"
      onClick={() => saveFile(target, 'conv')}
    >
      {loading && (
        <svg className="ring" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
          <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
          <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray={`${Math.max(0.06, pct) * 94.25} 94.25`} transform="rotate(-90 18 18)" className={pct ? '' : 'spin'} />
        </svg>
      )}
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        {share ? (
          <path d="M12 15V4M8 8l4-4 4 4M6 12v7h12v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M12 4v11M7 10l5 5 5-5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  );
}

/** File name with a middle ellipsis at any width: the head shrinks, the end and the extension stay. */
function FileName({ name }: { name: string }) {
  const { head, tail } = splitName(middleTruncate(name, 80));
  return (
    <span className="att-file-name" data-testid="att-file-name" data-name={name}>
      {head && <span className="att-file-head">{head}</span>}
      <span className="att-file-tail">{tail}</span>
    </span>
  );
}

function FileCard({ m, a, index }: { m: Message; a: Attachment; index: number }) {
  const conv = useConv();
  const t = useT();
  const name = normName(a.fileName) || saveName(a, 'file');
  const ext = extLabel(a.fileName, a.mimeType);
  const details = [fileSize(a.fileSize), ext].filter(Boolean).join(' · ');
  return (
    <div className="att-file" data-att={index} data-testid="att-file-card" data-kind={fileKind(a.fileName, a.mimeType)}>
      <button
        type="button"
        className="att-file-main"
        aria-label={t.media.fileLabel(name, details || t.common.file)}
        title={name}
        data-testid="att-file"
        data-file-key={mediaKey(m.id, index)}
        onClick={(e) => {
          if (performance.now() - longPressAt < 900) return;
          const target = mediaTarget(m, index);
          if (target) conv.openFile(target, e.currentTarget);
        }}
      >
        <FileIcon kind={fileKind(a.fileName, a.mimeType)} ext={extOf(a.fileName, a.mimeType)} size={40} />
        <span className="att-file-body">
          <FileName name={name} />
          {details && <span className="att-file-size">{details}</span>}
        </span>
      </button>
      <FileSaveButton m={m} index={index} name={name} />
    </div>
  );
}

/** ▶ in the middle of a video's poster, and its length in a corner when known. */
function VideoBadge({ seconds }: { seconds?: number }) {
  const len = durationLabel(seconds);
  return (
    <>
      <span className="vid-play" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22">
          <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
        </svg>
      </span>
      {len && (
        <span className="vid-len" data-testid="vid-len">
          {len}
        </span>
      )}
    </>
  );
}

/**
 * Poster of a real video in a bubble or an album tile (the video itself plays in the viewer): the network's
 * poster picture as a thumbnail, else the video's first frame (preload="metadata" and a #t media fragment, which
 * makes iOS Safari draw that frame; a few hundred KB by Range at most), else (that frame cannot be decoded here,
 * or the file is gone: the viewer says which) a dark box. Its length comes from the message, else from the
 * metadata.
 */
function VideoPoster({ a, src, cssWidth, dims, onLength }: { a: Attachment; src: string; cssWidth: number; dims?: { width?: number; height?: number }; onLength: (s: number) => void }) {
  const [state, setState] = useState<'wait' | 'fade' | 'blank'>('wait');
  const [noPoster, setNoPoster] = useState(false);
  const poster = mediaUrl(a.posterImg);
  if (poster && !noPoster) return <FadeImg {...bubbleImage(poster, undefined, cssWidth)} alt="" {...dims} onError={() => setNoPoster(true)} />;
  // A canvas keeps the box's proportions like the picture would (width / height attributes, height: auto).
  if (state === 'blank') return <canvas className="att-frame vid-blank" width={dims?.width ?? 16} height={dims?.height ?? 9} aria-hidden="true" data-testid="vid-blank" />;
  return (
    <video
      className={`att-pic att-frame ${state}`}
      src={`${src}#t=0.1`}
      muted
      playsInline
      preload="metadata"
      disablePictureInPicture
      disableRemotePlayback
      tabIndex={-1}
      aria-hidden="true"
      data-testid="vid-frame"
      {...dims}
      onLoadedMetadata={(e) => {
        setState('fade');
        if (Number.isFinite(e.currentTarget.duration)) onLength(e.currentTarget.duration);
      }}
      onError={() => setState('blank')}
    />
  );
}

/** A real video in a bubble: its poster with ▶ and length; a tap opens it in the viewer (native controls there). */
function VideoThumb({ m, a, index, src, retry, onOpen }: { m: Message; a: Attachment; index: number; src: string; retry: number; onOpen?: (el: HTMLElement) => void }) {
  const t = useT();
  const [len, setLen] = useState(a.duration);
  const dims = fit(a);
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className={`att-img att-vid ${dims.width ? '' : 'nodims'}`}
      data-att={index}
      data-media-key={onOpen ? mediaKey(m.id, index) : undefined}
      aria-haspopup={onOpen ? 'dialog' : undefined}
      aria-label={t.media.playVideo(durationLabel(len))}
      onClick={lightboxClick(onOpen)}
    >
      <VideoPoster key={retry} a={a} src={src} cssWidth={dims.width ?? 280} dims={dims} onLength={(s) => setLen((v) => v ?? s)} />
      <VideoBadge seconds={len} />
    </a>
  );
}

function AttachmentView({ m, a, index, onOpen }: { m: Message; a: Attachment; index: number; onOpen?: (el: HTMLElement) => void }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const base = attachmentUrl(a);
  if (!base) return <div className="att-missing" data-att={index}>{t.msg.attachmentUnavailable}</div>;
  const src = retryUrl(base, retry);
  const again = () => {
    setFailed(false);
    setRetry((n) => n + 1);
  };
  const mkey = mediaKey(m.id, index);
  const mime = (a.mimeType ?? '').toLowerCase();
  const kind = mediaKind(a);
  if (a.type === 'img' && !mime.includes('lottie')) {
    const dims = fit(a, a.isSticker ? 140 : 280, a.isSticker ? 140 : 320);
    if (failed) return <MediaError label={a.isSticker ? t.msg.sticker : t.media.unavailable} onRetry={again} index={index} box={{ ...dims, side: a.isSticker ? 140 : 240 }} />;
    // Stickers are shown as they are: no lightbox, no link to the bare image.
    if (a.isSticker) {
      return (
        <span className={`att-img sticker ${dims.width ? '' : 'nodims'}`} data-att={index}>
          <img src={src} alt={t.msg.sticker} loading="lazy" decoding="async" draggable={false} {...dims} onError={() => setFailed(true)} />
        </span>
      );
    }
    const open = kind ? onOpen : undefined;
    // No size in the message (some sources' older media): a fixed square, cropped, so loading never moves the list.
    // The bubble shows a thumbnail (srcset, server/thumbs.ts); the link, the viewer and saving keep the original.
    const img = bubbleImage(base, a.size?.width, dims.width ?? 320, retry);
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className={`att-img ${dims.width ? '' : 'nodims'}`}
        data-att={index}
        data-media-key={open ? mkey : undefined}
        aria-haspopup={open ? 'dialog' : undefined}
        onClick={lightboxClick(open)}
      >
        <FadeImg {...img} alt={normName(a.fileName)} {...dims} onError={() => setFailed(true)} />
      </a>
    );
  }
  if (a.type === 'video') {
    const dims = fit(a);
    if (failed) return <MediaError label={t.media.videoUnavailable} onRetry={again} index={index} box={{ ...dims, side: 280, ratio: '16 / 9' }} />;
    if (!a.isGif) return <VideoThumb m={m} a={a} index={index} src={src} retry={retry} onOpen={onOpen} />;
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className={`att-img att-gif ${dims.width ? '' : 'nodims'}`}
        data-att={index}
        data-media-key={onOpen ? mkey : undefined}
        aria-haspopup={onOpen ? 'dialog' : undefined}
        aria-label={normName(a.fileName) || t.msg.openImage}
        onClick={lightboxClick(kind ? onOpen : undefined)}
      >
        <video className="att-video" src={src} autoPlay loop muted playsInline preload="metadata" {...dims} onError={() => setFailed(true)} />
      </a>
    );
  }
  if (a.type === 'audio') {
    return (
      <div className="att-audio-wrap" data-att={index}>
        {a.isVoiceNote || /^audio\/(ogg|opus|webm)/.test(mime) ? <VoicePlayer src={src} seconds={a.duration} /> : <audio className="att-audio" src={src} controls preload="none" />}
      </div>
    );
  }
  if (a.isSticker) return <div className="att-missing" data-att={index}>{t.msg.sticker}</div>;
  return <FileCard m={m} a={a} index={index} />;
}

/** Picture or text of a reaction (pills, reactors sheet, chat list). */
export function ReactionGlyph({ view, size = 18 }: { view: ReactionGroup['view']; size?: number }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (view.kind === 'image') {
    const src = mediaUrl(view.img);
    return src && !failed ? (
      <img className="reaction-img" src={src} alt={t.reactions.custom} width={size} height={size} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
    ) : (
      <span className="reaction-code">{t.reactions.custom}</span>
    );
  }
  return <span className={view.kind === 'emoji' ? 'reaction-emoji' : 'reaction-code'}>{view.text}</span>;
}

/** Reaction pills under a bubble, or (`tile`) over the corner of an album tile: each item keeps its own. */
function Reactions({ m, own, tile }: { m: Message; own: boolean; tile?: boolean }) {
  const conv = useConv();
  const t = useT();
  const press = useRef<number | undefined>(undefined);
  const long = useRef(false);
  const groups = groupReactions(m.reactions, conv.selfIDs);
  // Pills that were not there on the previous render pop in (not on first mount: scrolling back in).
  const seen = useRef<Set<string> | null>(null);
  const prev = seen.current;
  useEffect(() => {
    seen.current = new Set(groups.map((g) => g.id));
  });
  if (!groups.length) return null;
  const interactive = canReact(conv.chat) && !m.isDeleted;
  const caps = conv.chat?.capabilities;
  return (
    <div className={`reactions ${own ? 'own' : ''} ${tile ? 'tile-reactions' : ''}`} data-testid="reactions" data-mid-of={tile ? m.id : undefined}>
      {groups.map((g) => {
        const names = g.who.map((id) => conv.nameOf(id));
        const what = g.view.kind === 'image' ? t.reactions.custom : g.view.text;
        const addKey = !g.mine && interactive ? sendableKey(g.key, caps) : undefined;
        const hint = g.mine && interactive ? t.reactions.remove : addKey ? t.reactions.add : '';
        const label = `${t.reactions.pill(what, names.join(', '))}${hint ? ` (${hint})` : ''}`;
        return (
          <button
            key={g.id}
            type="button"
            className={`reaction ${g.mine ? 'mine' : ''} ${prev && !prev.has(g.id) ? 'pop' : ''}`}
            title={names.join('\n')}
            aria-label={label}
            aria-pressed={interactive ? g.mine : undefined}
            data-testid="reaction"
            data-kind={g.view.kind}
            data-mine={g.mine ? '1' : undefined}
            onMouseEnter={() => conv.needNames(g.who)}
            onFocus={() => conv.needNames(g.who)}
            onClick={() => {
              if (long.current) return;
              if (g.mine && interactive) conv.toggleReaction(m, g.key);
              else if (addKey) conv.toggleReaction(m, addKey);
              else conv.openMenu(m, null, 'reactors', g.id);
            }}
            onTouchStart={(e) => {
              e.stopPropagation();
              long.current = false;
              press.current = window.setTimeout(() => {
                long.current = true;
                navigator.vibrate?.(10);
                conv.needNames(g.who);
                conv.openMenu(m, null, 'reactors', g.id);
              }, 450);
            }}
            onTouchEnd={(e) => {
              e.stopPropagation();
              window.clearTimeout(press.current);
              // The sheet now covers the finger: no synthetic click on its backdrop (it would close it).
              if (long.current && e.cancelable) e.preventDefault();
            }}
            onTouchMove={() => window.clearTimeout(press.current)}
            onContextMenu={(e) => {
              e.preventDefault();
              conv.needNames(g.who);
              conv.openMenu(m, { x: e.clientX, y: e.clientY }, 'reactors', g.id);
            }}
          >
            <ReactionGlyph view={g.view} />
            {g.count > 1 && <span className="reaction-n">{g.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** What a quote shows for a media message: its caption, else "Photo", "Video", "GIF" or the file's name. */
export function quoteText(m: Message, max = 140): string {
  if (m.isDeleted || toPlainText(m.text).trim()) return snippet(m, max);
  const a = m.attachments?.[0];
  const k = a && mediaKind(a);
  const tr = t();
  if (k === 'img') return tr.media.photo;
  if (k === 'video') return tr.media.video;
  if (k === 'gif') return 'GIF';
  if (a && a.type === 'unknown' && !a.isSticker && normName(a.fileName)) return middleTruncate(normName(a.fileName), max);
  return snippet(m, max);
}

/** Small picture of a quoted media message (thumbnail 144, poster for a video, type icon for a file). */
export function QuoteThumb({ m }: { m: Message }) {
  const [failed, setFailed] = useState(false);
  if (m.isDeleted) return null;
  const a = m.attachments?.find((x) => !x.isSticker && x.type !== 'audio');
  if (!a) return null;
  const k = mediaKind(a);
  if (a.type === 'unknown') return <span className="quote-thumb file" aria-hidden="true"><FileIcon kind={fileKind(a.fileName, a.mimeType)} ext={extOf(a.fileName, a.mimeType)} size={32} /></span>;
  if (!k) return null;
  const pic = k === 'img' ? attachmentUrl(a) : mediaUrl(a.posterImg);
  const src = pic && smallImage(pic, 144);
  return (
    <span className={`quote-thumb ${k}`} aria-hidden="true" data-testid="quote-thumb" data-kind={k}>
      {src && !failed ? <img src={src} alt="" width={36} height={36} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} /> : null}
      {k !== 'img' && (
        <svg viewBox="0 0 24 24" width="14" height="14" className="quote-play">
          <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}

/** Quoted message a reply points to; fetched when it is not in the loaded pages. */
export function ReplyQuote({ chatID, id, onClick }: { chatID: string; id: string; onClick?: () => void }) {
  const qc = useQueryClient();
  const t = useT();
  const q = useQuery({
    queryKey: ['message', chatID, id],
    queryFn: () => api.message(chatID, id),
    initialData: () => findMessage(qc, chatID, id),
    staleTime: LOOKUP_STALE_MS,
    retry: (n, e) => n < 1 && !(e instanceof HttpError && (e.status === 404 || e.status === 400)),
  });
  const m = q.data;
  const unavailable = q.isError || (!q.isPending && !m);
  return (
    <button type="button" className={`quote ${unavailable ? 'unavailable' : ''}`} data-testid="quote" onClick={onClick} disabled={unavailable || !onClick}>
      {unavailable ? (
        <span className="quote-text">{t.msg.unavailable}</span>
      ) : !m ? (
        <span className="quote-text">…</span>
      ) : (
        <>
          <span className="quote-body">
            <span className="quote-name">{m.isSender ? t.common.you : (displaySender(m) ?? '')}</span>
            <span className="quote-text">{quoteText(m)}</span>
          </span>
          <QuoteThumb m={m} />
        </>
      )}
    </button>
  );
}

/** The whole text in view, wrapped lines included, up to half the screen (then it scrolls). */
function fitEditor(el: HTMLTextAreaElement) {
  const was = el.style.height;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.5)}px`;
  // Grown: the list does not follow by itself; keep the editor and its buttons in view (after the list has
  // measured the taller row).
  if (was && el.style.height !== was) {
    const row = el.closest('.msg') ?? el.closest('form');
    [0, 80].forEach((ms) => window.setTimeout(() => row?.scrollIntoView({ block: 'nearest' }), ms));
  }
}

function InlineEditor({ m }: { m: Message }) {
  const conv = useConv();
  const t = useT();
  // Rich (HTML) bodies are edited as the Markdown that gives them (what the network displays of it), which the
  // server converts back: the formatting survives an edit.
  const network = chatNetwork(conv.chat);
  const [initial] = useState(() => (isHtmlBody(m.text) ? htmlToMarkdown(m.text!, network?.formatting, { edit: true }) : toPlainText(m.text)));
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const max = Math.min(20_000, conv.chat?.capabilities?.maxTextLength ?? 20_000);
  const valid = !!text.trim() && text.length <= max && text !== initial;
  // ✨ as in the composer, with the sections that only rewrite the text (ComposerSlots.inEdit: writing's fixes):
  // a message is often edited to fix its spelling. Undo puts the text back; the original shows meanwhile.
  const parts = conv.augmentations.filter((a) => a.composer?.inEdit);
  const [aiMenu, setAiMenu] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string>();
  const [undo, setUndo] = useState<{ before: string; result: string; note: RewriteNote } | null>(null);
  const live = useRef(text);
  live.current = text;
  const fmt = useFormatter(ref, network, setAiError);
  const setField = (s: string) => {
    setText(s);
    if (ref.current) requestAnimationFrame(() => ref.current && fitEditor(ref.current));
  };
  const editApi: ComposerApi = {
    chatID: conv.chatID,
    text: text.trim(),
    mentions: [],
    network,
    busy: working !== null,
    async rewrite(work, label, done) {
      if (working !== null) return;
      const cur = live.current;
      // A rewrite of a rewrite keeps the very first text.
      const before = undo && cur === undo.result ? undo.before : cur;
      setWorking(label);
      setAiError(undefined);
      try {
        const out = await work(cur.trim());
        setField(out);
        setUndo({ before, result: out, note: done(before) });
      } catch (e) {
        setAiError(e instanceof Error ? e.message : String(e));
      } finally {
        setWorking(null);
        ref.current?.focus();
      }
    },
    run() {},
    fill: setField,
    notify: setAiError,
  };
  const save = () => {
    if (!valid) return text === initial && conv.cancelEdit();
    if (undo?.note.onSend && text === undo.result) undo.note.onSend(text.trim());
    conv.saveEdit(m, text);
  };
  return (
    <form
      className="inline-edit"
      data-testid="inline-edit"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <textarea
        ref={(el) => {
          if (el && ref.current !== el) {
            ref.current = el;
            fitEditor(el);
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }}
        value={text}
        maxLength={max}
        readOnly={working !== null}
        aria-label={t.msg.editLabel}
        data-testid="inline-edit-input"
        rows={1}
        onChange={(e) => {
          setText(e.target.value);
          fitEditor(e.target);
        }}
        onPaste={fmt.onPaste}
        onKeyDown={(e) => {
          if (fmt.onKeyDown(e, { enterSends: window.matchMedia('(pointer: fine)').matches })) return;
          if (e.key === 'Escape') conv.cancelEdit();
          else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
            e.preventDefault();
            save();
          }
        }}
      />
      {fmt.help && <FormatHelp fmt={fmt} network={network} />}
      {working !== null && <div className="assist-bar" data-testid="inline-edit-working">{working}</div>}
      {aiError && working === null && (
        <div className="assist-bar" role="alert" data-testid="inline-edit-ai-error">
          {aiError}
        </div>
      )}
      {undo && working === null && (
        <div className="assist-bar" data-testid="inline-edit-assist-bar">
          <span className="assist-bar-main">
            <span className="assist-bar-label">{undo.note.label}</span>
            {undo.note.detail !== undefined && <span className="assist-bar-original">{undo.note.detail}</span>}
          </span>
          <button
            type="button"
            className="text-btn"
            data-testid="inline-edit-assist-undo"
            onClick={() => {
              setField(undo.before);
              setUndo(null);
              ref.current?.focus();
            }}
          >
            {t.assist.restore}
          </button>
        </div>
      )}
      <div className="inline-edit-actions">
        {parts.length > 0 && (
          <span className="assist-wrap inline-edit-ai">
            <button
              type="button"
              className={`icon-btn assist-btn ${working !== null ? 'busy' : ''}`}
              aria-label={t.assist.button}
              title={t.assist.button}
              aria-haspopup="menu"
              aria-expanded={aiMenu}
              data-testid="inline-edit-assist"
              disabled={working !== null || !text.trim()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAiMenu((v) => !v)}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M10 3l1.8 4.9L17 10l-5.2 2.1L10 17l-1.8-4.9L3 10l5.2-2.1zM18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              </svg>
            </button>
            {aiMenu && <AiMenu api={editApi} parts={parts} onClose={() => setAiMenu(false)} toggle="[data-testid=inline-edit-assist]" />}
          </span>
        )}
        <button type="button" className="text-btn" data-testid="inline-edit-cancel" onClick={conv.cancelEdit}>
          {t.common.cancel}
        </button>
        <button type="submit" className="text-btn primary" data-testid="inline-edit-save" disabled={!valid}>
          {t.msg.save}
        </button>
      </div>
    </form>
  );
}

// Elements whose own tap / double-click must keep its meaning (no double-tap reaction there).
const OWN_GESTURE = 'a, button, video, audio, input, textarea, select, .inline-edit, .voice';
let lastTouchAt = 0;
const DOUBLE_TAP_MS = 400;

/** Double-tap / double-click reaction: ❤️ (or the network's first allowed default), toggled. */
function quickReact(conv: Conv, m: Message): boolean {
  if (!DOUBLE_TAP_REACTION || m.isDeleted || !canReact(conv.chat)) return false;
  const key = defaultReaction(allowedReactions(conv.chat));
  if (!key) return false;
  conv.toggleReaction(m, key);
  return true;
}

// Where a double-click means "select this word" (message text, quotes, file names): no reaction there.
const TEXT_AREAS = '.text, .quote, .att-file, .link-card';

/** Desktop double-click on the bubble outside its text toggles the default reaction. */
function onBubbleDoubleClick(conv: Conv, m: Message, e: MouseEvent) {
  if (performance.now() - lastTouchAt < 800) return; // synthesized after a double-tap: already handled
  const target = e.target as Element;
  if (target.closest(OWN_GESTURE) || target.closest(TEXT_AREAS)) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim() && !e.currentTarget.contains(sel.anchorNode)) return;
  if (quickReact(conv, m)) sel?.removeAllRanges();
}
/**
 * Right-click on a bubble: the message menu at the pointer instead of the browser's. The browser menu
 * stays for Shift+right-click and for a text selection inside the bubble (copy part of a message).
 */
function onBubbleContextMenu(conv: Conv, m: Message, e: MouseEvent) {
  if (e.shiftKey) return;
  if (performance.now() - longPressAt < 900) return e.preventDefault(); // touch long-press: menu already open
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim() && e.currentTarget.contains(sel.anchorNode)) return;
  if ((e.target as Element).closest('input, textarea, video, audio')) return;
  e.preventDefault();
  const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
  const link = a && /^https?:/.test(a.href) && !a.closest('.att-img') ? a.href : undefined;
  conv.openMenu(m, { x: e.clientX, y: e.clientY, corner: true }, 'full', undefined, link, attIndex(e.target as Element));
}

/** Index of the attachment under the pointer / finger (data-att on each attachment's root). */
function attIndex(el: Element): number | undefined {
  const v = el.closest<HTMLElement>('[data-att]')?.dataset.att;
  return v === undefined ? undefined : Number(v);
}

/** No word selection from the double-click itself outside the text (time, padding, media frame). */
function onBubbleMouseDown(e: MouseEvent) {
  if (e.detail >= 2 && DOUBLE_TAP_REACTION && !(e.target as Element).closest(`${OWN_GESTURE}, ${TEXT_AREAS}`)) e.preventDefault();
}

/**
 * Long-press opens the action sheet, a right swipe starts a reply, a double-tap reacts (touch only). In an
 * album, `pick` gives the message of the tile under the finger: all three act on that item.
 */
function useTouchActions(conv: Conv, m: Message | undefined, pick?: (el: Element) => Message | undefined) {
  const st = useRef<{ m: Message; x: number; y: number; at: number; timer?: number; dx: number; locked: boolean; fired: boolean; moved: boolean; own: boolean; link?: string; att?: number } | null>(null);
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
  const [dx, setDx] = useState(0);
  // Visual cue of a long-press under way (navigator.vibrate does nothing on iOS): the bubble shrinks a little.
  const [pressing, setPressing] = useState(false);
  const cue = useRef<number>(undefined);
  const stopCue = () => {
    window.clearTimeout(cue.current);
    setPressing(false);
  };
  if (!m) return { dx: 0, pressing: false, handlers: {} };
  const replyOk = canReply(conv.chat) && !m.isDeleted;
  const end = (e?: TouchEvent) => {
    const s = st.current;
    stopCue();
    if (!s) return;
    window.clearTimeout(s.timer);
    // The sheet opened by the long-press now lies under the finger: no synthetic click on its backdrop
    // (it would close it at once), nor on a link or picture under it.
    if (s.fired && e?.cancelable) e.preventDefault();
    if (replyOk && s.dx >= 60 && !s.fired) conv.reply(s.m);
    st.current = null;
    setDx(0);
    const now = performance.now();
    lastTouchAt = now;
    if (s.fired || s.moved || s.locked || s.own || now - s.at > 300) {
      lastTap.current = null;
      return;
    }
    const p = lastTap.current;
    if (p && now - p.at < DOUBLE_TAP_MS && Math.abs(p.x - s.x) < 30 && Math.abs(p.y - s.y) < 30) {
      lastTap.current = null;
      quickReact(conv, s.m);
    } else lastTap.current = { x: s.x, y: s.y, at: now };
  };
  return {
    dx,
    pressing,
    handlers: {
      onTouchStart: (e: TouchEvent) => {
        const t = e.touches[0];
        if (!t || e.touches.length > 1) return;
        const own = !!(e.target as Element).closest(OWN_GESTURE);
        // A long-press on a link offers "Copy link" in the sheet (the bubble blocks the system callout).
        const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
        const link = a && /^https?:/.test(a.href) && !a.closest('.att-img, .att-file') ? a.href : undefined;
        const s = { m: pick?.(e.target as Element) ?? m, x: t.clientX, y: t.clientY, at: performance.now(), dx: 0, locked: false, fired: false, moved: false, own, link, att: attIndex(e.target as Element), timer: 0 };
        window.clearTimeout(cue.current);
        if (!own) cue.current = window.setTimeout(() => setPressing(true), 250);
        s.timer = window.setTimeout(() => {
          setPressing(false);
          s.fired = true;
          longPressAt = performance.now();
          navigator.vibrate?.(10);
          window.getSelection()?.removeAllRanges();
          conv.openMenu(s.m, null, 'full', undefined, s.link, s.att);
        }, 450);
        st.current = s;
      },
      onTouchMove: (e: TouchEvent) => {
        const s = st.current;
        const t = e.touches[0];
        if (!s || !t) return;
        const ddx = t.clientX - s.x;
        const ddy = t.clientY - s.y;
        if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) {
          window.clearTimeout(s.timer);
          if (!s.moved) stopCue();
          s.moved = true;
        }
        if (!s.locked && Math.abs(ddy) > 10 && Math.abs(ddy) > Math.abs(ddx)) {
          st.current = null;
          setDx(0);
          return;
        }
        if (replyOk && ddx > 10) {
          s.locked = true;
          s.dx = ddx;
          setDx(Math.min(ddx, 80));
        }
      },
      onTouchEnd: end,
      onTouchCancel: end,
    },
  };
}

/** The augmentations' lines under a message's text (extension.ts: message.Below), e.g. its translation. */
function Below({ m, own }: { m: Message; own: boolean }) {
  const conv = useConv();
  return conv.augmentations.map((a) => {
    const Slot = a.message?.Below;
    return (
      Slot && (
        <Lazy key={a.id} failed={null}>
          <Slot chatID={conv.chatID} m={m} own={own} />
        </Lazy>
      )
    );
  });
}

/** The augmentations' buttons in the hover row (extension.ts: message.Actions), e.g. a one-tap translation. */
function AugmentActions({ m }: { m: Message }) {
  const conv = useConv();
  return conv.augmentations.map((a) => {
    const Slot = a.message?.Actions;
    return (
      Slot && (
        <Lazy key={a.id} failed={null}>
          <Slot chatID={conv.chatID} m={m} />
        </Lazy>
      )
    );
  });
}

function Actions({ m }: { m: Message }) {
  const conv = useConv();
  const t = useT();
  const at = (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom };
  };
  return (
    <div className="msg-actions">
      <AugmentActions m={m} />
      {canReact(conv.chat) && (
        <button type="button" className="icon-btn small" aria-label={t.msg.react} title={t.msg.react} data-testid="msg-react" onClick={(e) => conv.openMenu(m, at(e), 'react')}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {canReply(conv.chat) && (
        <button type="button" className="icon-btn small" aria-label={t.msg.reply} title={t.msg.reply} data-testid="msg-reply" onClick={() => conv.reply(m)}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M10 8 5 12l5 4M5 12h9a5 5 0 0 1 5 5v1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <button type="button" className="icon-btn small" aria-label={t.msg.more} title={t.msg.more} data-testid="msg-more" onClick={(e) => conv.openMenu(m, at(e), 'full')}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M6 12h.01M12 12h.01M18 12h.01" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/**
 * ✓ sent, grey ✓✓ delivered (where the source says so; WhatsApp 1:1 inferred by the server), ✓✓ read: blue once everyone else read it (in a group, grey while
 * only some have).
 */
function Ticks({ readBy, deliveredTo, isGroup }: { readBy: string; deliveredTo?: string; isGroup: boolean }) {
  const conv = useConv();
  const t = useT();
  const ids = readBy ? readBy.split(',') : [];
  const delivered = !ids.length && !!deliveredTo;
  const others = Math.max(1, (conv.chat?.participants?.total ?? 2) - 1);
  const all = ids.length > 0 && (!isGroup || ids.length >= others);
  const label = ids.length
    ? isGroup
      ? t.msg.readBy(ids.map((id) => conv.names.get(id) ?? knownName(id) ?? t.common.member('')).join(', '))
      : t.msg.read
    : delivered
      ? t.msg.delivered
      : t.msg.sent;
  return (
    <span
      className={`ticks ${all ? 'read' : ''}`}
      role="img"
      aria-label={label}
      title={label}
      data-testid="msg-ticks"
      data-read={ids.length ? (all ? 'all' : 'some') : 'none'}
      data-delivered={delivered ? 'yes' : undefined}
    >
      <svg viewBox="0 0 18 12" width="16" height="11" aria-hidden="true">
        {ids.length || delivered ? (
          <path d="M1 6.5 4.5 10 11 2.5M7.5 9 8.5 10 15 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M3 6.5 6.5 10 13 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}

/**
 * Arrivals and departures as one discreet line ("Joined: Ana, Bao · Left: Kai"), each person once with their last
 * event; several events unfold into one line each, with their time.
 */
function MembersLine({ ms }: { ms: Message[] }) {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const events = ms.flatMap((m) => {
    const e = membershipOf(m);
    return e ? [{ ...e, m }] : [];
  });
  const sum = summarize(events);
  const list = (names: string[]) => {
    const shown = names.length > 4 ? [...names.slice(0, 3), t.members.others(names.length - 3)] : names;
    try {
      return new Intl.ListFormat(lang, { type: 'conjunction' }).format(shown);
    } catch {
      return shown.join(', ');
    }
  };
  const kinds = (['joined', 'left', 'invited', 'removed'] as const).filter((k) => sum.some((e) => e.kind === k));
  const text = kinds.map((k) => t.members[k](list(sum.filter((e) => e.kind === k).map((e) => e.who)), sum.filter((e) => e.kind === k).length)).join(' · ');
  const many = events.length > 1;
  return (
    <div className="notice members-line" data-testid="members-line" data-count={events.length}>
      {many ? (
        <button type="button" className="members-toggle" aria-expanded={open} data-testid="members-toggle" onClick={() => setOpen((v) => !v)}>
          {text} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      ) : (
        text
      )}
      {open && (
        <ul className="members-list" data-testid="members-list">
          {events.map((e) => (
            <li key={e.m.id}>
              <time>{timeOf(e.m.timestamp)}</time> {t.members[e.kind](e.who, 1)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function rowTime(r: Row): string {
  return r.kind === 'msg' ? r.m.timestamp : r.kind === 'out' ? r.o.createdAt : r.ms[r.ms.length - 1]!.timestamp;
}
function rowSender(r: Row): string {
  // After an arrival line, the next bubble shows its sender again.
  if (r.kind === 'members') return '\0members';
  const m = r.kind === 'msg' ? r.m : r.kind === 'album' ? r.ms[0]! : undefined;
  return m ? (m.isSender ? '\0self' : m.senderID) : '\0self';
}

const ratioOf = (a: Attachment) => (a.size?.width && a.size?.height ? a.size.width / a.size.height : undefined);

/**
 * One tile of an album: a photo or a video poster cropped to its cell (thumbnail for the cell's size), with its
 * own reactions in a corner. data-att / data-tile-mid: the item a long-press, a right-click or a swipe acts on.
 */
function AlbumTile({ m, a, index, tile, more, own, reacted, onHot }: { m: Message; a: Attachment; index: number; tile: MosaicTile; more: number; own: boolean; reacted: Message[]; onHot: () => void }) {
  const conv = useConv();
  const t = useT();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [len, setLen] = useState(a.duration);
  const base = attachmentUrl(a);
  const kind = tileKind(a);
  const key = mediaKey(m.id, index);
  const cssW = coverWidth(tile, ratioOf(a));
  const label = kind === 'video' ? t.media.playVideo(durationLabel(len)) : normName(a.fileName) || t.media.photo;
  return (
    <div className="tile" style={{ gridColumn: tile.col, gridRow: tile.row }} data-att={index} data-tile-mid={m.id} data-testid="album-tile" data-kind={kind} onMouseEnter={onHot}>
      {!base || failed ? (
        <MediaError
          label={kind === 'video' ? t.media.videoUnavailable : t.media.unavailable}
          index={index}
          onRetry={() => {
            setFailed(false);
            setRetry((n) => n + 1);
          }}
        />
      ) : (
        <a
          href={retryUrl(base, retry)}
          target="_blank"
          rel="noopener noreferrer"
          className={`att-img ${kind === 'video' ? 'att-vid' : ''}`}
          data-media-key={key}
          aria-haspopup="dialog"
          aria-label={more ? `${label} (${t.media.more(more)})` : label}
          onClick={lightboxClick((el) => conv.openMedia(key, el))}
        >
          {kind === 'video' ? (
            <VideoPoster key={retry} a={a} src={base} cssWidth={cssW} onLength={(s) => setLen((v) => v ?? s)} />
          ) : (
            <FadeImg {...bubbleImage(base, a.size?.width, cssW, retry)} alt={normName(a.fileName)} onError={() => setFailed(true)} />
          )}
          {kind === 'video' && <VideoBadge seconds={len} />}
          {more > 0 && (
            <span className="tile-more" data-testid="album-more">
              +{more}
            </span>
          )}
        </a>
      )}
      {reacted.length > 0 && (
        <div className="tile-reacts">
          {reacted.map((r) => (
            <Reactions key={r.id} m={r} own={own} tile />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Photo album: consecutive photos / videos of one sender (or one message with several) in one bubble, as a
 * mosaic (albums.ts). Each item stays its own message: tap opens it in the viewer, long-press / right-click /
 * swipe / double-tap act on the item pressed, reactions show on its tile, desktop hover buttons follow the
 * last tile hovered. The first item's reply quote goes above, its caption under the mosaic.
 */
function AlbumItem({ ms, isGroup, sameSender, separator, unreadSep, readBy, deliveredTo }: { ms: Message[]; isGroup: boolean; sameSender: boolean; separator: ReactNode; unreadSep: ReactNode; readBy?: string; deliveredTo?: string }) {
  const conv = useConv();
  const t = useT();
  const head = ms[0]!;
  const last = ms[ms.length - 1]!;
  const own = !!head.isSender;
  const pick = (el: Element) => {
    const id = el.closest<HTMLElement>('[data-tile-mid]')?.dataset.tileMid;
    return id ? ms.find((m) => m.id === id) : undefined;
  };
  const touch = useTouchActions(conv, head, pick);
  const [hot, setHot] = useState<string>();
  const tiles = ms.flatMap((m) => (m.attachments ?? []).map((a, i) => ({ m, a, i })));
  const lay = mosaic(tiles.length, tiles.slice(0, 3).map((x) => ratioOf(x.a)));
  const shown = tiles.slice(0, lay.tiles.length);
  // Reactions of the items behind "+N" show on that tile.
  const hiddenReacted = [...new Set(tiles.slice(lay.tiles.length).map((x) => x.m))].filter((m) => m.reactions?.length);
  const cap = head.text ? head : undefined;
  const target = ms.find((m) => m.id === hot) ?? head;
  const tinted = isGroup && !own && !!head.senderID;
  const lit = !!conv.highlight && ms.some((m) => m.id === conv.highlight);
  const edited = cap?.editedTimestamp;
  return (
    <div className="msg-wrap">
      {separator}
      {unreadSep}
      <div
        className={`msg ${own ? 'own' : 'other'} ${tinted ? 'tinted' : ''} ${sameSender ? 'cont' : ''} ${lit ? 'flash' : ''} ${cap && conv.editing === cap.id ? 'editing' : ''}`}
        style={tinted ? ({ '--sh': senderHue(head.senderID, conv.chat?.participants) } as CSSProperties) : undefined}
        data-mid={head.id}
        data-album={tiles.length}
        data-testid="msg"
      >
        {touch.dx > 0 && <span className="swipe-hint" style={{ opacity: touch.dx / 60 }} aria-hidden="true">↩</span>}
        <div className="bubble-row" style={touch.dx ? { transform: `translateX(${touch.dx}px)` } : undefined}>
          <div
            className={`bubble album-bubble ${touch.pressing ? 'pressing' : ''}`}
            data-testid="bubble"
            onDoubleClick={(e) => onBubbleDoubleClick(conv, pick(e.target as Element) ?? head, e)}
            onContextMenu={(e) => onBubbleContextMenu(conv, pick(e.target as Element) ?? head, e)}
            onMouseDown={onBubbleMouseDown}
            {...touch.handlers}
          >
            {isGroup && !own && !sameSender && displaySender(head) && <div className="sender">{displaySender(head)}</div>}
            {head.linkedMessageID && <ReplyQuote chatID={conv.chatID} id={head.linkedMessageID} onClick={() => conv.jumpTo(head.linkedMessageID!)} />}
            <div
              className="album"
              role="group"
              aria-label={t.media.album(tiles.length)}
              data-testid="album"
              data-count={tiles.length}
              style={{ gridTemplateColumns: lay.cols, gridTemplateRows: lay.rows, aspectRatio: String(lay.ratio) }}
            >
              {shown.map((x, k) => (
                <AlbumTile
                  key={mediaKey(x.m.id, x.i)}
                  m={x.m}
                  a={x.a}
                  index={x.i}
                  tile={lay.tiles[k]!}
                  more={k === lay.tiles.length - 1 ? lay.more : 0}
                  own={own}
                  reacted={[...(x.i === 0 && x.m.reactions?.length ? [x.m] : []), ...(k === lay.tiles.length - 1 ? hiddenReacted : [])]}
                  onHot={() => setHot(x.m.id)}
                />
              ))}
            </div>
            {cap && conv.editing === cap.id ? (
              <InlineEditor m={cap} />
            ) : (
              cap && (
                <div className={`text ${isHtmlBody(cap.text) ? 'rich' : ''}`} data-testid="msg-text">
                  <RichText text={cap.text!} mentions={mentionNames(conv, cap)} />
                </div>
              )
            )}
            {cap && conv.editing !== cap.id && <Below m={cap} own={own} />}
            {/* The other pictures' lines (a picture's translation is kept under its own message). */}
            {ms.filter((x) => x !== cap).map((x) => <Below key={x.id} m={x} own={own} />)}
            {cap && conv.editing !== cap.id && <LinkPreviews m={cap} />}
            <div className="meta">
              {edited && <span className="edited" data-testid="msg-edited">{t.msg.edited}</span>}
              <time dateTime={last.timestamp}>{timeOf(last.timestamp)}</time>
              {own && readBy !== undefined && <Ticks readBy={readBy} deliveredTo={deliveredTo} isGroup={isGroup} />}
            </div>
          </div>
          <Actions m={target} />
        </div>
      </div>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({
  row,
  prev,
  isGroup,
  onRetry,
  unread,
  readBy,
  deliveredTo,
}: {
  row: Row;
  prev?: Row;
  isGroup: boolean;
  onRetry: (o: Outgoing) => void;
  /** First unread message: the "N new messages" divider goes above it (N = unread count at opening). */
  unread?: number;
  /** Our message: IDs of the members who read it, comma-joined ('' = nobody yet). */
  readBy?: string;
  /** Our message: IDs of the members it was delivered to (where known: some sources, WhatsApp 1:1), same format. */
  deliveredTo?: string;
}) {
  const conv = useConv();
  const t = useT();
  const touch = useTouchActions(conv, row.kind === 'msg' && row.m.type !== 'NOTICE' ? row.m : undefined);
  const newDay = !prev || dayKey(rowTime(prev)) !== dayKey(rowTime(row));
  const sameSender = !newDay && prev && rowSender(prev) === rowSender(row);
  const separator = newDay ? <div className="day-sep"><span>{dayLabel(rowTime(row))}</span></div> : null;
  const unreadSep = unread ? (
    <div className="unread-sep" data-testid="unread-divider" role="separator">
      <span>{t.conv.unread(unread)}</span>
    </div>
  ) : null;
  if (row.kind === 'members') {
    return (
      <div className="msg-wrap">
        {separator}
        {unreadSep}
        <MembersLine ms={row.ms} />
      </div>
    );
  }
  if (row.kind === 'album') {
    return <AlbumItem ms={row.ms} isGroup={isGroup} sameSender={!!sameSender} separator={separator} unreadSep={unreadSep} readBy={readBy} deliveredTo={deliveredTo} />;
  }

  if (row.kind === 'out') {
    const o = row.o;
    return (
      <div className="msg-wrap">
        {separator}
        <div className={`msg own ${sameSender ? 'cont' : ''}`} data-testid="msg-outgoing" data-status={o.status}>
          <div className={`bubble ${o.status}`}>
            {o.replyTo && <ReplyQuote chatID={o.chatID} id={o.replyTo} />}
            {o.attachment &&
              (o.attachment.voice !== undefined ? (
                <VoicePlayer seconds={o.attachment.voice} />
              ) : o.attachment.previewURL ? (
                <span className="att-img">
                  <img src={o.attachment.previewURL} alt="" />
                </span>
              ) : (
                <span className="att-file">
                  <span className="att-file-main">
                    <FileIcon kind={fileKind(o.attachment.name)} ext={extOf(o.attachment.name)} size={40} />
                    <span className="att-file-body">
                      <FileName name={normName(o.attachment.name) || t.common.file} />
                      <span className="att-file-size">{[fileSize(o.attachment.size), extLabel(o.attachment.name)].filter(Boolean).join(' · ')}</span>
                    </span>
                  </span>
                </span>
              ))}
            {o.text && <div className="text">{linkify(o.text)}</div>}
            <div className="meta">
              {o.status !== 'pending' ? (
                <button type="button" className="retry" data-testid="msg-retry" onClick={() => onRetry(o)}>
                  {o.status === 'failed' ? t.msg.failedRetry : t.msg.unconfirmed}
                </button>
              ) : (
                <span className="status" aria-label={t.msg.sending}>◷</span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const m = row.m;
  const own = !!m.isSender;
  // Groups: each member's bubbles get their own colour.
  const tinted = isGroup && !own && !m.isDeleted && !!m.senderID;
  if (m.type === 'NOTICE' && !m.attachments?.length) {
    return (
      <div className="msg-wrap">
        {separator}
        {unreadSep}
        <div className="notice">{m.text}</div>
      </div>
    );
  }
  const failed = m.sendStatus?.status?.startsWith('FAIL');
  const pending = m.sendStatus?.status === 'PENDING';
  // Scheduled call events (their HTML shape) get a card and no preview of their join link; anything else
  // renders as text.
  const parsed = m.isDeleted || conv.editing === m.id ? null : parseCallEvent(m.text);
  const call = parsed?.rich ? parsed : null;
  // A call, a shared contact… (server/msgkind.ts): a card of its kind, its text only the detail.
  const kind = !m.isDeleted && conv.editing !== m.id && isKindCard(m);
  // A WeChat Channels video (server/wechatshare.ts): a card, its text only the description.
  const channels = m.isDeleted || conv.editing === m.id || call || kind ? null : parseChannelsShare(m);
  return (
    <div className="msg-wrap">
      {separator}
      {unreadSep}
      <div
        className={`msg ${own ? 'own' : 'other'} ${tinted ? 'tinted' : ''} ${sameSender ? 'cont' : ''} ${conv.highlight === m.id ? 'flash' : ''} ${m.reactions?.length ? 'has-reactions' : ''} ${conv.editing === m.id ? 'editing' : ''}`}
        style={tinted ? ({ '--sh': senderHue(m.senderID, conv.chat?.participants) } as CSSProperties) : undefined}
        data-mid={m.id}
        data-testid="msg"
      >
        {touch.dx > 0 && <span className="swipe-hint" style={{ opacity: touch.dx / 60 }} aria-hidden="true">↩</span>}
        <div className="bubble-row" style={touch.dx ? { transform: `translateX(${touch.dx}px)` } : undefined}>
          <div
            className={`bubble ${m.isDeleted ? 'deleted' : ''} ${!m.isDeleted && stickerOnly(m) ? 'sticker-only' : ''} ${failed ? 'failed' : ''} ${touch.pressing ? 'pressing' : ''}`}
            data-testid="bubble"
            onDoubleClick={(e) => onBubbleDoubleClick(conv, m, e)}
            onContextMenu={m.isDeleted || pending ? undefined : (e) => onBubbleContextMenu(conv, m, e)}
            onMouseDown={onBubbleMouseDown}
            {...touch.handlers}
          >
            {isGroup && !own && !sameSender && displaySender(m) && <div className="sender">{displaySender(m)}</div>}
            {m.linkedMessageID && !m.isDeleted && (
              <ReplyQuote chatID={conv.chatID} id={m.linkedMessageID} onClick={() => conv.jumpTo(m.linkedMessageID!)} />
            )}
            {m.isDeleted ? (
              <div className="text deleted-text" data-testid="msg-deleted">{t.msg.deleted}</div>
            ) : (
              <>
                {m.attachments?.map((a, i) => (
                  <AttachmentView
                    key={a.id ?? i}
                    m={m}
                    a={a}
                    index={i}
                    onOpen={mediaKind(a) ? (el) => conv.openMedia(mediaKey(m.id, i), el) : undefined}
                  />
                ))}
                {conv.editing === m.id ? <InlineEditor m={m} /> : call ? <CallCard call={call} /> : kind ? <KindCard m={m} /> : channels ? <ChannelsCard share={channels} /> : m.text && (
                  <div className={`text ${isHtmlBody(m.text) ? 'rich' : ''}`} data-testid="msg-text">
                    <RichText text={m.text} mentions={mentionNames(conv, m)} />
                  </div>
                )}
                {conv.editing !== m.id && <Below m={m} own={own} />}
                {conv.editing !== m.id && !call && !kind && !channels && <LinkPreviews m={m} />}
              </>
            )}
            <div className="meta">
              {m.editedTimestamp && !m.isDeleted && <span className="edited" data-testid="msg-edited">{t.msg.edited}</span>}
              <time dateTime={m.timestamp}>{timeOf(m.timestamp)}</time>
              {own && pending && <span className="status">◷</span>}
              {own && failed && <span className="status fail">!</span>}
              {own && !pending && !failed && !m.isDeleted && readBy !== undefined && <Ticks readBy={readBy} deliveredTo={deliveredTo} isGroup={isGroup} />}
            </div>
          </div>
          {!m.isDeleted && !pending && <Actions m={m} />}
        </div>
        <Reactions m={m} own={own} />
      </div>
    </div>
  );
});
