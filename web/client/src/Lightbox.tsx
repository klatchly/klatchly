// Full-screen viewer of a conversation's pictures and videos: zoom (wheel, double-click/double-tap, pinch), pan,
// previous/next (arrows, keys, swipe), close (✕, Esc, backdrop click, drag down, Back: see Conversation). Opens
// from the tapped thumbnail and flies back to it when it closes (flip.ts), like iOS Photos; a tap (touch) hides
// or shows the toolbar and the caption. Videos play here with the native controls (no zoom on them). Mounted only
// while open.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { clampScale, clampView, downloadName, IDENTITY, MAX_SCALE, swipeStep, toggleZoom, zoomAt, type MediaItem, type View } from './gallery';
import { dismissDecision, fitRect, flipClip, flipFrom, flipTransform, NO_CLIP, onScreen, pull as pullOf, velocity, type Rect } from './flip';
import { dateTimeOf } from './format';
import { linkify } from './richtext';
import { toPlainText } from '../../server/richtext';
import { useT } from './i18n';
import { isIOS } from './push';
import { canCopyImage, copyImage, prefetchFile, saveFile, shareMode, type SaveTarget } from './save';
import { SaveDock } from './SaveDock';
import { smallImage } from './thumbs';

export type LightboxItem = MediaItem & { sender: string };

const GAP = 24;
const PAD = 8;
const SLIDE_MS = 220;
const OPEN_MS = 300;
const CLOSE_MS = 260;
const FADE_MS = 160;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const TAP_MS = 260;
const VIDEO_BAND = 72;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Pt = { x: number; y: number };
interface Gesture {
  mode: 'idle' | 'pan' | 'pinch' | 'swipe';
  x0: number;
  y0: number;
  t0: number;
  v0: View;
  d0: number;
  m0: Pt;
  axis?: 'x' | 'y';
  moved: boolean;
  onMedia: boolean;
  touch: boolean;
  /** Vertical positions over time (drag-to-dismiss release speed). */
  ys: { t: number; v: number }[];
}
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
const retryUrl = (src: string, n: number) => (n ? `${src}${src.includes('?') ? '&' : '?'}r=${n}` : src);
const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
/** The list's thumbnail of an item, inside `scope` (the conversation's messages, or the chat's media page). */
const thumbEl = (key: string, scope = '.messages') => document.querySelector<HTMLElement>(`${scope} [data-media-key="${CSS.escape(key)}"]`);

/**
 * What the list already shows for an item (decoded, in the memory cache): drawn in the viewer while the
 * original loads, and what the open animation starts from. A picture's current source; a video's first frame
 * (VideoPoster in MessageItem) copied into a small JPEG.
 */
