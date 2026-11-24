import { log } from '#core/sdk.js';
import type { ChatMessages, CompleteOptions, LlmUse, ModelStats, Outcome, PictureMessages, Route } from '../api.js';
import { KIND_INFO, SERVER_PROVIDER } from '../kinds.js';
import { env, firstSeen, provider, routeOf, setServerKey, validModelId, type Provider, type Ref, type StoredRoute } from './store.js';

// Direct chat completions on OpenAI-compatible providers (Settings → Providers: the server's KLATCHLY_LLM_URL, e.g. a
// router in front of several accounts, and those added there). No agent, no tools, no memory: callers send fixed
// instructions and the user's data as data. A call names a primary model and an optional fallback, each on its
// provider: when the primary errors, or has not answered within PATIENCE_MS, the fallback is started in parallel
// and the first good answer wins (the other is aborted). No content in the logs: provider id, model, latency and
// outcome only; never a key or a URL.
//
// Redirects are never followed (a provider's 3xx is an error): the key would go along to wherever it points.

/** How long the primary model gets alone before the fallback is started alongside it. */
export const PATIENCE_MS = 10_000;
/** Hard cap for one completion, fallback included. */
export const CAP_MS = 45_000;

export { validModelId };

/** KLATCHLY_LLM_LABEL: a plain name (every language), or {"en": …, "fr": …}; null when unset or malformed. */
export function llmLabel(): Readonly<Record<string, string>> | null {
  const raw = (process.env.KLATCHLY_LLM_LABEL ?? '').trim();
  if (!raw) return null;
  if (!raw.startsWith('{')) return { en: raw };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = Object.fromEntries(Object.entries(v).filter(([k, x]) => /^[a-z]{2,3}(-[A-Z]{2})?$/.test(k) && typeof x === 'string' && x.trim()));
    return 'en' in out ? out : null;
  } catch {
    return null;
  }
}

/** Default model and fallback of the server's provider, from the environment (LlmProvider.defaults). */
export function defaultRoute(): Required<Route> {
  const { model, fallback } = env();
  return { model, fallback: fallback && fallback !== model ? fallback : null };
}

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
/** Tests: a fake network, and the server's key (null: none; undefined: read the file again). */
export function setLlmFetch(f: Fetch, k?: string | null): void {
  fetcher = f;
  setServerKey(k);
}

/** A request to a provider: its key as a Bearer header when it has one, redirects not followed. */
function call(p: Provider, path: string, init: { method?: string; body?: string; signal: AbortSignal }): Promise<Response> {
  const k = p.key();
  return fetcher(`${p.url}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body,
    signal: init.signal,
    redirect: 'manual',
  });
}

/** Caps of a provider's answer: a completion, a model list (OpenRouter's is a few hundred KB). */
export const MAX_COMPLETION_BYTES = 1024 * 1024;
export const MAX_MODELS_BYTES = 2 * 1024 * 1024;

/**
 * A provider's JSON answer, read up to `max` bytes. Fails with a fixed message ('<what> too large', '<what> bad
 * json'): nothing of the body (a parser's message quotes it) ever reaches an answer or a log line.
 */
export async function readBody(res: Response, max: number, what: 'llm' | 'models'): Promise<unknown> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${what} too large`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new Error(`${what} too large`);
      }
      chunks.push(value);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error(`${what} bad json`);
  }
}

/** An answer not read (an error status): its body let go. */
const drop = (res: Response) => void res.body?.cancel().catch(() => {});

/** The provider of a model, if it can be called (a kind that needs a key has one). */
function callable(id: string): Provider | Error {
  const p = provider(id);
  if (!p) return new Error('unknown provider');
  // The server's provider always needs its key file (server/index.ts check), whatever its kind looks like.
  if ((p.fromServer || KIND_INFO[p.kind].keyRequired) && !p.key()) return new Error('disabled');
  return p;
}

// ── Per-model stats (last calls, in memory) ───────────────────────────────

type Sample = { at: number; ms: number; outcome: Outcome };
const SAMPLES = 20;
const samples = new Map<string, Sample[]>();
const refKey = (r: Ref) => `${r.provider}\u0000${r.model}`;

