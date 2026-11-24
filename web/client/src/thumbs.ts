import { connectorThumb } from './connectors.js';

// Bubble-sized thumbnails (server/thumbs.ts: GET /api/thumb/w<width>.webp with the relay's own source
// parameters). Pure functions; a connector's own media URLs are told by connectors.ts (unit-tested in
// test/thumbs-client.test.ts). Bubbles and relayed avatars use them; the viewer, Save / Share and Copy image keep the original (api.ts attachmentUrl).

/** Widths made by the server: 144 for avatars (44 CSS px at DPR 3), the rest for bubbles (≤ 280 CSS px at DPR 1–3). */
export const THUMB_WIDTHS = [144, 320, 640, 960] as const;
const BUBBLE_WIDTHS = [320, 640, 960];
export const AVATAR_WIDTH = 144;
/** The service worker's cache of thumbnails (vite.config.ts), emptied at sign-out (devicestore.ts). */
export { THUMB_CACHE } from './cachenames.js';

/**
 * Source parameters of a relay URL (api.ts mediaUrl, or a connector's own media URL), for /api/thumb: what the
 * connector says (ConnectorUI.thumb, for its /api/media URLs too). Undefined for anything else (pictures that change
 * behind one URL, stickers, previews).
 */
export function thumbQuery(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const q = src.indexOf('?');
  if (q === -1) return undefined;
  return connectorThumb(src.slice(0, q), new URLSearchParams(src.slice(q + 1)));
}

export const thumbUrl = (query: string, width: number, retry = 0) => `/api/thumb/w${width}.webp?${query}${retry ? `&r=${retry}` : ''}`;

/**
 * <img> attributes of a bubble picture shown `cssWidth` CSS px wide: thumbnails narrower than the original, then
 * one more, which the server makes at the original's own width (it never enlarges) and which is described so.
 * Always thumbnails when the source has a route, small originals included: one cacheable WebP per picture
 * (service worker), never the original in a bubble. Without a route: the original.
 */
export function bubbleImage(src: string, srcWidth: number | undefined, cssWidth: number, retry = 0): { src: string; srcSet?: string; sizes?: string } {
  const q = thumbQuery(src);
  // Retry (after a failure): new URLs, the parameter is ignored by the server.
  if (!q) return { src: retry ? `${src}${src.includes('?') ? '&' : '?'}r=${retry}` : src };
  const set: string[] = [];
  const widths: number[] = [];
  for (const w of BUBBLE_WIDTHS) {
    const real = srcWidth && srcWidth < w ? srcWidth : w;
    set.push(`${thumbUrl(q, w, retry)} ${real}w`);
    widths.push(w);
    if (srcWidth && srcWidth <= w) break;
  }
  const fallback = widths.includes(640) ? 640 : widths[widths.length - 1]!;
  return { src: thumbUrl(q, fallback, retry), srcSet: set.join(', '), sizes: `${Math.round(cssWidth)}px` };
}

/** A small picture (avatar, video poster) by thumbnail when it has a route, else the original. */
export function smallImage(src: string | undefined, width: number): string | undefined {
  const q = thumbQuery(src);
  return q ? thumbUrl(q, width) : src;
}
