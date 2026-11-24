// Pictures and videos of a conversation for the lightbox, and the zoom/pan math of its viewer. Pure functions
// (unit-tested in test/lightbox.test.ts): structural copies of the types.ts shapes, no imports. galleryOf takes any
// list of messages (the loaded pages today, a whole chat's media list later).

export interface GalleryAttachment {
  type: string;
  srcURL?: string;
  mimeType?: string;
  fileName?: string;
  isGif?: boolean;
  isSticker?: boolean;
  size?: { width?: number; height?: number };
  posterImg?: string;
  duration?: number;
}
export interface GalleryMessage {
  id: string;
  timestamp: string;
  text?: string;
  isDeleted?: boolean;
  attachments?: GalleryAttachment[];
}

export type MediaItemKind = 'img' | 'gif' | 'video';

/**
 * What opens in the lightbox: photos and GIF images ('img'), GIFs sent as looping silent videos ('gif'), real
 * videos ('video', played there with the native controls; the bubble only shows a poster). Stickers stay
 * inline (small, transparent, meant to be seen in the bubble), animated Lottie stickers are not images.
 */
export function mediaKind(a: GalleryAttachment): MediaItemKind | undefined {
  if (a.isSticker) return undefined;
  const mime = (a.mimeType ?? '').toLowerCase();
  if (a.type === 'img' && !mime.includes('lottie')) return 'img';
  if (a.type === 'video') return a.isGif ? 'gif' : 'video';
  return undefined;
}

export const mediaKey = (messageID: string, index: number) => `${messageID}:${index}`;

export interface MediaItem {
  key: string;
  messageID: string;
  kind: MediaItemKind;
  src: string;
  mime?: string;
  width?: number;
  height?: number;
  fileName?: string;
  timestamp: string;
  caption?: string;
  /** Videos: the network's poster picture (relay URL), when it sends one; length in seconds. */
  poster?: string;
  duration?: number;
}

/** Every openable picture and video of the messages, oldest first (same order as the list). */
export function galleryOf(
  messages: readonly GalleryMessage[],
  src: (a: GalleryAttachment) => string | undefined,
  poster?: (a: GalleryAttachment) => string | undefined,
): MediaItem[] {
  const out: MediaItem[] = [];
  for (const m of messages) {
    if (m.isDeleted || !m.attachments) continue;
    m.attachments.forEach((a, i) => {
      const kind = mediaKind(a);
      const url = kind && src(a);
      if (!kind || !url) return;
      out.push({
        key: mediaKey(m.id, i),
        messageID: m.id,
        kind,
        src: url,
        mime: a.mimeType,
        width: a.size?.width,
        height: a.size?.height,
        fileName: a.fileName,
        timestamp: m.timestamp,
        caption: m.text || undefined,
        ...(kind === 'video' ? { poster: poster?.(a), duration: a.duration } : {}),
      });
    });
  }
  return out;
}

/** File name for "download": the attachment's own, else one built from its type. */
export function downloadName(item: Pick<MediaItem, 'fileName' | 'mime' | 'kind'>): string {
  const name = item.fileName?.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (name) return name;
  const sub = item.mime?.split(';')[0]?.split('/')[1]?.trim().toLowerCase();
  const ext = sub && /^[a-z0-9.+-]{1,10}$/.test(sub) ? (sub === 'jpeg' ? 'jpg' : sub === 'quicktime' ? 'mov' : sub.replace(/\+.*/, '')) : item.kind === 'img' ? 'jpg' : 'mp4';
  return `${item.kind === 'video' ? 'video' : 'image'}.${ext}`;
}

// --- Zoom and pan -------------------------------------------------------------------------------------------
// The media is centred in the stage, laid out at its "fit" size (w × h), then transformed by
// translate(x, y) scale(s) around its centre. Points are relative to the stage centre.

export interface View {
  s: number;
  x: number;
  y: number;
}
export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
export const TOGGLE_SCALE = 2.5;
export const IDENTITY: View = { s: 1, x: 0, y: 0 };

/** Pan limits: the zoomed media may not leave a gap on a side it overflows; a side that fits stays centred. */
export function clampView(v: View, media: { w: number; h: number }, stage: { w: number; h: number }): View {
  const mx = Math.max(0, (media.w * v.s - stage.w) / 2);
  const my = Math.max(0, (media.h * v.s - stage.h) / 2);
  return { s: v.s, x: Math.min(mx, Math.max(-mx, v.x)) + 0, y: Math.min(my, Math.max(-my, v.y)) + 0 };
}

/** New view at scale `s`, keeping the content under point p where it is on screen. */
export function zoomAt(v: View, s: number, p: { x: number; y: number }): View {
  const k = s / v.s;
  return { s, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k };
}

export const clampScale = (s: number, min = MIN_SCALE, max = MAX_SCALE) => Math.min(max, Math.max(min, s));

/** Double-click / double-tap: 1× ↔ 2.5× at that point. */
export function toggleZoom(v: View, p: { x: number; y: number }, media: { w: number; h: number }, stage: { w: number; h: number }): View {
  if (v.s > 1.01) return IDENTITY;
  return clampView(zoomAt(v, TOGGLE_SCALE, p), media, stage);
}

/** End of a horizontal swipe: -1 previous, 1 next, 0 snap back. */
export function swipeStep(dx: number, ms: number, width: number, hasPrev: boolean, hasNext: boolean): -1 | 0 | 1 {
  const fast = ms < 300 && Math.abs(dx) > 30;
  if (!(Math.abs(dx) > Math.min(80, width * 0.2) || fast)) return 0;
  if (dx < 0) return hasNext ? 1 : 0;
  return hasPrev ? -1 : 0;
}
