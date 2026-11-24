import type { Widen } from '#core/locales/en.js';

// Beeper's English strings: the reference. Their shape is `BeeperLocale` (index.ts); every other locale file of the
// package must match it (a language missing there falls back to English). Pure data, like the core catalogs.

/** The package's name and one-line description (Settings → Extensions; the server's). */
export const about = {
  name: 'Beeper (Desktop API)',
  description: 'Your chats through the Beeper Desktop API (Beeper Server or the Desktop app): the default source.',
};
export type BeeperAbout = Widen<typeof about>;

/**
 * What is particular to discreet reading here (Settings → Discreet reading, at the foot of its accounts: the
 * connector's receipts.note). True whatever the switch says: the page itself says what the switch does now.
 */
export const discreetNote =
  'Read discreetly, a chat stays unread in Beeper’s other apps. Replying marks all their earlier messages as read.';
