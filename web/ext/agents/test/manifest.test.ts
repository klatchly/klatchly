import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { ChatActor } from '#core/sdk.js';
import { agentList } from '../server/runtimes.js';
import { chatAgentRoutes, defaultConfig, mergeConfig, ownerName, setChatAgent, setChatAgentDepsForTests } from '../server/chatagent.js';
import { setSpace, spaceRoutes } from '../server/space.js';
import {
  chatDefaultOf,
  entryOf,
  forRuntime,
  fromRuntimes,
  loadManifest,
  ManifestError,
  manifestOf,
  parseManifest,
  readManifest,
  setManifestForTests,
  type Agent,
  type Manifest,
} from '../server/manifest.js';
import { setRuntimes } from '../server/runtimes.js';
import { fakeRuntime, NONE, useFakeRuntimes } from './fake.js';

// The agents manifest (server/manifest.ts): strict validation with the field at fault, the defaults (access not
// declared = the strongest warning), the runtimes ("hermes", "llm" and their rules), the fallback on the runtimes'
// own lists, and what the routes say from it.

const dir = mkdtempSync(join(tmpdir(), 'klatchly-agents-manifest-'));
after(() => {
  delete process.env.KLATCHLY_AGENTS_FILE;
  delete process.env.KLATCHLY_AGENTS_LABEL;
});

const VALID = {
  '//': 'comments are keys that start with //',
  version: 1,
  owner: 'Alex',
  chatDefault: 'helper',
  agents: [
    {
      id: 'default',
      label: 'Main',
      color: '#7A52C7',
      description: { en: 'Main agent', fr: 'Agent principal' },
      offer: ['space', 'chat'],
      access: 'full',
      accessNote: { en: 'terminal, files' },
      helpers: ['mail'],
      disclosure: 'the runtime on this server',
    },
    { id: 'mail', runtime: 'hermes', profile: 'mail', label: 'Mail', description: 'Sorts mail', access: 'extended', inbox: 'Recaps', '// note': 'ignored' },
    { id: 'helper', label: 'Helper', offer: ['chat'], access: 'limited', accessNote: { en: 'web search only', fr: 'recherche web seulement' } },
  ],
};
const parse = (v: unknown) => parseManifest(JSON.stringify(v));
const withAgents = (agents: unknown[], o: Record<string, unknown> = {}) => parse({ version: 1, agents, ...o });
const err = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof ManifestError, String(e));
    return e.message;
  }
  assert.fail('no error');
};

test('valid manifest: every field read, texts by language, defaults for the rest', () => {
  const m = parse(VALID);
  assert.equal(m.source, 'file');
  assert.equal(m.owner, 'Alex');
  assert.equal(m.chatDefault, 'helper');
  assert.deepEqual(m.agents.map((a) => a.id), ['default', 'mail', 'helper']);
  const [main, mail, helper] = m.agents;
  assert.deepEqual(main, {
    id: 'default',
    runtime: 'hermes',
    instructions: null,
    label: 'Main',
    color: '#7a52c7',
    description: { en: 'Main agent', fr: 'Agent principal' },
    offer: ['space', 'chat'],
    helpers: ['mail'],
    inbox: null,
    access: 'full',
    accessNote: { en: 'terminal, files' },
    disclosure: { en: 'the runtime on this server' },
  });
  assert.deepEqual([mail!.description, mail!.offer, mail!.inbox, mail!.color], [{ en: 'Sorts mail' }, ['space', 'chat'], 'Recaps', null], 'a plain string is every language; offered everywhere by default');
  assert.deepEqual([helper!.offer, helper!.access, helper!.disclosure], [['chat'], 'limited', null]);
  // What the hermes runtime is given (AgentRuntime.configure); none for llm.
  assert.deepEqual(forRuntime(m, 'hermes'), [
    { id: 'default', label: 'Main', description: 'Main agent', helpers: ['mail'], space: true, inbox: null, instructions: null },
    { id: 'mail', label: 'Mail', description: 'Sorts mail', helpers: [], space: true, inbox: 'Recaps', instructions: null },
    { id: 'helper', label: 'Helper', description: null, helpers: [], space: false, inbox: null, instructions: null },
  ]);
  assert.deepEqual(forRuntime(m, 'llm'), []);
});

