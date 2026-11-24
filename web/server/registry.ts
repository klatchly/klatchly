import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { RequestListener, Server } from 'node:http';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './context.js';
import { broadcast, type BrowserFrame } from './broadcast.js';
import { chatActor, onChatEvent, type ChatActor, type ChatEvent } from './chatactor.js';
import { chatReader, type ChatReader } from './chatread.js';
import { chatSender, type ChatSender } from './chatsender.js';
import { chatSources, type ChatSources } from './chatsources.js';
import { Listeners } from './listeners.js';
import {
  byOrder,
  capabilitiesOf,
  EXTENSION_API,
  isSpaceLink,
  segmentProblem,
  type AugmentationScope,
  type DependencyStatus,
  type ExtensionsDetails,
  type ExtensionsReply,
  type ModuleInfo,
  type ModuleType,
  type OffCause,
  type PackageAbout,
  type PackageDetails,
  type PackageInfo,
  type PackageStatus,
  type SpaceInfo,
} from './extension.js';
import { log } from './log.js';
import { SOURCE_FRAMES, type ConnectorShape, type SourceFeed } from './connector.js';
import { pushAll } from './push.js';
import { sourceEvent, sourceOff } from './pushwatch.js';
import { parseVersion, rangeProblem, satisfies } from './semver.js';
import { useConnectors } from './sources.js';
import { closeLiveOf } from './ws.js';

// Server half of the packages (see extension.ts): the module contracts, and the registry that turns the list of
// ext/packages.server.ts into what the app mounts. The registry takes that list as a parameter (createApp's
// default is an empty one: the core alone), sorts it by the packages' declared order, resolves `requires` with
// their versions (and the extension API's), leaves a misconfigured package off with the reason in its status,
// starts providers first, then connectors, then the rest (a package whose start fails is off from then on), and
// says what is on through GET /api/extensions. A module's routes live under /api/<its id>/ (and its declared
// `mounts`) only, mounted after the core's. At least one connector must be on (startProblem); none is privileged.
//
// Packages are turned off and on again while the app runs (Settings → Extensions, setEnabled): the choice is
// server-wide and kept in the data volume (extensions.json). Turning one off turns off what requires it; what goes
// off answers 404 at once, then its modules stop (dependants first), its event stream, listeners and connector feed
// end; what comes on starts in the usual order. The browsers get an 'extensions' frame and ask again.

/** What a module gets when it starts. */
export interface ModuleContext {
  /**
   * An active provider, by module id, of a package this one `requires` or `enhances` (at a matching version), or
   * of its own; undefined otherwise (also once that package goes off: look it up when needed, or on each start).
   * P is the provider's type, from its package's public entry (e.g. LlmProvider of ext/llm/api.ts).
   */
  provider<P extends ProviderModule = ProviderModule>(id: string): P | undefined;
  /**
   * Augmentations only (undefined for other modules): reads of the chat the user acts on, bound to this package
   * (each call logged with its id). An 'on-demand' augmentation reads nothing else of the chats.
   */
  chats?: ChatReader;
  /**
   * 'events' augmentations only: acting in chats on its own (the chat's latest page with ids and authors, its
   * details, sending in the user's name), bound to this package, each call logged with its id. Its stream of new
   * messages is the module's onEvent.
   */
  actor?: ChatActor;
  /**
   * Spaces that declare it only (ServerSpace.chatSources; undefined for other modules): the accounts of every
   * connector that is on with their status, every chat's figures, an account's latest chats. Read-only and
   * content-free (no message, no avatar, no user id), bound to this package (each call logged with its id), and
   * reading nothing once the package is off.
   */
  chatSources?: ChatSources;
  /**
   * Spaces that declare it only (ServerSpace.sends; undefined for other modules): plain text messages sent in the
   * user's name the way the composer sends them, in any chat of a connector that is on, bound to this package (each
   * send logged with its id, never the text), refused once the package is off. Since API 1.24.
   */
  sender?: ChatSender;
  /**
   * Web Push to the signed-in devices, as the sdk's pushAll, but only while this package is on: a run or a poll
   * that ends after its package was turned off notifies nobody. Packages push through this rather than pushAll.
   */
  push(payload: Parameters<typeof pushAll>[0]): ReturnType<typeof pushAll>;
  /**
   * Frames to the signed-in browsers over /api/ws (content-free pings: "this changed, refetch"). The type must be
   * the module's id or start with it and a dot ('demo', 'demo.changed'): the client half of the package
   * routes them (ClientPackage.events). Anything else is dropped and logged.
   */
  toBrowsers(frame: BrowserFrame): void;
  /**
   * Providers only: serves `handler` on a listener of its own at host:port (a specific IPv4 address of this
   * container, e.g. on a network shared with the one service that calls it back). The app is never served on
   * that address. Rejects when it cannot listen. The core closes it after the module's stop.
   */
  listen?(host: string, port: number, handler: RequestListener): Promise<void>;
  /**
   * Connectors only: their events into the core (badge, push, the 'events' augmentations) and their frames for
   * the browsers (SOURCE_FRAMES types only), while the package is on.
   */
  feed?: SourceFeed;
}

interface ModuleBase {
  /** Lower-case id, unique among the modules of its type (and among those with routes: their /api/<id>/). */
  id: string;
  /**
   * Readiness beyond the package's config variables (a key file, a socket…): why it cannot run, or null.
   * Evaluated once, when the registry is built (at startup), whatever the state of what it requires. A failing
   * check turns the whole package off, and it cannot be turned on in Settings until the app restarts.
   */
  check?: () => string | null;
  /** Called when its package goes on: at startup, and again after it was turned off and on (Settings). */
  start?: (ctx: ModuleContext) => void | Promise<void>;
  /**
   * Called when its package goes off (turned off in Settings, a package it requires going off) or the app stops:
   * it must leave nothing running (timers, sockets, subscriptions), so that a later start begins afresh.
   */
  stop?: () => void | Promise<void>;
  /**
   * Its API, mounted at /api/<id>/ (paths relative to that: '/overview' is /api/<id>/overview), after the core's
   * routes, behind the passkey session and the origin check, answered only while the package is on.
   */
  routes?: Hono<Env>;
  /**
   * More APIs of the module, each at /api/<key>/ with the same rules as `routes` (key checked like an id):
   * for a module moved out of the core whose public paths do not all start with its id (writing: /api/assist,
   * /api/translate…). A new module puts everything under `routes`.
   */
  mounts?: Readonly<Record<string, Hono<Env>>>;
  /** Public values for its client half, in GET /api/extensions while the package is on (see ModuleInfo). */
  info?: () => ModuleInfo;
  /** Log template of a request path: its own ids replaced (e.g. /api/example/items/:id); other paths unchanged. */
  logPath?: (path: string) => string;
}

