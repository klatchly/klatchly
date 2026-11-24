import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dataPath, log } from '#core/sdk.js';
import { isKind, KIND_INFO, SERVER_PROVIDER, type ProviderKind } from '../kinds.js';

// The providers (Settings → Providers) and the models chosen per use (Settings → Default models), in the data
// volume: llm.json (0600) the settings, llm-keys.json (0600) the keys of the providers added there, apart so that
// no view of the settings ever holds one. The server's provider ('env') comes from the environment at each start
// (KLATCHLY_LLM_URL, KLATCHLY_LLM_MODEL, KLATCHLY_LLM_FALLBACK, KLATCHLY_LLM_LABEL, KLATCHLY_LLM_KEY_FILE): only its name and its
// enabled models are kept here; its address and key stay the server's (its key stays in its file).
//
// A use's route is kept only when it differs from the defaults (the server's KLATCHLY_LLM_MODEL and fallback), so a
// new default takes effect for the uses left on it, as before 1.1. `seen` lists the uses that registered once: a
// use's legacy route (from before 1.1) is adopted on its first registration only.

export interface Ref {
  provider: string;
  model: string;
}
export interface StoredRoute {
  model: Ref;
  fallback: Ref | null;
}

/** A provider as the calls and the settings see it (never its key: `key()` reads it when a call needs it). */
export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  /** Base URL, …/v1, no trailing slash. */
  url: string;
  /** Enabled model ids; null: every model the provider lists (the server's, until the user picks). */
  models: string[] | null;
  /** The server's configuration (KLATCHLY_LLM_*): address and key not editable, never removed. */
  fromServer: boolean;
  key(): string | null;
}

interface StoredProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  url: string;
  models: string[] | null;
}
interface Saved {
  providers: StoredProvider[];
  server: { name?: string; models: string[] | null };
  routes: Record<string, StoredRoute>;
  seen: string[];
}

export const MAX_PROVIDERS = 20;
export const MAX_ENABLED = 300;
export const MAX_NAME = 40;

export const validModelId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(v);
export const validProviderId = (v: unknown): v is string => typeof v === 'string' && (v === SERVER_PROVIDER || /^p-[a-z0-9]{8}$/.test(v));
export const validUseId = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/.test(v);

/** A provider's name: trimmed, 1 to MAX_NAME characters, no control character; null otherwise. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && [...s].length <= MAX_NAME && !/\p{Cc}/u.test(s) ? s : null;
}

/**
 * A provider's base URL: http or https, a host, no credentials, query or fragment (the key goes in a header, never
 * in the URL); returned without its trailing slashes. Null otherwise.
 */
export function cleanUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password || u.search || u.hash) return null;
  return u.href.replace(/\/+$/, '');
}

/** A key as a header may carry it: printable ASCII, no space, at most 1000 characters. */
export const validKey = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,1000}$/.test(v);

// ── The server's provider (environment) ──────────────────────────────────

export const env = () => ({
  url: process.env.KLATCHLY_LLM_URL ?? '',
  model: process.env.KLATCHLY_LLM_MODEL ?? '',
  fallback: process.env.KLATCHLY_LLM_FALLBACK || null,
  keyFile: process.env.KLATCHLY_LLM_KEY_FILE ?? '/run/secrets/llm_key',
});

let envKey: string | null | undefined;
/** The server's key, from KLATCHLY_LLM_KEY_FILE (read once). */
export function serverKey(): string | null {
  if (envKey === undefined) {
    try {
      envKey = readFileSync(env().keyFile, 'utf8').trim() || null;
    } catch {
      envKey = null;
    }
  }
  return envKey;
}
/** Tests: the server's key (null: none; undefined: read the file again). */
export function setServerKey(k: string | null | undefined): void {
  envKey = k;
}

/** Which kind the server's endpoint looks like (only for what the page shows: every kind calls the same way). */
function guessKind(url: string): ProviderKind {
  const host = new URL(url).hostname;
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
  return /9router/i.test(host) ? '9router' : 'openai';
}

function serverProvider(s: Saved): Provider | null {
  const url = cleanUrl(env().url);
  if (!url) return null;
  return {
    id: SERVER_PROVIDER,
    kind: guessKind(url),
    // Its host by default ("9router" for http://9router:20128/v1).
    name: s.server.name ?? new URL(url).hostname,
    url,
    models: s.server.models,
    fromServer: true,
    key: serverKey,
  };
}

// ── Files ─────────────────────────────────────────────────────────────────

let saved: Saved | undefined;
let keys: Record<string, string> | undefined;

const empty = (): Saved => ({ providers: [], server: { models: null }, routes: {}, seen: [] });

/**
 * A file of the store, parsed; undefined when it does not exist (first run). Anything else (unreadable, not JSON)
 * is set aside as <name>.bad-<time> and logged before starting empty: a later save never overwrites it silently.
 */
