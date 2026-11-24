import type { Widen } from '#core/locales/en.js';

// The accounts package's English catalog: the reference. Its shape defines `AccountsMessages`; every other locale
// file of the package must match it (a language missing here falls back to English). Pure data, like the core
// catalogs. The sidebar button's labels are not here: they show at launch, before the package's chunk (launch.ts).

const plural = (n: number, one: string, other: string) => (new Intl.PluralRules('en').select(n) === 'one' ? one : other);

const messages = {
  title: 'Accounts and networks',
  subtitle: 'Every messaging account Klatchly reaches, read-only',
  refresh: 'Refresh',
  unavailable: 'The accounts cannot be read right now.',
  empty: 'No account is connected.',
  notFound: 'This account is not connected any more.',
  allNetworks: 'All networks',
  summary: (n: number) => plural(n, `${n} account`, `${n} accounts`),
  troubleCount: (n: number) => plural(n, `${n} needs attention`, `${n} need attention`),
  allFine: 'All connected',
  needsAttention: 'Needs attention',
  others: 'Accounts',
  /** Account.status in plain words. */
  status: {
    connected: 'Connected',
    connecting: 'Connecting',
    backfilling: 'Syncing history',
    connection_required: 'Sign-in needed',
    reconnect_required: 'Reconnect needed',
    attention_required: 'Needs attention',
    disconnected: 'Disconnected',
    disabled: 'Turned off',
    unknown: 'Status unknown',
  },
  stuck: 'Connecting for a long time',
  since: (when: string) => `since ${when}`,
  sinceNote: 'As noticed by Klatchly: the network does not say when it changed.',
  /** What to do when an account is in trouble: Klatchly cannot reconnect it. `where`: its source's name. */
  hint: (where: string) => `Klatchly cannot reconnect an account: reconnect it in ${where}.`,
  hintAnywhere: 'Klatchly cannot reconnect an account: reconnect it where it is connected.',
  /** A source that did not answer: its accounts are missing from the list. */
  qr: {
    show: 'Show the sign-in QR code',
    hide: 'Hide the QR code',
    alt: 'Sign-in QR code',
    howTo: 'In the network’s app on your phone, open its QR code scanner and scan this code, then confirm on the phone.',
    generating: 'Preparing the QR code…',
    scanned: 'Code scanned: confirm the sign-in on your phone.',
    loggedIn: 'Signed in. The session is back.',
    confirming: 'Code accepted: checking the sign-in with the bridge…',
    expired: 'This QR code expired: a new one is coming.',
    declined: 'Sign-in declined on the phone: a new QR code is coming.',
    none: 'No QR code waiting right now: the bridge is not waiting for a QR sign-in.',
    failed: 'The QR code could not be read.',
  },
  sourceDown: (name: string) => `${name} does not answer: its accounts are missing here.`,
  sourceUnnamed: 'A chat source',
  /** An account whose source does not answer: it may still be connected. */
  accountSourceDown: 'The source of this account does not answer: its state cannot be read right now.',
  provider: {
    cloud: 'Beeper Cloud',
    local: 'On the Beeper device',
    'self-hosted': 'Self-hosted bridge',
    'platform-sdk': 'Platform bridge',
  },
  chats: (n: number) => plural(n, `${n} chat`, `${n} chats`),
  groups: (n: number) => plural(n, `${n} group`, `${n} groups`),
  unread: (n: number) => `${n} unread`,
  lowPriority: (n: number) => `${n} low priority`,
  archived: (n: number) => `${n} archived`,
  muted: (n: number) => `${n} muted`,
  lastActivity: (when: string) => `last activity ${when}`,
  noActivity: 'no activity yet',
  partial: 'Counted on the most recent chats only: the real figures may be higher.',
  identity: 'Account',
  name: 'Name',
  handle: 'Handle',
  phone: 'Phone',
  email: 'Email',
  network: 'Network',
  runsOn: 'Runs on',
  figures: 'Chats',
  capabilities: 'What this network supports',
  noCapabilities: 'The network does not say what it allows for this account.',
  supported: 'Supported',
  notSupported: 'Not supported',
  /** Capabilities in plain words. */
  cap: {
    reply: 'Replies to a message',
    edit: 'Editing sent messages',
    delete: 'Deleting sent messages',
    reaction: 'Reactions',
    thread: 'Threads',
    poll: 'Polls',
    locationMessage: 'Sharing a location',
    readReceipts: 'Read receipts',
    typingNotifications: 'Typing indicator',
    archive: 'Archiving chats',
    markAsUnread: 'Marking a chat unread',
    deleteChat: 'Deleting a chat',
    disappearingTimer: 'Disappearing messages',
    attachments: 'Attachments',
    maxTextLength: 'Message length',
  },
  kinds: {
    image: 'photos',
    video: 'videos',
    audio: 'audio',
    voice: 'voice messages',
    file: 'files',
    sticker: 'stickers',
    gif: 'GIFs',
  },
  upTo: (size: string) => `up to ${size}`,
  maxChars: (n: string) => `up to ${n} characters`,
  recent: 'Recent chats',
  noRecent: 'No chat on this account yet.',
  untitled: 'Untitled chat',
  group: 'Group',
  readOnly: 'Read-only: nothing on this page changes your accounts.',
};

export type AccountsMessages = Widen<typeof messages>;
export default messages satisfies AccountsMessages;

/** The package's name and one-line description (Settings → Extensions; the server's). */
export const about = {
  name: 'Accounts and networks',
  description: 'Every messaging account of your chat sources at a glance: status, figures, recent chats. Read-only.',
};
export type AccountsAbout = Widen<typeof about>;
