import { readFileSync } from 'node:fs';
import type { RuntimeAgent } from '#core/sdk.js';
import { agentsLabel } from './label.js';

// The agents manifest: which agents this instance offers, and what Klatchly shows and says about each of them. One
// JSON file named by KLATCHLY_AGENTS_FILE (mounted read-only), the instance's own (private) configuration; the code
// names no agent. Each agent runs on a runtime (the core's AgentRuntime): "hermes" (the hermes package's provider)
// or "llm" (this package's own, on the llm provider: llmruntime.ts). Without the file, each runtime's own list is
// used (KLATCHLY_HERMES_AGENTS, read by the hermes package), as before 1.2, with nothing declared about access or
// disclosure (so the strongest warnings), and KLATCHLY_AGENTS_LABEL / KLATCHLY_AGENTS_OWNER_NAME for the privacy line and
// the owner's name. Agents made in Settings → Agents (llm) come on top of either (llmruntime.ts), with ids of their
// own.
//
// Schema (version 1; example: ext/agents/agents.example.json; docs/self-hosting.md "Agents manifest"):
//
//   {
//     "version": 1,                       required, 1
//     "owner": "Alex",                    optional: on whose behalf an agent writes in a chat (else
//                                         KLATCHLY_AGENTS_OWNER_NAME, else the user's name in that chat)
//     "chatDefault": "chat",              optional: the agent first offered in a chat's Agent panel (else the first
//                                         agent offered in chats with access "limited", else the first offered
//                                         only in chats, else the first offered in chats)
//     "agents": [                         required, 1 to 32 agents, in display order
//       {
//         "id": "chat",                   required: stable id in Klatchly (conversations, chats' settings):
//                                         [a-z0-9][a-z0-9_-]{0,31}; for "llm", [a-z][a-z0-9-]{0,31}. The runtime
//                                         may add rules of its own (Hermes: "default" is its own profile, always
//                                         in the space, never an inbox)
//         "runtime": "hermes",            optional: "hermes" (default) or "llm" (no tools: answers from a model of
//                                         the llm package, chosen in Settings → Default models; chats only)
//         "profile": "chat",              optional: the runtime's name for it; for now it must be the id
//         "instructions": "You are…",     "llm" only, optional: its standing instructions (persona), at most 4000
//         "label": "Agent",               optional: shown name (else the id), at most 40 characters
//         "color": "#2f8a7a",             optional: "#rrggbb" (else a colour picked from the id)
//         "description": {"en": "…"},     optional text: shown under its name (at most 200 characters)
//         "offer": ["space", "chat"],     optional: where it is offered, the Agents space and/or chats' Agent
//                                         panel (default both)
//         "helpers": ["assistant"],       optional: agents it may hand work to when it leads a conversation
//                                         (others of the same runtime offered in the space; not for "llm"; Hermes
//                                         needs the same profiles in its
//                                         delegation.backends.profile_routes)
//         "inbox": "Recaps",              optional: title of the pinned conversation that receives the messages
//                                         it posts itself (needs hermes_inbound_key_<id>); not for "default"
//         "access": "limited",            what the host declares it can reach: "limited" | "extended" | "full".
//                                         Klatchly cannot check it; shown as is. Absent: treated as the strongest
//                                         ("full", with a warning that nothing was declared). Never the reverse.
//                                         "llm": always "limited" (no tools: Klatchly guarantees it), nothing else
//         "accessNote": {"en": "…"},      optional text: what that access means for this agent (at most 120)
//         "disclosure": {"en": "…"}       optional text: where a chat's messages go when it is called (the
//                                         privacy line, "… sent to the agent (<disclosure>) …", at most 200);
//                                         absent: the line says the host did not say
//       }
//     ]
//   }
//
// A text is a string (every language) or an object by language code ({"en": "…", "fr": "…"}), English then the
// first one the fallback. Keys that start with "//" are comments, anywhere, and ignored. Any other unknown key, a
// wrong type or value, a duplicate id, a helper or chatDefault that names no suitable agent is an error: the
// package stays off and Settings → Extensions (and the log) says which field, rather than guess.

export type Access = 'limited' | 'extended' | 'full';
export type Offer = 'space' | 'chat';
/** A text by language code ("en", "fr", "pt-BR"…). A plain string in the file is stored under "en". */
export type LocalText = Readonly<Record<string, string>>;