/** A separate area of the app: a sidebar button, its own /api routes and pages (client/src/extension.ts has the UI). */
export interface ServerSpace extends ModuleBase, SpaceInfo {
  type: 'space';
  /**
   * It shows the user's accounts: it gets ModuleContext.chatSources (Settings → Extensions says so). A space only:
   * augmentations read the chat the user acts on (ModuleContext.chats), connectors and providers read no source.
   */
  chatSources?: true;
  /**
   * Whether it shows now, its package being on (default: always). False: no button and no page in the client (its
   * module is marked `hidden` in GET /api/extensions), its pages and its API answer as if it were off (its
   * notification targets stay listed: a notification sent while it showed still opens it once it shows again).
   * Read at each request; when what it depends on changes with another package going on or off, the browsers are
   * already told. Since API 1.17 (agents: the Agents space only with a runtime that keeps conversations).
   */
  shown?: () => boolean;
  /**
   * It sends messages in the user's name on its own (a link shared from another app): it gets ModuleContext.sender
   * (Settings → Extensions says so). Since API 1.24.
   */
  sends?: true;
  /**
   * Its API for devices that are not a signed-in browser (an iOS Shortcut…), mounted at /api/bearer/<id>/ before the
   * origin check and the session guard. Such a request never carries a session: the core does not read the cookie
   * there (c.get('session') is undefined), answers 400 { error: 'bad_token' } to one without an
   * `Authorization: Bearer <token>` header of 16 to 256 URL-safe characters, caps the body at 64 KB, and answers 404
   * while the package is off or the space hidden; anything else under /api/bearer/ is a 404, never a cookie route.
   * The module checks the token itself (its own, kept hashed), limits the rate, and answers a bad token with 400
   * { error: 'bad_token' } (never 401/403: deploy/Caddyfile.example). The cookie routes never read that header.
   * Settings → Extensions says the package has one. Since API 1.24.
   */
  bearerRoutes?: Hono<Env>;
  /**
   * Its home page (`path` itself, not its places) opens the app's shell signed out too, which signs in and then shows
   * the page with its query (a link shared from another app into /share is not lost). Every other page of every space
   * stays a 302 to / signed out. Decided from the build's declarations alone: nothing of the module runs (no `shown`)
   * and its package being on or off does not change the answer, so an anonymous visitor learns nothing of the
   * runtime. For a page whose query carries what the user brought, never for one that shows data. Since API 1.24.
   */
  signedOutPage?: true;
}

/**
 * A chat source (connector.ts has the contract: ConnectorShape). The registry refuses to start without one that
 * is on; the core's chat routes ask the one that owns a chat (sources.ts). Its events come in through
 * ModuleContext.feed.
 */
export type ConnectorModule = ModuleBase & ConnectorShape & { type: 'connector' };

/**
 * Actions inside conversations (the ✨ composer menu, the message menu, slots in the conversation: the client
 * half, client/src/extension.ts). The scope is declared, and enforced by the type and by the registry: only an
 * 'events' augmentation gets the stream of new messages (onEvent, while its package is on) and ModuleContext.actor.
 * An 'on-demand' one reads what the user acts on (ModuleContext.chats).
 */
export type AugmentationModule = ModuleBase & { type: 'augmentation' } & (
    | { scope: Extract<AugmentationScope, 'on-demand'>; onEvent?: never }
    | { scope: Extract<AugmentationScope, 'events'>; onEvent: (ev: ChatEvent) => void }
  );

/**
 * A capability other packages use (an LLM, an agent runtime), found through ModuleContext.provider by a package
 * that `requires` it. Its own package exports the provider's type from its public entry (ext/<id>/api.ts), which
 * the users import as a type only; the object is the module itself.
 */
export interface ProviderModule extends ModuleBase {
  type: 'provider';
  status(): { ready: boolean; detail?: string };
  /**
   * The hosts its configuration names for a listener of its own (ModuleContext.listen), as configured: the app
   * refuses every connection made to them whatever the package's state (off, failed check, not started), so a
   * misconfigured provider never leaves the app served on another network.
   */
  reserves?: () => readonly string[];
}

export type ServerModule = ServerSpace | ConnectorModule | AugmentationModule | ProviderModule;

export interface ServerPackage extends PackageInfo {
  /** Its name and description for Settings → Extensions (package.ts; not on the client's launch path). */
  about?: PackageAbout;
  modules: readonly ServerModule[];
}

// Typed constructors for a package's server entry (ext/<id>/server/index.ts).
export const definePackage = (p: ServerPackage): ServerPackage => p;
export const space = (m: Omit<ServerSpace, 'type'>): ServerSpace => ({ type: 'space', ...m });
export const connector = (m: Omit<ConnectorModule, 'type'>): ConnectorModule => ({ type: 'connector', ...m });
export const augmentation = (m: DistributiveOmit<AugmentationModule, 'type'>): AugmentationModule => ({ type: 'augmentation', ...m }) as AugmentationModule;
export const provider = (m: Omit<ProviderModule, 'type'>): ProviderModule => ({ type: 'provider', ...m });
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const ID = /^[a-z][a-z0-9-]{0,31}$/;
// A device API's Authorization header (ServerSpace.bearerRoutes): the scheme, one space, a URL-safe token.
const BEARER = /^Bearer [A-Za-z0-9._~-]{16,256}$/;
const BEARER_BODY_MAX = 64 * 1024;
// Ids of the core's sections and pages, and first segments of its paths and API: a space or a module with routes
// cannot take them (the core's routes come first anyway: this keeps a package from being silently shadowed).
const RESERVED = new Set([
  'chats', 'chat', 'lowpriority', 'archive', 'archives', 'inbox', 'settings', 'enroll', 'healthz', 'assets', 'splash', 'pdfjs',
  'api', 'accounts', 'auth', 'extensions', 'forward', 'media', 'messages', 'notify', 'preview',
  'preview-img', 'push', 'push-links', 'session', 'thumb', 'upload', 'ws', 'bearer',
]);
// First parts of the core's own frames over /api/ws (upstream events, delivery ticks, keepalives, the browser's
// messages, the packages' state): no module may take them as its id, as its frames are "<id>" or "<id>.<x>"
// (ModuleContext.toBrowsers).
const FRAME_RESERVED = new Set(['ready', 'keepalive', 'error', 'subscriptions', 'chat', 'message', 'visibility', 'extensions']);
// Start order by type; spaces and augmentations come last, in dependency order.
const PHASE: Record<ModuleType, number> = { provider: 0, connector: 1, space: 2, augmentation: 2 };

