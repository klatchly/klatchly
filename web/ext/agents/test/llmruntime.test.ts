import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '#core/app.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { sha256 } from '#core/sessions.js';
import type { LlmProvider, LlmUse } from '#ext/llm/api.js';
import { packages } from '../../packages.server.js';
import { idFor, llmAgentFields, llmRuntime, resetLlmAgentsForTests, setLlm, useOf, withInstructions } from '../server/llmruntime.js';
import { parseManifest, setManifestForTests } from '../server/manifest.js';

// The agents package's own runtime on the llm provider (server/llmruntime.ts): no tools, no conversations, its
// agents from Settings → Agents (llm) and the manifest (ids distinct, the manifest wins), each one a use of llm
// (agents.<id>) whose model is chosen in Settings → Default models; a completion is its instructions above the chat
// agent's prompt; the privacy line names the model's provider. Settings' changes need the step-up.

const uses = new Map<string, LlmUse>();
const asked: { use: string; messages: { role: string; content: string }[] }[] = [];
let ready = true;
const fakeLlm = {
  type: 'provider',
  id: 'llm',
  status: () => ({ ready }),
  use: (u: LlmUse) => {
    uses.set(u.id, u);
    return () => void uses.delete(u.id);
  },
  completeFor: async (use: string, messages: { role: string; content: string }[]) => {
    asked.push({ use, messages });
    return 'Bonjour.';
  },
  labelFor: (use: string) => (use === useOf('brief') ? { en: 'Model Co' } : null),
} as unknown as LlmProvider;

const AGENT = { id: 'brief', label: 'Brief', color: '#2f8a7a', description: 'Short answers', instructions: 'Answer in one sentence.', updatedAt: 1 };

beforeEach(() => {
  uses.clear();
  asked.length = 0;
  ready = true;
  setManifestForTests(null);
  resetLlmAgentsForTests([AGENT]);
  setLlm(() => fakeLlm);
});
after(() => {
  setLlm(undefined);
  setManifestForTests(undefined);
});

test('features: nothing but a completion (no tools, no conversations: no Agents space)', () => {
  assert.equal(llmRuntime.id, 'llm');
  assert.deepEqual(llmRuntime.features, { conversations: false, streaming: false, stop: false, organize: false, images: false, approvals: false, helpers: false, inbound: false, tools: false, mainAgent: null });
  assert.equal(llmRuntime.conversations, undefined);
});

test('its agents: the manifest\'s, then Settings\'; an id the manifest has wins; each one a use of llm', async () => {
  setManifestForTests(parseManifest(JSON.stringify({ version: 1, agents: [{ id: 'host', runtime: 'llm', label: 'Host', instructions: 'Host rules.' }, { id: 'brief' }] })));
  resetLlmAgentsForTests([AGENT, { ...AGENT, id: 'other', label: 'Other' }]);
  llmRuntime.configure([{ id: 'host', label: 'Host', description: null, helpers: ['x'], space: true, inbox: 'y', instructions: 'Host rules.' }]);
  assert.deepEqual(llmRuntime.agents().map((a) => [a.id, a.space, a.helpers, a.inbox]), [['host', false, [], null], ['other', false, [], null]], '"brief" is a Hermes agent of the manifest: the Settings one is ignored');
  assert.deepEqual([...uses.keys()].sort(), ['agents.host', 'agents.other']);
  assert.deepEqual(uses.get('agents.other')!.label, { en: 'Agent: Other', fr: 'Agent : Other' });
  assert.deepEqual((await llmRuntime.agentsStatus()).map((a) => a.up), [true, true]);
  ready = false;
  assert.equal(await llmRuntime.usable('host'), false, 'llm not ready: unavailable');
  setLlm(undefined);
  assert.equal(uses.size, 0, 'uses removed when the package stops');
});

test('a completion: the agent\'s instructions above the chat agent\'s prompt, on its use; its provider as disclosure', async () => {
  llmRuntime.configure(null);
  const text = await llmRuntime.complete('brief', [
    { role: 'system', content: 'You write in a chat.' },
    { role: 'user', content: '<conversation>…</conversation>' },
  ]);
  assert.equal(text, 'Bonjour.');
  assert.equal(asked[0]!.use, 'agents.brief');
  const sys = asked[0]!.messages[0]!.content;
  assert.match(sys, /^<agent_instructions>\nAnswer in one sentence\.\n\nYou have no tools/);
  assert.match(sys, /<\/agent_instructions>\n\nYou write in a chat\.$/);
  assert.equal(asked[0]!.messages[1]!.content, '<conversation>…</conversation>', 'the chat stays data');
  assert.deepEqual(llmRuntime.disclosure!('brief'), { en: 'Model Co' });
  await assert.rejects(llmRuntime.complete('nope', []), (e) => (e as { status?: number }).status === 503);
  assert.deepEqual(withInstructions([{ role: 'user', content: 'x' }], { label: 'Lou', instructions: null })[0]!.content.split('\n')[0], 'You are Lou, a helpful assistant.');
});

