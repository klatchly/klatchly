import type { PackageAbout } from '#core/extension.js';
import * as en from './en.js';
import type { LlmAbout, LlmMessages } from './en.js';
import * as fr from './fr.js';

// LLM's strings: one file per language in this folder (en.ts the reference), each listed here; a language
// without a file falls back to English. The titles of its Settings pages are in launch.ts.
export interface LlmLocale {
  default: LlmMessages;
  about: LlmAbout;
}
const languages: Readonly<Record<string, LlmLocale>> = { en, fr };

const byLang = <V>(f: (l: LlmLocale) => V): Readonly<Record<string, V>> =>
  Object.fromEntries(Object.entries(languages).map(([code, l]) => [code, f(l)]));

/** Its strings by language code (the llm chunk). */
export const llmCatalog = byLang((l) => l.default);
/** Its name and description, by language (Settings → Extensions). */
export const llmAbout: PackageAbout = { name: byLang((l) => l.about.name), description: byLang((l) => l.about.description) };
export type { LlmMessages };