function record(r: Ref, ms: number, outcome: Outcome): void {
  const list = samples.get(refKey(r)) ?? [];
  list.push({ at: Date.now(), ms, outcome });
  if (list.length > SAMPLES) list.splice(0, list.length - SAMPLES);
  samples.set(refKey(r), list);
}

export function statsOf(r: Ref): ModelStats {
  const list = samples.get(refKey(r)) ?? [];
  const okMs = list.filter((s) => s.outcome === 'ok').map((s) => s.ms).sort((a, b) => a - b);
  const last = list.at(-1);
  return {
    calls: list.length,
    ok: okMs.length,
    errors: list.filter((s) => s.outcome === 'error').length,
    aborted: list.filter((s) => s.outcome === 'aborted').length,
    medianMs: okMs.length ? okMs[Math.floor(okMs.length / 2)]! : null,
    lastMs: last?.ms ?? null,
    lastOutcome: last?.outcome ?? null,
    lastAt: last?.at ?? null,
  };
}

/** A model of the server's provider (LlmProvider.stats). */
export const modelStats = (model: string): ModelStats => statsOf({ provider: SERVER_PROVIDER, model });

export function resetStats(): void {
  samples.clear();
}

// ── One call ──────────────────────────────────────────────────────────────

/**
 * One chat completion on one model: model, messages and stream only. No extra parameter (reasoning effort,
 * max_tokens...): some routers answer an unsupported one with a 400 and then pause the account's shared
 * connection for every client.
 */
async function callOnce(r: Ref, messages: PictureMessages, signal: AbortSignal): Promise<string> {
  const p = callable(r.provider);
  if (p instanceof Error) throw p;
  const res = await call(p, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: r.model, stream: false, messages }), signal });
  if (!res.ok) {
    drop(res);
    throw new Error(`llm ${res.status}`);
  }
  const j = (await readBody(res, MAX_COMPLETION_BYTES, 'llm')) as { choices?: { message?: { content?: unknown } }[] } | null;
  const c = j?.choices?.[0]?.message?.content;
  const out = typeof c === 'string' ? c.trim() : '';
  if (!out) throw new Error('llm empty');
  return out;
}