function readJson(name: string): unknown {
  const file = dataPath(name);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = `${name}.bad-${stamp}`;
    try {
      renameSync(file, `${file}.bad-${stamp}`);
    } catch {
      // left in place: still logged
    }
    log('llm', 'store unreadable, set aside, starting empty', { file: name, aside });
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const modelList = (v: unknown): string[] | null => (Array.isArray(v) ? [...new Set(v.filter(validModelId))].slice(0, MAX_ENABLED) : null);
const ref = (v: unknown): Ref | null => (isObj(v) && validProviderId(v.provider) && validModelId(v.model) ? { provider: v.provider, model: v.model } : null);

/** llm.json, validated: what is malformed is dropped. */
function data(): Saved {
  if (saved) return saved;
  const s = empty();
  const raw = readJson('llm.json');
  if (isObj(raw)) {
    for (const p of Array.isArray(raw.providers) ? raw.providers : []) {
      if (!isObj(p) || !validProviderId(p.id) || p.id === SERVER_PROVIDER || !isKind(p.kind)) continue;
      const name = cleanName(p.name);
      const url = cleanUrl(p.url);
      if (name && url && !s.providers.some((x) => x.id === p.id) && s.providers.length < MAX_PROVIDERS) s.providers.push({ id: p.id, kind: p.kind, name, url, models: modelList(p.models) });
    }
    if (isObj(raw.server)) s.server = { ...(cleanName(raw.server.name) ? { name: cleanName(raw.server.name)! } : {}), models: modelList(raw.server.models) };
    if (isObj(raw.routes))
      for (const [use, r] of Object.entries(raw.routes)) {
        const model = isObj(r) ? ref(r.model) : null;
        if (validUseId(use) && model && isObj(r)) s.routes[use] = { model, fallback: ref(r.fallback) };
      }
    if (Array.isArray(raw.seen)) s.seen = [...new Set(raw.seen.filter(validUseId))];
  }
  saved = s;
  return s;
}

function keyData(): Record<string, string> {
  if (keys) return keys;
  const raw = readJson('llm-keys.json');
  keys = {};
  if (isObj(raw)) for (const [id, k] of Object.entries(raw)) if (validProviderId(id) && id !== SERVER_PROVIDER && validKey(k)) keys[id] = k;
  return keys;
}

/** Written whole, through a temporary file, 0600 (its mode set before it takes the name). False when it failed. */
function write(name: string, value: unknown): boolean {
  const file = dataPath(name);
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    return true;
  } catch {
    log('llm', 'store write failed', { file: name });
    return false;
  }
}

/**
 * Saves the settings (and the keys when they changed). On a failure the change is undone in memory (both files read
 * again) and 'store_failed' returned: what is used is always what is on disk.
 */
function commit(withKeys = false): Problem | null {
  if ((!withKeys || write('llm-keys.json', keyData())) && write('llm.json', data())) return null;
  resetStore();
  return 'store_failed';
}

/** Tests: forget what was read (the files are read again). */
export function resetStore(): void {
  saved = undefined;
  keys = undefined;
}

// ── Providers ─────────────────────────────────────────────────────────────

export function providers(): Provider[] {
  const s = data();
  const server = serverProvider(s);
  const own = s.providers.map(
    (p): Provider => ({ ...p, models: p.models ? [...p.models] : null, fromServer: false, key: () => keyData()[p.id] ?? null }),
  );
  return server ? [server, ...own] : own;
}

export const provider = (id: string): Provider | undefined => providers().find((p) => p.id === id);

/** Whether a provider has a key (the settings show "key set", never the key). */
export const hasKey = (p: Provider): boolean => !!p.key();

