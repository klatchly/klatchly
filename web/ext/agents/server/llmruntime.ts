import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { dataPath, jsonObject, log, requireStepUp, type AgentRuntime, type AgentRuntimeFeatures, type Env, type RuntimeAgent } from '#core/sdk.js';
import type { LlmProvider, PictureMessages } from '#ext/llm/api.js';
import { agentsPackage } from '../package.js';
import { agentsPushText } from '../locales/index.js';
import { fileManifest, LLM_ID, LLM_RUNTIME, MAX_INSTRUCTIONS, setExtraEntries, type Agent, type AgentEntry } from './manifest.js';

// The agents package's own runtime (the core's AgentRuntime), on the llm provider: an agent that answers from a
// model, nothing else. No tools, no memory, no conversations of its own (so no Agents space: only the agent inside
// a chat), no stream (the llm provider has none). Each agent is a "use" of llm (agents.<id>, named after it): its
// model is chosen in Settings → Default models, the server's defaults until then; the privacy line names that
// model's provider (LlmProvider.labelFor). A completion is the agent's standing instructions (its persona) above
// the chat agent's own system prompt, then llm's completeFor.
//
// Its agents come from two places, ids distinct:
// - the manifest (KLATCHLY_AGENTS_FILE), `runtime: "llm"`: the host's, read-only here;
// - Settings → Agents (llm) (client/LlmAgents.tsx, routes below): made and changed by the signed-in user, every
//   change behind the core's step-up; kept in the data volume (data/agents-llm.json). An id the manifest already
//   has is refused when made, and ignored (logged) when read back.
// Logs: counts and ids, never instructions or content.

export const LLM_FEATURES: AgentRuntimeFeatures = {
  conversations: false,
  streaming: false,
  stop: false,
  organize: false,
  images: false,
  approvals: false,
  helpers: false,
  inbound: false,
  tools: false,
  mainAgent: null,
};

/** An agent made in Settings. */
export interface LlmAgent {
  id: string;
  label: string;
  /** "#rrggbb", or null: picked from the id. */
  color: string | null;
  description: string | null;
  instructions: string;
  updatedAt: number;
}

export const MAX_LLM_AGENTS = 16;
const COLOR = /^#[0-9a-f]{6}$/;
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

// ── The provider (set at start) ──────────────────────────────────────────────

let llmOf: (() => LlmProvider | undefined) | undefined;
let removeUses: (() => void)[] = [];
const llm = () => llmOf?.();
export const useOf = (id: string) => `${agentsPackage.id}.${id}`;

/** Start / stop (index.ts), and tests: how to reach the llm provider now (it may go off and on). */
export function setLlm(get: (() => LlmProvider | undefined) | undefined): void {
  for (const r of removeUses.splice(0)) r();
  llmOf = get;
  syncUses();
}

/** Each agent listed on Settings → Default models while this package is on (its model chosen there). */
function syncUses(): void {
  for (const r of removeUses.splice(0)) r();
  const p = llm();
  if (!p) return;
  for (const a of runtimeAgents()) {
    try {
      removeUses.push(p.use({ id: useOf(a.id), label: Object.fromEntries(Object.entries(agentsPushText).map(([lang, t]) => [lang, t.llmUse(a.label)])) as { en: string } }));
    } catch {
      log('agents', 'llm use refused', { agent: a.id });
    }
  }
}

// ── Its agents ───────────────────────────────────────────────────────────────

let fromManifest: RuntimeAgent[] = [];
let local: LlmAgent[] | undefined;
const storeFile = () => dataPath('agents-llm.json');

function cleanStored(v: unknown): LlmAgent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !LLM_ID.test(o.id) || typeof o.label !== 'string' || !clean(o.label) || typeof o.instructions !== 'string') return null;
  return {
    id: o.id,
    label: clean(o.label).slice(0, 40),
    color: typeof o.color === 'string' && COLOR.test(o.color) ? o.color : null,
    description: typeof o.description === 'string' && clean(o.description) ? clean(o.description).slice(0, 200) : null,
    instructions: o.instructions.trim().slice(0, MAX_INSTRUCTIONS),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  };
}

function stored(): LlmAgent[] {
  if (!local) {
    local = [];
    try {
      const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as { agents?: unknown };
      if (Array.isArray(raw.agents)) for (const a of raw.agents.slice(0, MAX_LLM_AGENTS)) {
        const x = cleanStored(a);
        if (x && !local.some((y) => y.id === x.id)) local.push(x);
      }
    } catch {
      // first run
    }
  }
  return local;
}

function save(): void {
  try {
    const tmp = `${storeFile()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, agents: stored() })}\n`, { mode: 0o600 });
    renameSync(tmp, storeFile());
  } catch {
    log('agents', 'llm agents not saved');
  }
}

/** Ids the manifest uses, whatever their runtime (an agent made here never takes one). */
const manifestIds = () => new Set((fileManifest()?.agents ?? []).map((a) => a.id));

