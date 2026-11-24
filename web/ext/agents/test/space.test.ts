import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { setView, spaceViewedBy } from '#core/ws.js';
import { wireMessage, type Payload } from '#core/push.js';
import { agentsSpace } from '../package.js';
import { setManifestForTests } from '../server/manifest.js';
import { setRuntimes } from '../server/runtimes.js';
import {
  approvalPayload,
  chatMessage,
  helpersBody,
  inboundPayload,
  newSessionID,
  notificationText,
  receiveFollowUp,
  replyPayload,
  resetSpaceStateForTests,
  sessionPatch,
  setSpace,
  spaceRoutes,
  spaceShown,
  validSessionID,
} from '../server/space.js';
import { fakeRuntime, NONE, useFakeRuntimes } from './fake.js';

// The Agents space over the agent runtime contract (server/space.ts), on stand-in runtimes (test/fake.ts): its
// conversations and their owners, runs followed on the server and streamed to any browser, what the space offers
// by the runtime's capabilities, helpers, what agents post (inbound, inboxes), unread counts and notifications.
// Hermes' protocol behind the contract is ext/hermes/test/runtime.test.ts.

const S1 = 'klatchly_20261029_120000_0a1b2c3d';
const S2 = 'klatchly_20261029_130000_deadbeef';
// Made before 0.26.1, under the app's former name: still a conversation of Klatchly's.
const S3 = 'beep_20261030_090000_a55157a0';

const hermes = fakeRuntime(
  'hermes',
  [
    { id: 'default', label: 'Hermes', helpers: ['assistant'] },
    { id: 'assistant', label: 'Assistant', description: 'Mails : tri, résumés, brouillons', inbox: 'Récaps mails' },
    { id: 'ghost', label: 'Ghost' },
    { id: 'chat', label: 'Agent', space: false },
  ],
  { mainAgent: 'default' },
);
// A runtime that keeps nothing: its agents are for chats only (the llm runtime's shape).
const plain = fakeRuntime('llm', [{ id: 'brief', label: 'Brief', space: false }], { ...NONE });

const app = new Hono().route('/api/agents', spaceRoutes);
const json = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const frames: { type: string; sessionId?: unknown; status?: unknown }[] = [];
const tick = () => new Promise((r) => setTimeout(r, 20));
const post = (agent: string, conversation: string | null, text: string, id: string | null = null) => hermes.post({ agent, id, conversation, text });

beforeEach(() => {
  setManifestForTests(null);
  hermes.calls.length = 0;
  hermes.runs.length = 0;
  for (const x of hermes.conversations()) hermes.runtime.conversations!.remove(x.agent, x.c.id);
  hermes.addConversation('default', { id: S1, title: 'Pong', preview: 'Réponds juste : pong', lastActive: 2000, messages: 2 });
  hermes.addConversation('default', { id: S2, preview: 'Rappel', lastActive: 3000, messages: 1 });
  hermes.addConversation('default', { id: '20260608_001827_4d6da4', title: 'Telegram chat', lastActive: 9000 });
  hermes.addConversation('assistant', { id: S3, title: 'Mails du jour', lastActive: 2500, messages: 4 });
  hermes.setDown('assistant', false);
  hermes.setDown('ghost');
  useFakeRuntimes({ hermes: hermes.runtime, llm: plain.runtime });
  resetSpaceStateForTests();
  setSpace(true, (f) => void frames.push(f));
  frames.length = 0;
});
after(() => {
  setSpace(false);
  setRuntimes(undefined);
  setManifestForTests(undefined);
});

/** Reads an SSE response until `until` is seen. */
async function readSse(res: Response, until: string): Promise<{ event: string; data: unknown }[]> {
  const out: { event: string; data: unknown }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data === undefined) continue;
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      out.push({ event, data: JSON.parse(data) });
      if (event === until) {
        await reader.cancel();
        return out;
      }
    }
  }
  return out;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('session IDs: only Klatchly-made ones are valid ("beep_…" before 0.26.1 still are)', () => {
  assert.match(newSessionID(new Date(Date.UTC(2026, 9, 29, 12, 0, 0))), /^klatchly_20261029_120000_[0-9a-f]{8}$/);
  for (const ok of [S1, S3, newSessionID()]) assert.ok(validSessionID(ok), ok);
  for (const bad of ['other_20261029_120000_0a1b2c3d', 'beepx_20261029_120000_0a1b2c3d', 'klatchly_20261029_120000_0a1b2c3']) assert.ok(!validSessionID(bad), bad);
  for (const bad of ['api_1793275455_772c09d4', '20260608_001827_4d6da4', `${S1}/../x`, `${S1}x`, '', 42, null]) assert.ok(!validSessionID(bad), String(bad));
});

