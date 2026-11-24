import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { setManifestForTests } from '../server/manifest.js';
import { setRuntimes } from '../server/runtimes.js';
import { resetSpaceStateForTests, setSpace, spaceRoutes, validForeignID } from '../server/space.js';
import { fakeRuntime, useFakeRuntimes } from './fake.js';

// agents 3.1 over the runtime capabilities of extension API 1.19 (server/space.ts): conversations started elsewhere
// (otherSources: listed "ext_…" with their source, read-only, unread counts of their own), Klatchly's read state told to
// the runtime (readSync, best effort), the scheduled tasks (jobs; paused and resumed with jobsControl, agents 3.2).
// Stand-in runtimes (test/fake.ts).

const S1 = 'klatchly_20261029_120000_0a1b2c3d';
const TG = '20261111_084000_7e1a2b';
const CLI = '20261108_220000_c1c1c1';
const caps = { otherSources: true, jobs: true, readSync: true, jobsControl: true };
const hermes = fakeRuntime('hermes', [{ id: 'default', label: 'Hermes' }, { id: 'assistant', label: 'Assistant' }], { mainAgent: 'default', ...caps });
// The same runtime shape without the 1.19 capabilities (a runtime written for 1.17).
const older = fakeRuntime('hermes', [{ id: 'default', label: 'Hermes' }], { mainAgent: 'default' });

// Read-only tasks: jobs without jobsControl (a runtime written for 1.19).
const listOnly = fakeRuntime('hermes', [{ id: 'default', label: 'Hermes' }], { mainAgent: 'default', jobs: true });

const app = new Hono().route('/api/agents', spaceRoutes);
const json = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
type Row = { id: string; agent: string; source?: string; readOnly?: boolean; unread: number; title: string | null; preview: string | null };
const list = async () => ((await (await json('GET', '/api/agents/sessions')).json()) as { sessions: Row[] }).sessions;
const tick = () => new Promise((r) => setTimeout(r, 20));
const marks = () => hermes.calls.filter((c) => c.op === 'markRead').map((c) => [c.agent, c.id, c.body]);

beforeEach(() => {
  setManifestForTests(null);
  hermes.calls.length = 0;
  hermes.runs.length = 0;
  hermes.failOthers(null);
  hermes.failJobs(null);
  for (const x of hermes.conversations()) hermes.runtime.conversations!.remove(x.agent, x.c.id);
  hermes.clearOthers();
  hermes.addConversation('default', { id: S1, title: 'Pong', lastActive: 2000, messages: 2 });
  hermes.addOther('default', { id: TG, source: 'telegram', title: 'Livraison colis', preview: 'Demain matin', lastActive: 5000, messages: 4 }, [
    { kind: 'user', id: '1', ts: 4000, text: 'Le colis arrive quand ?', images: 0 },
    { kind: 'assistant', id: '2', ts: 5000, text: 'Demain matin.' },
  ]);
  hermes.addOther('default', { id: CLI, source: 'cli', title: 'Débogage', lastActive: 1000, messages: 2 });
  hermes.addOther('assistant', { id: '../evil', source: 'telegram', messages: 1 });
  hermes.addOther('assistant', { id: '20261111_000000_bad000', source: 'Bad Source', messages: 1 });
  hermes.setJobs('default', [{ id: 'a1', name: 'Veille', schedule: '0 7 * * *', state: 'scheduled', lastRun: 3000, lastStatus: 'ok', nextRun: 9000 }]);
  hermes.setJobs('assistant', [{ id: 'b2', name: 'Récap', schedule: 'every 120m', state: 'paused', lastRun: 4000, lastStatus: 'failed', nextRun: null }]);
  useFakeRuntimes({ hermes: hermes.runtime });
  resetSpaceStateForTests();
  setSpace(true, () => undefined);
});
after(() => {
  setSpace(false);
  setRuntimes(undefined);
  setManifestForTests(undefined);
});

test('ids: "ext_" + the runtime\'s id for conversations started elsewhere; never a path', () => {
  assert.ok(validForeignID(`ext_${TG}`));
  for (const bad of [TG, 'ext_', 'ext_../x', 'ext_a/b', `ext_${'a'.repeat(81)}`, S1, 'ext_-x', 42]) assert.ok(!validForeignID(bad), String(bad));
});

test('list: Klatchly\'s conversations and those started elsewhere, read-only, with their source; odd ids and sources dropped', async () => {
  const rows = await list();
  assert.deepEqual(rows.map((r) => [r.id, r.source ?? 'klatchly', r.readOnly === true]), [
    [`ext_${TG}`, 'telegram', true],
    [S1, 'klatchly', false],
    [`ext_${CLI}`, 'cli', true],
  ]);
  const tg = rows[0]!;
  assert.deepEqual([tg.agent, tg.title, tg.preview, tg.unread], ['default', 'Livraison colis', 'Demain matin', 0], 'first seen: read');
});