/** Settings' agents not shadowed by the manifest (logged once per id). */
const ignored = new Set<string>();
function ownAgents(): LlmAgent[] {
  const taken = manifestIds();
  return stored().filter((a) => {
    if (!taken.has(a.id)) return true;
    if (!ignored.has(a.id)) {
      ignored.add(a.id);
      log('agents', 'llm agent ignored: the manifest has its id', { agent: a.id });
    }
    return false;
  });
}

const fromLocal = (a: LlmAgent): RuntimeAgent => ({ id: a.id, label: a.label, description: a.description, helpers: [], space: false, inbox: null, instructions: a.instructions });
export const runtimeAgents = (): RuntimeAgent[] => [...fromManifest, ...ownAgents().map(fromLocal)];

/** The entry of an agent made in Settings (manifest.ts entryOf): offered in chats, limited, its model's provider. */
function entryOfLocal(a: Agent): AgentEntry | null {
  if (a.runtime !== LLM_RUNTIME) return null;
  const x = ownAgents().find((y) => y.id === a.id);
  if (!x) return null;
  return {
    id: x.id,
    runtime: LLM_RUNTIME,
    instructions: x.instructions,
    label: x.label,
    color: x.color,
    description: x.description ? { en: x.description } : null,
    offer: ['chat'],
    helpers: [],
    inbox: null,
    access: 'limited',
    accessNote: null,
    disclosure: null,
  };
}
setExtraEntries(entryOfLocal);

const known = (id: string) => runtimeAgents().some((a) => a.id === id);
const ready = () => !!llm() && llm()!.status().ready;
const unavailable = () => Object.assign(new Error('llm 503'), { status: 503 });

/** The chat agent's prompt with the agent's instructions above its system message. */
export function withInstructions(messages: { role: 'system' | 'user'; content: string }[], a: Pick<RuntimeAgent, 'label' | 'instructions'>): { role: 'system' | 'user'; content: string }[] {
  const persona = [
    a.instructions?.trim() || `You are ${a.label}, a helpful assistant.`,
    'You have no tools: you cannot browse, run programs or reach any file or service, and you remember nothing between calls. Say so when asked to.',
  ].join('\n\n');
  const i = messages.findIndex((m) => m.role === 'system');
  if (i < 0) return [{ role: 'system', content: persona }, ...messages];
  return messages.map((m, j) => (j === i ? { ...m, content: `<agent_instructions>\n${persona}\n</agent_instructions>\n\n${m.content}` } : m));
}

export const llmRuntime: AgentRuntime = {
  type: 'provider',
  id: LLM_RUNTIME,
  status: () => ({ ready: ready() }),
  features: LLM_FEATURES,
  configure: (list) => {
    fromManifest = (list ?? []).map((a) => ({ ...a, helpers: [], space: false, inbox: null }));
    syncUses();
  },
  agents: runtimeAgents,
  agentsStatus: async () => runtimeAgents().map((a) => ({ ...a, up: ready() })),
  probe: async (id) => known(id) && ready(),
  isUp: (id) => known(id) && ready(),
  usable: async (id) => known(id) && ready(),
  complete: async (id, messages, timeoutMs) => {
    const a = runtimeAgents().find((x) => x.id === id);
    const p = llm();
    if (!a || !p) throw unavailable();
    const t0 = Date.now();
    try {
      const text = await p.completeFor(useOf(id), withInstructions(messages, a), { feature: useOf(id), ...(timeoutMs ? { capMs: timeoutMs } : {}) });
      log('agents', 'llm completion', { agent: id, ms: Date.now() - t0, chars: text.length });
      return text;
    } catch (e) {
      log('agents', 'llm completion failed', { agent: id, ms: Date.now() - t0 });
      throw Object.assign(new Error('llm 502'), { status: (e as Error)?.message === 'disabled' ? 503 : 502 });
    }
  },
  disclosure: (id) => (known(id) ? (llm()?.labelFor(useOf(id)) ?? null) : null),
};

/** The chat agent's prompt with pictures in its user turn (OpenAI's vision parts), for completeWithPictures. */
export type PicturePrompt = PictureMessages;

/**
 * An llm agent's completion with pictures (the chat agent's images option): its instructions above the system
 * message, then llm's completePicturesFor on the agent's use. Its model must read images (llm does not say which
 * do): one that does not answers an error, which the chat agent logs in the chat's activity.
 */
export async function completeWithPictures(id: string, messages: PicturePrompt): Promise<string> {
  const a = runtimeAgents().find((x) => x.id === id);
  const p = llm();
  if (!a || !p || !ready()) throw unavailable();
  const sys = messages.find((m) => m.role === 'system');
  const persona = withInstructions([{ role: 'system', content: typeof sys?.content === 'string' ? sys.content : '' }], a)[0]!.content;
  const withPersona: PicturePrompt = sys ? messages.map((m) => (m === sys ? { role: 'system', content: persona } : m)) : [{ role: 'system', content: persona }, ...messages];
  const t0 = Date.now();
  try {
    // A picture takes a model longer than a text: the fallback (the same big request again) only after 25 s.
    const text = await p.completePicturesFor(useOf(id), withPersona, { feature: useOf(id), patienceMs: 25_000, capMs: 90_000 });
    log('agents', 'llm completion', { agent: id, ms: Date.now() - t0, chars: text.length, pictures: true });
    return text;
  } catch (e) {
    log('agents', 'llm completion failed', { agent: id, ms: Date.now() - t0, pictures: true });
    throw Object.assign(new Error('llm 502'), { status: (e as Error)?.message === 'disabled' ? 503 : 502 });
  }
}

