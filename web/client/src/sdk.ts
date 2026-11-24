// What a package's client half may use of the core: ext/<id>/client/ imports '../../../client/src/sdk' and nothing
// else of the core (test/boundary.test.ts holds the line), the twin of server/sdk.ts. Everything here is an API
// packages depend on, fingerprinted with the module contracts (test/contract.test.ts): adding to it bumps the
// minor of EXTENSION_API, removing or changing something the major. Named exports only, never `export *`, so
// that what enters is a decision. Since API 1.15.
//
// Bundling: a re-export pulls nothing into a chunk by itself; a package's launch entry (client/index.tsx) should
// still import from here only what the shell needs before its lazy chunk (definePackage, the constructors,
// lazyChunk), and leave the rest to the chunk.

// The module contracts (client/src/extension.ts): the typed constructors of a package's client entry and the
// props each slot of the core hands a package's components.
export { augmentation, connector, definePackage, space } from './extension';
export type {
  AugmentationUI,
  ClientModule,
  ClientPackage,
  ComposerApi,
  ComposerMenuProps,
  ComposerNetwork,
  ComposerSlots,
  ComposerToolsProps,
  ConnectorUI,
  ConversationPanelProps,
  ConversationSlotProps,
  MessageMenuSlotProps,
  MessageSlotProps,
  PackageFrame,
  RewriteNote,
  SettingsBodyProps,
  SettingsSection,
  SpaceControllerProps,
  SpaceListProps,
  SpaceMainProps,
  SpaceModule,
} from './extension';
// What a connector's UI side declares of its chats and media (ConnectorUI extends it).
export type { ConnectorTraits } from './connectors';
// A message as the client holds it (MessageSlotProps.m).
export type { Message } from './types';
// What the server half publishes for its client half (GET /api/extensions `info`), read with useModuleInfo.
export type { ModuleInfo } from '../../server/extension';

// Lazy components: a package's pages and slots are chunks loaded on first use (lazyChunk(() => import('./X'), 'X')).
export { lazyChunk, type Chunk } from './lazy';

// Calls to the server: request(method, '/<module id>/…', body) on /api (the session cookie and the CSRF header
// set), qs() for a query string, HttpError for a refusal (its status and `code`, e.g. 'step_up').
export { HttpError, qs, request } from './api';

// Strings. The core's catalog (useT: typed, its Messages) and a package's own: useCatalog(catalog by language code)
// in a component, localized(catalog) outside one; useLang() and lang() the language shown.
export { lang, localized, useCatalog, useLang, useT } from './i18n';
export type { Messages } from '../../server/locales/en';

// The server half's info for this module (GET /api/extensions `info`, while its package is on).
export { useModuleInfo } from './registry';

// Dates, times and sizes as the core shows them (the UI language).
export { dateTimeOf, fileSize, relativeTime, timeOf } from './format';
// A message's text as one plain line (Markdown marks dropped), e.g. to compare a draft with what was sent.
export { looseText } from './pending';

// Navigation inside a space as the core's lists do it: back to the list (phone), the state a list entry pushes,
// a replace that keeps it; phoneLayout() is the one-pane layout (under 800 px).
export { backToList, fromListState, phoneLayout, replaceKeepState } from './nav';

// Pieces of the core's UI a package's pages reuse: the connection banner, the list and message skeletons, a
// network's mark and name, the short toast line, a bottom sheet's drag to close, a popover's outside click and
// Escape, the composer's auto-growing field.
export { ConnBar } from './ConnBar';
export { ChatsSkeleton, MessagesSkeleton } from './Skeleton';
export { NetworkBadge, networkName } from './networks';
export { useToast } from './conn';
export { useSheetDrag } from './sheet';
export { useDismiss } from './dismiss';
export { autosize } from './Composer';

// A sensitive Settings page (a key, where data goes): its server routes use the server sdk's requireStepUp, and
// the page shows the core's confirmation box while the session must confirm (API 1.3).
export { isStepUpError, StepUpBox, StepUpLeft, stepUpLocked, StepUpPrompt, useStepUp, withStepUp } from './StepUp';

// Text put into a chat's unsent draft, shown by its composer when the chat opens (a shared link; 1.24).
export { prefillDraft } from './drafts';

// A chat's title and network, for a component in a conversation (1.21).
export { useChatSummary, type ChatSummary } from './chatsummary';
