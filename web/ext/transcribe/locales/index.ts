import type { PackageAbout } from '#core/extension.js';
import * as en from './en.js';
import type { TranscribeAbout, TranscribeMessages } from './en.js';
import * as fr from './fr.js';

// Transcription's strings: one file per language in this folder (en.ts the reference), each listed here; a language
// without a file falls back to English. The title of its Settings page is in launch.ts.
export interface TranscribeLocale {
  default: TranscribeMessages;
  about: TranscribeAbout;
}
const languages: Readonly<Record<string, TranscribeLocale>> = { en, fr };

const byLang = <V>(f: (l: TranscribeLocale) => V): Readonly<Record<string, V>> =>
  Object.fromEntries(Object.entries(languages).map(([code, l]) => [code, f(l)]));

/** Its strings by language code (the transcribe chunk). */
export const transcribeCatalog = byLang((l) => l.default);
/** Its name and description, by language (Settings → Extensions). */
export const transcribeAbout: PackageAbout = { name: byLang((l) => l.about.name), description: byLang((l) => l.about.description) };
export type { TranscribeMessages };