/** The runtimes a manifest may name: provider ids (hermes), or this package's own (llm). */
export const RUNTIMES = ['hermes', 'llm'] as const;
export type RuntimeName = (typeof RUNTIMES)[number];
/** The runtime of an entry that names none (the manifests of before 2.0 were all Hermes'). */
export const DEFAULT_RUNTIME: RuntimeName = 'hermes';
/** The built-in runtime on the llm provider (llmruntime.ts). */
export const LLM_RUNTIME: RuntimeName = 'llm';
/** An agent as Klatchly knows it: what its runtime reports, and which runtime. */
export type Agent = RuntimeAgent & { runtime: string };

export interface AgentEntry {
  id: string;
  runtime: string;
  /** Standing instructions (llm). */
  instructions: string | null;
  label: string;
  /** "#rrggbb", or null: picked from the id (colorFor). */
  color: string | null;
  description: LocalText | null;
  offer: readonly Offer[];
  helpers: readonly string[];
  inbox: string | null;
  /** null: not declared, shown as the strongest. */
  access: Access | null;
  accessNote: LocalText | null;
  disclosure: LocalText | null;
}

export interface Manifest {
  /** Where it comes from: KLATCHLY_AGENTS_FILE, or KLATCHLY_HERMES_AGENTS (the fallback). */
  source: 'file' | 'env';
  owner: string | null;
  chatDefault: string | null;
  agents: readonly AgentEntry[];
}

export class ManifestError extends Error {}

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LANG = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ACCESS: readonly Access[] = ['limited', 'extended', 'full'];
const OFFERS: readonly Offer[] = ['space', 'chat'];
const MAX_AGENTS = 32;
const MAX_HELPERS = 8;
const TOP_KEYS = new Set(['version', 'owner', 'chatDefault', 'agents']);
const AGENT_KEYS = new Set(['id', 'runtime', 'profile', 'label', 'color', 'description', 'offer', 'helpers', 'inbox', 'access', 'accessNote', 'disclosure', 'instructions']);
/** An id the llm runtime accepts: it names its llm use (agents.<id>). */
export const LLM_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_INSTRUCTIONS = 4000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (where: string, what: string): never => {
  throw new ManifestError(`${where}: ${what}`);
};
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

function checkKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  for (const k of Object.keys(o)) if (!k.startsWith('//') && !allowed.has(k)) fail(where, `unknown key "${k}"`);
}

function str(v: unknown, where: string, max: number): string {
  if (typeof v !== 'string' || !clean(v)) fail(where, 'must be a non-empty string');
  const s = clean(v as string);
  if (s.length > max) fail(where, `at most ${max} characters`);
  return s;
}

/** A text: a string (stored under "en") or {lang: string} with at least one language. */
function localText(v: unknown, where: string, max: number): LocalText {
  if (typeof v === 'string') return { en: str(v, where, max) };
  if (!isObject(v)) fail(where, 'must be a string or an object by language code ({"en": "…"})');
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k.startsWith('//')) continue;
    if (!LANG.test(k)) fail(where, `"${k}" is not a language code`);
    out[k] = str(x, `${where}.${k}`, max);
  }
  if (!Object.keys(out).length) fail(where, 'needs at least one language');
  return out;
}

const optional = <T>(o: Record<string, unknown>, key: string, read: (v: unknown) => T): T | null => (o[key] === undefined || o[key] === null ? null : read(o[key]));

