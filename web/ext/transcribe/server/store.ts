import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dataPath, log } from '#core/sdk.js';
import { defaultModel, isKind, needsLanguage, RIVA_DEFAULT_MODEL, RIVA_HOSTED, SERVER_PROVIDER, validLanguage, validModel, type ProviderKind } from '../kinds.js';

// The providers (Settings → Transcription), the default one, and the transcripts, in the data volume:
// transcribe.json (0600) the settings, transcribe-keys.json (0600) the keys of the providers added there (apart, so
// that no view of the settings ever holds one), transcripts.json (0600) the texts shown under the voice notes. The
// server's provider ('env') comes from the environment at each start (KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE,
// KLATCHLY_TRANSCRIBE_NVIDIA_MODEL, KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE): only its name, model and language chosen in Settings
// are kept here; its key stays in its file.

/** A provider as the calls and the settings see it (never its key: `key()` reads it when a call needs it). */
export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  /** Riva: its endpoint, 'https://host:port' (TLS) or 'http://host:port'; openai: its base URL (…/v1, no trailing slash). */
  url: string;
  /** Riva: a preset id or an NVCF function id; openai: a model id. */
  model: string;
  /** '' : automatic. */
  language: string;
  fromServer: boolean;
  key(): string | null;
}

interface StoredProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  url: string;
  model: string;
  language: string;
}
interface Saved {
  providers: StoredProvider[];
  server: { name?: string; model?: string; language?: string };
  /** The default provider; null: the first one. */
  default: string | null;
}

export const MAX_PROVIDERS = 10;
export const MAX_NAME = 40;

export const validProviderId = (v: unknown): v is string => typeof v === 'string' && (v === SERVER_PROVIDER || /^p-[a-z0-9]{8}$/.test(v));

/** A provider's name: trimmed, 1 to MAX_NAME characters, no control character; null otherwise. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && [...s].length <= MAX_NAME && !/\p{Cc}/u.test(s) ? s : null;
}

function parseUrl(v: unknown): URL | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v.trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password || u.search || u.hash) return null;
    return u;
  } catch {
    return null;
  }
}

/** An OpenAI-compatible base URL: http(s), a host, no credentials, query or fragment; without its trailing slashes. */
export function cleanUrl(v: unknown): string | null {
  const u = parseUrl(v);
  return u ? u.href.replace(/\/+$/, '') : null;
}

