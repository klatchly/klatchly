// Writing's strings on the launch path (client/index.tsx): shown by the core before writing's chunk loads, and
// read by the chunk too (the privacy line). By language code, English the fallback; fr has the keys of en.

import type { ModuleInfo } from '#core/extension.js';

/**
 * Who answers, in this language, from the module's server info (from the llm package): `llmLabel` for writing help,
 * `llmLabelTranslate` for the translation of received messages.
 */
export function llmLabelIn(info: ModuleInfo, lang: string, key: 'llmLabel' | 'llmLabelTranslate' = 'llmLabel'): string | undefined {
  const v = info[key];
  if (typeof v === 'string') return v;
  return v ? (v[lang] ?? v.en) : undefined;
}

export interface WritingLaunch {
  /** Its Settings page's title (Translation languages: menu entry, page header). */
  langsTitle: string;
  /** Where the text goes (the ✨ tooltip, the top of writing's menus); `who`: its provider's label (KLATCHLY_LLM_LABEL or the provider's name), if any. */
  privacy: (who?: string) => string;
  shortcuts: string;
}

export const launch: Readonly<Record<string, WritingLaunch>> = {
  en: {
    langsTitle: 'Translation languages',
    privacy: (who?: string) => (who ? `Sent to the AI model (${who})` : 'Sent to the AI model'),
    shortcuts: 'Ctrl+Shift+K: fix · Ctrl+Shift+L: translate',
  },
  fr: {
    langsTitle: 'Langues de traduction',
    privacy: (who?: string) => (who ? `Envoyé au modèle IA (${who})` : 'Envoyé au modèle IA'),
    shortcuts: 'Ctrl+Maj+K : corriger · Ctrl+Maj+L : traduire',
  },
};