function newId(): string {
  const taken = new Set(providers().map((p) => p.id));
  for (;;) {
    const id = `p-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
    if (!taken.has(id)) return id;
  }
}

export type Problem = 'bad_request' | 'too_many' | 'key_required' | 'key_reentry' | 'server_provider' | 'not_found' | 'store_failed';

export interface NewProvider {
  kind: ProviderKind;
  name: string;
  url: string;
  key: string | null;
}

/** Adds a provider (no model enabled yet); its id, or what is wrong. */
export function addProvider(p: NewProvider): { id: string } | { error: Problem } {
  const s = data();
  if (s.providers.length >= MAX_PROVIDERS) return { error: 'too_many' };
  if (KIND_INFO[p.kind].keyRequired && !p.key) return { error: 'key_required' };
  const id = newId();
  s.providers.push({ id, kind: p.kind, name: p.name, url: p.url, models: [] });
  if (p.key) keyData()[id] = p.key;
  const failed = commit(true);
  return failed ? { error: failed } : { id };
}

export interface ProviderChanges {
  name?: string;
  url?: string;
  /** A new key, or null to clear it. */
  key?: string | null;
}

/** The server's provider takes a name only (its address and key are the server's). */
export function updateProvider(id: string, ch: ProviderChanges): Problem | null {
  const s = data();
  if (id === SERVER_PROVIDER) {
    if (!serverProvider(s)) return 'not_found';
    if (ch.url !== undefined || ch.key !== undefined) return 'server_provider';
    if (ch.name !== undefined) s.server.name = ch.name;
    return commit();
  }
  const p = s.providers.find((x) => x.id === id);
  if (!p) return 'not_found';
  // Another origin (host, scheme or port: https to http would send the key in clear) and no new key: the stored key
  // is dropped, never sent there (a kind that needs one: type it again).
  const moved = ch.url !== undefined && new URL(ch.url).origin !== new URL(p.url).origin;
  const newKey = ch.key !== undefined ? ch.key : moved ? null : undefined;
  if (moved && ch.key === undefined && keyData()[id] && KIND_INFO[p.kind].keyRequired) return 'key_reentry';
  const key = newKey === undefined ? (keyData()[id] ?? null) : newKey;
  if (KIND_INFO[p.kind].keyRequired && !key) return 'key_required';
  if (ch.name !== undefined) p.name = ch.name;
  if (ch.url !== undefined) p.url = ch.url;
  if (newKey !== undefined) {
    if (newKey) keyData()[id] = newKey;
    else delete keyData()[id];
  }
  return commit(newKey !== undefined);
}

/** Removes a provider and its key; the uses that chose one of its models go back to the defaults. */
export function removeProvider(id: string): Problem | null {
  const s = data();
  if (id === SERVER_PROVIDER) return 'server_provider';
  const at = s.providers.findIndex((x) => x.id === id);
  if (at < 0) return 'not_found';
  s.providers.splice(at, 1);
  for (const [use, r] of Object.entries(s.routes)) {
    if (r.model.provider === id) delete s.routes[use];
    else if (r.fallback?.provider === id) r.fallback = null;
  }
  delete keyData()[id];
  return commit(true);
}

/** The enabled models of a provider (null: all it lists; only the server's may go back to that). */
export function setModels(id: string, models: string[] | null): Problem | null {
  const s = data();
  if (models && (models.length > MAX_ENABLED || !models.every(validModelId))) return 'bad_request';
  const list = models ? [...new Set(models)] : null;
  if (id === SERVER_PROVIDER) {
    if (!serverProvider(s)) return 'not_found';
    s.server.models = list;
  } else {
    const p = s.providers.find((x) => x.id === id);
    if (!p) return 'not_found';
    p.models = list ?? [];
  }
  return commit();
}

// ── Routes per use ────────────────────────────────────────────────────────

/** The defaults: the server's model and fallback, while it has a provider and a model. */
export function defaultRoute(): StoredRoute | null {
  const { model, fallback } = env();
  if (!serverProvider(data()) || !validModelId(model)) return null;
  return { model: { provider: SERVER_PROVIDER, model }, fallback: fallback && fallback !== model && validModelId(fallback) ? { provider: SERVER_PROVIDER, model: fallback } : null };
}

export const sameRef = (a: Ref | null, b: Ref | null): boolean => (a === null || b === null ? a === b : a.provider === b.provider && a.model === b.model);
const sameRoute = (a: StoredRoute | null, b: StoredRoute | null) => (a === null || b === null ? a === b : sameRef(a.model, b.model) && sameRef(a.fallback, b.fallback));

/** A use's models: its choice, else the defaults (null: none at all). */
export const routeOf = (use: string): StoredRoute | null => data().routes[use] ?? defaultRoute();
export const isDefault = (use: string): boolean => !data().routes[use];

/** Sets a use's models (null: back to the defaults). A choice equal to the defaults is not kept. */
export function setRoute(use: string, r: StoredRoute | null): Problem | null {
  const s = data();
  const fallback = r?.fallback && !sameRef(r.fallback, r.model) ? r.fallback : null;
  const next = r ? { model: r.model, fallback } : null;
  if (!next || sameRoute(next, defaultRoute())) delete s.routes[use];
  else s.routes[use] = next;
  return commit();
}

/**
 * A use registers: the first time ever, its legacy route (model ids of the server's endpoint, from before 1.1)
 * becomes its choice. Returns whether it was adopted.
 */
export function firstSeen(use: string, legacy: { model: string; fallback?: string | null } | null | undefined): boolean {
  const s = data();
  if (s.seen.includes(use)) return false;
  s.seen.push(use);
  let adopted = false;
  if (legacy && validModelId(legacy.model) && !s.routes[use]) {
    const fb = legacy.fallback && legacy.fallback !== legacy.model && validModelId(legacy.fallback) ? legacy.fallback : null;
    const r: StoredRoute = { model: { provider: SERVER_PROVIDER, model: legacy.model }, fallback: fb ? { provider: SERVER_PROVIDER, model: fb } : null };
    if (!sameRoute(r, defaultRoute())) {
      s.routes[use] = r;
      adopted = true;
    }
  }
  // Not saved: the use is seen again at the next start (and its legacy route adopted then).
  if (commit()) return false;
  return adopted;
}
