import { DEFAULT_LANG_PREFS, type Lang } from '../langs.js';

// What the composer's writing help offers (pure, so tested on its own): the ✨ menu's "Translate into" list and
// Ctrl+Shift+L's language, the one-tap button's choices (../server/assist.ts QUICK), from the user's languages for
// drafts (Settings → Translation languages, `draftLangs`) and this chat's own settings.

export type AssistMode = 'spelling' | 'grammar' | 'rephrase' | 'translate';
/** One-tap composer button; unset = spelling. */
export type AssistQuick = 'spelling' | 'grammar' | 'rephrase' | `translate:${Lang}` | 'none';

const DRAFT = DEFAULT_LANG_PREFS.draftLangs;
const FIXES = ['spelling', 'grammar', 'rephrase'] as const;
export const DEFAULT_QUICK: AssistQuick = 'spelling';

/** The ✨ menu's translations: the chat's language first (even one no longer in the list), then the others. */
export function draftTargets(chatLang: Lang | '' | undefined, draftLangs: readonly Lang[] = DRAFT): Lang[] {
  return chatLang ? [chatLang, ...draftLangs.filter((l) => l !== chatLang)] : [...draftLangs];
}

/** Ctrl+Shift+L: the chat's language, else the first of the list. */
export const defaultTarget = (chatLang: Lang | '' | undefined, draftLangs: readonly Lang[] = DRAFT): Lang => chatLang || draftLangs[0] || 'vi';

/** The quick button's choices: the fixes, a translation per language, and the chat's own if it is another. */
export function quickChoices(draftLangs: readonly Lang[], current?: AssistQuick | ''): Exclude<AssistQuick, 'none'>[] {
  const out: Exclude<AssistQuick, 'none'>[] = [...FIXES, ...draftLangs.map((l) => `translate:${l}` as const)];
  return current && current !== 'none' && !out.includes(current) ? [...out, current] : out;
}

/** The per-chat "Default language" choices: the list, and the chat's own if it is another. */
export const langChoices = (draftLangs: readonly Lang[], current?: Lang): Lang[] => (current && !draftLangs.includes(current) ? [...draftLangs, current] : [...draftLangs]);

/** What a quick choice runs. */
export function quickAction(q: Exclude<AssistQuick, 'none'>): { mode: AssistMode; target?: Lang } {
  const [mode, target] = q.split(':') as [AssistMode, Lang | undefined];
  return target ? { mode, target } : { mode };
}
