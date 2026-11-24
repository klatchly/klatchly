import { useSyncExternalStore } from 'react';
import { DRAFTS_KEY } from './devicestore';

// Unsent composer text per chat, kept on this device (localStorage, best effort). The Desktop API has a
// draft field, but beeper-server accepts it without persisting it (a later GET returns null), so syncing
// to the other Beeper apps is not possible.

export interface Draft {
  text: string;
  /** Mentions inserted from the picker: display name -> participant ID. */
  mentions?: { name: string; id: string }[];
  at: number;
}

const KEY = DRAFTS_KEY;
const MAX = 200;
let all: Record<string, Draft> = load();
const listeners = new Set<() => void>();
let timer: number | undefined;

function load(): Record<string, Draft> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Draft>) : {};
  } catch {
    return {};
  }
}

function flush() {
  window.clearTimeout(timer);
  timer = undefined;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage full or unavailable: drafts live for this page only
  }
}

function persist() {
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, 300);
}

// Leaving or hiding the page (reload, app switch on mobile) must not lose the last keystrokes.
window.addEventListener('pagehide', () => timer !== undefined && flush());
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && timer !== undefined && flush());

export const drafts = {
  get: (chatID: string): Draft | undefined => all[chatID],
  set(chatID: string, text: string, mentions?: Draft['mentions']): void {
    const cur = all[chatID];
    if (!text.trim()) {
      if (!cur) return;
      const { [chatID]: _, ...rest } = all;
      all = rest;
    } else {
      if (cur?.text === text && cur.mentions === mentions) return;
      all = { ...all, [chatID]: { text: text.slice(0, 20_000), ...(mentions?.length ? { mentions } : {}), at: Date.now() } };
      const ids = Object.keys(all);
      if (ids.length > MAX) {
        ids.sort((a, b) => all[a]!.at - all[b]!.at);
        all = Object.fromEntries(ids.slice(ids.length - MAX).map((k) => [k, all[k]!]));
      }
    }
    persist();
    listeners.forEach((l) => l());
  },
  /** Sign-out: unsent text stays on no device. */
  clear(): void {
    window.clearTimeout(timer);
    timer = undefined;
    all = {};
    try {
      localStorage.removeItem(KEY);
    } catch {
      // storage unavailable: nothing stored
    }
    listeners.forEach((l) => l());
  },
};

/**
 * Puts text into a chat's unsent draft, after what is already there (its mentions kept), for the composer to show
 * when that chat opens: a link shared from another app (ext/share), never sent by itself. Empty text: nothing.
 * Since API 1.24.
 */
export function prefillDraft(chatID: string, text: string): void {
  const add = text.trim();
  if (!chatID || !add) return;
  const cur = drafts.get(chatID);
  const before = cur?.text.trimEnd() ?? '';
  drafts.set(chatID, before ? `${before}\n${add}` : add, cur?.mentions);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useDrafts(): Record<string, Draft> {
  return useSyncExternalStore(subscribe, () => all);
}
