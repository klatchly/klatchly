import type { PackageInfo, SpaceInfo } from '#core/extension.js';

// Accounts: a dashboard of the messaging accounts of every chat source that is on (each connector's own, with the
// status it reports), read-only. What both halves share: the package and the space's URLs (slug.ts: an account id
// as one URL segment).

export const accountsPackage = {
  id: 'accounts',
  // 1.1: a source's sign-in QR code on the account page. 1.2: a page of Settings (Settings → Networks) instead of
  // a sidebar button.
  version: '1.2.0',
  // ModuleContext.chatSources (extension API 1.1); ChatSources.loginQR (1.10); Settings places and counts, a space
  // without a button (1.14).
  // 1.16: its capability declarations (network / listen / files / spawns, below).
  klatchly: '^2.0',
  // No config: on whenever it is built in, with whatever connectors are on.
  config: [],
  // Capabilities (1.16): its own file in the data volume (the 'since' of each account); no connection of its own.
  files: ['data'],
  // After the other spaces in the sidebar, before the providers.
  order: 55,
} as const satisfies PackageInfo;

/** Settings → Networks: its id among the package's Settings pages, and its URL. */
export const NETWORKS_SECTION = 'networks';
export const NETWORKS_SETTINGS = `/settings/ext/${accountsPackage.id}/${NETWORKS_SECTION}`;

/**
 * The space: since 1.2 no button, only its URLs, /networks (the dashboard) and /networks/<account> (one account),
 * which send on to Settings → Networks; its server half keeps the API (/api/networks/*). Its id is not 'accounts': that is the
 * core's /api/accounts. An account is its id escaped by accountSlug (slug.ts: the core's segment patterns take no '.').
 */
export const networksSpace = {
  id: 'networks',
  path: '/networks',
  segment: '[A-Za-z0-9_-]{1,600}',
} as const satisfies SpaceInfo;
