import type { PackageAbout } from '#core/extension.js';
import * as en from './en.js';
import type { AgentsAbout, AgentsMessages, AgentsPush } from './en.js';
import * as fr from './fr.js';

// The agents package's strings: one file per language in this folder (en.ts the reference), each listed here; a language
// without a file falls back to English. The few strings of the launch path are in launch.ts.
export interface AgentsLocale {
  default: AgentsMessages;
  push: AgentsPush;
  about: AgentsAbout;
}
const languages: Readonly<Record<string, AgentsLocale>> = { en, fr };

const byLang = <V>(f: (l: AgentsLocale) => V): Readonly<Record<string, V>> =>
  Object.fromEntries(Object.entries(languages).map(([code, l]) => [code, f(l)]));

/** The package's strings by language code (its chunks). */
export const agentsCatalog = byLang((l) => l.default);
/** Its notification texts (the server). */
export const agentsPushText = byLang((l) => l.push);
/** Its name and description, by language (Settings → Extensions). */
export const agentsAbout: PackageAbout = { name: byLang((l) => l.about.name), description: byLang((l) => l.about.description) };
export type { AgentsMessages };

/**
 * A text of the manifest (description, access note, disclosure) in this language: that one, else English, else
 * the first; undefined when there is none.
 */
export function textIn(t: Readonly<Record<string, string>> | null | undefined, lang: string): string | undefined {
  if (!t) return undefined;
  return t[lang] ?? t.en ?? Object.values(t)[0];
}
