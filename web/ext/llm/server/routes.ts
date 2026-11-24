import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { clientIp, jsonObject, log, RateLimiter, requireStepUp, type Env } from '#core/sdk.js';
import type { ChatMessages } from '../api.js';
import { isKind, SERVER_PROVIDER } from '../kinds.js';
import { CAP_MS, completeOn, enabledModels, listModels, PATIENCE_MS, registeredUses, resetModelsCache, statsOf, testProvider } from './llm.js';
import {
  addProvider,
  cleanName,
  cleanUrl,
  defaultRoute,
  hasKey,
  isDefault,
  provider,
  providers,
  removeProvider,
  routeOf,
  sameRef,
  setModels,
  setRoute,
  updateProvider,
  validKey,
  validModelId,
  validProviderId,
  type Problem,
  type Provider,
  type Ref,
  type StoredRoute,
} from './store.js';

// The llm package's API, at /api/llm (its module's routes): Settings → Providers and Settings → Default models.
//   GET    /providers                 the providers (never a key: `keySet` only)
//   POST   /providers                 add one {kind, name, url, key?}                       (step-up)
//   PUT    /providers/:id             {name?, url?, key?: string | null (clears)}          (step-up)
//   DELETE /providers/:id                                                                  (step-up)
//   GET    /providers/:id/models      what it lists (?refresh=1) and what is enabled
//   PUT    /providers/:id/models      {models: string[] | null} the enabled ones (null: all it lists, server's only)
//   POST   /providers/:id/test        reaches it (model list; the key where the kind can check it for free)
//   GET    /routes                    the uses, their models, and the models to choose from
//   PUT    /routes                    {[use]: {model: Ref, fallback: Ref | 'none'} | null (defaults)}
//   POST   /test                      {provider, model}: a fixed prompt to that model alone
// Adding, editing and removing a provider changes where the users' text goes and with which key: it needs a recent
// sign-in or step-up (the sdk's requireStepUp, as the sign-in settings). Choosing models among those does not.

const view = (p: Provider) => ({ id: p.id, kind: p.kind, name: p.name, url: p.url, fromServer: p.fromServer, keySet: hasKey(p), all: p.models === null });

// Fixed prompt for the "Test" button: never user data.
const TEST_PROMPT: ChatMessages = [
  { role: 'system', content: 'You are a health check. Reply with the single word: ok' },
  { role: 'user', content: 'ping' },
];

