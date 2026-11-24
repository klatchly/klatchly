import type { Widen } from '#core/locales/en.js';

// Writing's English catalog: the reference. Its shape defines `WritingMessages`; every other locale file of the
// package must match it (a language missing here falls back to English). Pure data, like the core catalogs.
// The strings the core shows before writing's chunk loads (Settings title, ✨ tooltip) are in launch.ts.

const messages = {
  assist: {
    fix: 'Fix',
    spelling: 'Spelling only',
    grammar: 'Spelling and grammar',
    rephrase: 'Improve phrasing',
    translateTo: 'Translate into',
    settings: 'Settings for this chat…',
    chatSettings: 'Writing help for this chat',
    headSummary: (lang: string, address?: string) => `Writing help for this chat: ${lang}${address ? ` · ${address}` : ''}`,
    typeFirst: 'Type a message first to fix or translate it.',
    defaultLang: 'Default language',
    address: 'How I address this person',
    addressHint: 'e.g. "I am em, she is chị", "formal, vous"',
    save: 'Save',
    working: 'Working…',
    fixed: (what: string) => `${what} · AI`,
    original: 'Original',
    translatedFrom: (lang: string) => `Translated into ${lang} · original below`,
    sentOriginal: 'Your original (only you see this)',
    hideOriginal: 'Hide the original',
    lost: (items: string) => `Not applied: the AI dropped ${items}.`,
    failed: 'The AI could not answer. Try again.',
    tooLong: 'Too long for the AI (4000 characters at most).',
    quick: 'Quick button (next to ✨)',
    quickNone: 'None',
    defaultChoice: (what: string) => `Default (${what})`,
    quickTranslate: (lang: string) => `Translate into ${lang}`,
    msgQuick: 'Quick action on messages',
    privacyBoth: (assist?: string, translate?: string) =>
      `Sent to AI models: ${assist ?? 'the AI model'} (writing help), ${translate ?? 'the AI model'} (translation of received messages)`,
  },
  translate: {
    label: (lang: string) => `Translation · ${lang}`,
    loading: 'Translating…',
    failed: 'Translation failed.',
    tooLong: 'Too long to translate.',
    noText: 'No text to translate in this picture.',
    imageTooLarge: 'Picture too large to translate (8 MB at most).',
    noImage: 'This picture cannot be read for a translation (JPEG, PNG, WebP or GIF only).',
    reading: 'Reading the picture…',
    hide: 'Hide translation',
  },
  menu: {
    translateTo: (lang: string) => `Translate to ${lang}`,
    translateImageTo: (lang: string) => `Translate the picture to ${lang}`,
  },
  settings: {
    langsHint:
      'The languages offered to translate, in all your chats. A chat remembers the last language you translated into; choose “Default” in its ✨ settings to follow this list again.',
    langsDraft: 'Translate my messages into',
    langsRead: 'Translate received messages into',
    langsMax: (n: number) => `Up to ${n}. The first one is the default.`,
    langsDefault: 'default',
    langsAdd: '+ Add',
    langsAddLabel: 'Add a language',
    langsRemove: (lang: string) => `Remove ${lang}`,
    langsUp: (lang: string) => `Move ${lang} up`,
    langsSaved: 'Saved.',
  },
};

export type WritingMessages = Widen<typeof messages>;

/** The package's name and one-line description (Settings → Extensions; the server's). */
export const about = {
  name: 'Writing help',
  description: 'Fixes and translates your drafts, translates received messages, when you ask.',
};
export type WritingAbout = Widen<typeof about>;

/** Its uses of a language model, as llm's Settings → Default models names them (the server's, llm's `use`). */
export const uses = {
  translate: 'Translation of received messages',
  assist: 'Writing help (fixes and translation of the draft)',
  image: 'Translation of pictures (a model that reads images)',
};
export type WritingUses = Widen<typeof uses>;
export default messages satisfies WritingMessages;