test('defaults: only an id is required; access not declared is null (shown as the strongest)', () => {
  const m = withAgents([{ id: 'solo' }]);
  assert.deepEqual(m.agents[0], {
    id: 'solo',
    runtime: 'hermes',
    instructions: null,
    label: 'solo',
    color: null,
    description: null,
    offer: ['space', 'chat'],
    helpers: [],
    inbox: null,
    access: null,
    accessNote: null,
    disclosure: null,
  });
  assert.deepEqual([m.owner, m.chatDefault], [null, null]);
});

test('invalid manifests: refused, with the field at fault', () => {
  const cases: [unknown, RegExp][] = [
    [{ version: 2, agents: [{ id: 'a' }] }, /^version: required, 1$/],
    [{ agents: [{ id: 'a' }] }, /^version/],
    [{ version: 1, agents: [] }, /^agents: required, a list of 1 to 32/],
    [{ version: 1, agents: [{ id: 'a' }], extra: 1 }, /^manifest: unknown key "extra"/],
    [[1], /^manifest: must be a JSON object/],
    [{ version: 1, agents: ['x'] }, /^agents\[0\]: must be an object/],
    [{ version: 1, agents: [{ id: 'Bad Id' }] }, /^agents\[0\]\.id: required/],
    [{ version: 1, agents: [{ label: 'x' }] }, /^agents\[0\]\.id: required/],
    [{ version: 1, agents: [{ id: 'a', colour: 'red' }] }, /^agents\[0\] \(a\): unknown key "colour"/],
    [{ version: 1, agents: [{ id: 'a' }, { id: 'a' }] }, /^agents \(a\): duplicate id/],
    [{ version: 1, agents: [{ id: 'a', access: 'none' }] }, /^agents\[0\] \(a\)\.access: must be "limited", "extended" or "full"/],
    [{ version: 1, agents: [{ id: 'a', color: 'red' }] }, /\.color: must be "#rrggbb"/],
    [{ version: 1, agents: [{ id: 'a', label: '' }] }, /\.label: must be a non-empty string/],
    [{ version: 1, agents: [{ id: 'a', label: 'x'.repeat(41) }] }, /\.label: at most 40 characters/],
    [{ version: 1, agents: [{ id: 'a', description: { english: 'x' } }] }, /\.description: "english" is not a language code/],
    [{ version: 1, agents: [{ id: 'a', description: {} }] }, /\.description: needs at least one language/],
    [{ version: 1, agents: [{ id: 'a', disclosure: 3 }] }, /\.disclosure: must be a string or an object by language code/],
    [{ version: 1, agents: [{ id: 'a', offer: [] }] }, /\.offer: a non-empty list of "space" and\/or "chat"/],
    [{ version: 1, agents: [{ id: 'a', offer: ['web'] }] }, /\.offer/],
    [{ version: 1, agents: [{ id: 'a', offer: ['chat'], inbox: 'x' }] }, /\.inbox: only for an agent offered in the space/],
    [{ version: 1, agents: [{ id: 'a', runtime: 'letta' }] }, /\.runtime: one of "hermes", "llm"/],
    [{ version: 1, agents: [{ id: 'a', instructions: 'x' }] }, /\.instructions: only for an "llm" agent/],
    [{ version: 1, agents: [{ id: 'a_b', runtime: 'llm' }] }, /\.id: an "llm" agent/],
    [{ version: 1, agents: [{ id: 'a', runtime: 'llm', offer: ['space', 'chat'] }] }, /\.offer: an "llm" agent is offered in chats only/],
    [{ version: 1, agents: [{ id: 'a', runtime: 'llm', access: 'full' }] }, /\.access: an "llm" agent has no tools/],
    [{ version: 1, agents: [{ id: 'a', runtime: 'llm', instructions: 'x'.repeat(4001) }] }, /\.instructions: a non-empty text of at most 4000/],
    [{ version: 1, agents: [{ id: 'a', helpers: ['b'] }, { id: 'b', runtime: 'llm' }] }, /"b" must be another agent of this manifest, on the same runtime/],
    [{ version: 1, agents: [{ id: 'a', profile: 'b' }] }, /\.profile: must be the same as the id for now/],
    [{ version: 1, agents: [{ id: 'a', helpers: ['ghost'] }] }, /^agents \(a\)\.helpers: "ghost" must be another agent of this manifest, on the same runtime, offered in the space/],
    [{ version: 1, agents: [{ id: 'a', helpers: ['a'] }] }, /"a" must be another agent/],
    [{ version: 1, agents: [{ id: 'a', helpers: ['b'] }, { id: 'b', offer: ['chat'] }] }, /"b" must be another agent of this manifest, on the same runtime, offered in the space/],
    [{ version: 1, agents: [{ id: 'a', offer: ['space'] }], chatDefault: 'a' }, /^chatDefault: must be the id of an agent offered in chats/],
    [{ version: 1, agents: [{ id: 'a' }], owner: '' }, /^owner: must be a non-empty string/],
  ];
  for (const [v, re] of cases) assert.match(err(() => parse(v)), re, JSON.stringify(v));
  assert.match(err(() => parseManifest('{"version": 1,')), /^not valid JSON/);
});

