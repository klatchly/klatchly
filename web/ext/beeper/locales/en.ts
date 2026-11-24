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

/** Joining and leaving Matrix rooms with the Beeper account (New chat, a room's link in a message, the chat menu). */
export const matrix = {
  /** New chat, on the Beeper account: the entry, then its form. */
  joinOpen: 'Join a Matrix room',
  joinField: 'Room address or matrix.to link',
  joinPlaceholder: '#room:server or a matrix.to link',
  join: 'Join',
  joining: 'Joining…',
  joinHint: 'You join with your Beeper account: the room’s members see it. A room you join starts muted.',
  badTarget: 'Not a room address. Use #room:server, !id:server or a matrix.to link.',
  notReady: 'Joined. The room shows in your chats in a moment.',
  errForbidden: 'This room is invite-only, or you are banned from it.',
  errNotFound: 'No room has this address.',
  errRate: 'Too many attempts. Try again in a few minutes.',
  errUnavailable: 'This Beeper server does not let Klatchly join rooms. Join from a Beeper app instead: the room then shows here.',
  errRefused: 'The server refused to join this room.',
  errGeneric: 'Could not join the room. Try again.',
  /** A matrix.to link to a room, clicked in a message. */
  linkTitle: 'Matrix room',
  linkBody: (room: string) => `Join ${room} with your Beeper account? Its members will see you joined. It starts muted.`,
  /** A link to a bare room id (!…): the id itself is shown below, small. */
  linkBodyId: 'Join this Matrix room with your Beeper account? Its members will see you joined. It starts muted.',
  linkChecking: 'Checking…',
  linkBrowser: 'Open in browser',
  /** The chat menu of a room of the Beeper account. */
  leave: 'Leave room',
  leaveTitle: (title: string) => `Leave ${title}?`,
  leaveBody: 'You leave this Matrix room for all your devices. To come back, you join it again (or someone invites you).',
  leaving: 'Leaving…',
  left: 'Room left',
  errLeave: 'Could not leave the room. Try again.',
  errLeaveUnavailable: 'This Beeper server does not let Klatchly leave rooms. Leave from a Beeper app instead.',
};
export type BeeperMatrix = Widen<typeof matrix>;