// A host name in a capability declaration (lower case, at least one dot: 'api.example.com').
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const ranges = (deps: PackageInfo['requires']): [string, string][] => Object.entries(deps ?? {});

// The legacy connectors (no `owns`) already said once in this process.
const legacyLogged = new Set<string>();

/** Throws on a malformed list: a programming error, caught by the tests, never a configuration one. */
function validate(packages: readonly ServerPackage[]): void {
  const ids = new Set<string>();
  const modules = new Set<string>();
  const mounts = new Set<string>();
  // Former homes of spaces (SpaceInfo.formerPaths): never another space's home, now or among the former ones.
  const formers = new Set<string>();
  let legacy = 0;
  for (const p of packages) {
    if (!ID.test(p.id) || ids.has(p.id)) throw new Error(`package id ${JSON.stringify(p.id)}: invalid or used twice`);
    ids.add(p.id);
    if (!parseVersion(p.version)) throw new Error(`${p.id}: version ${JSON.stringify(p.version)} is not x.y.z`);
    if (rangeProblem(p.klatchly)) throw new Error(`${p.id}: klatchly ${JSON.stringify(p.klatchly)}: not a range`);
    for (const [id, range] of [...ranges(p.requires), ...ranges(p.enhances)]) {
      if (!ID.test(id) || id === p.id || rangeProblem(range)) throw new Error(`${p.id}: dependency ${id} ${JSON.stringify(range)}`);
    }
    for (const v of [...(p.config ?? []), ...(p.optionalConfig ?? [])]) if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(v)) throw new Error(`${p.id}: config ${JSON.stringify(v)}`);
    if (p.order !== undefined && !Number.isInteger(p.order)) throw new Error(`${p.id}: order ${p.order}`);
    // Capabilities (1.16): an address or a path is a declared variable; a host is a host name; '*' and 'data' as documented.
    const vars = new Set([...(p.config ?? []), ...(p.optionalConfig ?? [])]);
    for (const v of p.network ?? []) if (v !== '*' && !vars.has(v) && !HOST.test(v)) throw new Error(`${p.id}: network ${JSON.stringify(v)}: '*', a host name or a declared variable`);
    for (const v of p.listen ?? []) if (!vars.has(v)) throw new Error(`${p.id}: listen ${JSON.stringify(v)}: a declared variable`);
    for (const v of p.files ?? []) if (v !== 'data' && !vars.has(v)) throw new Error(`${p.id}: files ${JSON.stringify(v)}: 'data' or a declared variable`);
    if (p.spawns !== undefined && typeof p.spawns !== 'boolean') throw new Error(`${p.id}: spawns ${JSON.stringify(p.spawns)}`);
    for (const m of p.modules) {
      const key = `${m.type}:${m.id}`;
      if (!ID.test(m.id) || modules.has(key)) throw new Error(`${p.id}: module ${key} invalid or used twice`);
      modules.add(key);
      if (FRAME_RESERVED.has(m.id)) throw new Error(`${p.id}: ${key} takes the name of the core's frames`);
      if (m.type === 'augmentation' && !(m.scope === 'on-demand' ? m.onEvent === undefined : m.scope === 'events' && typeof m.onEvent === 'function')) {
        throw new Error(`${p.id}: ${key} scope ${JSON.stringify(m.scope)} and onEvent do not match`);
      }
      if ('chatSources' in m && m.chatSources !== undefined && (m.type !== 'space' || m.chatSources !== true)) throw new Error(`${p.id}: ${key} chatSources is for spaces only (true)`);
      if ('sends' in m && m.sends !== undefined && (m.type !== 'space' || m.sends !== true)) throw new Error(`${p.id}: ${key} sends is for spaces only (true)`);
      if ('bearerRoutes' in m && m.bearerRoutes !== undefined && m.type !== 'space') throw new Error(`${p.id}: ${key} bearerRoutes is for spaces only`);
      if ('signedOutPage' in m && m.signedOutPage !== undefined && (m.type !== 'space' || m.signedOutPage !== true)) throw new Error(`${p.id}: ${key} signedOutPage is for spaces only (true)`);
      if (m.type === 'connector' && !m.owns && ++legacy > 1) throw new Error(`${p.id}: ${key} is a second connector without owns (legacy catch-all)`);
      if (m.type === 'connector' && m.mediaRoutes?.length && (!m.routes || m.mediaRoutes.some((r) => !ID.test(r)))) {
        throw new Error(`${p.id}: ${key} mediaRoutes need routes and plain names`);
      }
      if (m.routes || m.type === 'space') {
        if (RESERVED.has(m.id) || mounts.has(m.id)) throw new Error(`${p.id}: ${key} takes a core or used id`);
        mounts.add(m.id);
      }
      for (const at of Object.keys(m.mounts ?? {})) {
        if (!ID.test(at) || RESERVED.has(at) || mounts.has(at)) throw new Error(`${p.id}: ${key} mounts /api/${at}, a core, used or invalid id`);
        mounts.add(at);
      }
      if (m.type !== 'space') continue;
      if (m.path !== `/${m.id}`) throw new Error(`${p.id}: space path ${m.path} is not /${m.id}`);
      for (const f of m.formerPaths ?? []) {
        const id = f.slice(1);
        if (f !== `/${id}` || !ID.test(id) || RESERVED.has(id) || id === m.id || formers.has(id)) throw new Error(`${p.id}: space former path ${JSON.stringify(f)}`);
        formers.add(id);
      }
      const why = m.segment === undefined ? null : segmentProblem(m.segment);
      if (why) throw new Error(`${p.id}: space segment ${JSON.stringify(m.segment)}: ${why}`);
    }
  }
  const homes = new Set(packages.flatMap((p) => p.modules.flatMap((m) => (m.type === 'space' ? [m.id] : []))));
  for (const f of formers) if (homes.has(f)) throw new Error(`space former path /${f} is the home of a space`);
}