test('capabilities: a runtime without otherSources lists only Klatchly\'s conversations; a failing listing never hides them', async () => {
  useFakeRuntimes({ hermes: older.runtime });
  older.addConversation('default', { id: S1, title: 'Pong' });
  assert.deepEqual((await list()).map((r) => r.id), [S1]);
  assert.ok(!older.calls.some((c) => c.op === 'listOther'));
  useFakeRuntimes({ hermes: hermes.runtime });
  hermes.failOthers(Object.assign(new Error('x'), { status: 502 }));
  assert.deepEqual((await list()).map((r) => r.id), [S1]);
});

test('unread of a conversation started elsewhere: the messages since it was last seen; opening it reads it and tells the runtime', async () => {
  await list();
  hermes.addOther('default', { id: TG, source: 'telegram', title: 'Livraison colis', preview: 'Le livreur a appelé', lastActive: 6000, messages: 6 });
  const tg = (await list()).find((r) => r.id === `ext_${TG}`)!;
  assert.equal(tg.unread, 2);
  const r = await json('GET', `/api/agents/sessions/ext_${TG}/messages`);
  assert.equal(r.status, 200);
  const b = (await r.json()) as { items: { kind: string }[]; readOnly: boolean; source: string; run: unknown; agent: string };
  assert.deepEqual([b.readOnly, b.source, b.run, b.agent], [true, 'telegram', null, 'default']);
  assert.deepEqual(b.items.map((i) => i.kind), ['user', 'assistant']);
  assert.equal((await list()).find((x) => x.id === `ext_${TG}`)!.unread, 0);
  await tick();
  assert.deepEqual(marks(), [['default', TG, true]], 'the runtime id, read');
  // Opened again with nothing new: nothing more to tell.
  await json('GET', `/api/agents/sessions/ext_${TG}/messages`);
  await tick();
  assert.equal(marks().length, 1);
});

test('read-only: nothing is sent, renamed, pinned, deleted or given helpers in a conversation started elsewhere (403), and the runtime is never asked', async () => {
  await list();
  const id = `ext_${TG}`;
  for (const [method, path, body] of [
    ['POST', `/api/agents/sessions/${id}/messages`, { text: 'Réponds juste : pong' }],
    ['PATCH', `/api/agents/sessions/${id}`, { title: 'x' }],
    ['PATCH', `/api/agents/sessions/${id}`, { pinned: true }],
    ['DELETE', `/api/agents/sessions/${id}`, undefined],
    ['PUT', `/api/agents/sessions/${id}/helpers`, { helpers: [] }],
  ] as const) {
    const r = await json(method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.deepEqual(await r.json(), { error: 'read_only' });
  }
  assert.ok(!hermes.calls.some((c) => ['send', 'update', 'remove'].includes(c.op)));
  assert.equal(hermes.runs.length, 0);
  assert.equal((await json('GET', '/api/agents/sessions/ext_20990101_000000_ffffff/messages')).status, 404, 'unknown: not found');
  assert.equal((await json('GET', `/api/agents/sessions/${id}`)).status, 200);
});

test('read sync of Klatchly\'s conversations: unread when a reply lands, read when opened or all marked; only on a change', async () => {
  const r = await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'pong ?' });
  assert.equal(r.status, 200);
  hermes.runs.at(-1)!.emit({ type: 'text', text: 'pong' });
  hermes.runs.at(-1)!.end();
  await tick();
  assert.deepEqual(marks(), [['default', S1, false]]);
  await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'encore ?' });
  hermes.runs.at(-1)!.end();
  await tick();
  assert.equal(marks().length, 1, 'already unread: not told again');
  await json('POST', '/api/agents/sessions/read', {});
  await tick();
  assert.deepEqual(marks().at(-1), ['default', S1, true]);
});

test('mark all as read: conversations started elsewhere too (one agent\'s, with the filter)', async () => {
  await list();
  hermes.addOther('default', { id: TG, source: 'telegram', title: 'Livraison colis', lastActive: 6000, messages: 5 });
  await list();
  const r = (await (await json('POST', '/api/agents/sessions/read', { agent: 'assistant' })).json()) as { marked: number };
  assert.equal(r.marked, 0, 'another agent: untouched');
  const all = (await (await json('POST', '/api/agents/sessions/read', { agent: 'default' })).json()) as { marked: number };
  assert.equal(all.marked, 1);
  assert.equal((await list()).find((x) => x.id === `ext_${TG}`)!.unread, 0);
});

test('a runtime without readSync is never told', async () => {
  useFakeRuntimes({ hermes: older.runtime });
  older.addConversation('default', { id: S1, title: 'Pong' });
  await json('POST', `/api/agents/sessions/${S1}/messages`, { text: 'x' });
  older.runs.at(-1)!.end();
  await tick();
  await json('GET', `/api/agents/sessions/${S1}/messages`);
  assert.ok(!older.calls.some((c) => c.op === 'markRead'));
});