test('Settings fields and ids', () => {
  assert.deepEqual(llmAgentFields({ label: '  Mon   agent ', instructions: ' Sois bref. ', color: '#2F8A7A' }), { label: 'Mon agent', color: '#2f8a7a', description: null, instructions: 'Sois bref.' });
  for (const [body, error] of [
    [{ instructions: 'x' }, 'bad_label'],
    [{ label: 'x'.repeat(41), instructions: 'x' }, 'bad_label'],
    [{ label: 'a', instructions: 'x'.repeat(4001) }, 'bad_instructions'],
    [{ label: 'a', instructions: 'x', color: 'red' }, 'bad_request'],
    [{ label: 'a', instructions: 'x', access: 'full' }, 'bad_request'],
  ] as const) assert.deepEqual(llmAgentFields(body as Record<string, unknown>), { error }, JSON.stringify(body));
  assert.equal(idFor('Élodie & Co', new Set()), 'elodie-co');
  assert.equal(idFor('Brief', new Set(['brief'])), 'brief-2');
  assert.equal(idFor('123', new Set()), 'agent');
});

// ── Through the app: Settings → Agents (llm), and the agent in a chat ────────

const llmBuilt = packages.some((p) => p.id === 'llm');
test('the Settings routes: list, add, change, remove, behind the step-up; the agent offered in chats, limited for sure', { skip: llmBuilt ? false : 'the build has no llm package' }, async () => {
  const hermesUrl = process.env.KLATCHLY_HERMES_URL;
  delete process.env.KLATCHLY_HERMES_URL;
  resetLlmAgentsForTests([]);
  const r = new Registry(packages);
  const app = createApp(r);
  await r.start();
  setLlm(() => fakeLlm); // in place of the build's llm provider (the runtime itself comes from the registry)
  const sid = store.mutate((s) => sessions.create(s));
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(`/api/chatagent${path}`, { method, headers: { cookie: `sid=${sid}`, origin: 'http://localhost:3095', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    assert.deepEqual((await call('/llm-agents')).body.agents, []);
    const added = await call('/llm-agents', 'POST', { label: 'Brief', instructions: 'One sentence.', description: 'Short answers' });
    assert.equal(added.status, 200);
    assert.equal((added.body.agent as { id: string }).id, 'brief');
    const list = (await call('/llm-agents')).body as { agents: { id: string; source: string; disclosure: unknown }[] };
    assert.deepEqual(list.agents.map((a) => [a.id, a.source, a.disclosure]), [['brief', 'settings', { en: 'Model Co' }]]);
    assert.ok(uses.has('agents.brief'), 'listed on Default models');
    // Offered in chats, with what Klatchly guarantees about it.
    const chat = (await call('/agents')).body as { agents: { name: string; access: string; guaranteed: boolean; disclosure: unknown }[] };
    assert.deepEqual(chat.agents.find((a) => a.name === 'brief'), { ...chat.agents.find((a) => a.name === 'brief')!, access: 'limited', guaranteed: true, disclosure: { en: 'Model Co' } });
    // No runtime keeps conversations here: no Agents space.
    assert.equal((await app.request('/api/agents/agents', { headers: { cookie: `sid=${sid}`, origin: 'http://localhost:3095' } })).status, 404);
    assert.equal((await call('/llm-agents/brief', 'PUT', { label: 'Bref' })).body.agent && true, true);
    assert.equal((await call('/llm-agents/nope', 'PUT', { label: 'x' })).status, 404);
    // Changes need a recent sign-in or step-up.
    store.mutate((s) => void (s.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now() - 3600_000));
    for (const [path, method, body] of [['/llm-agents', 'POST', { label: 'X', instructions: 'x' }], ['/llm-agents/brief', 'PUT', { label: 'Y' }], ['/llm-agents/brief', 'DELETE', undefined]] as const) {
      const res = await call(path, method, body);
      assert.deepEqual([res.status, res.body.error], [403, 'step_up'], `${method} ${path}`);
    }
    store.mutate((s) => void (s.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now()));
    assert.equal((await call('/llm-agents/brief', 'DELETE')).status, 200);
    assert.ok(!uses.has('agents.brief'));
  } finally {
    await r.stop();
    if (hermesUrl) process.env.KLATCHLY_HERMES_URL = hermesUrl;
  }
});
