import type { PackageAbout } from '#core/extension.js';
import * as en from './en.js';
import type { WritingAbout, WritingMessages, WritingUses } from './en.js';
import * as fr from './fr.js';

// Writing's strings: one file per language in this folder (en.ts the reference), each listed here; a language
// without a file falls back to English. The few strings of the launch path are in launch.ts.
export interface WritingLocale {
  default: WritingMessages;
  about: WritingAbout;
  uses: WritingUses;
}
const languages: Readonly<Record<string, WritingLocale>> = { en, fr };

const byLang = <V>(f: (l: WritingLocale) => V): Readonly<Record<string, V>> =>
  Object.fromEntries(Object.entries(languages).map(([code, l]) => [code, f(l)]));

/** Writing's strings by language code (the writing chunk). */
export const writingCatalog = byLang((l) => l.default);
/** Its name and description, by language (Settings → Extensions). */
export const writingAbout: PackageAbout = { name: byLang((l) => l.about.name), description: byLang((l) => l.about.description) };
/** The names of its uses of a model, by language (llm's Settings → Default models). */
export const writingUses: Readonly<Record<keyof WritingUses, Readonly<Record<string, string>>>> = {
  translate: byLang((l) => l.uses.translate),
  assist: byLang((l) => l.uses.assist),
  image: byLang((l) => l.uses.image),
};
export type { WritingMessages };