function listThumb(el: HTMLElement | null): { src: string; w: number; h: number } | undefined {
  if (!el) return undefined;
  const img = el.querySelector('img');
  if (img?.complete && img.naturalWidth) return { src: img.currentSrc || img.src, w: img.naturalWidth, h: img.naturalHeight };
  const v = el.querySelector('video');
  if (v && v.readyState >= 2 && v.videoWidth) {
    try {
      const c = document.createElement('canvas');
      const k = Math.min(1, 480 / v.videoWidth);
      c.width = Math.round(v.videoWidth * k);
      c.height = Math.round(v.videoHeight * k);
      c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
      return { src: c.toDataURL('image/jpeg', 0.8), w: v.videoWidth, h: v.videoHeight };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface LightboxProps {
  items: LightboxItem[];
  startKey: string;
  from?: HTMLElement | null;
  exiting?: boolean;
  onClose: () => void;
  /** Where the thumbnails are (open and close animations): the conversation's list by default. */
  scope?: string;
  /** "Show in chat" (opened from the chat's media page). */
  onShowInChat?: (item: LightboxItem) => void;
  onForward?: (item: LightboxItem) => void;
  /** The item shown changed (the media page loads older items as the viewer nears the oldest). */
  onIndex?: (index: number, count: number) => void;
}

export function Lightbox({ items, startKey, from, exiting, onClose, scope = '.messages', onShowInChat, onForward, onIndex }: LightboxProps) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const frames = useRef(new Map<string, HTMLDivElement>());
  const [key, setKey] = useState(startKey);
  const idx = items.findIndex((i) => i.key === key);
  const item = items[idx];
  const onIndexRef = useRef(onIndex);
  onIndexRef.current = onIndex;
  useEffect(() => {
    if (idx >= 0) onIndexRef.current?.(idx, items.length);
  }, [idx, items.length]);
  const [view, setView] = useState<View>(IDENTITY);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [anim, setAnim] = useState(false);
  const [drag, setDrag] = useState(0);
  // Drag to dismiss: where the current picture has been pulled to (follows the finger).
  const [pulled, setPulled] = useState<Pt | null>(null);
  const [status, setStatus] = useState<Record<string, 'ok' | 'error'>>({});
  const [retries, setRetries] = useState<Record<string, number>>({});
  const [chrome, setChrome] = useState(true);
  // Size of the stage (the whole screen): the frames are laid out from it, before the first paint.
  const [box, setBox] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [natural, setNatural] = useState<Record<string, { w: number; h: number }>>({});
  // Pictures the list already shows (placeholders), by key; the opened one read from the tapped thumbnail.
  const thumbs = useRef(new Map<string, { src: string; w: number; h: number } | null>());
  if (!thumbs.current.has(startKey)) thumbs.current.set(startKey, listThumb(from ?? thumbEl(startKey, scope)) ?? null);
  const thumbFor = (k: string) => {
    if (!thumbs.current.has(k)) thumbs.current.set(k, listThumb(thumbEl(k, scope)) ?? null);
    return thumbs.current.get(k) ?? undefined;
  };
  const closing = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const curKeyRef = useRef(key);
  curKeyRef.current = key;

  const aspect = (it: LightboxItem) => (it.width && it.height ? { w: it.width, h: it.height } : (natural[it.key] ?? thumbFor(it.key)));
  const fitOf = (it: LightboxItem) => {
    const a = aspect(it);
    if (!a) return undefined;
    // A video keeps clear of the toolbar and of the sender / caption band: its own controls sit at its bottom.
    const band = it.kind === 'video' ? VIDEO_BAND : 0;
    const r = fitRect({ w: box.w, h: box.h - 2 * band }, a, PAD);
    return r.w ? { ...r, y: r.y + band } : undefined;
  };

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !('ResizeObserver' in window)) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e?.contentRect.width ?? 0);
      const h = Math.round(e?.contentRect.height ?? 0);
      if (w && h) setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- Open: from the thumbnail's place to the full view -------------------------------------------------
  useLayoutEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    document.documentElement.classList.add('lb-open');
    const fr = frames.current.get(startKey);
    const bd = backdrop.current;
    const chromeEls = [...(d?.querySelectorAll<HTMLElement>('.lb-bar, .lb-foot, .lb-nav') ?? [])];
    const src = from?.isConnected ? from : thumbEl(startKey, scope);
    const T = src ? rectOf(src) : undefined;
    const view = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const F = fr ? rectOf(fr) : undefined;
    const fly = !reducedMotion() && !!T && !!F && F.w > 0 && onScreen(T, view);
    if (d) d.dataset.anim = fly ? 'open' : 'fade';
    const done = () => {
      if (d) delete d.dataset.anim;
    };
    if (fly && fr && T && F) {
      const f = flipFrom(T, F, parseFloat(getComputedStyle(src!).borderTopLeftRadius) || 0);
      const opts = { duration: OPEN_MS, easing: EASE };
      fr.animate([{ transform: flipTransform(f), clipPath: flipClip(f) }, { transform: 'none', clipPath: NO_CLIP }], opts).finished.then(done, done);
      bd?.animate([{ opacity: 0 }, { opacity: 1 }], opts);
      for (const el of chromeEls) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'ease-out' });
    } else {
      // Not on screen, size unknown, or reduced motion: a short cross-fade (no movement).
      const all = [fr, bd, ...chromeEls].filter((x): x is HTMLElement | HTMLDivElement => !!x);
      let left = all.length;
      if (!left) done();
      for (const el of all)
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' }).finished.then(
          () => --left || done(),
          () => --left || done(),
        );
    }
    return () => document.documentElement.classList.remove('lb-open');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The list's thumbnail of the item on screen is hidden while the viewer shows it (it is "in" the viewer: the
  // backdrop clears during a drag down, and the picture flies back into that hole when closing).
  useLayoutEffect(() => {
    const el = thumbEl(key, scope);
    el?.classList.add('lb-src');
    return () => el?.classList.remove('lb-src');
  }, [key]);

  // --- Close: back to the thumbnail when it is on screen, else a fade ---------------------------------------
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const d = dialog.current;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      // The picture has landed: its thumbnail shows again now, and the page stops being inert (the focus can go
      // back to it before React has unmounted the viewer).
      thumbEl(curKeyRef.current, scope)?.classList.remove('lb-src');
      if (d?.open) d.close();
      onCloseRef.current();
    };
    for (const v of d?.querySelectorAll('video') ?? []) v.pause();
    const fr = frames.current.get(curKeyRef.current);
    const bd = backdrop.current;
    if (!d || !fr) return end();
    d.dataset.closing = '1';
    const chromeEls = [...d.querySelectorAll<HTMLElement>('.lb-bar, .lb-foot, .lb-nav')];
    const now = getComputedStyle(fr).transform;
    const start = now && now !== 'none' ? now : 'none';
    const bdFrom = bd ? getComputedStyle(bd).opacity : '1';
    const th = thumbEl(curKeyRef.current, scope);
    // The frame's own place (its pull transform aside), and the thumbnail's.
    const saved = fr.style.transform;
    fr.style.transform = 'none';
    const F = rectOf(fr);
    fr.style.transform = saved;
    const T = th ? rectOf(th) : undefined;
    const list = d.ownerDocument.querySelector(scope);
    const area = list ? rectOf(list) : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const fly = !reducedMotion() && !!T && F.w > 0 && onScreen(T, area) && viewRef.current.s <= 1.01;
    d.dataset.anim = fly ? 'close' : 'fade-out';
    const opts: KeyframeAnimationOptions = { duration: fly ? CLOSE_MS : FADE_MS, easing: fly ? EASE : 'ease-in', fill: 'forwards' };
    let a: Animation;
    if (fly && T) {
      const f = flipFrom(T, F, parseFloat(getComputedStyle(th!).borderTopLeftRadius) || 0);
      a = fr.animate([{ transform: start, clipPath: NO_CLIP }, { transform: flipTransform(f), clipPath: flipClip(f) }], opts);
    } else {
      const small = reducedMotion() ? start : `${start === 'none' ? '' : start} scale(0.94)`.trim();
      a = fr.animate([{ transform: start, opacity: 1 }, { transform: small, opacity: 0 }], opts);
    }
    bd?.animate([{ opacity: bdFrom }, { opacity: 0 }], opts);
    for (const el of chromeEls) el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], { ...opts, duration: FADE_MS });
    a.finished.then(() => {
      // Where the picture landed (e2e: on the thumbnail).
      if (fly) {
        const r = fr.getBoundingClientRect();
        d.dataset.landed = [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10).join(',');
      }
      end();
    }, end);
    window.setTimeout(end, (fly ? CLOSE_MS : FADE_MS) + 250);
  }, []);

  useEffect(() => {
    if (exiting) close();
  }, [exiting, close]);

  // The picture was deleted (or its message is gone from the loaded pages): nothing left to show.
  const missing = idx < 0;
  useEffect(() => {
    if (missing && !closing.current) {
      closing.current = true;
      onCloseRef.current();
    }
  }, [missing]);

  const isVideo = item?.kind === 'video';
  const sizes = () => {
    const r = stage.current?.getBoundingClientRect();
    const m = media.current;
    return { stage: { w: r?.width ?? 0, h: r?.height ?? 0 }, media: { w: m?.offsetWidth ?? 0, h: m?.offsetHeight ?? 0 } };
  };
  const point = (cx: number, cy: number): Pt => {
    const r = stage.current!.getBoundingClientRect();
    return { x: cx - r.left - r.width / 2, y: cy - r.top - r.height / 2 };
  };
  const zoomTo = (s: number, p: Pt = { x: 0, y: 0 }, animate = true) => {
    if (isVideo) return;
    const v = viewRef.current;
    const ns = clampScale(s);
    const { media: m, stage: st } = sizes();
    setAnim(animate && !reducedMotion());
    setView(ns <= 1.001 ? IDENTITY : clampView(zoomAt(v, ns, p), m, st));
  };

  // Previous / next: the strip slides by one screen, then the new item becomes the centre one.
  const sliding = useRef(0);
  useEffect(() => () => window.clearTimeout(sliding.current), []);
  const go = useCallback(
    (dir: -1 | 1) => {
      const next = items[idx + dir];
      if (!next || sliding.current || closing.current) return;
      const done = () => {
        sliding.current = 0;
        setAnim(false);
        setKey(next.key);
        setDrag(0);
        setView(IDENTITY);
      };
      if (reducedMotion() || !stage.current) return done();
      setAnim(true);
      setDrag(-dir * (stage.current.clientWidth + GAP));
      sliding.current = window.setTimeout(done, SLIDE_MS);
    },
    [items, idx],
  );
  const snapBack = () => {
    setAnim(!reducedMotion());
    setDrag(0);
    setPulled(null);
  };

  // iOS: a download link only opens the file; the share sheet offers "Save Image" (to Photos). The share must
  // start within the tap, so the current item is read into a File beforehand (from the browser's cache:
  // it is on screen already). If it is not ready at the tap, the dock shows the progress and a second button.
  const share = shareMode();
  const curKey = item?.key;
  const target = (it: LightboxItem): SaveTarget => ({ src: it.src, name: downloadName(it), mime: it.mime });
  useEffect(() => {
    const it = items.find((i) => i.key === curKey);
    if (it) prefetchFile(target(it));
  }, [curKey, items]);
  const save = (e: { preventDefault: () => void }) => {
    if (!share || !item) return; // desktop: the plain download link
    e.preventDefault();
    saveFile(target(item), 'lightbox');
  };
  const copyOk = canCopyImage();

  // Only the current GIF plays; a video starts if the browser lets it (else its play button waits); every
  // other one (neighbours, the one swiped away) is paused.
  useEffect(() => {
    for (const v of dialog.current?.querySelectorAll('video') ?? []) {
      if (v === media.current && !closing.current) {
        if (v.loop || v.dataset.autoplay) void v.play().catch(() => {});
      } else if (!v.paused) v.pause();
    }
  }, [key]);

  // A new window size changes the fit size: start again from 1×.
  useEffect(() => {
    const reset = () => setView(IDENTITY);
    window.addEventListener('resize', reset);
    return () => window.removeEventListener('resize', reset);
  }, []);

  // Wheel / trackpad pinch (ctrl+wheel): zoom at the cursor. Native listener: React's is passive.
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const v = viewRef.current;
      const s = clampScale(v.s * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)));
      if (Math.abs(s - v.s) < 0.001) return;
      zoomRef.current(s, point(e.clientX, e.clientY), false);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Pointer gestures (mouse, touch, pen).
  const ptrs = useRef(new Map<number, Pt>());
  const gest = useRef<Gesture | null>(null);
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
  const chromeTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(chromeTimer.current), []);
  const tap = (cx: number, cy: number, onMedia: boolean, touch: boolean) => {
    const now = performance.now();
    const p = lastTap.current;
    if (p && now - p.at < 350 && Math.hypot(cx - p.x, cy - p.y) < 40) {
      lastTap.current = null;
      window.clearTimeout(chromeTimer.current);
      if (isVideo) return;
      const { media: m, stage: st } = sizes();
      setAnim(!reducedMotion());
      setView(toggleZoom(viewRef.current, point(cx, cy), m, st));
      return;
    }
    lastTap.current = { x: cx, y: cy, at: now };
    // Touch: a tap shows or hides the toolbar and caption (after the double-tap window). Mouse: a click on
    // the backdrop closes.
    if (touch) {
      window.clearTimeout(chromeTimer.current);
      chromeTimer.current = window.setTimeout(() => setChrome((c) => !c), TAP_MS);
    } else if (!onMedia) close();
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (closing.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.target as Element;
    if (el.closest('button, a')) return;
    // A video's own controls (its bottom band, or any click with a mouse) keep their gestures.
    if (el instanceof HTMLVideoElement) {
      const r = el.getBoundingClientRect();
      if (e.pointerType === 'mouse' || e.clientY > r.bottom - 64) return;
    }
    const touch = e.pointerType !== 'mouse';
    if (!isVideo) e.currentTarget.setPointerCapture?.(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const v = viewRef.current;
    if (ptrs.current.size === 1) {
      gest.current = {
        mode: v.s > 1.01 ? 'pan' : touch ? 'swipe' : 'idle',
        x0: e.clientX,
        y0: e.clientY,
        t0: performance.now(),
        v0: v,
        d0: 1,
        m0: { x: 0, y: 0 },
        moved: false,
        onMedia: !!media.current && media.current.contains(el),
        touch,
        ys: [{ t: performance.now(), v: e.clientY }],
      };
      setAnim(false);
    } else if (ptrs.current.size === 2 && gest.current && !sliding.current && !isVideo) {
      const [a, b] = [...ptrs.current.values()] as [Pt, Pt];
      gest.current = { ...gest.current, mode: 'pinch', d0: dist(a, b), m0: point((a.x + b.x) / 2, (a.y + b.y) / 2), v0: v, moved: true };
      setDrag(0);
      setPulled(null);
      setAnim(false);
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gest.current;
    if (!g || sliding.current || closing.current) return;
    if (g.mode === 'pinch') {
      if (ptrs.current.size < 2) return;
      const [a, b] = [...ptrs.current.values()] as [Pt, Pt];
      const m = point((a.x + b.x) / 2, (a.y + b.y) / 2);
      const s = clampScale((g.v0.s * dist(a, b)) / g.d0, 0.8, MAX_SCALE);
      const z = zoomAt(g.v0, s, g.m0);
      setView({ s, x: z.x + m.x - g.m0.x, y: z.y + m.y - g.m0.y });
      return;
    }
    if (ptrs.current.size > 1) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
    if (!g.moved) return;
    if (g.mode === 'pan') {
      const { media: m, stage: st } = sizes();
      setView(clampView({ s: g.v0.s, x: g.v0.x + dx, y: g.v0.y + dy }, m, st));
    } else if (g.mode === 'swipe') {
      g.axis ??= Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (g.axis === 'x') {
        const edge = (dx > 0 && idx <= 0) || (dx < 0 && idx >= items.length - 1);
        setDrag(edge ? dx / 3 : dx);
      } else {
        g.ys.push({ t: performance.now(), v: e.clientY });
        if (g.ys.length > 12) g.ys.shift();
        setPulled({ x: dx, y: dy });
      }
    }
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!ptrs.current.delete(e.pointerId)) return;
    const g = gest.current;
    if (!g) return;
    const cancelled = e.type === 'pointercancel';
    if (g.mode === 'pinch') {
      const rest = [...ptrs.current.values()];
      if (rest.length === 1) {
        gest.current = { ...g, mode: 'pan', x0: rest[0]!.x, y0: rest[0]!.y, v0: viewRef.current };
      } else if (!rest.length) {
        gest.current = null;
        const v = viewRef.current;
        const { media: m, stage: st } = sizes();
        setAnim(!reducedMotion());
        setView(v.s < 1.01 ? IDENTITY : clampView(v, m, st));
      }
      return;
    }
    if (ptrs.current.size) return;
    gest.current = null;
    if (closing.current) return;
    if (g.mode === 'pan' && g.moved) {
      // End of a pan (or of a pinch whose fingers left one by one): back inside the limits, 1× minimum.
      const v = viewRef.current;
      const { media: m, stage: st } = sizes();
      setAnim(!reducedMotion());
      setView(v.s < 1.01 ? IDENTITY : clampView(v, m, st));
      return;
    }
    if (sliding.current) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    const ms = performance.now() - g.t0;
    if (g.mode === 'swipe' && g.moved) {
      if (cancelled) return snapBack();
      if (g.axis === 'x') {
        const step = swipeStep(dx, ms, stage.current?.clientWidth ?? 0, idx > 0, idx < items.length - 1);
        if (step) go(step);
        else snapBack();
      } else if (dismissDecision(dy, velocity(g.ys), box.h)) close();
      else snapBack();
      return;
    }
    if (!g.moved && !cancelled && ms < 400) tap(e.clientX, e.clientY, g.onMedia, g.touch);
  };

  // Keys are read on the window: a focused button that disappears (last "next") leaves the focus on <body>.
  const onKeyDown = (e: globalThis.KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // On a focused video, the arrows seek (native).
      if (document.activeElement instanceof HTMLVideoElement) return;
      e.preventDefault();
      go(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === '+' || e.key === '=') zoomTo(viewRef.current.s * 1.5);
    else if (e.key === '-') zoomTo(viewRef.current.s / 1.5);
    else if (e.key === '0') zoomTo(1);
    else if (e.key === 'Tab') {
      // Focus stays in the viewer (the page behind is inert anyway; this also skips the browser chrome).
      const list = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], video[controls]') ?? [])].filter((el) => el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.current?.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const keyRef = useRef(onKeyDown);
  keyRef.current = onKeyDown;
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  if (!item) return null;
  const zoomed = view.s > 1.01;
  const caption = item.caption ? toPlainText(item.caption).trim() : '';
  const pl = pulled ? pullOf(pulled.x, pulled.y, box.h) : null;
  const slides = [-1, 0, 1].map((off) => ({ off, it: items[idx + off] })).filter((s): s is { off: number; it: LightboxItem } => !!s.it);
  const state = status[item.key];

  return (
    <dialog
      ref={dialog}
      className={`lightbox ${anim ? 'lb-anim' : ''} ${zoomed ? 'zoomed' : ''} ${chrome && !pulled ? '' : 'chrome-off'} ${pulled ? 'pulling' : ''}`}
      aria-label={t.lightbox.label}
      aria-modal="true"
      data-testid="lightbox"
      data-index={idx}
      data-kind={item.kind}
      data-scale={view.s.toFixed(2)}
      data-chrome={chrome ? 'on' : 'off'}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div ref={backdrop} className="lb-backdrop" data-testid="lb-backdrop" style={pl && pl.fade < 1 ? { opacity: pl.fade } : undefined} />
      <div
        ref={stage}
        className="lb-stage"
        data-testid="lb-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDragStart={(e) => e.preventDefault()}
      >
        <div className="lb-track" style={drag ? { transform: `translate3d(${drag}px, 0, 0)` } : undefined}>
          {slides.map(({ off, it }) => {
            const cur = off === 0;
            const style = cur && (view.s !== 1 || view.x || view.y) ? { transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` } : undefined;
            const ref = cur ? (el: HTMLImageElement | HTMLVideoElement | null) => void (media.current = el) : undefined;
            const ok = () => setStatus((s) => (s[it.key] === 'ok' ? s : { ...s, [it.key]: 'ok' }));
            const err = () => setStatus((s) => ({ ...s, [it.key]: 'error' }));
            const known = (w: number, h: number) => {
              if (w && h && !(it.width && it.height)) setNatural((n) => (n[it.key] ? n : { ...n, [it.key]: { w, h } }));
            };
            const alt = it.fileName || `${it.sender}, ${dateTimeOf(it.timestamp)}`;
            const src = retryUrl(it.src, retries[it.key] ?? 0);
            const fit = fitOf(it);
            // Placeholder while the original loads: the list's thumbnail (or the video's poster / first frame).
            const ph = it.kind === 'video' ? (it.poster ? { src: smallImage(it.poster, 640) } : thumbFor(it.key)) : status[it.key] !== 'ok' ? thumbFor(it.key) : undefined;
            const frameStyle = {
              ...(fit ? { left: fit.x, top: fit.y, width: fit.w, height: fit.h } : {}),
              ...(cur && pl ? { transform: `translate3d(${pl.x}px, ${pl.y}px, 0) scale(${pl.s})` } : {}),
            };
            return (
              <div key={it.key} className="lb-slide" style={off ? { transform: `translateX(calc(${off} * (100% + ${GAP}px)))` } : undefined} aria-hidden={cur ? undefined : true}>
                <div
                  ref={(el) => {
                    if (el) frames.current.set(it.key, el);
                    else frames.current.delete(it.key);
                  }}
                  className={`lb-frame ${fit ? 'fit' : 'auto'} ${cur ? 'cur' : ''}`}
                  style={frameStyle}
                  data-testid={cur ? 'lb-frame' : undefined}
                >
                  {ph?.src && it.kind !== 'video' && status[it.key] !== 'error' && <img className="lb-ph" src={ph.src} alt="" decoding="sync" draggable={false} aria-hidden="true" />}
                  {status[it.key] === 'error' ? null : it.kind === 'img' ? (
                    <img
                      ref={ref}
                      className={`lb-media ${cur ? 'cur' : ''}`}
                      src={src}
                      alt={alt}
                      width={it.width}
                      height={it.height}
                      decoding="async"
                      draggable={false}
                      data-testid={cur ? 'lb-media' : undefined}
                      onLoad={(e) => {
                        known(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
                        ok();
                      }}
                      onError={err}
                      style={style}
                    />
                  ) : (
                    <video
                      ref={ref}
                      className={`lb-media ${it.kind === 'video' ? 'lb-video' : ''} ${cur ? 'cur' : ''}`}
                      // No poster from the network: the first frame stands for it (#t: iOS draws it).
                      src={it.kind === 'video' && !it.poster ? `${src}#t=0.1` : src}
                      poster={ph?.src}
                      width={it.width}
                      height={it.height}
                      {...(it.kind === 'gif' ? { loop: true, muted: true, autoPlay: cur } : { controls: true, 'data-autoplay': '1' })}
                      playsInline
                      preload={cur ? (it.kind === 'gif' ? 'auto' : 'metadata') : 'metadata'}
                      aria-label={alt}
                      data-testid={cur ? 'lb-media' : undefined}
                      onLoadedMetadata={(e) => {
                        known(e.currentTarget.videoWidth, e.currentTarget.videoHeight);
                        if (it.kind === 'video') ok();
                      }}
                      onLoadedData={ok}
                      onError={err}
                      style={style}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!state && item.kind !== 'video' && <div className="lb-spinner" role="status" aria-label={t.lightbox.loading} data-testid="lb-loading" />}
        {state === 'error' && (
          <div className="lb-error" role="alert" data-testid="lb-error">
            <span>{item.kind === 'video' ? t.media.videoError : t.lightbox.error}</span>
            <button
              type="button"
              className="lb-retry"
              data-testid="lb-retry"
              onClick={() => {
                setRetries((r) => ({ ...r, [item.key]: (r[item.key] ?? 0) + 1 }));
                setStatus((s) => {
                  const { [item.key]: _, ...rest } = s;
                  return rest;
                });
              }}
            >
              {t.common.retry}
            </button>
          </div>
        )}
        {idx > 0 && (
          <button type="button" className="lb-nav prev" aria-label={t.lightbox.previous} title={t.lightbox.previous} data-testid="lb-prev" onClick={() => go(-1)}>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {idx < items.length - 1 && (
          <button type="button" className="lb-nav next" aria-label={t.lightbox.next} title={t.lightbox.next} data-testid="lb-next" onClick={() => go(1)}>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
              <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      <div className="lb-bar">
        <div className="lb-info" aria-live="polite">
          <span className="lb-count" data-testid="lb-counter">{t.lightbox.counter(idx + 1, items.length)}</span>
        </div>
        {!isVideo && (
          <button
            type="button"
            className="lb-btn"
            aria-label={zoomed ? t.lightbox.zoomOut : t.lightbox.zoomIn}
            title={zoomed ? t.lightbox.zoomOut : t.lightbox.zoomIn}
            data-testid="lb-zoom"
            onClick={() => zoomTo(zoomed ? 1 : 2.5)}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d={zoomed ? 'M8 11h6M16 16l4.5 4.5' : 'M8 11h6M11 8v6M16 16l4.5 4.5'} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {copyOk && item.kind === 'img' && (
          <button type="button" className="lb-btn" aria-label={t.media.copyImage} title={t.media.copyImage} data-testid="lb-copy" onClick={() => copyImage(target(item), 'lightbox')}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <a
          className="lb-btn"
          href={item.src}
          download={downloadName(item)}
          aria-label={share ? t.media.saveShare : t.lightbox.download}
          title={share ? t.media.saveShare : t.lightbox.download}
          data-testid="lb-download"
          onClick={save}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            {share ? (
              <path d="M12 15V4M8 8l4-4 4 4M6 12v7h12v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M12 4v11M7 10l5 5 5-5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </a>
        {/* iOS Home Screen app: a new tab would leave the app with no way back. */}
        {!isIOS() && (
          <a className="lb-btn" href={item.src} target="_blank" rel="noopener noreferrer" aria-label={t.lightbox.openOriginal} title={t.lightbox.openOriginal} data-testid="lb-original">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        )}
        {onForward && (
          <button type="button" className="lb-btn" aria-label={t.lightbox.forward} title={t.lightbox.forward} data-testid="lb-forward" onClick={() => onForward(item)}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M14 5l7 7-7 7M21 12H9a6 6 0 0 0-6 6v1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {onShowInChat && (
          <button type="button" className="lb-btn" aria-label={t.lightbox.showInChat} title={t.lightbox.showInChat} data-testid="lb-show-in-chat" onClick={() => onShowInChat(item)}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5zM8 10h8M8 13h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <button type="button" className="lb-btn" aria-label={t.lightbox.close} title={t.lightbox.close} data-testid="lb-close" autoFocus onClick={close}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className={`lb-foot ${isVideo ? 'video' : ''}`} data-testid="lb-foot">
        <div className="lb-who">
          <span className="lb-sender" data-testid="lb-sender">{item.sender}</span>
          <time dateTime={item.timestamp}>{dateTimeOf(item.timestamp)}</time>
        </div>
        {caption && (
          <div className="lb-caption" data-testid="lb-caption">
            {linkify(caption)}
          </div>
        )}
      </div>
      <SaveDock scope="lightbox" />
    </dialog>
  );
}
