import type { ComponentType, ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ModuleInfo, PackageInfo, SpaceInfo } from '../../server/extension';
import type { ConnectorTraits } from './connectors';
import type { Chunk } from './lazy';
import type { Message, SupportLevel } from './types';

// Client half of the packages (see server/extension.ts): the module contracts. A package's client entry
// (ext/<id>/client/index.tsx) is on the launch path, so it holds only what the shell needs before the package's
// own lazy chunk arrives: ids, URLs, labels, and the lazy components it plugs into the core's slots. Its modules
// are on when the server says its package is (GET /api/extensions, registry.ts). A connector's UI side is static
// knowledge of its chats and media (connectors.ts), true whatever the server says. The window reports the space it shows (its id) with what it shows, so the
// server can spare that device the space's own pushes (ModuleContext / sdk spaceViewedBy).

/** Sidebar column of a space (left; on a phone, the page under its places). */
export interface SpaceListProps {
  /** The place shown on the right, if any (to mark its row). */
  place?: string;
  online: boolean;
  onSettings: () => void;
  settingsIcon: ReactNode;
  /** The section tabs, for its header. */
  tabs: ReactNode;
  /** The right pane shows this space (its home or a place); false while Settings is open over its list (kept, hidden). */
  here: boolean;
}

/** Right pane of a space: its home (place undefined) or one of its places. */
export interface SpaceMainProps {
  place?: string;
}

/** `active`: the space is shown; `listed`: its list is mounted (also hidden under Settings opened from it). */
export interface SpaceControllerProps {
  active: boolean;
  listed: boolean;
}

/**
 * A separate area of the app: a sidebar button, its list and pane (lazy), its URLs (SpaceInfo). A place (a URL
 * segment matching its `segment`) opens in the right pane, over the list on a phone, and Back returns to the list.
 */
export interface SpaceModule extends SpaceInfo {
  type: 'space';
  /** Button label by language code (English the fallback): here rather than in the chunk, it shows at launch. */
  label: Readonly<Record<string, string>>;
  icon: ComponentType;
  /** Count on the button (unread…): a hook, called while the button shows (also while the space is open). */
  useBadge?: () => number;
  /** The button's label while that count is not zero, by language code (English the fallback). */
  badgeLabel?: Readonly<Record<string, (n: number) => string>>;
  /**
   * Places that are lists too (a home shown over the list on a phone): what opens from them is a list entry,
   * so Back pops it rather than stacking the list again.
   */
  listPlaces?: readonly string[];
  List: Chunk<ComponentType<SpaceListProps>>;
  Main: Chunk<ComponentType<SpaceMainProps>>;
  /** Mounted beside the panes from the first visit on, so state, dialogs and toasts outlive a pane switch. */
  Controller?: Chunk<ComponentType<SpaceControllerProps>>;
  /**
   * false: no button in the section tabs (its pages still answer, e.g. to send old links on to a Settings page of
   * the package that replaced the button). Since API 1.14.
   */
  button?: false;
}

/**
 * A chat source's UI side: its name and mark in the network filter and on chats (`networks`), and what its chats
 * and media are like beyond their capabilities (ConnectorTraits; the server's ConnectorShape has the same
 * rules). On the launch path: plain data and its mark.
 */
export interface ConnectorUI extends ConnectorTraits {
  type: 'connector';
  /** Its mark, `size` px square; `label` is the network's name as shown (the image's accessible name). */
  icon: ComponentType<{ size?: number; label?: string }>;
  /**
   * Its own entry in New chat for some of its accounts (e.g. joining a room by its address), drawn under the
   * account's search while that account is chosen: `available` says for which (on the launch path). (2.1.0)
   */
  newChat?: {
    available: (account: { accountID: string; network?: string }) => boolean;
    Entry: Chunk<ComponentType<ConnectorNewChatProps>>;
  };
  /**
   * Links in messages it opens in the app instead of a new tab (e.g. a room's link): `handles` tells them apart (on
   * the launch path, an href as the browser resolved it); a plain click on one shows `Dialog` (a modal of its own).
   * Middle and modified clicks keep the link's own behaviour. (2.1.0)
   */
  links?: {
    handles: (href: string) => boolean;
    Dialog: Chunk<ComponentType<ConnectorLinkProps>>;
  };
  /**
   * Entries of its own in a chat's menu (the chat list's), after the core's: `list` says which for a chat (on the
   * launch path; none for most), and choosing one shows `Dialog` with its id (a modal of its own: a confirmation
   * before leaving a room…). (2.1.0)
   */
  chatActions?: {
    list: (chat: ConnectorChat) => readonly ConnectorChatAction[];
    Dialog: Chunk<ComponentType<ConnectorChatActionProps>>;
  };
}