/** The log's words for a cause (PackageStatus.reason), in English. */
export function reasonOf(c: OffCause): string {
  switch (c.kind) {
    case 'disabled':
      return 'disabled in settings';
    case 'config':
      return `missing config ${c.missing.join(', ')}`;
    case 'check':
      return `${c.module}: ${c.detail}`;
    case 'api':
      return `requires extension API ${c.range} (present ${c.present})`;
    case 'requires':
      return c.state === 'missing'
        ? `requires ${c.id} (not installed)`
        : c.state === 'version'
          ? `requires ${c.id} ${c.range} (present ${c.present})`
          : c.state === 'disabled'
            ? `requires ${c.id} (disabled in settings)`
            : `requires ${c.id} (off)`;
    case 'cycle':
      return 'requires cycle';
    case 'start':
      return `${c.module}: start failed`;
  }
}

/** Where the choices made in Settings are kept: { disabled: [ids] }, read at startup. */
function readDisabled(file: string | undefined): Set<string> {
  if (!file) return new Set();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  try {
    const v = JSON.parse(raw) as { disabled?: unknown };
    if (Array.isArray(v.disabled)) return new Set(v.disabled.filter((x): x is string => typeof x === 'string' && ID.test(x)));
  } catch {
    // below
  }
  log('ext', 'state unreadable', { file: 'extensions.json' });
  return new Set();
}

/** What an off-and-on request answers (PUT /api/extensions/<id>): done, or why not (409). */
export type ToggleOutcome =
  | { ok: true; changed: string[] }
  | { ok: false; status: 404 | 409 | 500; error: 'not_found' | 'required' | 'cannot_run' | 'requires_disabled' | 'not_saved'; needs?: string[]; cause?: OffCause };

type Target = { active: boolean; cause?: OffCause };

export class Registry {
  /** The build's packages, by their declared order (then id): the order of GET /api/extensions. */
  private readonly packages: readonly ServerPackage[];
  private readonly byID: ReadonlyMap<string, ServerPackage>;
  /** Packages after what they require and enhance (start order; stop is its reverse). */
  private readonly topo: readonly ServerPackage[];
  /** Why a package cannot run whatever the user chooses (config, checks, versions, missing packages, a cycle). */
  private readonly broken = new Map<string, OffCause>();
  /** Turned off in Settings (server-wide), and the packages whose start failed (off until turned on again). */
  private readonly disabled: Set<string>;
  private readonly failed = new Map<string, string>();
  /** What is served now (routes, pages, links, GET /api/extensions). */
  private readonly status = new Map<string, PackageStatus>();
  /** Packages whose modules are started (or starting), and those modules in start order. */
  private readonly running = new Set<string>();
  private started: { p: ServerPackage; m: ServerModule }[] = [];
  /** Stream subscriptions of the started 'events' augmentations, by package. */
  private readonly unsubscribe = new Map<string, (() => void)[]>();
  private listeners: Listeners | undefined;
  /** Hosts the providers of the build reserve (ProviderModule.reserves), on or off. */
  private readonly reserved: string[] = [];
  /** Starts, changes and the stop, one after the other. */
  private queue: Promise<unknown> = Promise.resolve();
  private starting: Promise<void> | undefined;
  private booted = false;
  private stopped = false;

  constructor(
    packages: readonly ServerPackage[],
    env: Readonly<Record<string, string | undefined>> = process.env,
    /** `stateFile`: where the choices of Settings → Extensions are kept (server/index.ts: extensions.json); none: in memory. */
    private readonly opts: { stateFile?: string } = {},
  ) {
    validate(packages);
    // A connector that claims no chat ids (before API 1.25): still the catch-all of chat and account routing, nothing more.
    for (const p of packages) {
      if (legacyLogged.has(p.id) || !p.modules.some((m) => m.type === 'connector' && !m.owns)) continue;
      legacyLogged.add(p.id);
      log('ext', 'connector without owns (legacy catch-all)', { id: p.id });
    }
    this.packages = [...packages].sort(byOrder);
    this.byID = new Map(this.packages.map((p) => [p.id, p]));
    for (const p of this.packages) {
      for (const m of p.modules) {
        if (m.type !== 'provider' || !m.reserves) continue;
        try {
          this.reserved.push(...m.reserves());
        } catch {
          log('ext', 'reserves failed', { id: p.id, module: `${m.type}:${m.id}` });
        }
      }
    }
    // Depth first: a package after what it requires, and after what it enhances when that is in the build.
    const topo: ServerPackage[] = [];
    const seen = new Set<string>();
    const visit = (p: ServerPackage) => {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      for (const [id] of [...ranges(p.requires), ...ranges(p.enhances)]) {
        const q = this.byID.get(id);
        if (q) visit(q);
      }
      topo.push(p);
    };
    this.packages.forEach(visit);
    this.topo = topo;
    // What no choice changes: evaluated once (checks read key files, sockets…).
    for (const p of this.packages) {
      const cause = this.ownProblem(p, env);
      if (cause) this.broken.set(p.id, cause);
    }
    for (const p of this.packages) if (this.requiresCycle(p)) this.broken.set(p.id, this.broken.get(p.id) ?? { kind: 'cycle' });
    this.disabled = readDisabled(opts.stateFile);
    // A choice the build cannot run with (no connector left) is not kept.
    for (const id of [...this.disabled]) {
      if (this.byID.has(id) && this.keeps(id, new Set([...this.disabled].filter((x) => x !== id)))) {
        this.disabled.delete(id);
        log('ext', 'disabled ignored', { id });
      }
    }
    for (const [id, t] of this.resolve()) this.status.set(id, this.statusOf(this.byID.get(id)!, t));
    // The core's chat routes ask the connectors that are on (a package that goes off leaves the list); the chats and
    // accounts of one that is off belong to nobody.
    const all = this.packages.flatMap((p) => p.modules.filter((m): m is ConnectorModule => m.type === 'connector'));
    useConnectors(() => this.modules('connector'), () => all);
    for (const p of this.packages) {
      const st = this.status.get(p.id)!;
      log('ext', st.active ? 'package on' : 'package off', { id: p.id, ...(st.reason ? { reason: st.reason } : {}) });
    }
  }

