import type { PackageAbout } from '#core/extension.js';
import * as en from './en.js';
import type { BeeperAbout, BeeperMatrix } from './en.js';
import * as fr from './fr.js';

// Beeper's strings: one file per language in this folder (en.ts the reference), each listed here; a language
// without a file falls back to English.
export interface BeeperLocale {
  about: BeeperAbout;
  discreetNote: string;
  matrix: BeeperMatrix;
}
const languages: Readonly<Record<string, BeeperLocale>> = { en, fr };

const byLang = <V>(f: (l: BeeperLocale) => V): Readonly<Record<string, V>> =>
  Object.fromEntries(Object.entries(languages).map(([code, l]) => [code, f(l)]));

/** Its name and description, by language (Settings → Extensions). */
export const beeperAbout: PackageAbout = { name: byLang((l) => l.about.name), description: byLang((l) => l.about.description) };
/** What is particular to discreet reading here, by language (Settings → Discreet reading). */
export const beeperDiscreetNote = byLang((l) => l.discreetNote);
/** Joining and leaving Matrix rooms (its client half: New chat, room links, the chat menu), by language. */
export const beeperMatrix = byLang((l) => l.matrix);
export type { BeeperMatrix };