/** A Riva endpoint: 'https://host[:port]' or 'http://host:port', no path; returned with its port. Null otherwise. */
export function cleanEndpoint(v: unknown): string | null {
  const u = parseUrl(v);
  if (!u || (u.pathname !== '/' && u.pathname !== '')) return null;
  return `${u.protocol}//${u.hostname.includes(':') ? `[${u.hostname.replace(/^\[|\]$/g, '')}]` : u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
}

export const cleanAddress = (kind: ProviderKind, v: unknown): string | null => (kind === 'nvidia-riva' ? cleanEndpoint(v) : cleanUrl(v));

/** A key as a header may carry it: printable ASCII, no space, at most 1000 characters. */
export const validKey = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,1000}$/.test(v);

// ── The server's provider (environment) ──────────────────────────────────

export const env = () => ({
  keyFile: process.env.KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE ?? '',
  model: process.env.KLATCHLY_TRANSCRIBE_NVIDIA_MODEL || RIVA_DEFAULT_MODEL,
  language: process.env.KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE ?? '',
});

let envKey: string | null | undefined;
/** The server's key, from KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE (read once); null without the variable or the file. */
export function serverKey(): string | null {
  if (envKey === undefined) {
    const file = env().keyFile;
    try {
      envKey = file ? readFileSync(file, 'utf8').trim() || null : null;
    } catch {
      envKey = null;
    }
    if (envKey && !validKey(envKey)) envKey = null;
  }
  return envKey;
}
/** Tests: the server's key (null: none; undefined: read the file again). */
export function setServerKey(k: string | null | undefined): void {
  envKey = k;
}

function serverProvider(s: Saved): Provider | null {
  const e = env();
  if (!e.keyFile || !validModel('nvidia-riva', e.model) || !validLanguage(e.language)) return null;
  const model = s.server.model ?? e.model;
  return {
    id: SERVER_PROVIDER,
    kind: 'nvidia-riva',
    name: s.server.name ?? 'NVIDIA',
    url: RIVA_HOSTED,
    model,
    language: s.server.language ?? e.language,
    fromServer: true,
    key: serverKey,
  };
}

// ── Files ─────────────────────────────────────────────────────────────────

let saved: Saved | undefined;
let keys: Record<string, string> | undefined;

const empty = (): Saved => ({ providers: [], server: {}, default: null });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

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
    try {
      renameSync(file, `${file}.bad-${stamp}`);
    } catch {
      // left in place: still logged
    }
    log('transcribe', 'store unreadable, set aside, starting empty', { file: name });
    return undefined;
  }
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
    log('transcribe', 'store write failed', { file: name });
    return false;
  }
}

function data(): Saved {
  if (saved) return saved;
  const s = empty();
  const raw = readJson('transcribe.json');
  if (isObj(raw)) {
    for (const p of Array.isArray(raw.providers) ? raw.providers : []) {
      if (!isObj(p) || !validProviderId(p.id) || p.id === SERVER_PROVIDER || !isKind(p.kind)) continue;
      const name = cleanName(p.name);
      const url = cleanAddress(p.kind, p.url);
      const model = validModel(p.kind, p.model) ? p.model : defaultModel(p.kind);
      const language = validLanguage(p.language) ? p.language : '';
      if (name && url && !s.providers.some((x) => x.id === p.id) && s.providers.length < MAX_PROVIDERS) s.providers.push({ id: p.id, kind: p.kind, name, url, model, language });
    }
    if (isObj(raw.server)) {
      const n = cleanName(raw.server.name);
      if (n) s.server.name = n;
      if (validModel('nvidia-riva', raw.server.model)) s.server.model = raw.server.model;
      if (validLanguage(raw.server.language)) s.server.language = raw.server.language;
    }
    if (validProviderId(raw.default)) s.default = raw.default;
  }
  saved = s;
  return s;
}

function keyData(): Record<string, string> {
  if (keys) return keys;
  const raw = readJson('transcribe-keys.json');
  keys = {};
  if (isObj(raw)) for (const [id, k] of Object.entries(raw)) if (validProviderId(id) && id !== SERVER_PROVIDER && validKey(k)) keys[id] = k;
  return keys;
}

export type Problem = 'bad_request' | 'too_many' | 'key_required' | 'key_reentry' | 'server_provider' | 'not_found' | 'language_required' | 'store_failed';

/** Saves the settings (and the keys when they changed); on a failure both are read again: what is used is on disk. */
function commit(withKeys = false): Problem | null {
  if ((!withKeys || write('transcribe-keys.json', keyData())) && write('transcribe.json', data())) return null;
  resetStore();
  return 'store_failed';
}

/** Tests: forget what was read (the files are read again). */
export function resetStore(): void {
  saved = undefined;
  keys = undefined;
  transcripts = undefined;
}

// ── Providers ─────────────────────────────────────────────────────────────

export function providers(): Provider[] {
  const s = data();
  const server = serverProvider(s);
  const own = s.providers.map((p): Provider => ({ ...p, fromServer: false, key: () => keyData()[p.id] ?? null }));
  return server ? [server, ...own] : own;
}

export const provider = (id: string): Provider | undefined => providers().find((p) => p.id === id);
export const hasKey = (p: Provider): boolean => !!p.key();

/** The default provider: the one chosen, else the first (the server's when there is one); undefined: none. */
export function defaultProvider(): Provider | undefined {
  const all = providers();
  const d = data().default;
  return (d ? all.find((p) => p.id === d) : undefined) ?? all[0];
}
export const chosenDefault = (): string | null => data().default;

/** Riva needs a key on NVIDIA's hosted endpoint; elsewhere (a self-hosted server) a key is optional. */
export const keyRequired = (kind: ProviderKind, url: string): boolean => kind === 'nvidia-riva' && /^https:\/\/[^/]*\.nvidia\.com:/.test(url);

function newId(): string {
  const taken = new Set(providers().map((p) => p.id));
  for (;;) {
    const id = `p-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
    if (!taken.has(id)) return id;
  }
}

export interface NewProvider {
  kind: ProviderKind;
  name: string;
  url: string;
  key: string | null;
  model: string;
  language: string;
}

export function addProvider(p: NewProvider): { id: string } | { error: Problem } {
  const s = data();
  if (s.providers.length >= MAX_PROVIDERS) return { error: 'too_many' };
  if (keyRequired(p.kind, p.url) && !p.key) return { error: 'key_required' };
  if (needsLanguage(p.kind, p.model) && !p.language) return { error: 'language_required' };
  const id = newId();
  s.providers.push({ id, kind: p.kind, name: p.name, url: p.url, model: p.model, language: p.language });
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

/** Where the sound goes and with which key (step-up). The server's provider takes a name only. */
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
  // is dropped, never sent there (one that needs a key: type it again).
  const moved = ch.url !== undefined && new URL(ch.url).origin !== new URL(p.url).origin;
  const url = ch.url ?? p.url;
  if (moved && ch.key === undefined && keyData()[id] && keyRequired(p.kind, url)) return 'key_reentry';
  const newKey = ch.key !== undefined ? ch.key : moved ? null : undefined;
  const key = newKey === undefined ? (keyData()[id] ?? null) : newKey;
  if (keyRequired(p.kind, url) && !key) return 'key_required';
  if (ch.name !== undefined) p.name = ch.name;
  p.url = url;
  if (newKey !== undefined) {
    if (newKey) keyData()[id] = newKey;
    else delete keyData()[id];
  }
  return commit(newKey !== undefined);
}

