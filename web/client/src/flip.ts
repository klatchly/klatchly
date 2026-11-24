// Open / close animation of the viewer (thumbnail ↔ full view, "FLIP") and the drag-to-dismiss math. Pure
// functions (unit-tested in test/flip.test.ts), no imports. Everything animates with transform and opacity, plus a
// clip-path inset where the thumbnail was cropped (album tiles, square boxes): no layout during the animation.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a w × h media is drawn in a box: centred, fitted inside the padding, never enlarged. */
export function fitRect(box: { w: number; h: number }, media: { w: number; h: number }, pad = 8): Rect {
  const bw = Math.max(0, box.w - 2 * pad);
  const bh = Math.max(0, box.h - 2 * pad);
  if (!(media.w > 0 && media.h > 0) || !bw || !bh) return { x: box.w / 2, y: box.h / 2, w: 0, h: 0 };
  const k = Math.min(1, bw / media.w, bh / media.h);
  const w = media.w * k;
  const h = media.h * k;
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
}

export interface Flip {
  /** translate (px, from the full view's own place) and uniform scale, around its centre */
  x: number;
  y: number;
  s: number;
  /** clip in the full view's own (unscaled) px: what is left visible is the thumbnail's crop */
  clip: { t: number; r: number; b: number; l: number };
  /** corner radius in the full view's own px (the thumbnail's radius once scaled) */
  radius: number;
}

/**
 * Transform that puts the full view (`full`, its layout rect on screen) exactly over the thumbnail (`thumb`):
 * scaled uniformly to cover it (the thumbnail shows the picture with object-fit: cover), centred on it, and
 * clipped to it. Animating from this to the identity (open), or back (close), morphs one into the other.
 */
export function flipFrom(thumb: Rect, full: Rect, thumbRadius = 0): Flip {
  if (!(full.w > 0 && full.h > 0 && thumb.w > 0 && thumb.h > 0)) return { x: 0, y: 0, s: 1, clip: { t: 0, r: 0, b: 0, l: 0 }, radius: 0 };
  const s = Math.max(thumb.w / full.w, thumb.h / full.h);
  const x = thumb.x + thumb.w / 2 - (full.x + full.w / 2);
  const y = thumb.y + thumb.h / 2 - (full.y + full.h / 2);
  // (rounding noise of an uncropped thumbnail: no clip at all)
  const ix = Math.max(0, (full.w - thumb.w / s) / 2);
  const iy = Math.max(0, (full.h - thumb.h / s) / 2);
  const clip = { t: iy < 1e-6 ? 0 : iy, r: ix < 1e-6 ? 0 : ix, b: iy < 1e-6 ? 0 : iy, l: ix < 1e-6 ? 0 : ix };
  return { x, y, s, clip, radius: thumbRadius / s };
}

const n = (v: number) => Math.round(v * 1000) / 1000;
export const flipTransform = (f: Pick<Flip, 'x' | 'y' | 's'>) => `translate(${n(f.x)}px, ${n(f.y)}px) scale(${n(f.s)})`;
export const flipClip = (f: Pick<Flip, 'clip' | 'radius'>) => `inset(${n(f.clip.t)}px ${n(f.clip.r)}px ${n(f.clip.b)}px ${n(f.clip.l)}px round ${n(f.radius)}px)`;
export const NO_CLIP = 'inset(0px 0px 0px 0px round 0px)';

/** The thumbnail is visible enough in the list to fly back to (else the viewer fades out). */
export function onScreen(r: Rect, view: Rect, min = 0.3): boolean {
  if (!(r.w > 0 && r.h > 0)) return false;
  const w = Math.min(r.x + r.w, view.x + view.w) - Math.max(r.x, view.x);
  const h = Math.min(r.y + r.h, view.y + view.h) - Math.max(r.y, view.y);
  return w > 0 && h > 0 && (w * h) / (r.w * r.h) >= min;
}

// --- Drag to dismiss -----------------------------------------------------------------------------------------

/**
 * The picture follows the finger (pulling up is resisted) and shrinks as it goes down, to 65 % at a full
 * screen height; the backdrop clears in proportion (gone at 45 % of the height).
 */
export function pull(dx: number, dy: number, h: number): { x: number; y: number; s: number; fade: number } {
  const y = dy >= 0 ? dy : dy / 3;
  const down = h > 0 ? Math.min(1, Math.max(0, dy) / h) : 0;
  const fade = h > 0 ? Math.max(0, 1 - Math.abs(y) / (h * 0.45)) : 1;
  return { x: dx, y, s: 1 - 0.35 * down, fade };
}

/** Release of a dismiss drag (dy px down, vy px/ms at release, h the screen height): close, or snap back. */
export function dismissDecision(dy: number, vy: number, h: number): boolean {
  if (vy < -0.15) return false; // flicked back up
  return dy > Math.min(110, h * 0.15) || (vy > 0.35 && dy > 30);
}

/** Speed (px/ms) over the samples of the last `windowMs` (time, position), 0 when too few. */
export function velocity(samples: readonly { t: number; v: number }[], windowMs = 100): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i]!;
    if (last.t - s.t > windowMs) break;
    first = s;
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.v - first.v) / dt : 0;
}
