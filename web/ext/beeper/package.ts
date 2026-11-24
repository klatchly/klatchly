import type { PackageInfo } from '#core/extension.js';

// Beeper: the Beeper Desktop API (beeper-server, a headless Beeper on the same compose network) as a connector like
// any other: the chats of Matrix room ids ('!…') and the accounts beeper-server lists. Both halves share this file:
// the package and how its chats are named. The core refuses to start without a connector (any one is enough).

export const beeperPackage = {
  id: 'beeper',
  version: '1.2.0',
  // 1.25: no default connector (owns, ownsAccount and longReactionKey declared; the client half's traits). 1.26: its
  // reads stop with the browser requests waiting on them (upstreamSignal). 2.1: its Matrix rooms in New chat, links and
  // the chat menu (ConnectorUI.newChat, links, chatActions).
  klatchly: '^2.1',
  // KLATCHLY_UPSTREAM (default http://beeper-server:23373) and KLATCHLY_TOKEN_FILE (default the beeper_token docker
  // secret) have defaults; the token file itself is checked by the module.
  config: [],
  optionalConfig: ['KLATCHLY_UPSTREAM', 'KLATCHLY_TOKEN_FILE'],
  // Capabilities (1.16): beeper-server (KLATCHLY_UPSTREAM: its HTTP API, event stream and media), the token file
  // (KLATCHLY_TOKEN_FILE) and its own files in the data volume.
  network: ['KLATCHLY_UPSTREAM'],
  files: ['data', 'KLATCHLY_TOKEN_FILE'],
  // First of the connectors: lists merge in this order.
  order: 10,
} as const satisfies PackageInfo;

/** Chat ids: Matrix room ids, which all start with '!' (the core bounds their length and characters). */
export const isBeeperChatID = (id: string | undefined): id is string => !!id && id.startsWith('!');