/** A chat as a connector's entries see it (ConnectorUI.chatActions). (2.1.0) */
export interface ConnectorChat {
  id: string;
  title?: string;
  accountID?: string;
  network?: string;
  type?: string;
}

/** What New chat hands a connector's entry (ConnectorUI.newChat), for the account chosen. (2.1.0) */
export interface ConnectorNewChatProps {
  accountID: string;
  /** The account's network, as shown. */
  network: string;
  /** Closes New chat and opens this chat. */
  open: (chatID: string) => void;
}

/** What the conversation hands a connector's link dialog (ConnectorUI.links). (2.1.0) */
export interface ConnectorLinkProps {
  /** The link, as the browser resolved it. */
  href: string;
  /** Closes the dialog and opens this chat. */
  open: (chatID: string) => void;
  close: () => void;
}

/** An entry of a chat's menu from a connector (ConnectorUI.chatActions). (2.1.0) */
export interface ConnectorChatAction {
  /** Lower-case id (`[a-z][a-z0-9-]{0,31}`), unique in the connector; its testid is chat-menu-<id>. */
  id: string;
  /** By language code (English the fallback). */
  label: Readonly<Record<string, string>>;
}

/** What the chat list hands a connector's dialog for an entry of a chat's menu (ConnectorUI.chatActions). (2.1.0) */
export interface ConnectorChatActionProps {
  /** The entry chosen (ConnectorChatAction.id). */
  action: string;
  chat: ConnectorChat;
  close: () => void;
  /**
   * The chat is gone for the user (a room left): the core takes it out of its lists and leaves its conversation if
   * it shows. Then close.
   */
  gone: () => void;
  /** Shows a short line in the list's toast. */
  notify: (message: string) => void;
}

/** What the composer hands an augmentation: the draft, and what may be done with it. */
export interface ComposerApi {
  chatID: string;
  /** The field's text, trimmed. */
  text: string;
  /** Names of the @mentions in the draft: a rewrite must keep them. */
  mentions: readonly string[];
  /**
   * Where the text goes: the chat's network (its name as shown) and the formatting it displays, from the chat's
   * capabilities (bridge levels, 2 = full support; absent: not known). A rewrite can shape the Markdown for it.
   * Undefined while the chat is not loaded. (1.13.0)
   */
  network?: ComposerNetwork;
  /** A rewrite or a run (an augmentation's task) is under way (the ✨ button is busy). */
  busy: boolean;
  /**
   * Replaces the draft with what `work` returns. Meanwhile the field is read-only, ✨ spins and `working` shows
   * under the field; a rejection shows its message (an Error's) in the conversation's toast. Then the Undo bar
   * shows `done(before)` until Undo (or Ctrl+Z on the untouched result) or the send. `before` is what Undo puts
   * back: the very first text when a rewrite follows a rewrite.
   */
  rewrite(work: (draft: string) => Promise<string>, working: string, done: (before: string) => RewriteNote): void;
  /**
   * Runs `task` with the field's text (trimmed, possibly empty) as its input: ✨ spins and `working` shows under
   * the field, which stays editable; no Undo. When it resolves true the field is cleared, unless the text has
   * changed meanwhile (e.g. an instruction handed to an agent). A rejection shows its message in the toast.
   */
  run(task: (text: string) => Promise<boolean>, working: string): void;
  /** Puts this text into the field (mentions dropped), focused with the caret at the end: a draft to edit. */
  fill(text: string): void;
  /** Shows a short line in the conversation's toast (e.g. "the agent answered in the chat"). */
  notify(message: string): void;
}

/** The network a draft is sent to (ComposerApi.network). */
export interface ComposerNetwork {
  name: string;
  formatting?: Readonly<Record<string, SupportLevel>>;
}

