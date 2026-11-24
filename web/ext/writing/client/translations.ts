import { useSyncExternalStore } from 'react';
import { HttpError } from '../../../client/src/sdk';
import type { Lang } from '../langs';
import { writingApi as api } from './api';

export type Target = Lang;
export interface Translation {
  target: Target;
  status: 'loading' | 'done' | 'error';
  text?: string;
  error?: 'failed' | 'tooLong' | 'noText' | 'tooLarge' | 'noImage';
  /** A picture's text (its attachment index): asked again the same way. */
  image?: number;
}

// Translations shown under messages. The server keeps them (data/translations.json): a conversation loads
// its own on opening, so they come back after a reload and on other devices.
let shown = new Map<string, Translation>();
const listeners = new Set<() => void>();
const k = (chatID: string, id: string) => `${chatID}\n${id}`;

function put(key: string, t: Translation | undefined) {
  shown = new Map(shown);
  if (t) shown.set(key, t);
  else shown.delete(key);
  listeners.forEach((l) => l());
}

export function translateMessage(chatID: string, id: string, target: Target): void {
  const key = k(chatID, id);
  const cur = shown.get(key);
  if (cur?.target === target && cur.image === undefined && cur.status !== 'error') return;
  put(key, { target, status: 'loading' });
  // Still the one on screen (not replaced by a picture's translation asked meanwhile).
  const same = () => shown.get(key)?.target === target && shown.get(key)?.image === undefined;
  api.translate(chatID, id, target).then(
    (r) => same() && put(key, { target, status: 'done', text: r.text }),
    (e) => same() && put(key, { target, status: 'error', error: e instanceof HttpError && e.status === 413 ? 'tooLong' : 'failed' }),
  );
}

/** The text of a picture of the message (its attachment `index`), translated by a model that reads images. */
export function translateImage(chatID: string, id: string, index: number, target: Target): void {
  const key = k(chatID, id);
  const cur = shown.get(key);
  if (cur?.target === target && cur.image === index && cur.status !== 'error') return;
  put(key, { target, status: 'loading', image: index });
  const same = () => shown.get(key)?.target === target && shown.get(key)?.image === index;
  api.translateImage(chatID, id, index, target).then(
    (r) => same() && put(key, { target, status: 'done', text: r.text, image: index }),
    (e) => {
      const code = e instanceof HttpError ? e.code : undefined;
      const error = code === 'no_text' ? 'noText' : code === 'too_large' ? 'tooLarge' : code === 'no_image' ? 'noImage' : 'failed';
      if (same()) put(key, { target, status: 'error', image: index, error });
    },
  );
}

export function hideTranslation(chatID: string, id: string): void {
  put(k(chatID, id), undefined);
  api.hideTranslation(chatID, id).catch(() => {});
}

/** Translations the server kept for this chat (those not already on screen). */
export function loadTranslations(chatID: string): void {
  api.translations(chatID).then(
    ({ items }) => {
      const missing = Object.entries(items).filter(([id]) => !shown.has(k(chatID, id)));
      if (!missing.length) return;
      shown = new Map(shown);
      for (const [id, t] of missing) shown.set(k(chatID, id), { target: t.target, status: 'done', text: t.text });
      listeners.forEach((l) => l());
    },
    () => {},
  );
}

export function useTranslation(chatID: string, id: string): Translation | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shown.get(k(chatID, id)),
  );
}