test('jobs: the scheduled tasks of the agents, most recently run first; none from a runtime without the capability', async () => {
  const b = (await (await json('GET', '/api/agents/jobs')).json()) as { jobs: { agent: string; id: string; state: string }[] };
  assert.deepEqual(b.jobs.map((j) => [j.agent, j.id, j.state]), [['assistant', 'b2', 'paused'], ['default', 'a1', 'scheduled']]);
  useFakeRuntimes({ hermes: older.runtime });
  assert.deepEqual(await (await json('GET', '/api/agents/jobs')).json(), { jobs: [] });
});

test('jobs control (agents 3.2): pause and resume a listed task, {agent} only; refused without the capability, for another agent\'s task or a finished one', async () => {
  type J = { agent: string; id: string; state: string; controllable: boolean };
  const listed = ((await (await json('GET', '/api/agents/jobs')).json()) as { jobs: J[] }).jobs;
  assert.ok(listed.every((j) => j.controllable));
  const r = await json('POST', '/api/agents/jobs/a1/pause', { agent: 'default' });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as { job: J }).job, { id: 'a1', name: 'Veille', schedule: '0 7 * * *', state: 'paused', lastRun: 3000, lastStatus: 'ok', nextRun: 9000, agent: 'default', controllable: true });
  const back = await json('POST', '/api/agents/jobs/b2/resume', { agent: 'assistant' });
  assert.equal(((await back.json()) as { job: J }).job.state, 'scheduled');
  assert.deepEqual(hermes.calls.filter((c) => /Job$/.test(c.op)).map((c) => [c.op, c.agent, c.id]), [
    ['pauseJob', 'default', 'a1'],
    ['resumeJob', 'assistant', 'b2'],
  ]);
  hermes.calls.length = 0;
  for (const [path, body, status] of [
    ['/api/agents/jobs/a1/pause', { agent: 'assistant' }, 404], // another agent's task
    ['/api/agents/jobs/zz/pause', { agent: 'default' }, 404],
    ['/api/agents/jobs/a1/pause', { agent: 'ghost' }, 400],
    ['/api/agents/jobs/a1/pause', {}, 400],
    ['/api/agents/jobs/a1/pause', { agent: 'default', name: 'x' }, 400],
    ['/api/agents/jobs/a1/pause', { agent: 'default', prompt: 'x' }, 400],
    ['/api/agents/jobs/a.1/pause', { agent: 'default' }, 400],
    ['/api/agents/jobs/a1/run', { agent: 'default' }, 404],
    ['/api/agents/jobs/a1/delete', { agent: 'default' }, 404],
  ] as const) {
    const res = await json('POST', path, body);
    assert.equal(res.status, status, `${path} ${JSON.stringify(body)}`);
  }
  assert.equal((await json('PATCH', '/api/agents/jobs/a1', { agent: 'default', state: 'paused' })).status, 404);
  assert.equal((await json('DELETE', '/api/agents/jobs/a1')).status, 404);
  assert.ok(!hermes.calls.some((c) => /Job$/.test(c.op)), 'nothing reached the runtime');
  // A finished one-shot task: listed, not controllable.
  hermes.setJobs('default', [{ id: 'c3', name: 'Une fois', schedule: null, state: 'completed', lastRun: 1, lastStatus: 'ok', nextRun: null }]);
  const done = ((await (await json('GET', '/api/agents/jobs')).json()) as { jobs: J[] }).jobs.find((j) => j.id === 'c3')!;
  assert.equal(done.controllable, false);
  assert.equal((await json('POST', '/api/agents/jobs/c3/resume', { agent: 'default' })).status, 404);
  // The runtime fails: its status, no detail.
  hermes.setJobs('default', [{ id: 'a1', name: 'Veille', schedule: null, state: 'scheduled', lastRun: null, lastStatus: null, nextRun: null }]);
  hermes.failJobs(Object.assign(new Error('boom'), { status: 500 }));
  const failed = await json('POST', '/api/agents/jobs/a1/pause', { agent: 'default' });
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'upstream' });
});

test('jobs control: not offered by a runtime without jobsControl (listed, controllable false; 403 not_supported)', async () => {
  listOnly.setJobs('default', [{ id: 'a1', name: 'Veille', schedule: null, state: 'scheduled', lastRun: null, lastStatus: null, nextRun: null }]);
  useFakeRuntimes({ hermes: listOnly.runtime });
  const b = (await (await json('GET', '/api/agents/jobs')).json()) as { jobs: { id: string; controllable: boolean }[] };
  assert.deepEqual(b.jobs.map((j) => [j.id, j.controllable]), [['a1', false]]);
  const r = await json('POST', '/api/agents/jobs/a1/pause', { agent: 'default' });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'not_supported' });
  assert.equal(listOnly.runtime.pauseJob, undefined);
});

test('jobs control: rate-limited per client', async () => {
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await json('POST', '/api/agents/jobs/a1/' + (i % 2 ? 'resume' : 'pause'), { agent: 'default' })).status;
  assert.equal(last, 429);
});
