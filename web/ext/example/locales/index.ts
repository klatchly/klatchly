import type { PackageAbout } from '#core/extension.js';
import * as en from './en.js';
import type { ExampleAbout, ExampleMessages } from './en.js';
import * as fr from './fr.js';

// The package's strings: one file per language in this folder, each listed here (a language without a file falls
// back to English). Adding a language: copy en.ts to <code>.ts, translate it, add it to `languages`.
interface ExampleLocale {
  default: ExampleMessages;
  about: ExampleAbout;
}
const languages: Readonly<Record<string, ExampleLocale>> = { en, fr };

const byLang = <V>(f: (l: ExampleLocale) => V): Readonly<Record<string, V>> =>
  Object.fromEntries(Object.entries(languages).map(([code, l]) => [code, f(l)]));

/** Its strings by language code: the client chunk reads them with useCatalog (client/i18n.ts). */
export const exampleCatalog = byLang((l) => l.default);
/** Its name and description, by language (Settings → Extensions). */
export const exampleAbout: PackageAbout = { name: byLang((l) => l.about.name), description: byLang((l) => l.about.description) };
export type { ExampleMessages };