test('the llm runtime in the manifest: chats only, limited (guaranteed), its instructions; the hermes rules of "default" are the runtime\'s', () => {
  const m = withAgents([{ id: 'helpdesk', runtime: 'llm', label: 'Helpdesk', instructions: '  Be brief.  ' }, { id: 'default', offer: ['chat'] }]);
  const [llm, main] = m.agents;
  assert.deepEqual([llm!.runtime, llm!.offer, llm!.access, llm!.instructions, llm!.helpers, llm!.inbox], ['llm', ['chat'], 'limited', 'Be brief.', [], null]);
  assert.deepEqual(forRuntime(m, 'llm'), [{ id: 'helpdesk', label: 'Helpdesk', description: null, helpers: [], space: false, inbox: null, instructions: 'Be brief.' }]);
  // "default" outside the space is no longer refused by the manifest: the hermes runtime puts its own profile in the
  // space and never gives it an inbox (ext/hermes/test/runtime.test.ts).
  assert.deepEqual([main!.runtime, main!.offer], ['hermes', ['chat']]);
});

test('the file: read at check and start; unset = the fallback; unreadable, YAML or invalid = an error naming KLATCHLY_AGENTS_FILE', () => {
  delete process.env.KLATCHLY_AGENTS_FILE;
  assert.equal(loadManifest(), null);
  const good = join(dir, 'agents.json');
  writeFileSync(good, JSON.stringify(VALID));
  process.env.KLATCHLY_AGENTS_FILE = good;
  assert.deepEqual(loadManifest()?.agents.map((a) => a.id), ['default', 'mail', 'helper']);
  process.env.KLATCHLY_AGENTS_FILE = join(dir, 'missing.json');
  assert.equal(err(loadManifest), 'KLATCHLY_AGENTS_FILE: cannot read the file (ENOENT)');
  const yaml = join(dir, 'agents.yaml');
  writeFileSync(yaml, 'version: 1\n');
  assert.match(err(() => readManifest(yaml)), /YAML is not supported yet: write the manifest as JSON/);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ version: 1, agents: [{ id: 'a', access: 'root' }] }));
  process.env.KLATCHLY_AGENTS_FILE = bad;
  assert.match(err(loadManifest), /^KLATCHLY_AGENTS_FILE: agents\[0\] \(a\)\.access/);
  delete process.env.KLATCHLY_AGENTS_FILE;
  assert.equal(loadManifest(), null);
});