function parseAgent(v: unknown, i: number): AgentEntry {
  let where = `agents[${i}]`;
  if (!isObject(v)) fail(where, 'must be an object');
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id)) fail(`${where}.id`, 'required, lowercase letters, digits, - or _ (at most 32, starting with a letter or digit)');
  const id = o.id as string;
  where = `agents[${i}] (${id})`;
  checkKeys(o, AGENT_KEYS, where);
  if (o.runtime !== undefined && !RUNTIMES.includes(o.runtime as RuntimeName)) fail(`${where}.runtime`, `one of ${RUNTIMES.map((r) => `"${r}"`).join(', ')}`);
  const runtime = (o.runtime as RuntimeName | undefined) ?? DEFAULT_RUNTIME;
  const llm = runtime === LLM_RUNTIME;
  if (o.profile !== undefined && o.profile !== id) fail(`${where}.profile`, 'must be the same as the id for now (a profile under another id is not supported yet)');
  if (llm && !LLM_ID.test(id)) fail(`${where}.id`, 'an "llm" agent: lowercase letters, digits or - (starting with a letter)');
  const offer = optional(o, 'offer', (x) => {
    if (!Array.isArray(x) || !x.length || x.some((e) => !OFFERS.includes(e as Offer))) fail(`${where}.offer`, 'a non-empty list of "space" and/or "chat"');
    return [...new Set(x as Offer[])];
  }) ?? (llm ? ['chat'] : ['space', 'chat']);
  // The llm runtime keeps no conversations (no Agents space), posts nothing itself, hands work to nobody, has no tools.
  if (llm && offer.includes('space')) fail(`${where}.offer`, 'an "llm" agent is offered in chats only (it keeps no conversations)');
  const inbox = optional(o, 'inbox', (x) => str(x, `${where}.inbox`, 60));
  if (inbox && (llm || !offer.includes('space'))) fail(`${where}.inbox`, 'only for an agent offered in the space');
  const helpers = optional(o, 'helpers', (x) => {
    if (!Array.isArray(x) || x.length > MAX_HELPERS || x.some((e) => typeof e !== 'string' || !ID.test(e))) fail(`${where}.helpers`, `a list of agent ids (at most ${MAX_HELPERS})`);
    return [...new Set(x as string[])];
  }) ?? [];
  if (llm && helpers.length) fail(`${where}.helpers`, 'an "llm" agent hands work to nobody');
  if (!llm && o.instructions !== undefined) fail(`${where}.instructions`, 'only for an "llm" agent (a Hermes profile has its own)');
  if (llm && o.access !== undefined && o.access !== 'limited') fail(`${where}.access`, 'an "llm" agent has no tools: "limited" (or nothing)');
  return {
    id,
    runtime,
    instructions: optional(o, 'instructions', (x) => {
      if (typeof x !== 'string' || !x.trim() || x.length > MAX_INSTRUCTIONS) fail(`${where}.instructions`, `a non-empty text of at most ${MAX_INSTRUCTIONS} characters`);
      return (x as string).trim();
    }),
    label: optional(o, 'label', (x) => str(x, `${where}.label`, 40)) ?? id,
    color: optional(o, 'color', (x) => {
      if (typeof x !== 'string' || !COLOR.test(x)) fail(`${where}.color`, 'must be "#rrggbb"');
      return (x as string).toLowerCase();
    }),
    description: optional(o, 'description', (x) => localText(x, `${where}.description`, 200)),
    offer,
    helpers,
    inbox,
    access: llm
      ? 'limited'
      : optional(o, 'access', (x) => {
          if (!ACCESS.includes(x as Access)) fail(`${where}.access`, 'must be "limited", "extended" or "full"');
          return x as Access;
        }),
    accessNote: optional(o, 'accessNote', (x) => localText(x, `${where}.accessNote`, 120)),
    disclosure: optional(o, 'disclosure', (x) => localText(x, `${where}.disclosure`, 200)),
  };
}

/** The manifest's text (JSON) -> its agents, or a ManifestError naming the first wrong field. */
export function parseManifest(raw: string): Manifest {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new ManifestError(`not valid JSON (${e instanceof Error ? e.message : 'parse error'})`);
  }
  if (!isObject(v)) fail('manifest', 'must be a JSON object');
  const o = v as Record<string, unknown>;
  checkKeys(o, TOP_KEYS, 'manifest');
  if (o.version !== 1) fail('version', 'required, 1');
  if (!Array.isArray(o.agents) || !o.agents.length || o.agents.length > MAX_AGENTS) fail('agents', `required, a list of 1 to ${MAX_AGENTS} agents`);
  const agents = (o.agents as unknown[]).map(parseAgent);
  const ids = new Set<string>();
  for (const a of agents) {
    if (ids.has(a.id)) fail(`agents (${a.id})`, 'duplicate id');
    ids.add(a.id);
  }
  for (const a of agents)
    for (const h of a.helpers) {
      const helper = agents.find((x) => x.id === h);
      if (h === a.id || !helper || !helper.offer.includes('space') || helper.runtime !== a.runtime) fail(`agents (${a.id}).helpers`, `"${h}" must be another agent of this manifest, on the same runtime, offered in the space`);
    }
  const chatDefault = optional(o, 'chatDefault', (x) => {
    if (typeof x !== 'string' || !agents.some((a) => a.id === x && a.offer.includes('chat'))) fail('chatDefault', 'must be the id of an agent offered in chats');
    return x as string;
  });
  return { source: 'file', owner: optional(o, 'owner', (x) => str(x, 'owner', 60)), chatDefault, agents };
}