  /** Why a package cannot run, from its own declaration and the build: no choice changes it. */
  private ownProblem(p: ServerPackage, env: Readonly<Record<string, string | undefined>>): OffCause | undefined {
    for (const [id, range] of ranges(p.requires)) {
      const q = this.byID.get(id);
      if (!q) return { kind: 'requires', id, range, state: 'missing' };
      if (!satisfies(q.version, range)) return { kind: 'requires', id, range, present: q.version, state: 'version' };
    }
    if (!satisfies(EXTENSION_API, p.klatchly)) return { kind: 'api', range: p.klatchly, present: EXTENSION_API };
    const missing = (p.config ?? []).filter((v) => !env[v]);
    if (missing.length) return { kind: 'config', missing };
    for (const m of p.modules) {
      let why: string | null;
      try {
        why = m.check?.() ?? null;
      } catch {
        why = 'check failed';
      }
      if (why) return { kind: 'check', module: m.id, detail: why };
    }
    return undefined;
  }

  private requiresCycle(p: ServerPackage): boolean {
    const walk = (q: ServerPackage, path: Set<string>): boolean => {
      for (const [id] of ranges(q.requires)) {
        if (id === p.id) return true;
        const r = this.byID.get(id);
        if (r && !path.has(id) && walk(r, new Set([...path, id]))) return true;
      }
      return false;
    };
    return walk(p, new Set([p.id]));
  }

  /**
   * What should be on with these choices: a package is on unless it cannot run, is turned off, failed to start, or
   * requires a package that is off (the first one, in its declared order, gives the reason).
   */
  private resolve(disabled: ReadonlySet<string> = this.disabled, failed: ReadonlyMap<string, string> = this.failed): Map<string, Target> {
    const out = new Map<string, Target>();
    const visiting = new Set<string>();
    const at = (p: ServerPackage): Target => {
      const known = out.get(p.id);
      if (known) return known;
      if (visiting.has(p.id)) return { active: false, cause: { kind: 'cycle' } };
      visiting.add(p.id);
      let t: Target = { active: true };
      const own = this.broken.get(p.id);
      if (own && own.kind !== 'cycle') t = { active: false, cause: own };
      else if (disabled.has(p.id)) t = { active: false, cause: { kind: 'disabled' } };
      else if (failed.has(p.id)) t = { active: false, cause: { kind: 'start', module: failed.get(p.id)! } };
      else {
        for (const [id, range] of ranges(p.requires)) {
          const q = this.byID.get(id)!;
          if (at(q).active) continue;
          t = { active: false, cause: { kind: 'requires', id, range, present: q.version, state: disabled.has(id) ? 'disabled' : 'off' } };
          break;
        }
        if (t.active && own) t = { active: false, cause: own };
      }
      visiting.delete(p.id);
      out.set(p.id, t);
      return t;
    };
    this.packages.forEach(at);
    return out;
  }

  private statusOf(p: ServerPackage, t: Target): PackageStatus {
    return t.active ? { id: p.id, active: true, modules: describe(p) } : { id: p.id, active: false, reason: reasonOf(t.cause!), modules: describe(p) };
  }

  /** GET /api/extensions: every package of the build, in their declared order. */
  describe(): ExtensionsReply {
    return {
      packages: this.packages.map((p) => {
        const st = this.status.get(p.id)!;
        if (!st.active) return st;
        // Info is read now (a module may only know it once started, e.g. from its provider).
        return { ...st, modules: st.modules.map((d, i) => withInfo(isHidden(p.modules[i]!) ? { ...d, hidden: true as const } : d, p.modules[i]!.info?.())) };
      }),
    };
  }

  isActive(id: string): boolean {
    return !!this.status.get(id)?.active;
  }

  /** The packages that are on now, in start order (not those that failed or went off). */
  private live(): ServerPackage[] {
    return this.topo.filter((p) => this.isActive(p.id));
  }

  /** Modules of the active packages, by type (packages in start order). */
  modules<T extends ModuleType>(type: T): Extract<ServerModule, { type: T }>[] {
    return this.live().flatMap((p) => p.modules.filter((m): m is Extract<ServerModule, { type: T }> => m.type === type));
  }

  /**
   * The modules' APIs, to mount by the app after its own routes: [their mount point, their routes]. Each answers
   * only while its package is on (it may go off and on while the app runs).
   */
  routes(): [string, Hono<Env>][] {
    return this.packages.flatMap((p) =>
      p.modules.flatMap((m): [string, Hono<Env>][] =>
        [...(m.routes ? [[m.id, m.routes] as const] : []), ...Object.entries(m.mounts ?? {})].map(([at, routes]) => {
          const r = new Hono<Env>();
          r.use('*', async (c, next) => (this.isActive(p.id) && !isHidden(m) ? next() : c.json({ error: 'not_found' }, 404)));
          r.route('/', routes);
          return [`/api/${at}`, r];
        }),
      ),
    );
  }

  /**
   * The spaces' device APIs (ServerSpace.bearerRoutes), to mount by the app before its origin check and session
   * guard: [/api/bearer/<id>, routes]. Each answers only while its package is on and its space shown, only to a
   * request with a Bearer header of a sane form (400 bad_token otherwise), with a 64 KB body at most.
   */
  bearerRoutes(): [string, Hono<Env>][] {
    return this.packages.flatMap((p) =>
      p.modules.flatMap((m): [string, Hono<Env>][] => {
        if (m.type !== 'space' || !m.bearerRoutes) return [];
        const r = new Hono<Env>();
        r.use('*', async (c, next) => {
          if (!this.isActive(p.id) || isHidden(m)) return c.json({ error: 'not_found' }, 404);
          if (!BEARER.test(c.req.header('authorization') ?? '')) return c.json({ error: 'bad_token' }, 400);
          const length = Number(c.req.header('content-length') ?? 0);
          if (!(length <= BEARER_BODY_MAX)) return c.json({ error: 'too_large' }, 413);
          await next();
        });
        r.use('*', bodyLimit({ maxSize: BEARER_BODY_MAX, onError: (c) => c.json({ error: 'too_large' }, 413) }));
        r.route('/', m.bearerRoutes);
        return [[`/api/bearer/${m.id}`, r]];
      }),
    );
  }