const testLimiter = new RateLimiter(10 * 60 * 1000, 30, 200);
const small = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });
// A list of enabled models (300 ids at most).
const list = bodyLimit({ maxSize: 40 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

const STATUS: Record<Problem, 400 | 404 | 409 | 500> = { bad_request: 400, too_many: 409, key_required: 400, key_reentry: 400, server_provider: 400, not_found: 404, store_failed: 500 };
const problem = (c: Context<Env>, p: Problem) => c.json({ error: p }, STATUS[p]);
const who = (c: Context<Env>) => ({ session: c.get('session')!.slice(0, 12), ip: clientIp(c) });

export const llmRoutes = new Hono<Env>();

llmRoutes.get('/providers', (c) => c.json({ providers: providers().map(view) }));

llmRoutes.post('/providers', requireStepUp, small, async (c) => {
  const b = await jsonObject(c);
  if (!b || Object.keys(b).some((k) => !['kind', 'name', 'url', 'key'].includes(k))) return problem(c, 'bad_request');
  const name = cleanName(b.name);
  const url = cleanUrl(b.url);
  const key = b.key === undefined || b.key === null || b.key === '' ? null : validKey(b.key) ? b.key : undefined;
  if (!isKind(b.kind) || !name || !url || key === undefined) return problem(c, 'bad_request');
  const r = addProvider({ kind: b.kind, name, url, key });
  if ('error' in r) return problem(c, r.error);
  log('llm', 'provider added', { provider: r.id, kind: b.kind, key: !!key, ...who(c) });
  return c.json(view(provider(r.id)!));
});

llmRoutes.put('/providers/:id', requireStepUp, small, async (c) => {
  const id = c.req.param('id');
  const b = await jsonObject(c);
  if (!validProviderId(id) || !b || !Object.keys(b).length || Object.keys(b).some((k) => !['name', 'url', 'key'].includes(k))) return problem(c, 'bad_request');
  const name = b.name === undefined ? undefined : cleanName(b.name);
  const url = b.url === undefined ? undefined : cleanUrl(b.url);
  const key = b.key === undefined ? undefined : b.key === null ? null : validKey(b.key) ? b.key : false;
  if (name === null || url === null || key === false) return problem(c, 'bad_request');
  const p = updateProvider(id, { ...(name !== undefined ? { name } : {}), ...(url !== undefined ? { url } : {}), ...(key !== undefined ? { key } : {}) });
  if (p) return problem(c, p);
  if (url !== undefined || key !== undefined) resetModelsCache(id);
  log('llm', 'provider changed', { provider: id, name: name !== undefined, url: url !== undefined, key: key === undefined ? 'kept' : key ? 'replaced' : 'cleared', ...who(c) });
  return c.json(view(provider(id)!));
});

llmRoutes.delete('/providers/:id', requireStepUp, (c) => {
  const id = c.req.param('id');
  if (!validProviderId(id)) return problem(c, 'bad_request');
  const p = removeProvider(id);
  if (p) return problem(c, p);
  resetModelsCache(id);
  log('llm', 'provider removed', { provider: id, ...who(c) });
  return c.json({ ok: true });
});

llmRoutes.get('/providers/:id/models', async (c) => {
  const p = provider(c.req.param('id'));
  if (!p) return problem(c, 'not_found');
  let offered: { id: string; name?: string }[] = [];
  let reachable = true;
  try {
    offered = await listModels(p.id, c.req.query('refresh') === '1');
  } catch {
    reachable = false;
  }
  const enabled = new Set(p.models ?? offered.map((m) => m.id));
  // Models enabled by hand (not in the list) come after the listed ones.
  const extra = [...enabled].filter((id) => !offered.some((m) => m.id === id)).sort();
  return c.json({
    reachable,
    all: p.models === null,
    items: [...offered.map((m) => ({ ...m, listed: true, enabled: enabled.has(m.id) })), ...extra.map((id) => ({ id, listed: false, enabled: true }))],
  });
});

llmRoutes.put('/providers/:id/models', list, async (c) => {
  const id = c.req.param('id');
  const b = await jsonObject(c);
  if (!validProviderId(id) || !b || Object.keys(b).length !== 1 || !('models' in b)) return problem(c, 'bad_request');
  const models = b.models;
  // Back to "all it lists": the server's provider only (as before 1.1).
  if (models === null ? id !== SERVER_PROVIDER : !Array.isArray(models) || !models.every(validModelId)) return problem(c, 'bad_request');
  const p = setModels(id, models as string[] | null);
  if (p) return problem(c, p);
  log('llm', 'models enabled', { provider: id, count: models === null ? 'all' : (models as string[]).length });
  return c.json({ ok: true });
});

llmRoutes.post('/providers/:id/test', async (c) => {
  const id = c.req.param('id');
  if (!provider(id)) return problem(c, 'not_found');
  if (!testLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  return c.json(await testProvider(id));
});

// ── Default models ────────────────────────────────────────────────────────

const refView = (r: Ref | null) => (r ? { provider: r.provider, model: r.model } : null);

/** Every enabled model of every provider, and the models in use even if no longer enabled (shown as such). */
async function choices() {
  const out: { provider: string; model: string; enabled: boolean; stats: ReturnType<typeof statsOf> }[] = [];
  const reachable: Record<string, boolean> = {};
  // The lists asked of every provider at once (one slow provider does not add up).
  const lists = await Promise.all(providers().map(async (p) => ({ p, ids: await enabledModels(p).catch(() => null) })));
  for (const { p, ids } of lists) {
    reachable[p.id] = ids !== null;
    for (const model of ids ?? []) out.push({ provider: p.id, model, enabled: true, stats: statsOf({ provider: p.id, model }) });
  }
  const inUse = [...registeredUses().flatMap((u) => [routeOf(u.id)?.model, routeOf(u.id)?.fallback]), defaultRoute()?.model, defaultRoute()?.fallback];
  for (const r of inUse) if (r && !out.some((x) => sameRef(x, r))) out.push({ provider: r.provider, model: r.model, enabled: false, stats: statsOf(r) });
  return { items: out, reachable };
}

async function routesView() {
  const def = defaultRoute();
  return {
    patienceMs: PATIENCE_MS,
    defaults: def ? { model: refView(def.model), fallback: refView(def.fallback) } : null,
    providers: providers().map((p) => ({ id: p.id, name: p.name })),
    uses: registeredUses().map((u) => {
      const r = routeOf(u.id);
      return { id: u.id, label: u.label, model: refView(r?.model ?? null), fallback: refView(r?.fallback ?? null), isDefault: isDefault(u.id) };
    }),
    choices: await choices(),
  };
}

llmRoutes.get('/routes', async (c) => c.json(await routesView()));

const asRef = (v: unknown): Ref | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length === 2 && validProviderId(o.provider) && validModelId(o.model) ? { provider: o.provider, model: o.model } : null;
};

/** Whether a model can be chosen: enabled on its provider (or the model a use has now, kept). */
async function choosable(r: Ref, current: StoredRoute | null): Promise<boolean | 'unavailable'> {
  if (current && (sameRef(current.model, r) || sameRef(current.fallback, r))) return true;
  const p = provider(r.provider);
  if (!p) return false;
  try {
    return (await enabledModels(p)).includes(r.model);
  } catch {
    return 'unavailable';
  }
}

llmRoutes.put('/routes', small, async (c) => {
  const b = await jsonObject(c);
  const known = new Set(registeredUses().map((u) => u.id));
  if (!b || !Object.keys(b).length || Object.keys(b).some((k) => !known.has(k))) return problem(c, 'bad_request');
  const changes: [string, StoredRoute | null][] = [];
  for (const [use, v] of Object.entries(b)) {
    if (v === null) {
      changes.push([use, null]);
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return problem(c, 'bad_request');
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length !== 2 || !('model' in o) || !('fallback' in o)) return problem(c, 'bad_request');
    const model = asRef(o.model);
    const fallback = o.fallback === 'none' ? null : asRef(o.fallback);
    if (!model || (o.fallback !== 'none' && !fallback)) return problem(c, 'bad_request');
    const current = routeOf(use);
    for (const r of [model, fallback]) {
      if (!r) continue;
      const ok = await choosable(r, current);
      if (ok === 'unavailable') return c.json({ error: 'models_unavailable' }, 503);
      if (!ok) return c.json({ error: 'unknown_model' }, 400);
    }
    changes.push([use, { model, fallback }]);
  }
  for (const [use, r] of changes) {
    const p = setRoute(use, r);
    if (p) return problem(c, p);
  }
  const shown = (r: Ref | null | undefined) => (r ? `${r.provider}:${r.model}` : 'none');
  log('llm', 'routes', Object.fromEntries(registeredUses().map((u) => [u.id, `${shown(routeOf(u.id)?.model)}>${shown(routeOf(u.id)?.fallback)}`])));
  return c.json(await routesView());
});

llmRoutes.post('/test', small, async (c) => {
  if (!testLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const b = await jsonObject(c);
  const r = asRef(b);
  if (!r) return problem(c, 'bad_request');
  const ok = await choosable(r, null);
  // A model in use may be tested even when no longer enabled.
  const inUse = registeredUses().some((u) => sameRef(routeOf(u.id)?.model ?? null, r) || sameRef(routeOf(u.id)?.fallback ?? null, r));
  if (ok === 'unavailable' && !inUse) return c.json({ error: 'models_unavailable' }, 503);
  if (!ok && !inUse) return c.json({ error: 'unknown_model' }, 400);
  const t0 = Date.now();
  try {
    await completeOn(TEST_PROMPT, { model: r, fallback: null }, { capMs: CAP_MS, feature: 'test' });
    return c.json({ ok: true, ms: Date.now() - t0, stats: statsOf(r) });
  } catch (e) {
    return c.json({ ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : 'unknown', stats: statsOf(r) });
  }
});