test('chat body: text, up to 4 small images as data URLs, nothing else', () => {
  const img = `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`;
  assert.deepEqual(chatMessage({ text: 'Réponds juste : pong' }), { text: 'Réponds juste : pong', images: [] });
  assert.deepEqual(chatMessage({ text: '  ', images: [img] }), { text: '  ', images: [img] });
  for (const bad of [
    null,
    {},
    { text: '   ' },
    { text: 'x', model: 'other' },
    { text: 'x'.repeat(20_001) },
    { text: 'x', images: [img, img, img, img, img] },
    { text: 'x', images: ['https://example.org/a.jpg'] },
    { text: 'x', images: ['data:image/svg+xml;base64,PHN2Zz4='] },
    { text: 'x', images: [`data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 10).toString('base64')}`] },
  ]) {
    assert.equal(chatMessage(bad as Record<string, unknown> | null), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('rename / pin and helpers bodies', () => {
  assert.deepEqual(sessionPatch({ title: '  Courses \n de la semaine  ' }), { title: 'Courses de la semaine' });
  for (const bad of [{}, null, { title: 'x'.repeat(121) }, { title: 3 }, { pinned: 'yes' }, { archived: true }]) assert.equal(sessionPatch(bad as Record<string, unknown> | null), null, JSON.stringify(bad));
  for (const bad of [null, {}, { helpers: 'assistant' }, { helpers: ['../x'] }, { helpers: [], x: 1 }, { helpers: Array(9).fill('a') }]) assert.equal(helpersBody(bad as Record<string, unknown> | null), null, JSON.stringify(bad));
  assert.deepEqual(helpersBody({ helpers: ['assistant', 'assistant'] }), ['assistant']);
});

test('notifications: one line, the agent named, navigate to the conversation; withheld from a device on the space', () => {
  assert.equal(notificationText('**Fait** : voir [le lien](https://x.org)\n\n```\ncode\n```\n# fin'), 'Fait : voir le lien fin');
  const nav = (p: Payload) => (wireMessage(p, { declarative: true }).notification as { navigate: string }).navigate;
  assert.equal(nav(approvalPayload('k1', S1, 'rm -rf', 'fr', 'Hermes')), `http://localhost:3095/agents/${S1}`);
  assert.deepEqual([approvalPayload('k1', S1, 'rm', 'en', 'Lou').title, approvalPayload('k1', S1, 'rm', 'fr', 'Lou').body], ['Lou asks for permission', "Lou demande l'autorisation : rm"]);
  assert.equal(replyPayload(S1, '**pong**', 'Hermes')!.body, 'pong');
  assert.equal(replyPayload(S1, '   ', 'Hermes'), null);
  assert.equal(nav(inboundPayload({ id: 'i1', sessionId: null, text: 'Rappel', ts: 5 })), 'http://localhost:3095/agents');
  assert.equal(inboundPayload({ id: 'i1', sessionId: null, text: 'Rappel', ts: 5 }).title, 'Hermes', 'no agent: the main one');
  const w = {};
  setView(w, 'pc', { visible: true, focused: true, chatID: null, space: agentsSpace.id });
  assert.equal(spaceViewedBy('pc', agentsSpace.id), true);
  setView(w, 'pc', null);
});

// ── Capabilities ─────────────────────────────────────────────────────────────

test('the space shows only with a runtime that keeps conversations and offers an agent there', () => {
  assert.equal(spaceShown(), true);
  useFakeRuntimes({ llm: plain.runtime });
  assert.equal(spaceShown(), false, 'a runtime without conversations: no space');
  useFakeRuntimes({});
  assert.equal(spaceShown(), false);
  const onlyChats = fakeRuntime('hermes', [{ id: 'chat', space: false }]);
  useFakeRuntimes({ hermes: onlyChats.runtime });
  assert.equal(spaceShown(), false, 'no agent offered in the space');
});

test('agents of the space: what their runtime can do there; the main agent', async () => {
  const b = (await (await json('GET', '/api/agents/agents')).json()) as { main: string; agents: { name: string; available: boolean; helpers: string[]; features: Record<string, boolean> }[] };
  assert.equal(b.main, 'default');
  assert.deepEqual(b.agents.map((a) => [a.name, a.available, a.helpers]), [['default', true, ['assistant']], ['assistant', true, []], ['ghost', false, []]], 'not the chats-only agents, nor the llm runtime\'s');
  assert.deepEqual(b.agents[0]!.features, { stop: true, images: true, organize: true, helpers: true, approvals: true });
  const limited = fakeRuntime('hermes', [{ id: 'solo', helpers: ['other'] }, { id: 'other' }], { stop: false, images: false, organize: false, helpers: false, approvals: false });
  useFakeRuntimes({ hermes: limited.runtime });
  const c = (await (await json('GET', '/api/agents/agents')).json()) as { main: string; agents: { name: string; helpers: string[]; features: Record<string, boolean> }[] };
  assert.equal(c.main, 'solo', 'no main agent: the first of the space');
  assert.deepEqual(c.agents[0]!.features, { stop: false, images: false, organize: false, helpers: false, approvals: false });
  assert.deepEqual(c.agents[0]!.helpers, [], 'no helpers without the capability');
  // What it cannot do is refused.
  limited.addConversation('solo', { id: S1 });
  const img = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
  assert.equal((await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'x', images: [img] })).status, 400, 'no images');
  assert.equal((await json('PATCH', `/api/agents/sessions/${S1}`, { title: 'x' })).status, 409, 'no rename');
  assert.equal((await json('PUT', `/api/agents/sessions/${S1}/helpers`, { helpers: ['other'] })).status, 400, 'no helpers');
  const { run } = (await (await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'x' })).json()) as { run: string };
  await tick();
  assert.deepEqual(await (await json('POST', `/api/agents/runs/${run}/stop`, {})).json(), { error: 'unsupported' });
  limited.runs[0]!.end();
});