/** What the Undo bar under the field says about the last rewrite. */
export interface RewriteNote {
  label: string;
  /** Under the label (e.g. the original of a translation). */
  detail?: string;
  /** The rewritten draft was sent (as `sent`, trimmed). */
  onSend?: (sent: string) => void;
}

/** An augmentation's section of the ✨ menu (direct children of the menu: buttons with role="menuitem"…). */
export interface ComposerMenuProps {
  api: ComposerApi;
  close: () => void;
  /** Shows this section alone while true (a form that takes the whole menu), every section again when false. */
  solo: (on: boolean) => void;
}

/** Mounted beside ✨ while its section is available and the menu can open: a one-tap button, keyboard shortcuts. */
export interface ComposerToolsProps {
  api: ComposerApi;
  /**
   * Adds a keydown handler of the field (returns its removal, for an effect); it returns true when it took the
   * key, and the composer then prevents the default. They run after the mention picker's keys, before the
   * composer's own (Ctrl+Z, Escape, Enter).
   */
  onKey: (handler: (e: KeyboardEvent) => boolean) => () => void;
}

/** A message, in a slot of its row. */
export interface MessageSlotProps {
  chatID: string;
  m: Message;
}

/**
 * Entries of the message menu for a message with text, as <li><button data-testid="menu-…"> items (close the
 * menu before running). Rendered twice: 'top' heads the list, only in the touch sheet of a message without
 * media (where an augmentation's one-tap action goes, as there is no hover row); 'text' follows the core's text
 * actions (copy, select). An entry shown at 'top' is left out at 'text'.
 */
export interface MessageMenuSlotProps extends MessageSlotProps {
  place: 'top' | 'text';
  /** Desktop popover at the pointer (false: the touch sheet). */
  anchored: boolean;
  /** The menu is about an attachment (with its caption). */
  media: boolean;
  /** The menu is about a picture: its index in the message's attachments (ChatReader.readImage). (1.9.0) */
  image?: number;
  /**
   * The menu is about an audio attachment (a voice note…): its index in the message's attachments
   * (ChatReader.readAudio). Only augmentations that declare `audioMenu` get the menu of an audio attachment
   * without text. (1.23.0)
   */
  audio?: number;
  close: () => void;
}

/** A conversation-level slot (header, per-chat mount). Read-only chats get them too: the slot decides. */
export interface ConversationSlotProps {
  chatID: string;
  readOnly: boolean;
}

/** The per-chat mount, drawn above the composer (its cards: an agent's drafts…). */
export interface ConversationPanelProps extends ConversationSlotProps {
  /** Puts this text into the composer's field to edit (ComposerApi.fill). */
  fill: (text: string) => void;
  /** Shows a short line in the conversation's toast. */
  notify: (message: string) => void;
}

/** An augmentation's part of the composer. */
export interface ComposerSlots {
  /** Its section of the ✨ menu: the ✨ button shows when some section is available in this chat. */
  Menu: Chunk<ComponentType<ComposerMenuProps>>;
  Tools?: Chunk<ComponentType<ComposerToolsProps>>;
  /**
   * Whether its section (and Tools) is there in this chat: a hook, on the launch path (default: always). E.g. the
   * chat's agent: only in chats where one sits.
   */
  useAvailable?: (chatID: string) => boolean;
  /** Lines of the ✨ button's tooltip, by language code, from the module's server info (shown before the chunk loads). */
  hint?: (info: ModuleInfo) => Readonly<Record<string, string>>;
  /**
   * Its section also in the ✨ menu of a message being edited (one only rewrites the text there: `run` does nothing,
   * no Tools). Absent: the composer only. (1.12.0)
   */
  inEdit?: boolean;
}

/**
 * Actions inside conversations: lazy components in the core's slots, drawn only in chats opened in the
 * conversation view (the composer's, never in read-only ones). Its data scope is declared by the server half
 * (AugmentationModule.scope): 'on-demand' only reads what the user acts on. Contracts grow by adding.
 */