  /**
   * Whether an API path is a media relay of an active connector (ConnectorShape.mediaRoutes: /api/<id>/<name>
   * or /api/<id>/<name>/<file>), which sets its own sandboxed headers.
   */
  isMediaRoute(path: string): boolean {
    const m = /^\/api\/([a-z][a-z0-9-]{0,31})\/([a-z][a-z0-9-]{0,31})(\/[a-z0-9]{1,16}\.[a-z0-9]{2,5})?$/.exec(path);
    return !!m && this.modules('connector').some((k) => k.id === m[1] && !!k.mediaRoutes?.includes(m[2]!));
  }

  /** Whether a page path is a deep link of an active space (the server then answers with the app). */
  isPage(path: string): boolean {
    return this.modules('space').some((s) => !isHidden(s) && isSpaceLink(s, path));
  }

  /**
   * Whether a page path is the home of a space that opens signed out (ServerSpace.signedOutPage): a static check over
   * the build's packages, on or off, that runs no module code (never `shown`), for a request without a session.
   */
  isSignedOutPage(path: string): boolean {
    return this.packages.some((p) => p.modules.some((m) => m.type === 'space' && m.signedOutPage === true && path === m.path));
  }

  /** Request path as logged: each active module removes its own ids. */
  logPath(path: string): string {
    return this.live().reduce((p, pkg) => pkg.modules.reduce((q, m) => m.logPath?.(q) ?? q, p), path);
  }

  /** The service worker's list of notification targets (imported by sw.js before push-sw.js): the active spaces'. */
  pushLinksScript(): string {
    return pushLinksScript(this.modules('space'));
  }

  /**
   * Why the app cannot run with this build: no connector is on (a messaging client needs a chat source); any one
   * is enough. Null otherwise. server/index.ts exits on it before listening; start() refuses it too.
   */
  startProblem(): string | null {
    return this.problemWith((id) => this.isActive(id));
  }

  private problemWith(active: (id: string) => boolean): string | null {
    // A module named after its package says its reason once ("beeper: token file…", not "beeper: beeper: …").
    const why = (p: ServerPackage) => {
      const r = this.status.get(p.id)?.reason ?? 'off';
      return r.startsWith(`${p.id}: `) ? r.slice(p.id.length + 2) : r;
    };
    if (this.packages.some((p) => active(p.id) && p.modules.some((m) => m.type === 'connector'))) return null;
    const off = this.packages.filter((p) => p.modules.some((m) => m.type === 'connector'));
    if (!off.length) return 'no connector package in the build (ext/packages.server.ts)';
    return `no connector on (${off.map((p) => `${p.id}: ${why(p)}`).join('; ')})`;
  }

  /** Packages that require `id`, directly or not. */
  private dependantsOf(id: string): ServerPackage[] {
    const out = new Set<string>();
    const add = (x: string) => {
      for (const p of this.packages) if (p.requires && Object.hasOwn(p.requires, x) && !out.has(p.id)) (out.add(p.id), add(p.id));
    };
    add(id);
    return this.packages.filter((p) => out.has(p.id));
  }

  /** Packages `id` requires, directly or not. */
  private requirementsOf(id: string): ServerPackage[] {
    const out = new Set<string>();
    const add = (x: string) => {
      for (const [r] of ranges(this.byID.get(x)?.requires)) if (this.byID.has(r) && !out.has(r)) (out.add(r), add(r));
    };
    add(id);
    return this.packages.filter((p) => out.has(p.id));
  }

  /** What turning `id` off turns off with it: itself and the packages that require it and could run. */
  private cascade(id: string): string[] {
    return [id, ...this.dependantsOf(id).filter((p) => !this.broken.has(p.id)).map((p) => p.id)];
  }

  /** Why `id` must stay on: turned off (with what requires it), the app could not run; null when it may go. */
  private keeps(id: string, disabled: ReadonlySet<string> = this.disabled): 'no-connector' | null {
    const now = this.resolve(disabled);
    if (this.problemWith((x) => !!now.get(x)?.active)) return null;
    const after = this.resolve(new Set([...disabled, ...this.cascade(id)]));
    // The last connector on (or what it requires): the app cannot run without one.
    return this.problemWith((x) => !!after.get(x)?.active) ? 'no-connector' : null;
  }

  /** GET /api/extensions/details: everything Settings → Extensions shows, and what each switch may do. */
  details(): ExtensionsDetails {
    const dep = (deps: PackageInfo['requires']): DependencyStatus[] =>
      ranges(deps).map(([id, range]) => {
        const q = this.byID.get(id);
        return { id, range, ...(q ? { present: q.version } : {}), ok: !!q && satisfies(q.version, range) };
      });
    const target = this.resolve();
    return {
      api: EXTENSION_API,
      packages: this.packages.map((p): PackageDetails => {
        const st = this.status.get(p.id)!;
        const cause = st.active ? undefined : target.get(p.id)?.cause;
        const keep = this.keeps(p.id);
        const blocked = [p, ...this.requirementsOf(p.id)].find((q) => this.broken.has(q.id));
        return {
          id: p.id,
          version: p.version,
          klatchly: p.klatchly,
          apiOk: satisfies(EXTENSION_API, p.klatchly),
          ...(p.about ? { about: p.about } : {}),
          state: st.active ? 'on' : this.disabled.has(p.id) ? 'disabled' : 'off',
          ...(cause ? { cause } : {}),
          ...(st.reason ? { reason: st.reason } : {}),
          modules: p.modules.map((m) => ({ type: m.type, id: m.id, ...(m.type === 'augmentation' ? { scope: m.scope } : {}), ...(m.type === 'space' ? { path: m.path } : {}) })),
          ...(p.modules.some((m) => m.type === 'space' && m.chatSources) ? { chatSources: true as const } : {}),
          ...(p.modules.some((m) => m.type === 'space' && m.sends) ? { sends: true as const } : {}),
          ...(p.modules.some((m) => m.type === 'space' && m.bearerRoutes) ? { bearer: true as const } : {}),
          capabilities: capabilitiesOf(p),
          requires: dep(p.requires),
          enhances: dep(p.enhances),
          requiredBy: this.packages.filter((q) => q.requires && Object.hasOwn(q.requires, p.id)).map((q) => q.id),
          enhancedBy: this.packages.filter((q) => q.enhances && Object.hasOwn(q.enhances, p.id)).map((q) => q.id),
          dependants: this.dependantsOf(p.id).filter((q) => this.isActive(q.id)).map((q) => q.id),
          canDisable: !keep,
          ...(keep ? { keep } : {}),
          canEnable: !blocked,
          needs: this.requirementsOf(p.id).filter((q) => this.disabled.has(q.id)).map((q) => q.id),
        };
      }),
    };
  }