// ── Conversations ────────────────────────────────────────────────────────────

test('list: Klatchly conversations of every agent of the space that is up, pinned then newest; the down ones named', async () => {
  const b = (await (await json('GET', '/api/agents/sessions')).json()) as { sessions: { id: string; agent: string }[]; main: string; down: string[] };
  assert.deepEqual(b.sessions.map((s) => [s.id, s.agent]), [[S2, 'default'], [S3, 'assistant'], [S1, 'default']]);
  assert.equal(b.main, S2);
  assert.deepEqual(b.down, ['ghost']);
  hermes.setDown('assistant');
  const c = (await (await json('GET', '/api/agents/sessions')).json()) as { sessions: { id: string }[]; down: string[] };
  assert.deepEqual(c.sessions.map((s) => s.id), [S2, S1]);
  assert.deepEqual(c.down, ['assistant', 'ghost']);
});

test('create: on the main agent by default, or on an agent of the space that is up', async () => {
  for (const agent of ['ghost', 'nope', '../default', 'Assistant', 'chat', 'brief', 42]) assert.equal((await json('POST', '/api/agents/sessions', { agent })).status, 400, String(agent));
  const a = (await (await json('POST', '/api/agents/sessions', {})).json()) as { session: { id: string; agent: string } };
  assert.ok(validSessionID(a.session.id));
  assert.equal(a.session.agent, 'default');
  assert.equal(((await (await json('GET', '/api/agents/sessions')).json()) as { main: string }).main, a.session.id, 'the current one');
  const b = (await (await json('POST', '/api/agents/sessions', { agent: 'assistant' })).json()) as { session: { id: string; agent: string } };
  assert.equal(b.session.agent, 'assistant');
  assert.notEqual(((await (await json('GET', '/api/agents/sessions')).json()) as { main: string }).main, b.session.id, 'only the main agent\'s is current');
});

test('routing: a conversation is found on its agent, remembered; unknown and foreign ids are 404', async () => {
  const r = await json('GET', `/api/agents/sessions/${S3}/messages`);
  assert.equal(((await r.json()) as { agent: string }).agent, 'assistant');
  for (const [m, p] of [
    ['GET', '/api/agents/sessions/20260608_001827_4d6da4/messages'],
    ['GET', '/api/agents/sessions/klatchly_20261030_090000_ffffffff/messages'],
    ['POST', '/api/agents/sessions/..%2F..%2Fapi%2Fjobs/messages'],
    ['GET', '/api/agents/runs/abc/events'],
  ] as const) assert.equal((await json(m, p, m === 'POST' ? { text: 'x' } : undefined)).status, 404, `${m} ${p}`);
  assert.equal((await json('PATCH', `/api/agents/sessions/${S3}`, { title: 'Tri' })).status, 200);
  assert.deepEqual(hermes.calls.find((c) => c.op === 'update'), { op: 'update', agent: 'assistant', id: S3, body: { title: 'Tri' } });
  assert.equal((await json('DELETE', `/api/agents/sessions/${S3}`)).status, 200);
  assert.ok(!hermes.conversations().some((x) => x.c.id === S3));
});

