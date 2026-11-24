import { readdirSync } from 'node:fs';
import type { Locale, Messages } from './locales/en.js';

// Server-side catalogs (push notification texts). Every file in ./locales/ is a language: adding one
// is adding a file there (the client picks it up too, see client/src/i18n.ts).

const dir = new URL('./locales/', import.meta.url);
const locales = new Map<string, Locale>();
for (const f of readdirSync(dir).sort()) {
  if (!/^[a-z]{2,3}(-[A-Z]{2})?\.js$/.test(f)) continue;
  const mod = (await import(new URL(f, dir).href)) as { default: Locale };
  locales.set(mod.default.code, mod.default);
}

export const DEFAULT_LANG = 'en';
export const languages = (): string[] => [...locales.keys()];
export const isLanguage = (v: unknown): v is string => typeof v === 'string' && locales.has(v);
export const messages = (lang?: string): Messages => (locales.get(lang ?? '') ?? locales.get(DEFAULT_LANG)!).messages;

/** A package's own catalog (language code → messages): that language's, else English. */
export function pick<M>(catalog: Readonly<Record<string, M>>, lang?: string): M {
  return (lang && Object.hasOwn(catalog, lang) ? catalog[lang] : undefined) ?? catalog[DEFAULT_LANG]!;
}
