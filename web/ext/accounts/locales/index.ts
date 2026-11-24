import type { PackageAbout } from '#core/extension.js';
import * as en from './en.js';
import type { AccountsAbout, AccountsMessages } from './en.js';
import * as fr from './fr.js';

// The accounts package's strings: one file per language in this folder (en.ts the reference), each listed here; a language
// without a file falls back to English. The few strings of the launch path are in launch.ts.
export interface AccountsLocale {
  default: AccountsMessages;
  about: AccountsAbout;
}
const languages: Readonly<Record<string, AccountsLocale>> = { en, fr };

const byLang = <V>(f: (l: AccountsLocale) => V): Readonly<Record<string, V>> =>
  Object.fromEntries(Object.entries(languages).map(([code, l]) => [code, f(l)]));

/** The space's strings by language code (its chunk). */
export const accountsCatalog = byLang((l) => l.default);
/** Its name and description, by language (Settings → Extensions). */
export const accountsAbout: PackageAbout = { name: byLang((l) => l.about.name), description: byLang((l) => l.about.description) };
export type { AccountsMessages };