test('a turn: followed on the server, streamed to any client; approval relayed once/deny only; stop', async () => {
  const r = await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'Réponds juste : pong' });
  const { run } = (await r.json()) as { run: string };
  await tick();
  const fr = hermes.runs[0]!;
  assert.deepEqual([fr.agent, fr.id, fr.message], ['default', S1, { text: 'Réponds juste : pong', images: [] }]);
  assert.equal((await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'encore' })).status, 409, 'one turn at a time');
  fr.emit({ type: 'delta', delta: 'po' });
  await tick();
  const reading = readSse(await app.request(`/api/agents/runs/${run}/events`), 'end');
  await tick();
  fr.emit({ type: 'delta', delta: 'ng' });
  fr.emit({ type: 'tool', name: 'terminal', state: 'running' });
  fr.emit({ type: 'approval', approval: { command: 'chmod 777 /tmp/x', description: 'perms', choices: ['once', 'deny'] } });
  await tick();
  assert.equal((await json('POST', `/api/agents/runs/${run}/approval`, { choice: 'always' })).status, 400, 'never widened');
  assert.equal((await json('POST', `/api/agents/runs/${run}/approval`, { choice: 'deny' })).status, 200);
  assert.deepEqual(fr.approvals, ['deny']);
  assert.equal((await json('POST', `/api/agents/runs/${run}/approval`, { choice: 'once' })).status, 409, 'answered: none pending');
  assert.equal((await json('POST', `/api/agents/runs/${run}/stop`, {})).status, 200);
  assert.equal(fr.stops, 1);
  fr.emit({ type: 'tool', name: 'terminal', state: 'failed' });
  fr.emit({ type: 'text', text: 'pong' });
  fr.emit({ type: 'status', status: 'completed' });
  fr.end();
  const evs = await reading;
  assert.deepEqual(evs[0], { event: 'snapshot', data: { status: 'running', text: 'po', tools: [], approval: null, error: null } });
  for (const n of ['delta', 'tools', 'approval', 'text', 'end']) assert.ok(evs.some((e) => e.event === n), n);
  const end = evs.at(-1)!.data as { status: string; text: string; tools: { state: string }[] };
  assert.deepEqual([end.status, end.text, end.tools[0]!.state], ['completed', 'pong', 'failed']);
  const late = await readSse(await app.request(`/api/agents/runs/${run}/events`), 'end');
  assert.deepEqual(late.map((e) => e.event), ['snapshot', 'end']);
  const l = (await (await json('GET', '/api/agents/sessions')).json()) as { sessions: { id: string; unread: number; preview: string; own: boolean }[] };
  const row = l.sessions.find((s) => s.id === S1)!;
  assert.deepEqual([row.unread, row.preview, row.own], [1, 'pong', false], 'the reply counts as unread, previewed');
});

test('a run whose stream fails ends as failed', async () => {
  const { run } = (await (await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'x' })).json()) as { run: string };
  await tick();
  hermes.runs[0]!.end(Object.assign(new Error('fake 502'), { status: 502 }));
  const end = (await readSse(await app.request(`/api/agents/runs/${run}/events`), 'end')).at(-1)!.data as { status: string; error: string };
  assert.deepEqual([end.status, end.error], ['failed', 'upstream 502']);
});

test('group: helpers stored per conversation, only those the lead may use, given to the runtime at each turn', async () => {
  assert.equal((await json('PUT', `/api/agents/sessions/${S3}/helpers`, { helpers: ['default'] })).status, 400, 'the assistant may not lead');
  assert.equal((await json('PUT', `/api/agents/sessions/${S1}/helpers`, { helpers: ['ghost'] })).status, 400);
  assert.deepEqual(await (await json('PUT', `/api/agents/sessions/${S1}/helpers`, { helpers: ['assistant'] })).json(), { helpers: ['assistant'] });
  assert.deepEqual(((await (await json('GET', `/api/agents/sessions/${S1}/messages`)).json()) as { helpers: string[] }).helpers, ['assistant']);
  await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'Demande à assistant' });
  await tick();
  assert.deepEqual(hermes.runs[0]!.helpers, ['assistant']);
  hermes.runs[0]!.end();
  await tick();
  // A helper's late result (the runtime's follow-up): preview, unread, a ping to the browsers.
  receiveFollowUp({ agent: 'default', conversation: S1, key: '5', results: [{ agent: 'assistant', ok: true, text: 'pong' }] });
  const l = (await (await json('GET', '/api/agents/sessions')).json()) as { sessions: { id: string; unread: number; preview: string }[] };
  const row = l.sessions.find((s) => s.id === S1)!;
  assert.match(row.preview, /^Assistant : pong/);
  assert.equal(row.unread, 2);
  assert.ok(frames.some((f) => f.type === 'agents.inbound' && f.sessionId === S1));
  hermes.followUp({ agent: 'default', conversation: S2, key: '6', results: [] });
  assert.ok(frames.some((f) => f.type === 'agents.inbound' && f.sessionId === S2), 'the runtime reaches the space through onFollowUp');
});