  /**
   * Turns a package off or on, server-wide, at once (Settings → Extensions): off takes the packages that require
   * it along (refused for one the app cannot run without); on is refused for a package that cannot run, and, unless
   * `withRequired`, for one that requires a package turned off (`needs`). The choice is saved before it applies.
   */
  setEnabled(id: string, enabled: boolean, opts: { withRequired?: boolean } = {}): Promise<ToggleOutcome> {
    const run = async (): Promise<ToggleOutcome> => {
      if (!this.byID.has(id)) return { ok: false, status: 404, error: 'not_found' };
      const before = new Set(this.disabled);
      if (!enabled) {
        if (this.keeps(id)) return { ok: false, status: 409, error: 'required' };
        for (const x of this.cascade(id)) this.disabled.add(x);
        this.failed.delete(id);
      } else {
        const blocked = [this.byID.get(id)!, ...this.requirementsOf(id)].find((q) => this.broken.has(q.id));
        if (blocked) return { ok: false, status: 409, error: 'cannot_run', cause: this.broken.get(blocked.id)! };
        const needs = this.requirementsOf(id).filter((q) => this.disabled.has(q.id)).map((q) => q.id);
        if (needs.length && !opts.withRequired) return { ok: false, status: 409, error: 'requires_disabled', needs };
        for (const x of [id, ...needs]) this.disabled.delete(x);
        // Turning on again retries a package that failed to start (and what it requires).
        for (const q of [id, ...this.requirementsOf(id).map((r) => r.id)]) this.failed.delete(q);
      }
      const changed = [...new Set([...before].filter((x) => !this.disabled.has(x)).concat([...this.disabled].filter((x) => !before.has(x))))];
      if (!this.save()) {
        this.disabled.clear();
        for (const x of before) this.disabled.add(x);
        return { ok: false, status: 500, error: 'not_saved' };
      }
      if (changed.length || enabled) await this.apply();
      return { ok: true, changed };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private save(): boolean {
    const file = this.opts.stateFile;
    if (!file) return true;
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ disabled: [...this.disabled].sort() }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      return true;
    } catch {
      log('ext', 'state write failed', { file: 'extensions.json' });
      return false;
    }
  }

  /** `host.server`: the app's HTTP server (index.ts), so that a provider's listener address never serves the app. */
  start(host: { server?: Server } = {}): Promise<void> {
    if (!this.starting) {
      const run = async () => {
        const problem = this.startProblem();
        if (problem) {
          log('ext', 'cannot start', { reason: problem });
          throw new Error(problem);
        }
        this.listeners = new Listeners(host.server, this.reserved);
        this.booted = true;
        await this.reconcile();
      };
      this.starting = this.queue.then(run, run);
      this.queue = this.starting.catch(() => {});
    }
    return this.starting;
  }

  /** After a change of choices: statuses, then the modules that must stop or start; the browsers are told. */
  private async apply(): Promise<void> {
    if (this.booted && !this.stopped) await this.reconcile();
    else for (const [id, t] of this.resolve()) this.status.set(id, this.statusOf(this.byID.get(id)!, t));
    broadcast({ type: 'extensions' });
  }

  /**
   * Brings the started modules in line with what should be on. What goes off answers 404 at once (its status),
   * then stops, dependants first; what comes on starts by type (providers, connectors, the rest), in dependency
   * order. A start that fails turns its package off (its started modules stop) and the round runs again.
   */
  private async reconcile(): Promise<void> {
    for (let round = 0; round <= this.packages.length; round++) {
      const want = this.resolve();
      const off = this.topo.filter((p) => !want.get(p.id)!.active);
      for (const p of off) {
        const was = this.status.get(p.id);
        const st = this.statusOf(p, want.get(p.id)!);
        this.status.set(p.id, st);
        if (was?.active) log('ext', 'package off', { id: p.id, reason: st.reason! });
      }
      await this.stopPackages(new Set(off.filter((p) => this.running.has(p.id)).map((p) => p.id)));
      const on = this.topo.filter((p) => want.get(p.id)!.active && !this.running.has(p.id));
      for (const p of on) {
        if (!this.status.get(p.id)?.active) log('ext', 'package on', { id: p.id });
        this.status.set(p.id, this.statusOf(p, { active: true }));
        this.running.add(p.id);
      }
      const order = new Map(this.topo.map((p, i) => [p.id, i]));
      const mods = on
        .flatMap((p) => p.modules.map((m) => ({ p, m })))
        .sort((a, b) => PHASE[a.m.type] - PHASE[b.m.type] || order.get(a.p.id)! - order.get(b.p.id)!);
      let failures = false;
      for (const { p, m } of mods) {
        // A package that failed (or requires one that did) starts no further module.
        if (this.failed.has(p.id) || ranges(p.requires).some(([r]) => this.failed.has(r) || !this.running.has(r))) continue;
        try {
          await m.start?.(this.contextOf(p, m));
          this.started.push({ p, m });
          if (m.type === 'augmentation' && m.scope === 'events') this.subscribe(p, m);
        } catch (e) {
          log('ext', 'start failed', { id: p.id, module: `${m.type}:${m.id}`, err: e instanceof Error ? e.name : '?' });
          this.failed.set(p.id, m.id);
          failures = true;
        }
      }
      if (!failures) return;
    }
  }