// Our own messages ('llm 502', 'models bad json', 'disabled'…) as they are; anything else (a network error's text
// may name an address, a parser's quotes the body) as a fixed word.
const OWN = /^(?:(?:llm|models|key) (?:\d{3}|empty|timeout|too large|bad json)|disabled|unknown provider)$/;
const errName = (e: unknown) => (e instanceof Error ? (e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timeout' : OWN.test(e.message) ? e.message : 'network') : 'unknown');
const shown = (r: Ref) => (r.provider === SERVER_PROVIDER ? r.model : `${r.provider}:${r.model}`);

/** Completion with fallback over providers (see LlmProvider.complete in ../api.ts). */
export function completeOn(messages: PictureMessages, route: StoredRoute, opts: CompleteOptions = {}): Promise<string> {
  const primary = callable(route.model.provider);
  if (primary instanceof Error && primary.message === 'disabled' && !route.fallback) return Promise.reject(primary);
  const patienceMs = opts.patienceMs ?? PATIENCE_MS;
  const capMs = opts.capMs ?? CAP_MS;
  const fallback = route.fallback && refKey(route.fallback) !== refKey(route.model) ? route.fallback : null;
  const t0 = Date.now();
  const feature: Record<string, string> = opts.feature ? { feature: opts.feature } : {};

  return new Promise<string>((resolve, reject) => {
    let done = false;
    let running = 0;
    let fallbackStarted = false;
    let firstError: Error | undefined;
    const controllers = new Map<string, AbortController>();
    const timers: NodeJS.Timeout[] = [];

    const finish = (err: Error | null, out?: string, winner?: Ref) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      for (const [k, c] of controllers) {
        if (!winner || k !== refKey(winner)) c.abort();
      }
      if (err) {
        log('llm', 'error', { ...feature, model: shown(route.model), fallback: fallback ? shown(fallback) : 'none', ms: Date.now() - t0, error: err.message });
        reject(err);
      } else {
        log('llm', 'info', { ...feature, model: shown(winner!), fellBack: refKey(winner!) !== refKey(route.model), ms: Date.now() - t0 });
        resolve(out!);
      }
    };

    const start = (r: Ref) => {
      const ctrl = new AbortController();
      controllers.set(refKey(r), ctrl);
      running++;
      const s0 = Date.now();
      callOnce(r, messages, ctrl.signal).then(
        (out) => {
          record(r, Date.now() - s0, 'ok');
          finish(null, out, r);
        },
        (e: unknown) => {
          running--;
          // Aborted by us: the other model won or the cap fired. Counts as "slow", not as an error.
          record(r, Date.now() - s0, ctrl.signal.aborted ? 'aborted' : 'error');
          if (done) return;
          const err = new Error(errName(e) === 'timeout' ? 'llm timeout' : errName(e));
          if (r === route.model) {
            firstError = err;
            if (fallback && !fallbackStarted) {
              startFallback();
              return;
            }
          }
          if (running === 0) finish(firstError ?? err);
        },
      );
    };

    const startFallback = () => {
      if (done || fallbackStarted || !fallback) return;
      fallbackStarted = true;
      start(fallback);
    };

    start(route.model);
    if (fallback) timers.push(setTimeout(startFallback, patienceMs));
    timers.push(setTimeout(() => finish(new Error('llm timeout')), capMs));
  });
}

/** LlmProvider.complete: model ids of the server's provider. */
export function complete(messages: ChatMessages, route: Route, opts: CompleteOptions = {}): Promise<string> {
  if (!provider(SERVER_PROVIDER)) return Promise.reject(new Error('disabled'));
  const fb = route.fallback && route.fallback !== route.model ? { provider: SERVER_PROVIDER, model: route.fallback } : null;
  return completeOn(messages, { model: { provider: SERVER_PROVIDER, model: route.model }, fallback: fb }, opts);
}

// ── Uses (Settings → Default models) ──────────────────────────────────────

const uses = new Map<string, LlmUse>();

/** The uses registered now, in their order of registration. */
export const registeredUses = (): LlmUse[] => [...uses.values()];

/** LlmProvider.use. */
export function use(u: LlmUse): () => void {
  if (!/^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/.test(u.id) || typeof u.label?.en !== 'string') throw new Error(`llm: bad use ${JSON.stringify(u.id)}`);
  uses.set(u.id, u);
  if (firstSeen(u.id, u.legacy)) log('llm', 'use adopted its earlier models', { use: u.id });
  return () => {
    if (uses.get(u.id) === u) uses.delete(u.id);
  };
}

/** LlmProvider.completeFor. */
export function completeFor(useId: string, messages: ChatMessages, opts: CompleteOptions = {}): Promise<string> {
  const r = routeOf(useId);
  if (!r) return Promise.reject(new Error('disabled'));
  return completeOn(messages, r, { feature: useId, ...opts });
}

/** LlmProvider.completePicturesFor: the same call, its turns may carry pictures (the use's models must read them). */
export function completePicturesFor(useId: string, messages: PictureMessages, opts: CompleteOptions = {}): Promise<string> {
  const r = routeOf(useId);
  if (!r) return Promise.reject(new Error('disabled'));
  return completeOn(messages, r, { feature: useId, ...opts });
}

/** LlmProvider.labelFor: the server's KLATCHLY_LLM_LABEL for its own models, a provider's name for the others. */
export function labelFor(useId: string): Readonly<Record<string, string>> | null {
  const r = routeOf(useId);
  if (!r || r.model.provider === SERVER_PROVIDER) return llmLabel();
  const p = provider(r.model.provider);
  return p ? { en: p.name } : null;
}

// ── Models a provider lists ───────────────────────────────────────────────

export interface Listed {
  id: string;
  /** Its display name, when the provider gives one other than the id (OpenRouter). */
  name?: string;
}

/**
 * The chat models of a /models answer: valid ids, "-review" variants left out (a router's reviewers, not chat
 * models), a router's search and fetch tools (`kind`) and models that do not write text (OpenRouter's
 * `architecture.output_modalities`) too.
 */
export function parseModels(j: unknown): Listed[] {
  const data = j && typeof j === 'object' && Array.isArray((j as { data?: unknown }).data) ? ((j as { data: unknown[] }).data) : [];
  const out = new Map<string, Listed>();
  for (const m of data) {
    if (!m || typeof m !== 'object') continue;
    const { id, name, kind, architecture } = m as { id?: unknown; name?: unknown; kind?: unknown; architecture?: { output_modalities?: unknown } };
    if (!validModelId(id) || id.endsWith('-review') || out.has(id)) continue;
    if (typeof kind === 'string' && kind !== 'llm') continue;
    const outputs = architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes('text')) continue;
    const label = typeof name === 'string' && name.trim() && name.trim() !== id && !/\p{Cc}/u.test(name) ? name.trim().slice(0, 100) : undefined;
    out.set(id, label ? { id, name: label } : { id });
    if (out.size >= 2000) break;
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const MODELS_TTL = 5 * 60_000;
const lists = new Map<string, { at: number; sig: string; items: Listed[] }>();
const pending = new Map<string, Promise<Listed[]>>();
// A list is the provider's at an address with a key: another address or key, another list.
const signature = (p: Provider) => `${p.url}\u0000${p.key() ?? ''}`;

/** The models a provider lists, cached a few minutes; the last list when it fails, else throws. */
export async function listModels(id: string, force = false): Promise<Listed[]> {
  const p = provider(id);
  if (!p) throw new Error('unknown provider');
  const cached = lists.get(id);
  const fresh = cached && cached.sig === signature(p) ? cached : undefined;
  if (!force && fresh && Date.now() - fresh.at < MODELS_TTL) return fresh.items;
  let job = pending.get(id);
  if (!job) {
    job = (async () => {
      try {
        const c = callable(id);
        if (c instanceof Error) throw c;
        const res = await call(c, '/models', { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) {
          drop(res);
          throw new Error(`models ${res.status}`);
        }
        const items = parseModels(await readBody(res, MAX_MODELS_BYTES, 'models'));
        lists.set(id, { at: Date.now(), sig: signature(c), items });
        return items;
      } catch (e) {
        if (fresh) return fresh.items;
        throw e;
      } finally {
        pending.delete(id);
      }
    })();
    pending.set(id, job);
  }
  return job;
}

/** The server's provider's model ids (LlmProvider.models). */
export const availableModels = async (force = false): Promise<string[]> => (await listModels(SERVER_PROVIDER, force)).map((m) => m.id);

/** The models enabled on a provider: its list, or all it lists (null). Throws when that list cannot be had. */
export async function enabledModels(p: Provider): Promise<string[]> {
  return p.models ?? (await listModels(p.id)).map((m) => m.id);
}

export function resetModelsCache(id?: string): void {
  if (id) lists.delete(id);
  else lists.clear();
}

// ── A provider's Test (Settings → Providers) ──────────────────────────────

export interface ProviderTest {
  ok: boolean;
  ms: number;
  /** How many models it lists (when reached). */
  models?: number;
  /** The key was checked by a free call of its kind (OpenRouter's /key): otherwise only the first completion tells. */
  keyChecked: boolean;
  error?: string;
}

/** Reaches the provider's model list (fresh), and checks the key where the kind can do it for free. */
export async function testProvider(id: string): Promise<ProviderTest> {
  const t0 = Date.now();
  const end = (r: Omit<ProviderTest, 'ms'>): ProviderTest => {
    log('llm', 'provider test', { provider: id, ok: r.ok, ms: Date.now() - t0, ...(r.error ? { error: r.error } : {}) });
    return { ...r, ms: Date.now() - t0 };
  };
  const p = callable(id);
  if (p instanceof Error) return end({ ok: false, keyChecked: false, error: p.message });
  let models: number;
  try {
    const res = await call(p, '/models', { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      drop(res);
      return end({ ok: false, keyChecked: false, error: `models ${res.status}` });
    }
    const items = parseModels(await readBody(res, MAX_MODELS_BYTES, 'models'));
    lists.set(id, { at: Date.now(), sig: signature(p), items });
    models = items.length;
  } catch (e) {
    return end({ ok: false, keyChecked: false, error: errName(e) });
  }
  const check = KIND_INFO[p.kind].keyCheck;
  if (!check || !p.key()) return end({ ok: true, models, keyChecked: false });
  try {
    const res = await call(p, check, { signal: AbortSignal.timeout(8_000) });
    drop(res);
    return end(res.ok ? { ok: true, models, keyChecked: true } : { ok: false, models, keyChecked: true, error: `key ${res.status}` });
  } catch (e) {
    return end({ ok: false, models, keyChecked: false, error: errName(e) });
  }
}
