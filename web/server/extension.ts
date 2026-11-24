// Packages (web/ext/<id>/): optional features plugged in at build time, never loaded at run time. A package is
// one or more modules, each of one of four types: a connector (a chat source), a space (an area of the app with
// its own sidebar button and routes), an augmentation (actions inside conversations) or a provider (a server
// capability other packages use). Its server half (server/registry.ts) and its client half
// (client/src/extension.ts) are separate entry files, listed by ext/packages.server.ts and ext/packages.client.ts:
// the only files of ext/ the core imports. This file is what both halves share: pure data types, no imports, so
// the client (and a package's own package.ts) can use it.

export type ModuleType = 'connector' | 'space' | 'augmentation' | 'provider';

/**
 * The version of the extension API: what packages build on (server/sdk.ts, client/src/sdk.ts since 1.15, and the
 * module contracts, server and client: registry.ts, connector.ts, this file, client/src/extension.ts). A package
 * states the versions it works with (PackageInfo.klatchly, a range). 1.16: capability declarations (PackageInfo
 * network / listen / files / spawns, PackageDetails.capabilities). 1.17: the agent runtime contract (agentruntime.ts),
 * ServerSpace.shown and a hidden space in PackageStatus.modules. 1.18: SpaceInfo.formerPaths (notification links
 * of a renamed space). 1.19: optional agent runtime capabilities otherSources, jobs, readSync. 1.20: jobsControl
 * (pauseJob / resumeJob). 1.21: ChatReader.readRange (a chat's messages over a period). 1.22: client withStepUp / StepUpPrompt. 1.23:
 * ChatReader.readAudio (a message's sound), the message menu for an audio attachment (MessageMenuSlotProps.audio,
 * AugmentationUI.audioMenu). 1.24: a space's device API (ServerSpace.bearerRoutes at /api/bearer/<id>/) and sends
 * (ServerSpace.sends, ModuleContext.sender, ChatSender), PackageDetails.sends / bearer, client prefillDraft. 1.25: no default connector
 * (ConnectorShape.longReactionKey, client ConnectorTraits.mediaQuery / displaysMarkdown; `owns` absent is a legacy
 * catch-all for chat and account routing only). 1.26: upstreamSignal (a connector's reads stop with the browser
 * requests waiting on them; identical reads are shared). 2.0: PackageInfo.beep renamed PackageInfo.klatchly (and
 * PackageDetails), with the app's rename to Klatchly. Additions bump the minor, a removal or a changed
 * signature the major; test/contract.test.ts holds the line (its snapshot, test/contract.json).
 */
export const EXTENSION_API = '2.0.0';

/** What an augmentation sees: only what the user hands it ('on-demand'), or every upstream event ('events'). */
export type AugmentationScope = 'on-demand' | 'events';

/** Package ids and the versions wanted of each (npm-style ranges, server/semver.ts): `{ llm: '^1.0' }`. */
export type Dependencies = Readonly<Record<string, string>>;

/** A package as both halves know it (its package.ts). */
export interface PackageInfo {
  /** Lower-case id, also its folder (ext/<id>/). */
  id: string;
  /** Its version (x.y.z): the major changes when what other packages use of it (its api.ts) loses or changes something. */
  version: string;
  /** The extension API versions it works with (a range over EXTENSION_API, e.g. '^1.0'): off otherwise. */
  klatchly: string;
  /** Packages it needs, with the versions it works with: it stays off unless they are on and match. */
  requires?: Dependencies;
  /**
   * Packages it works better with: used when they are on and match (a provider found through ctx.provider, its
   * types imported from their public entry), started before it; never a reason for it to be off.
   */
  enhances?: Dependencies;
  /** Environment variables it needs (names, never values): it stays off while one is unset or empty. */
  config?: readonly string[];
  /** Environment variables it reads that have a default or are optional (names): listed for the record and checked by the tests. */
  optionalConfig?: readonly string[];
  /**
   * Where its modules go among the other packages' (sidebar spaces, the conversation's slots and ✨ sections,
   * connectors' merged lists, the Settings list): lower first, then by id. Not the list's order in ext/.
   */
  order?: number;
  // What its server code reaches outside the app's own work (1.16). A declaration, not a sandbox: a package runs in
  // the server's process with all its rights (docs/extensions.md, "Security model"). test/boundary.test.ts checks it against
  // the Node modules and globals its server code uses (node:net, node:http, fetch, ws…: `network`; node:fs:
  // `files`; ctx.listen: `listen`; node:child_process…: `spawns`), and Settings → Extensions shows it beside what
  // it reads. Its client half runs in the page under the app's CSP (default-src 'self'): nothing to declare there.
  // An address or a path is named by the declared variable that holds it (`config` / `optionalConfig`), never
  // written with its value: the declaration is the same on every server.
  /**
   * Where it connects (outbound): each entry the name of a declared variable holding the address (an URL, a host,
   * a socket path: 'KLATCHLY_LLM_URL'), a host name ('api.example.com'), or '*': addresses it is given at run time
   * (set in its Settings, read from a message). Absent or empty: no connection of its own (one made for it by a
   * package it requires is that package's).
   */
  network?: readonly string[];
  /** Where it listens (ModuleContext.listen, providers only): declared variables holding host:port. */
  listen?: readonly string[];
  /**
   * Files it reads or writes: 'data' (its own files in the data volume, dataPath) and declared variables holding a
   * path (a key file; files beside it included). Absent or empty: none.
   */
  files?: readonly string[];
  /** It starts other programs or threads (node:child_process, node:worker_threads, node:cluster). */
  spawns?: boolean;
}

