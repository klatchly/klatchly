import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

// Connection banner under the conversation header: the realtime socket has not been open for a while, or
// the device is offline. A short reconnect (under 2 s) shows nothing.

export type ConnBanner = 'offline' | 'reconnecting' | null;
const DELAY_MS = 2000;

let banner: ConnBanner = null;
let wsOpen = true;
let timer: number | undefined;
const listeners = new Set<() => void>();

function set(next: ConnBanner) {
  if (next === banner) return;
  banner = next;
  listeners.forEach((l) => l());
}

function update() {
  window.clearTimeout(timer);
  if (!navigator.onLine) return set('offline');
  if (wsOpen) return set(null);
  if (banner === 'offline') set('reconnecting');
  else timer = window.setTimeout(() => set('reconnecting'), DELAY_MS);
}

let watching = false;
/** Fed by the realtime socket's status (Shell). */
export function setSocketOpen(open: boolean): void {
  if (!watching) {
    watching = true;
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
  }
  wsOpen = open;
  update();
}

export function useConnBanner(): ConnBanner {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => banner,
  );
}

/** A toast that stays `ms`, each new one restarting the timer (no early hide from an older one). */
export function useToast(ms = 3000): [string | undefined, (text: string) => void] {
  const [toast, setToast] = useState<string>();
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = useCallback(
    (text: string) => {
      window.clearTimeout(timer.current);
      setToast(text);
      timer.current = window.setTimeout(() => setToast(undefined), ms);
    },
    [ms],
  );
  return [toast, flash];
}
