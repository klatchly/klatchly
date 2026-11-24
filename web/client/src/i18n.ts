import { useSyncExternalStore } from 'react';
import type { Locale, Messages } from '../../server/locales/en';
import type { BootMessages } from './locales/boot/en';

// Interface language. Every file in server/locales/ (shared with the server, which uses it for push notification
// texts) is a language: adding one is adding a file there, and its signed-out strings in locales/boot/.
// This module is part of the public boot entry (boot.tsx): it holds the current language and the signed-out screens'
// strings (locales/boot/) only. The app's catalogs (server/locales/) come with its code: catalogs.ts registers them,
// imported first by the private entry (appmain.tsx), before anything calls t() or useT(). locales/boot/ has exactly
// their languages (test/i18n.test.ts), so the language detected here is one the app knows.

const boot: Readonly<Record<string, BootMessages>> = Object.fromEntries(
  Object.entries(import.meta.glob<{ default: BootMessages }>('./locales/boot/*.ts', { eager: true })).map(([f, m]) => [f.slice(f.lastIndexOf('/') + 1, -3), m.default]),
);
const FALLBACK = 'en';
const KEY = 'lang';
const known = (code: string) => Object.hasOwn(boot, code);

function stored(): string | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return v && known(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** First supported browser language (exact code, then base language), else English. */
export function detect(langs: readonly string[] = navigator.languages ?? [navigator.language]): string {
  for (const l of langs) {
    if (known(l)) return l;
    const base = l.toLowerCase().split('-')[0]!;
    if (known(base)) return base;
  }
  return FALLBACK;
}

let current = stored() ?? detect();
const listeners = new Set<() => void>();

function apply() {
  document.documentElement.lang = current;
}
apply();

export const lang = (): string => current;

export function setLang(code: string): void {
  if (!known(code) || code === current) return;
  current = code;
  try {
    localStorage.setItem(KEY, code);
  } catch {
    // private mode: the choice lasts for this page only
  }
  apply();
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useLang = (): string => useSyncExternalStore(subscribe, () => current);
export const onLangChange = subscribe;

/** Text of a by-language map (a package's catalog, a button label): the current language's, else English. */
export function localized<M>(map: Readonly<Record<string, M>>, code: string = current): M {
  return (Object.hasOwn(map, code) ? map[code] : undefined) ?? map[FALLBACK]!;
}
/** A package's own catalog in the current language; re-renders the component when it changes. */
export const useCatalog = <M,>(catalog: Readonly<Record<string, M>>): M => localized(catalog, useLang());

/** The signed-out screens' strings in the current language; re-renders the component when it changes. */
export const useBootT = (): BootMessages => useCatalog(boot);

// The app's catalogs, by language code (catalogs.ts).
let catalogs = new Map<string, Locale>();
/** Called once by catalogs.ts, with the app's code. */
export function registerCatalogs(locales: readonly Locale[]): void {
  catalogs = new Map(locales.map((l) => [l.code, l]));
}
/** Messages of the current language (the app's catalogs, catalogs.ts). */
export const t = (): Messages => {
  const l = catalogs.get(current) ?? catalogs.get(FALLBACK);
  if (!l) throw new Error('i18n: the app catalogs are not loaded (catalogs.ts)');
  return l.messages;
};

/** Messages of the current language; re-renders the component when it changes. */
export function useT(): Messages {
  useSyncExternalStore(subscribe, () => current);
  return t();
}