/** What a package declares it reaches (PackageInfo network / listen / files / spawns), for Settings → Extensions. */
export interface PackageCapabilities {
  network: readonly string[];
  listen: readonly string[];
  files: readonly string[];
  spawns: boolean;
}

/** A package's declared capabilities, absent fields as empty. */
export const capabilitiesOf = (p: Pick<PackageInfo, 'network' | 'listen' | 'files' | 'spawns'>): PackageCapabilities => ({
  network: [...(p.network ?? [])],
  listen: [...(p.listen ?? [])],
  files: [...(p.files ?? [])],
  spawns: p.spawns === true,
});

/** A package's name and one-line description, by language code (English the fallback), shown in Settings → Extensions. */
export interface PackageAbout {
  name: Readonly<Record<string, string>>;
  description: Readonly<Record<string, string>>;
}

const DEFAULT_ORDER = 100;
/** Sorts packages by their declared order, then id (both halves, so the list's order in ext/ never matters). */
export const byOrder = (a: Pick<PackageInfo, 'id' | 'order'>, b: Pick<PackageInfo, 'id' | 'order'>): number =>
  (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A space's URLs, shared by its server half (pages served, notification targets) and its client half (routing). */
export interface SpaceInfo {
  /** Lower-case id: the sidebar button is `open-<id>`, its colour class `sec-<id>`, its API /api/<id>/. */
  id: string;
  /** Its home, e.g. '/example': one lower-case segment. */
  path: string;
  /**
   * Its places, one segment after `path` ('/example/<place>'): a pattern for that segment alone, e.g.
   * '[a-f0-9]{12}|machine'. The core builds the whole match (spacePlace): a segment never holds '/' or '\',
   * so no pattern can reach another path. Without it, the space has its home only.
   */
  segment?: string;
  /**
   * Homes the space had before a rename ('/old'), for notification links only (1.18): a notification delivered
   * before the rename, whose link is one of them or one of their places, opens the same place under `path` (the
   * service worker translates it locally, push-sw.js). Nothing is served there: no page, no API, no redirect.
   */
  formerPaths?: readonly string[];
}

// A segment pattern: letters, digits and the regex pieces that stay inside one segment ('.', '^', '$', '\\', '/'
// and flags are refused), brackets balanced so that no ')' closes the group the core puts around it.
const SEGMENT_CHARS = /^[A-Za-z0-9_|()[\]{},?*+-]{1,200}$/;
export function segmentProblem(seg: string): string | null {
  if (!SEGMENT_CHARS.test(seg)) return 'characters outside [A-Za-z0-9_|()[]{},?*+-]';
  let depth = 0;
  for (const c of seg) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return 'unbalanced )';
  }
  if (depth) return 'unbalanced (';
  try {
    new RegExp(`^(?:${seg})$`);
  } catch {
    return 'not a pattern';
  }
  return null;
}

const compiled = new Map<string, RegExp>();
/**
 * Whether a path is one of a space's pages: null if not, else its place (undefined for the home or a segment
 * that is not one of its places). Every check of space URLs goes through here (server pages, client routing);
 * the service worker repeats it (client/public/push-sw.js).
 */
export function spacePlace(space: SpaceInfo, path: string): { place: string | undefined } | null {
  if (path === space.path) return { place: undefined };
  if (!path.startsWith(`${space.path}/`)) return null;
  const seg = path.slice(space.path.length + 1);
  if (!seg || /[/\\]/.test(seg)) return null;
  if (space.segment === undefined) return { place: undefined };
  let re = compiled.get(space.segment);
  if (!re) compiled.set(space.segment, (re = new RegExp(`^(?:${space.segment})$`)));
  return { place: re.test(seg) ? seg : undefined };
}

/** Whether a path is a deep link of the space: its home or one of its places (not any segment). */
export const isSpaceLink = (space: SpaceInfo, path: string): boolean => {
  const m = spacePlace(space, path);
  return !!m && (path === space.path || m.place !== undefined);
};

/**
 * Public values a module's client half shows (a provider's display name…): a string, or one by language code.
 * Never a secret: anyone signed in reads them in GET /api/extensions.
 */
export type ModuleInfo = Readonly<Record<string, string | Readonly<Record<string, string>>>>;