export interface AugmentationUI {
  type: 'augmentation';
  id: string;
  composer?: ComposerSlots;
  /** In the conversation header (the packages' chips, in the order of the build). */
  Header?: Chunk<ComponentType<ConversationSlotProps>>;
  /** Mounted while a conversation shows, keyed by chat, above the composer: its per-chat state, its cards. */
  Conversation?: Chunk<ComponentType<ConversationPanelProps>>;
  message?: {
    /** In the hover row of a message (desktop), before React. */
    Actions?: Chunk<ComponentType<MessageSlotProps>>;
    /** Under the text in the bubble (a caption's message for an album), not while it is edited. `own`: we sent it. */
    Below?: Chunk<ComponentType<MessageSlotProps & { own: boolean }>>;
    Menu?: Chunk<ComponentType<MessageMenuSlotProps>>;
  };
  /**
   * Its message.Menu also in the menu of an audio attachment (MessageMenuSlotProps.audio set), even without text.
   * Absent: text and pictures only, as before. (1.23.0)
   */
  audioMenu?: boolean;
}

/**
 * A page of Settings from a package: an entry of the Settings menu (in the Extensions part, under its package's
 * name, after the core's entries), at /settings/ext/<package id>/<id>, listed while its package is on. A package
 * may have several, listed in the order of `settings`. Turned off, its entries leave the menu and an open page of
 * it gives way to the menu.
 */
export interface SettingsSection {
  /** One lower-case URL segment (`[a-z][a-z0-9-]{0,39}`), unique in its package; its testid is settings-<id>. */
  id: string;
  /** By language code (English the fallback), like the rest of a package's launch-path labels. */
  title: Readonly<Record<string, string>>;
  /** Its page; it gets SettingsBodyProps (the place inside it), since API 1.14. */
  Body: Chunk<ComponentType>;
  /**
   * Places inside the page (/settings/ext/<package>/<id>/<sub>): the pattern a sub must match in full (a regular
   * expression's source; the core's SETTINGS_SUB applies too). Without it, a URL with a sub opens the page itself.
   * Since API 1.14.
   */
  segment?: string;
  /**
   * A count on its menu entry (accounts in trouble…), and a dot on the Settings button while it is not zero: a
   * hook, called while the package is on. Since API 1.14.
   */
  useBadge?: () => number;
  /** Unused since 0.15.7 (an off package's pages are not listed); kept for packages that still set it. */
  off?: Readonly<Record<string, string>>;
  /** The menu entry's mark (an inline SVG, 20 px, currentColor), on the launch path: a generic one without. Since API 1.2. */
  icon?: ComponentType;
}
/** What a Settings page gets: the place inside it the URL names (SettingsSection.segment), if any. */
export interface SettingsBodyProps {
  sub?: string;
}

// A page whose changes are sensitive (a key, how one signs in) guards its server routes with the sdk's
// requireStepUp and shows client/src/StepUp.tsx (useStepUp, StepUpBox) while the session must confirm. Since API 1.3.

// Providers are server-only (server/registry.ts): no client side.
export type ClientModule = SpaceModule | ConnectorUI | AugmentationUI;

/** A frame the package's server half sent to the browsers (ModuleContext.toBrowsers): a ping, never content. */
export type PackageFrame = { type: string } & Readonly<Record<string, unknown>>;

/**
 * A package's client half: its package.ts spread in (id, version, requires, order…: the same as its server half,
 * test/boundary.test.ts checks it), its modules, its Settings sections and frame handlers.
 */
export interface ClientPackage extends PackageInfo {
  modules: readonly ClientModule[];
  settings?: readonly SettingsSection[];
  /**
   * Its server half's frames, by type (one of its modules' ids, or that id and a dot): what to refresh. Called
   * while its package is on, on the launch path (keep it to cache invalidations).
   */
  events?: Readonly<Record<string, (frame: PackageFrame, qc: QueryClient) => void>>;
}

// Typed constructors for a package's client entry.
export const definePackage = (p: ClientPackage): ClientPackage => p;
export const space = (m: Omit<SpaceModule, 'type'>): SpaceModule => ({ type: 'space', ...m });
export const augmentation = (m: Omit<AugmentationUI, 'type'>): AugmentationUI => ({ type: 'augmentation', ...m });
export const connector = (m: Omit<ConnectorUI, 'type'>): ConnectorUI => ({ type: 'connector', ...m });
