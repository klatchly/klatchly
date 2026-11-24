// Settings → Discreet reading (ReadingSettings.tsx, its own chunk), English: the reference. Its shape defines
// `ReadingMessages`; every other file of this folder is a language (as in server/locales/) and must match it. The
// strings used outside the page (the chat menu, the conversation header, the toasts) stay in the launch catalog
// (server/locales/, `reading`).

import type { Widen } from '../../../../server/locales/en.js';

const plural = (n: number, one: string, other: string) => (new Intl.PluralRules('en').select(n) === 'one' ? one : other);

const messages = {
  intro: 'Read messages without the sender knowing. Klatchly marks them read here only; “Mark as read” tells the sender when you choose.',
  levels: 'Each account has its setting. A conversation can have its own, which wins over its account’s.',
  perAccount: 'Per account',
  none: 'No messaging account.',
  toggle: (account: string) => `Discreet reading on ${account}`,
  unsupported: 'Not possible on this network: reading always tells the sender.',
  // What the switch does now, under the account's name (the source's note, about what is particular there, under its accounts).
  stateOn: 'Opening a chat tells no one. “Mark as read” tells the sender.',
  stateOff: 'Opening a chat tells the sender you read it.',
  failed: 'Could not change the setting.',
  perChat: 'Per conversation',
  count: (n: number) => `${n} ${plural(n, 'conversation', 'conversations')}`,
  add: 'Add a conversation',
  empty: 'No conversation has its own setting yet.',
  emptyHow: 'Add one here, or from the chat list: right-click or long press a chat, then “Discreet reading”.',
  filter: 'Filter conversations',
  filterNone: 'No conversation matches.',
  unknownChat: 'Conversation not found',
  chatSub: (network: string, accountDiscreet: boolean) => `${network}, account ${accountDiscreet ? 'discreet' : 'normal'}`,
  stateLabel: (chat: string) => `Reading in ${chat}`,
  discreet: 'Discreet',
  normal: 'Normal',
  open: (chat: string) => `Open ${chat}`,
  remove: (chat: string) => `${chat}: back to the account setting`,
  resetAll: 'Put all back on the account setting',
  resetConfirm: (n: number) => `Put ${n} ${plural(n, 'conversation', 'conversations')} back on their account’s setting?`,
  resetDo: 'Put all back',
  // The picker (Add a conversation).
  pickTitle: 'Add a conversation',
  pickSearch: 'Search conversations',
  pickRecent: 'Recent',
  pickResults: 'Results',
  pickNoResults: 'No conversation found',
  pickHint: 'The conversation gets the opposite of what applies now; change it in the list afterwards.',
  pickNow: (network: string, discreet: boolean) => `${network}, ${discreet ? 'discreet now' : 'normal now'}`,
  pickAlready: 'Already in the list',
  added: (chat: string, discreet: boolean) => `${chat}: ${discreet ? 'discreet reading' : 'normal reading'}.`,
};

export type ReadingMessages = Widen<typeof messages>;
export default messages satisfies ReadingMessages;