/** Which model and language a provider uses (no step-up: it changes neither where the sound goes nor the key). */
export function setModel(id: string, model: string, language: string): Problem | null {
  const s = data();
  const p = id === SERVER_PROVIDER ? serverProvider(s) : s.providers.find((x) => x.id === id);
  if (!p) return 'not_found';
  if (!validModel(p.kind, model) || !validLanguage(language)) return 'bad_request';
  if (needsLanguage(p.kind, model) && !language) return 'language_required';
  if (id === SERVER_PROVIDER) {
    const e = env();
    // Kept only when it differs from the server's configuration (a new default then applies).
    if (model === e.model) delete s.server.model;
    else s.server.model = model;
    if (language === e.language && model === e.model) delete s.server.language;
    else s.server.language = language;
  } else {
    const own = s.providers.find((x) => x.id === id)!;
    own.model = model;
    own.language = language;
  }
  return commit();
}

export function removeProvider(id: string): Problem | null {
  const s = data();
  if (id === SERVER_PROVIDER) return 'server_provider';
  const at = s.providers.findIndex((x) => x.id === id);
  if (at < 0) return 'not_found';
  s.providers.splice(at, 1);
  if (s.default === id) s.default = null;
  delete keyData()[id];
  return commit(true);
}

/** The default provider (null: the first one). */
export function setDefault(id: string | null): Problem | null {
  if (id !== null && !provider(id)) return 'not_found';
  data().default = id;
  return commit();
}

// ── Transcripts ───────────────────────────────────────────────────────────

/** A transcript kept for a voice note: its text, the language detected, the provider, when. */
export interface Kept {
  text: string;
  language?: string;
  provider: string;
  at: number;
}

export const MAX_KEPT = 5000;
let transcripts: Map<string, Kept> | undefined;
const keyOf = (chatID: string, messageID: string, index: number) => `${chatID}\n${messageID}\n${index}`;

function kept(): Map<string, Kept> {
  if (transcripts) return transcripts;
  transcripts = new Map();
  const raw = readJson('transcripts.json');
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !isObj(e[1])) continue;
    const v = e[1];
    if (typeof v.text !== 'string' || typeof v.provider !== 'string' || typeof v.at !== 'number') continue;
    transcripts.set(e[0], { text: v.text, provider: v.provider, at: v.at, ...(typeof v.language === 'string' && validLanguage(v.language) ? { language: v.language } : {}) });
  }
  return transcripts;
}

const saveKept = (): boolean => write('transcripts.json', [...kept()]);

export const transcriptOf = (chatID: string, messageID: string, index: number): Kept | undefined => kept().get(keyOf(chatID, messageID, index));

/** Keeps a transcript (the oldest dropped past MAX_KEPT). */
export function keepTranscript(chatID: string, messageID: string, index: number, t: Omit<Kept, 'at'>): void {
  const m = kept();
  const k = keyOf(chatID, messageID, index);
  m.delete(k);
  m.set(k, { ...t, at: Date.now() });
  while (m.size > MAX_KEPT) m.delete(m.keys().next().value!);
  saveKept();
}

export function forgetTranscript(chatID: string, messageID: string, index: number): boolean {
  const ok = kept().delete(keyOf(chatID, messageID, index));
  if (ok) saveKept();
  return ok;
}

/** A chat's transcripts, by '<message id>/<index>'. */
export function transcriptsFor(chatID: string): Record<string, { text: string; language?: string }> {
  const out: Record<string, { text: string; language?: string }> = {};
  const prefix = `${chatID}\n`;
  for (const [k, v] of kept()) {
    if (!k.startsWith(prefix)) continue;
    const [messageID, index] = k.slice(prefix.length).split('\n');
    out[`${messageID}/${index}`] = { text: v.text, ...(v.language ? { language: v.language } : {}) };
  }
  return out;
}

export const transcriptCount = (): number => kept().size;

/** Forgets every transcript (Settings → Transcription, Clear). */
export function clearTranscripts(): Problem | null {
  transcripts = new Map();
  return saveKept() ? null : 'store_failed';
}