test('the example manifest (agents.example.json) is valid', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // build-test/ext/agents/test -> ext/agents/agents.example.json in the source tree.
  const src = join(here, '../../../../ext/agents/agents.example.json');
  const m = parseManifest(readFileSync(src, 'utf8'));
  assert.ok(m.agents.length >= 2);
  assert.ok(m.agents.every((a) => a.access !== null), 'the example declares every access');
});

test("fallback without a manifest: the runtimes' own agents (KLATCHLY_HERMES_AGENTS) as given, offered in chats, nothing declared, KLATCHLY_AGENTS_LABEL as disclosure", () => {
  process.env.KLATCHLY_AGENTS_LABEL = '{"en":"Runtime X","fr":"Runtime X (fr)"}';
  const list: Agent[] = [
    { id: 'default', runtime: 'hermes', label: 'Hermes', description: 'Main', helpers: ['assistant'], space: true, inbox: null, instructions: null },
    { id: 'assistant', runtime: 'hermes', label: 'Assistant', description: null, helpers: [], space: true, inbox: 'Recaps', instructions: null },
    { id: 'chat', runtime: 'hermes', label: 'Agent', description: null, helpers: [], space: false, inbox: null, instructions: null },
  ];
  const m = fromRuntimes(list);
  delete process.env.KLATCHLY_AGENTS_LABEL;
  assert.equal(m.source, 'env');
  assert.deepEqual(
    m.agents.map((a) => [a.id, a.offer, a.access, a.disclosure]),
    [
      ['default', ['space', 'chat'], null, { en: 'Runtime X', fr: 'Runtime X (fr)' }],
      ['assistant', ['space', 'chat'], null, { en: 'Runtime X', fr: 'Runtime X (fr)' }],
      ['chat', ['chat'], null, { en: 'Runtime X', fr: 'Runtime X (fr)' }],
    ],
  );
  // No access declared: the first chat agent is the one offered only in chats, never guessed from its name.
  assert.equal(chatDefaultOf(m, m.agents), 'chat');
  assert.equal(chatDefaultOf(fromRuntimes(list.slice(0, 2)), fromRuntimes(list.slice(0, 2)).agents), 'default', 'else the first');
  setManifestForTests(undefined);
  assert.equal(manifestOf(list).source, 'env');
});

test('chat default: chatDefault, else the first declared limited, else the first offered only in chats, else the first', () => {
  const m = parse(VALID);
  assert.equal(chatDefaultOf(m, m.agents), 'helper');
  const noDefault = { ...m, chatDefault: null } satisfies Manifest;
  assert.equal(chatDefaultOf(noDefault, m.agents), 'helper', 'the limited one');
  const two = withAgents([{ id: 'a', access: 'full' }, { id: 'b', offer: ['chat'], access: 'extended' }]);
  assert.equal(chatDefaultOf(two, two.agents), 'b', 'offered only in chats');
  const named = withAgents([{ id: 'x' }, { id: 'chat' }]);
  assert.equal(chatDefaultOf(named, named.agents), 'x', 'a profile named "chat" is nothing special');
});

test('entry of a profile the provider added (Hermes\' own, left out of the file): in the space only, nothing declared', () => {
  const m = withAgents([{ id: 'a', offer: ['chat'] }]);
  const e = entryOf(m, { id: 'default', runtime: 'hermes', label: 'Hermes', description: null, helpers: [], space: true, inbox: null, instructions: null });
  assert.deepEqual([e.offer, e.access, e.disclosure], [['space'], null, null]);
});

// ── Routes, with a manifest ──────────────────────────────────────────────────