/** One package in GET /api/extensions. */
export interface PackageStatus {
  id: string;
  active: boolean;
  /** Why it is off (a missing variable, a package it needs…). Never a secret. */
  reason?: string;
  /**
   * `info`: the module's ModuleInfo, while the package is on (and only if it has some). `hidden` (1.17): a space
   * of a package that is on but that does not show now (ServerSpace.shown): no button, no page.
   */
  modules: { type: ModuleType; id: string; path?: string; segment?: string; info?: ModuleInfo; hidden?: true }[];
}

export interface ExtensionsReply {
  packages: PackageStatus[];
}

/** Why a package is off, for Settings → Extensions to say in the user's language (PackageStatus.reason is the log's). */
export type OffCause =
  /** Turned off in Settings (server-wide). */
  | { kind: 'disabled' }
  | { kind: 'config'; missing: string[] }
  /** A module's readiness check (a key file…): its own words. */
  | { kind: 'check'; module: string; detail: string }
  /** The extension API of this build is not one it works with. */
  | { kind: 'api'; range: string; present: string }
  /** A package it requires: not in the build, another version, off, or turned off in Settings. */
  | { kind: 'requires'; id: string; range: string; present?: string; state: 'missing' | 'version' | 'off' | 'disabled' }
  | { kind: 'cycle' }
  | { kind: 'start'; module: string };

/** A dependency as Settings → Extensions shows it: the range wanted, the version present, whether it matches. */
export interface DependencyStatus {
  id: string;
  range: string;
  /** The version in this build (absent: not installed). */
  present?: string;
  ok: boolean;
}

/** One package in GET /api/extensions/details (Settings → Extensions). */
export interface PackageDetails {
  id: string;
  version: string;
  /** Its range over the extension API, and whether this build's matches. */
  klatchly: string;
  apiOk: boolean;
  about?: PackageAbout;
  /** 'disabled': turned off in Settings; 'off': for another reason (cause). */
  state: 'on' | 'off' | 'disabled';
  cause?: OffCause;
  reason?: string;
  modules: { type: ModuleType; id: string; scope?: AugmentationScope; path?: string }[];
  /** A space of it reads the accounts and the chat list's figures of every source (ServerSpace.chatSources). */
  chatSources?: true;
  /** A space of it sends messages in your name on its own (ServerSpace.sends). Since API 1.24. */
  sends?: true;
  /** A space of it answers devices holding a token of its own at /api/bearer/<id>/ (ServerSpace.bearerRoutes). Since API 1.24. */
  bearer?: true;
  /** What it declares it reaches outside the app (1.16): connections, listeners, files, programs. */
  capabilities: PackageCapabilities;
  requires: DependencyStatus[];
  enhances: DependencyStatus[];
  /** Packages of the build that require it / that it enhances. */
  requiredBy: string[];
  enhancedBy: string[];
  /** What turning it off turns off too (the packages that require it, directly or not, and are not already off by choice). */
  dependants: string[];
  /**
   * Whether it may be turned off, and why not ('no-connector': the last connector on). 'default-connector' (the build's
   * default chat source) is no longer produced since 1.25: no connector is privileged.
   */
  canDisable: boolean;
  keep?: 'default-connector' | 'no-connector';
  /** Whether it may be turned on: not when it, or a package it requires, cannot run (cause says why). */
  canEnable: boolean;
  /** Packages it requires that are turned off in Settings: turning it on offers to turn them on too. */
  needs: string[];
}

export interface ExtensionsDetails {
  /** EXTENSION_API of this build. */
  api: string;
  packages: PackageDetails[];
}

/**
 * The client's spaces that the server has on, with the same URLs on both sides (a half built against another
 * version of its package stays off).
 */
export function activeSpaces<S extends SpaceInfo>(reply: ExtensionsReply | undefined, spaces: readonly { pkg: string; space: S }[]): S[] {
  const on = new Map<string, { path?: string; segment?: string }>();
  for (const p of reply?.packages ?? []) if (p.active) for (const m of p.modules) if (m.type === 'space' && !m.hidden) on.set(`${p.id}/${m.id}`, m);
  return spaces
    .filter(({ pkg, space }) => {
      const m = on.get(`${pkg}/${space.id}`);
      return !!m && m.path === space.path && m.segment === space.segment;
    })
    .map((x) => x.space);
}

/** Whether the server has this module of this package on (an augmentation's slots, a package's settings). */
export function moduleOn(reply: ExtensionsReply | undefined, pkg: string, type: ModuleType, id: string): boolean {
  return !!reply?.packages.some((p) => p.id === pkg && p.active && p.modules.some((m) => m.type === type && m.id === id));
}

/** A module's ModuleInfo while its package is on ({} otherwise). */
export function moduleInfo(reply: ExtensionsReply | undefined, pkg: string, type: ModuleType, id: string): ModuleInfo {
  const p = reply?.packages.find((x) => x.id === pkg && x.active);
  return p?.modules.find((m) => m.type === type && m.id === id)?.info ?? {};
}

/** Whether the server has this package on. */
export const packageOn = (reply: ExtensionsReply | undefined, pkg: string): boolean => !!reply?.packages.some((p) => p.id === pkg && p.active);
