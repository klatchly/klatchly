import { useEffect, type RefObject } from 'react';

/** Closes on Escape or a click outside `ref` (and outside `keep`, the button that toggles it). */
export function useDismiss(ref: RefObject<HTMLElement | null>, keep: string, onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(keep) && onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [ref, keep, onClose]);
}