test('routes: the manifest decides which agents, their colour, access and disclosure; owner from the manifest', async () => {
  const hermes = fakeRuntime('hermes', [{ id: 'default' }], { mainAgent: 'default' });
  const llm = fakeRuntime('llm', [], { ...NONE });
  const m = parse({ ...VALID, agents: [...VALID.agents, { id: 'brief', runtime: 'llm', label: 'Brief', instructions: 'Be brief.' }] });
  setManifestForTests(m);
  llm.runtime.disclosure = (id) => (id === 'brief' ? { en: 'Model Co' } : null);
  useFakeRuntimes({ hermes: hermes.runtime, llm: llm.runtime });
  const actor: ChatActor = {
    recentMessages: async () => [],
    chat: async () => ({ title: '', type: 'single', network: '', selfName: null, source: 'test', replies: true }),
    canSend: () => true,
    send: async () => ({}),
  };
  setChatAgent(true, actor, () => {});
  setSpace(true);
  setChatAgentDepsForTests({});
  const app = new Hono().route('/api/chatagent', chatAgentRoutes).route('/api/agents', spaceRoutes);
  const chat = (await (await app.request('/api/chatagent/agents')).json()) as {
    default: string;
    contextLines: number;
    agents: { name: string; access: string | null; accessNote: unknown; disclosure: unknown; limited: boolean; guaranteed: boolean; description: unknown }[];
  };
  assert.equal(chat.default, 'helper');
  assert.equal(chat.contextLines, 20);
  assert.deepEqual(
    chat.agents.map((a) => [a.name, a.access, a.limited, a.guaranteed, a.disclosure]),
    [
      ['default', 'full', false, false, { en: 'the runtime on this server' }],
      ['mail', 'extended', false, false, null],
      ['helper', 'limited', true, false, null],
      ['brief', 'limited', true, true, { en: 'Model Co' }],
    ],
    'each runtime configured with its own agents; the llm one limited for sure, its model\'s provider as disclosure',
  );
  assert.deepEqual(chat.agents[0]!.description, { en: 'Main agent', fr: 'Agent principal' });
  assert.deepEqual((llm.calls.find((c) => c.op === 'configure')!.body as { id: string }[]).map((a) => a.id), ['brief']);
  const space = (await (await app.request('/api/agents/agents')).json()) as { main: string; agents: { name: string; color: string | null; helpers: string[] }[] };
  assert.equal(space.main, 'default');
  assert.deepEqual(
    space.agents.map((a) => [a.name, a.color, a.helpers]),
    [
      ['default', '#7a52c7', ['mail']],
      ['mail', null, []],
    ],
    'the space: agents offered there only',
  );
  // A chat's settings: only agents offered in chats; the first one is chatDefault.
  assert.equal(defaultConfig(agentList()).agent, 'helper');
  assert.deepEqual(mergeConfig(null, { agent: 'helper' }, []), { error: 'unknown_agent' }, 'none offered: refused');
  // The owner: the manifest's, before KLATCHLY_AGENTS_OWNER_NAME and the name in the chat.
  process.env.KLATCHLY_AGENTS_OWNER_NAME = 'Env Name';
  assert.equal(ownerName('Chat Name'), 'Alex');
  setManifestForTests({ ...m, owner: null });
  assert.equal(ownerName('Chat Name'), 'Env Name');
  delete process.env.KLATCHLY_AGENTS_OWNER_NAME;
  // An agent no longer offered in chats is not offered there.
  setManifestForTests(withAgents([{ id: 'default', offer: ['space'] }]));
  useFakeRuntimes({ hermes: hermes.runtime, llm: llm.runtime });
  const none = (await (await app.request('/api/chatagent/agents')).json()) as { default: string | null; agents: unknown[] };
  assert.deepEqual([none.default, none.agents.length], [null, 0]);
  setManifestForTests(undefined);
  setChatAgent(false);
  setSpace(false);
  setRuntimes(undefined);
});
