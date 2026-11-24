// The languages writing translates into, shared by both halves: the supported set (the server validates against it
// and names each one in English in its prompts; the client shows them in the UI language), and the user's
// preferences (Settings → Translation languages, ../server/langs.ts): which languages a draft can be translated
// into, and which ones received messages. Pure data and functions, no imports.

export const LANGS = ['vi', 'fr', 'en', 'ja', 'zh', 'ko', 'th', 'es', 'de', 'it', 'pt', 'ru'] as const;
export type Lang = (typeof LANGS)[number];

/** English names, for the prompts (and the client's fallback when Intl.DisplayNames is missing). */
export const LANG_NAMES: Readonly<Record<Lang, string>> = {
  vi: 'Vietnamese',
  fr: 'French',
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  th: 'Thai',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
};

export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as readonly string[]).includes(v);

/** The user's translation languages, in order: the first is the default. */
export interface LangPrefs {
  /** What a draft can be translated into (the composer's ✨ menu, its quick button): 1 to MAX_DRAFT. */
  draftLangs: Lang[];
  /** What received messages can be translated into (message menu, one-tap action): 1 to MAX_READ. */
  readLangs: Lang[];
}
export const MAX_DRAFT = 3;
export const MAX_READ = 2;
export const DEFAULT_LANG_PREFS: Readonly<LangPrefs> = { draftLangs: ['vi', 'fr', 'en'], readLangs: ['fr', 'en'] };

/** A list of 1 to `max` distinct supported languages. */
export function validLangList(v: unknown, max: number): v is Lang[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(isLang) && new Set(v).size === v.length;
}

/** A language's name in the UI language ("vietnamien", "Japanese"), English when Intl cannot name it. */
export function langName(code: Lang, uiLang: string): string {
  try {
    const n = new Intl.DisplayNames([uiLang], { type: 'language' }).of(code);
    if (n && n !== code) return n;
  } catch {
    // no Intl.DisplayNames, or a bad tag
  }
  return LANG_NAMES[code];
}