  /** Stops the started modules of these packages, last started first, and what the core holds for them. */
  private async stopPackages(ids: ReadonlySet<string>): Promise<void> {
    if (!ids.size) return;
    for (const id of ids) for (const off of this.unsubscribe.get(id)?.splice(0) ?? []) off();
    const list = this.started.filter((x) => ids.has(x.p.id)).reverse();
    this.started = this.started.filter((x) => !ids.has(x.p.id));
    for (const { m } of list) {
      try {
        await m.stop?.();
      } catch {
        log('ext', 'stop failed', { module: `${m.type}:${m.id}` });
      }
    }
    // A connector's badge reseeding and its chats' unread counts go with it (a legacy catch-all's stay: pushwatch.ts).
    // So do its live sessions with the open browsers (their sockets stay, for the other connectors).
    for (const id of ids) {
      for (const m of this.byID.get(id)!.modules) {
        if (m.type !== 'connector') continue;
        sourceOff(m);
        closeLiveOf(m);
      }
    }
    for (const id of ids) {
      await this.listeners?.close(id);
      this.running.delete(id);
    }
  }

  private contextOf(p: ServerPackage, m: ServerModule): ModuleContext {
    const listeners = this.listeners!;
    return {
      ...(m.type === 'augmentation' ? { chats: chatReader(p.id) } : {}),
      ...(m.type === 'augmentation' && m.scope === 'events' ? { actor: chatActor(p.id, () => this.isActive(p.id)) } : {}),
      ...(m.type === 'space' && m.chatSources === true ? { chatSources: chatSources(p.id, () => this.isActive(p.id), (k) => this.ownerOf(k)?.about?.name) } : {}),
      ...(m.type === 'space' && m.sends === true ? { sender: chatSender(p.id, () => this.isActive(p.id)) } : {}),
      ...(m.type === 'provider' ? { listen: (h: string, port: number, handler: RequestListener) => listeners.listen(p.id, h, port, handler) } : {}),
      ...(m.type === 'connector' ? { feed: this.feed(p, m) } : {}),
      provider: <P extends ProviderModule>(id: string) => {
        // Its own, the packages it requires, and those it enhances at a version it works with.
        const from = new Set([p.id, ...ranges(p.requires).map(([r]) => r), ...ranges(p.enhances).filter(([e, range]) => satisfies(this.byID.get(e)?.version ?? '', range)).map(([e]) => e)]);
        const owner = this.live().find((q) => from.has(q.id) && q.modules.some((m) => m.type === 'provider' && m.id === id));
        return owner?.modules.find((m) => m.type === 'provider' && m.id === id) as P | undefined;
      },
      push: (payload) => (this.isActive(p.id) ? pushAll(payload) : Promise.resolve({ sent: 0, failed: 0, skipped: 0 })),
      toBrowsers: (frame) => {
        if (!this.isActive(p.id)) return;
        const t = typeof frame?.type === 'string' ? frame.type : '';
        if (t !== m.id && !t.startsWith(`${m.id}.`)) {
          log('ext', 'frame refused', { id: p.id, module: `${m.type}:${m.id}` });
          return;
        }
        broadcast(frame);
      },
    };
  }

  /** The package of a module of the build. */
  private ownerOf(m: ServerModule): ServerPackage | undefined {
    return this.packages.find((p) => p.modules.includes(m));
  }

  /** A connector's way into the core (ModuleContext.feed), dead once its package is off. */
  private feed(p: ServerPackage, m: ConnectorModule): SourceFeed {
    return {
      event: (ev) => {
        if (this.isActive(p.id)) sourceEvent(m, ev);
      },
      toBrowsers: (frame) => {
        if (!this.isActive(p.id)) return;
        if (!SOURCE_FRAMES.has(typeof frame?.type === 'string' ? frame.type : '')) {
          log('ext', 'frame refused', { id: p.id, module: `${m.type}:${m.id}` });
          return;
        }
        broadcast(frame);
      },
    };
  }

  /** Feeds an 'events' augmentation the stream of new messages, while its package is on. */
  private subscribe(p: ServerPackage, m: Extract<AugmentationModule, { scope: 'events' }>): void {
    let failures = 0;
    const list = this.unsubscribe.get(p.id) ?? [];
    this.unsubscribe.set(p.id, list);
    list.push(
      onChatEvent((ev) => {
        if (!this.isActive(p.id)) return;
        try {
          m.onEvent(ev);
        } catch {
          // Logged a few times, not for every message of a broken handler.
          if (failures++ < 5) log('ext', 'event handler error', { id: p.id, module: `${m.type}:${m.id}` });
        }
      }),
    );
    log('ext', 'events on', { id: p.id, module: `${m.type}:${m.id}` });
  }

  /** Stops what started, in reverse order (after a start or change still under way); nothing starts after. */
  async stop(): Promise<void> {
    const run = async () => {
      this.stopped = true;
      await this.stopPackages(new Set(this.running));
      await this.listeners?.close();
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    await next;
  }
}

/** A space that says it does not show now (ServerSpace.shown); a failing `shown` hides it. */
function isHidden(m: ServerModule): boolean {
  if (m.type !== 'space' || !m.shown) return false;
  try {
    return !m.shown();
  } catch {
    return true;
  }
}

const withInfo = <D extends object>(d: D, info: ModuleInfo | undefined): D => (info && Object.keys(info).length ? { ...d, info } : d);

const describe = (p: ServerPackage) =>
  p.modules.map((m) => (m.type === 'space' ? { type: m.type, id: m.id, path: m.path, ...(m.segment === undefined ? {} : { segment: m.segment }) } : { type: m.type, id: m.id }));

/**
 * The service worker script that lists the spaces' notification targets (served as /push-links.js, see app.ts):
 * each space's path and segment pattern, which push-sw.js checks again and matches as spacePlace does, and its
 * former homes (SpaceInfo.formerPaths), which push-sw.js translates to the same place under the path.
 */
export function pushLinksScript(spaces: readonly SpaceInfo[]): string {
  const list = spaces.map((s) => ({
    path: s.path,
    ...(s.segment === undefined ? {} : { segment: s.segment }),
    ...(s.formerPaths?.length ? { former: [...s.formerPaths] } : {}),
  }));
  return `// Generated by the server (server/registry.ts): notification targets of the spaces of this build.\nself.pushLinks = ${JSON.stringify(list)};\n`;
}