/** Tests: start from an empty store (or a given one). */
export function resetLlmAgentsForTests(list: LlmAgent[] = []): void {
  local = list.map((a) => ({ ...a }));
  fromManifest = [];
  ignored.clear();
}

/** The offline instance, between scripts: no agent made in Settings (the file emptied too). */
export function clearSettingsAgents(): void {
  local = [];
  save();
  syncUses();
}

// ── Settings → Agents (llm): /api/chatagent/llm-agents ───────────────────────

/** A new agent's id from its name: letters and digits, lower case, made unique. */
export function idFor(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^[^a-z]+|-+$/g, '')
      .slice(0, 24) || 'agent';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `agent-${randomBytes(3).toString('hex')}`;
}

/** A body from the page -> the agent's fields, or an error code. `cur`: the agent changed (absent: a new one). */
export function llmAgentFields(body: Record<string, unknown> | null, cur?: LlmAgent): Omit<LlmAgent, 'id' | 'updatedAt'> | { error: string } {
  if (!body || Object.keys(body).some((k) => !['label', 'color', 'description', 'instructions'].includes(k))) return { error: 'bad_request' };
  const label = body.label === undefined ? cur?.label : typeof body.label === 'string' ? clean(body.label) : null;
  if (!label || label.length > 40) return { error: 'bad_label' };
  const color = body.color === undefined ? (cur?.color ?? null) : body.color === null || body.color === '' ? null : typeof body.color === 'string' && COLOR.test(body.color.toLowerCase()) ? body.color.toLowerCase() : undefined;
  if (color === undefined) return { error: 'bad_request' };
  const description = body.description === undefined ? (cur?.description ?? null) : typeof body.description === 'string' ? clean(body.description) || null : body.description === null ? null : undefined;
  if (description === undefined || (description && description.length > 200)) return { error: 'bad_request' };
  const instructions = body.instructions === undefined ? cur?.instructions : typeof body.instructions === 'string' ? body.instructions.trim() : null;
  if (instructions === undefined || instructions === null || instructions.length > MAX_INSTRUCTIONS) return { error: 'bad_instructions' };
  return { label, color, description, instructions };
}

const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });
const ID_PARAM = /^[a-z][a-z0-9-]{0,31}$/;

export const llmAgentRoutes = new Hono<Env>();

/** The agents of the llm runtime: those made here (editable) and the manifest's (read-only); whether llm is on. */
llmAgentRoutes.get('/', (c) => {
  const disclosure = (id: string) => llmRuntime.disclosure!(id);
  const own = ownAgents();
  return c.json({
    llm: !!llm(),
    ready: ready(),
    max: MAX_LLM_AGENTS,
    maxInstructions: MAX_INSTRUCTIONS,
    agents: [
      ...fromManifest.map((a) => ({ id: a.id, label: a.label, color: fileManifest()?.agents.find((x) => x.id === a.id)?.color ?? null, description: a.description, instructions: a.instructions ?? '', source: 'manifest' as const, disclosure: disclosure(a.id) })),
      ...own.map((a) => ({ ...a, source: 'settings' as const, disclosure: disclosure(a.id) })),
    ],
  });
});

llmAgentRoutes.post('/', requireStepUp, small, async (c) => {
  const f = llmAgentFields(await jsonObject(c));
  if ('error' in f) return c.json({ error: f.error }, 400);
  const list = stored();
  if (ownAgents().length >= MAX_LLM_AGENTS) return c.json({ error: 'too_many' }, 409);
  const taken = new Set([...manifestIds(), ...list.map((a) => a.id), ...runtimeAgents().map((a) => a.id)]);
  const a: LlmAgent = { id: idFor(f.label, taken), ...f, updatedAt: Date.now() };
  list.push(a);
  save();
  syncUses();
  log('agents', 'llm agent added', { agent: a.id });
  return c.json({ agent: a });
});

llmAgentRoutes.put('/:id', requireStepUp, small, async (c) => {
  const id = c.req.param('id');
  const cur = ID_PARAM.test(id) ? ownAgents().find((a) => a.id === id) : undefined;
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const f = llmAgentFields(await jsonObject(c), cur);
  if ('error' in f) return c.json({ error: f.error }, 400);
  Object.assign(cur, f, { updatedAt: Date.now() });
  save();
  syncUses();
  log('agents', 'llm agent changed', { agent: id });
  return c.json({ agent: cur });
});

llmAgentRoutes.delete('/:id', requireStepUp, (c) => {
  const id = c.req.param('id');
  const list = stored();
  const i = ID_PARAM.test(id) ? list.findIndex((a) => a.id === id && !manifestIds().has(id)) : -1;
  if (i < 0) return c.json({ error: 'not_found' }, 404);
  list.splice(i, 1);
  save();
  syncUses();
  log('agents', 'llm agent removed', { agent: id });
  return c.json({ ok: true });
});
