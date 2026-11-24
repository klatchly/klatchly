import { useSyncExternalStore } from 'react';
import type { Chat, Message } from './types';
import { isRawUserID } from '../../server/names';
import { NAMES_KEY } from './devicestore';

// Some sources (Beeper) resolve member names in message lists only: chat previews and single-message lookups of
// big bridged groups carry the raw user ID instead (the canonical model's "unknown name", server/names.ts). Names
// seen in lists are remembered here (per device).

const KEY = NAMES_KEY;
const MAX = 3000;
let names = new Map<string, string>();
try {
  names = new Map(JSON.parse(localStorage.getItem(KEY) ?? '[]') as [string, string][]);
} catch {
  // no storage: memory only
}
const listeners = new Set<() => void>();
let version = 0;
let saveTimer = 0;

function save(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify([...names].slice(-MAX)));
    } catch {
      // quota or private mode
    }
  }, 1000);
}

export function learnNames(msgs: readonly Message[] | undefined): void {
  let changed = false;
  for (const m of msgs ?? []) {
    const n = m.senderName?.trim();
    if (!m.senderID || !n || isRawUserID(n) || names.get(m.senderID) === n) continue;
    names.delete(m.senderID);
    names.set(m.senderID, n);
    changed = true;
  }
  if (!changed) return;
  while (names.size > MAX) names.delete(names.keys().next().value!);
  version++;
  listeners.forEach((l) => l());
  save();
}

/** Sign-out: forget the names learned on this device. */
export function forgetNames(): void {
  window.clearTimeout(saveTimer);
  names = new Map();
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: nothing stored
  }
  version++;
  listeners.forEach((l) => l());
}

export const knownName = (id: string | undefined) => (id ? names.get(id) : undefined);

/** Re-render when new names are learned. */
export function useKnownNames(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

// Chat previews whose sender is unknown: load the chat's latest messages once (read-only, nothing is
// marked as read) to learn the name. Two at a time, once per chat per page load.
const tried = new Set<string>();
const queue: string[] = [];
let running = 0;
let fetchPage: ((chatID: string) => Promise<{ items: Message[] }>) | undefined;

export function setNameFetcher(f: (chatID: string) => Promise<{ items: Message[] }>): void {
  fetchPage = f;
}

function pump(): void {
  while (running < 2 && queue.length && fetchPage) {
    const id = queue.shift()!;
    running++;
    fetchPage(id)
      .then((p) => learnNames(p.items))
      .catch(() => {})
      .finally(() => {
        running--;
        pump();
      });
  }
}

export function resolvePreviewSender(chat: Chat): void {
  const p = chat.preview;
  if (chat.type !== 'group' || !p || p.isSender || !p.senderID || knownName(p.senderID)) return;
  if ((p.senderName && !isRawUserID(p.senderName)) || tried.has(chat.id)) return;
  tried.add(chat.id);
  queue.push(chat.id);
  pump();
}