test('mark all as read: every conversation, or only one agent\'s', async () => {
  await post('default', S1, 'Un');
  await post('assistant', null, 'Deux');
  assert.equal(((await (await json('POST', '/api/agents/sessions/read', { agent: 'default' })).json()) as { marked: number }).marked, 1);
  assert.equal(((await (await json('POST', '/api/agents/sessions/read', {})).json()) as { marked: number }).marked, 1);
});

// ── Inbound (agent -> Klatchly) ──────────────────────────────────────────────────

test('inbound from the main agent: the current conversation, shown in its history, mirrored only between turns', async () => {
  const created = ((await (await json('POST', '/api/agents/sessions', {})).json()) as { session: { id: string } }).session.id;
  assert.deepEqual(await post('default', 'main', 'Bonjour', 'm0'), { ok: true, mirror: created });
  assert.deepEqual(await post('default', S1, 'Rappel', 'm1'), { ok: true, mirror: S1 }, 'a conversation it names');
  assert.deepEqual(await post('default', 'main', 'again', 'm1'), { ok: true, duplicate: true, mirror: null });
  const h = (await (await json('GET', `/api/agents/sessions/${S1}/messages`)).json()) as { items: { kind: string; text: string }[] };
  assert.deepEqual(h.items.map((i) => [i.kind, i.text]), [['inbound', 'Rappel']]);
  await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'x' });
  assert.deepEqual(await post('default', S1, 'pendant un tour', 'm2'), { ok: true, mirror: null }, 'not during a turn');
  hermes.runs[0]!.end();
  for (const text of ['', 'x'.repeat(20_001)]) assert.deepEqual(await post('default', 'main', text), { ok: false, status: 400, error: 'bad_request' });
});

test('inbound from an agent: its own pinned inbox conversation, made once, remade if deleted; never another agent\'s', async () => {
  const first = await post('assistant', 'main', '**Récap du soir** : 3 mails', 'a1');
  assert.ok(first.ok && first.mirror);
  const inbox = (first as { mirror: string }).mirror;
  const made = hermes.conversations().find((x) => x.c.id === inbox)!;
  assert.deepEqual([made.agent, made.c.title, made.c.pinned], ['assistant', 'Récaps mails', true]);
  assert.deepEqual(await post('assistant', S1, 'Alerte : facture', 'a2'), { ok: true, mirror: inbox }, 'not the main agent\'s conversation');
  const l = (await (await json('GET', '/api/agents/sessions')).json()) as { sessions: { id: string; inbox: boolean; unread: number; preview: string }[] };
  const row = l.sessions.find((x) => x.id === inbox)!;
  assert.deepEqual([row.inbox, row.unread, row.preview], [true, 2, 'Alerte : facture']);
  assert.equal((await json('DELETE', `/api/agents/sessions/${inbox}`)).status, 200);
  const again = (await post('assistant', 'main', 'Récap du matin', 'a3')) as { mirror: string };
  assert.notEqual(again.mirror, inbox);
  for (const agent of ['ghost', 'chat', 'nope']) assert.deepEqual(await post(agent, null, 'x'), { ok: false, status: 403, error: 'unknown_agent' }, agent);
});

test('stopped: runtimes no longer hand anything over, running turns end', async () => {
  const { run } = (await (await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'x' })).json()) as { run: string };
  await tick();
  setSpace(false);
  await assert.rejects(post('default', 'main', 'x'), /no consumer/);
  setSpace(true, (f) => void frames.push(f));
  assert.equal((await app.request(`/api/agents/runs/${run}/events`)).status, 404, 'its runs are gone');
  hermes.runs[0]!.end();
});