/** KLATCHLY_AGENTS_FILE, read now. A YAML file is refused for now (no YAML parser in the server). */
export function readManifest(file: string): Manifest {
  if (/\.ya?ml$/i.test(file)) throw new ManifestError('YAML is not supported yet: write the manifest as JSON');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ManifestError(`cannot read the file (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  return parseManifest(raw);
}

// ── The manifest in use ──────────────────────────────────────────────────────

const FILE = () => (process.env.KLATCHLY_AGENTS_FILE ?? '').trim();
let fromFile: Manifest | null = null;
let forTests: Manifest | null | undefined;

/**
 * Reads KLATCHLY_AGENTS_FILE again (the package's check and start): its manifest, null when unset (the fallback), or
 * a ManifestError whose message says what is wrong (the reason the package is off).
 */
export function loadManifest(): Manifest | null {
  if (forTests !== undefined) return (fromFile = forTests);
  const file = FILE();
  if (!file) return (fromFile = null);
  try {
    return (fromFile = readManifest(file));
  } catch (e) {
    fromFile = null;
    throw new ManifestError(`KLATCHLY_AGENTS_FILE: ${(e as Error).message}`);
  }
}

/** Tests: a manifest in place of KLATCHLY_AGENTS_FILE (undefined: the file again). */
export function setManifestForTests(m: Manifest | null | undefined): void {
  forTests = m;
  fromFile = m ?? null;
}

/** The manifest loaded from KLATCHLY_AGENTS_FILE at start, or null (the fallback). */
export const fileManifest = (): Manifest | null => fromFile;

/** What a runtime is given (AgentRuntime.configure): the manifest's agents on it. */
export function forRuntime(m: Manifest, runtime: string): RuntimeAgent[] {
  return m.agents
    .filter((a) => a.runtime === runtime)
    .map((a) => ({
      id: a.id,
      label: a.label,
      description: a.description ? textIn(a.description, 'en') : null,
      helpers: [...a.helpers],
      space: a.offer.includes('space'),
      inbox: a.inbox,
      instructions: a.instructions,
    }));
}

/** An entry for an agent the manifest does not name: what its runtime knows, nothing declared. */
function bare(a: Agent, offer: readonly Offer[], disclosure: LocalText | null): AgentEntry {
  return {
    id: a.id,
    runtime: a.runtime,
    instructions: a.instructions,
    label: a.label,
    color: null,
    description: a.description ? { en: a.description } : null,
    offer,
    helpers: a.helpers,
    inbox: a.inbox,
    access: null,
    accessNote: null,
    disclosure,
  };
}

/**
 * The fallback (no KLATCHLY_AGENTS_FILE): the runtimes' own agents (KLATCHLY_HERMES_AGENTS), every one offered in chats as
 * before, nothing declared about access, KLATCHLY_AGENTS_LABEL as every agent's disclosure.
 */
export function fromRuntimes(list: readonly Agent[]): Manifest {
  const disclosure = agentsLabel();
  return { source: 'env', owner: null, chatDefault: null, agents: list.map((a) => bare(a, a.space ? ['space', 'chat'] : ['chat'], disclosure)) };
}

/** The manifest in use: the file's, else the fallback built from the runtimes' agents. */
export const manifestOf = (list: readonly Agent[]): Manifest => fromFile ?? fromRuntimes(list);

/** Entries of agents that are not the manifest's (made in Settings → Agents (llm)): set by llmruntime.ts. */
let extraEntry: (a: Agent) => AgentEntry | null = () => null;
export function setExtraEntries(f: ((a: Agent) => AgentEntry | null) | undefined): void {
  extraEntry = f ?? (() => null);
}

/**
 * An agent's entry: the file's, else one made in Settings, else (an agent its runtime added: Hermes' own when the
 * file omits it, or the fallback's) what the runtime knows: offered where it says, nothing declared.
 */
export function entryOf(m: Manifest, a: Agent): AgentEntry {
  if (m.source === 'file') return m.agents.find((x) => x.id === a.id) ?? extraEntry(a) ?? bare(a, a.space ? ['space'] : [], null);
  return extraEntry(a) ?? m.agents.find((x) => x.id === a.id) ?? bare(a, a.space ? ['space'] : [], null);
}

/** The agent first offered in a chat, among those offered there (ids in display order). */
export function chatDefaultOf(m: Manifest, offered: readonly AgentEntry[]): string | null {
  if (m.chatDefault && offered.some((a) => a.id === m.chatDefault)) return m.chatDefault;
  return (offered.find((a) => a.access === 'limited') ?? offered.find((a) => !a.offer.includes('space')) ?? offered[0])?.id ?? null;
}

/** A text in a language: that one, else English, else the first. */
export function textIn(t: LocalText, lang: string): string {
  return t[lang] ?? t.en ?? Object.values(t)[0]!;
}
