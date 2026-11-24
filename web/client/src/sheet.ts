import { useEffect, useRef } from 'react';
import { swipeDismiss } from './gestures';
import { reducedMotion } from './nav';

// Areas of a sheet that scroll or select on their own: a drag there is theirs, not the sheet's.
const OWN_SCROLL = '.picker, .select-text, .reactors';

/**
 * Bottom sheet (message and chat menus on touch): drag it down to close, with the lightbox's threshold
 * (far enough or a quick flick); otherwise it springs back. Attach the returned ref to the sheet element.
 */
export function useSheetDrag(enabled: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let g: { y0: number; t0: number; dy: number; on: boolean } | null = null;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const target = e.target as Element;
      // From the grab handle always; elsewhere only when the sheet is scrolled to its top.
      const handle = !!target.closest('.sheet-grab');
      if (!t || e.touches.length > 1 || (!handle && (el.scrollTop > 0 || target.closest(OWN_SCROLL)))) {
        g = null;
        return;
      }
      g = { y0: t.clientY, t0: e.timeStamp, dy: 0, on: false };
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!g || !t) return;
      const dy = t.clientY - g.y0;
      if (!g.on) {
        if (dy <= 4) {
          if (dy < -4) g = null; // scrolling the sheet up: not a dismiss
          return;
        }
        g.on = true;
        el.style.transition = 'none';
      }
      if (e.cancelable) e.preventDefault();
      g.dy = Math.max(0, dy);
      el.style.transform = `translateY(${g.dy}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      const cur = g;
      g = null;
      if (!cur?.on) return;
      if (e.type !== 'touchcancel' && swipeDismiss(cur.dy, e.timeStamp - cur.t0)) {
        if (reducedMotion()) return close.current();
        el.style.transition = 'transform 0.18s ease-in';
        el.style.transform = 'translateY(100%)';
        window.setTimeout(() => close.current(), 170);
        return;
      }
      el.style.transition = reducedMotion() ? '' : 'transform 0.2s ease-out';
      el.style.transform = '';
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
  }, [enabled]);
  return ref;
}
