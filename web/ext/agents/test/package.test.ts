import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '#core/app.js';
import { onBrowserFrame } from '#core/broadcast.js';
import { chatEventSubscribers, emitChatEvent } from '#core/chatactor.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { fakeSource } from '../../../test/fakesource.js';
import { load, plain, push } from '../../../test/sw-harness.js';
import { packages } from '../../packages.server.js';
import { agentsCatalog, agentsPushText, textIn } from '../locales/index.js';
import { launch } from '../locales/launch.js';
import { agentsSpace } from '../package.js';
import agentsServer from '../server/index.js';
import { resetSpaceStateForTests } from '../server/space.js';
import { resetChatAgentForTests } from '../server/chatagent.js';
import { agentsLabel } from '../server/label.js';

// The agents package in the build: with the hermes runtime (when the build has it) the space and the chat agent;
// without Hermes configured, the chat agent only (the space hidden: no runtime keeps conversations); the space's
// pages, notification targets and log paths; what Hermes posts reaching the space through the provider's own
// listener; the chat agent fed by the core's stream (its catalogs and its two halves: ext/build.test.ts,
// test/boundary.test.ts). Hermes itself is never reached here (no api_server: every upstream call fails, as when
// Hermes is down). The tests that need the hermes package skip on a build without it.

const dir = mkdtempSync(join(tmpdir(), 'klatchly-agents-pkg-'));
const INBOUND_KEY = 'inbound-key-0123456789abcdef';
writeFileSync(join(dir, 'hermes_key'), 'api-key-0123456789\n');
writeFileSync(join(dir, 'hermes_inbound_key'), `${INBOUND_KEY}\n`);
const ENV = {
  KLATCHLY_HERMES_URL: 'http://127.0.0.1:9',
  KLATCHLY_HERMES_KEY_FILE: join(dir, 'hermes_key'),
  KLATCHLY_HERMES_INBOUND_KEY_FILE: join(dir, 'hermes_inbound_key'),
  KLATCHLY_HERMES_PEER: '127.0.0.1',
};

beforeEach(() => {
  Object.assign(process.env, ENV);
  delete process.env.KLATCHLY_HERMES_INBOUND_LISTEN;
  resetSpaceStateForTests();
  resetChatAgentForTests();
});
after(() => {
  for (const k of [...Object.keys(ENV), 'KLATCHLY_HERMES_INBOUND_LISTEN']) delete process.env[k];
});

const sid = store.mutate((s) => sessions.create(s));
const call = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { cookie: `sid=${sid}`, origin: 'http://localhost:3095', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
const statusOf = (r: Registry, id: string) => r.describe().packages.find((p) => p.id === id);

const SPACE = { type: 'space', id: 'agents', path: '/agents', segment: 'klatchly_[0-9a-z_]{1,60}|beep_[0-9a-z_]{1,60}|ext_[0-9A-Za-z][0-9A-Za-z_-]{0,79}|new|overview|automations' };
const withHermes = { skip: packages.some((p) => p.id === 'hermes') ? false : 'the build has no hermes package' };
const withBeeper = { skip: packages.some((p) => p.id === 'beeper') ? false : 'the build has no beeper package' };

test('on with Hermes configured: the space and the chat agent, same pages and API paths as before the packages', withHermes, async () => {
  const r = new Registry(packages);
  const app = createApp(r);
  await r.start();
  assert.deepEqual(statusOf(r, 'hermes'), { id: 'hermes', active: true, modules: [{ type: 'provider', id: 'hermes' }] });
  assert.deepEqual(statusOf(r, 'agents'), { id: 'agents', active: true, modules: [SPACE, { type: 'augmentation', id: 'chatagent' }] });
  // beep_…: a conversation made before 0.26.1, under the app's former name.
  for (const p of ['/agents', '/agents/klatchly_20261029_120000_0a1b2c3d', '/agents/beep_20261029_120000_0a1b2c3d', '/agents/ext_20261111_084000_7e1a2b', '/agents/new', '/agents/overview', '/agents/automations']) assert.equal((await call(app, p)).status, 200, p);
  // The agents home was /agents/agents before agents 3.1: not served (no redirect).
  for (const p of ['/agents/x', '/agents/a/b', '/agents/beep_X', '/agents/klatchly_X', '/agents/agents', '/agents/ext_', '/agents/ext_a.b', '/hermesx']) assert.equal((await call(app, p)).status, 404, p);
  assert.deepEqual(await (await call(app, '/api/agents/status')).json(), { enabled: true });
  // Hermes is down here: the list says so, nothing breaks.
  assert.equal((await call(app, '/api/agents/sessions')).status, 503);
  const agents = (await (await call(app, '/api/chatagent/agents')).json()) as { agents: { name: string; available: boolean }[] };
  assert.deepEqual(agents.agents.map((a) => [a.name, a.available]), [['default', false]]);
  await r.stop();
});

test('without Hermes: the agents package stays on for the chat agent; the space is hidden (no button, no page, no API)', async () => {
  delete process.env.KLATCHLY_HERMES_URL;
  let r = new Registry(packages);
  if (packages.some((p) => p.id === 'hermes')) assert.equal(statusOf(r, 'hermes')!.reason, 'missing config KLATCHLY_HERMES_URL');
  assert.equal(statusOf(r, 'agents')!.active, true);
  const app = createApp(r);
  await r.start();
  assert.deepEqual(statusOf(r, 'agents')!.modules[0], { ...SPACE, hidden: true }, 'the client shows no button');
  for (const p of ['/agents', '/agents/overview', '/agents/automations', '/api/agents/status', '/api/agents/sessions', '/api/agents/jobs']) assert.equal((await call(app, p)).status, 404, p);
  assert.equal((await call(app, '/api/chatagent/agents')).status, 200);
  assert.equal((await call(app, '/api/chatagent/llm-agents')).status, 200);
  await r.stop();
  if (!packages.some((p) => p.id === 'hermes')) return;
  process.env.KLATCHLY_HERMES_URL = ENV.KLATCHLY_HERMES_URL;
  process.env.KLATCHLY_HERMES_INBOUND_LISTEN = 'localhost:8081';
  r = new Registry(packages);
  assert.equal(statusOf(r, 'hermes')!.reason, 'hermes: KLATCHLY_HERMES_INBOUND_LISTEN must be ipv4:port');
});

test('the agents manifest (KLATCHLY_AGENTS_FILE): invalid turns the package off with the field at fault; valid gives Hermes its agents', withHermes, async () => {
  const file = join(dir, 'agents.json');
  process.env.KLATCHLY_AGENTS_FILE = file;
  try {
    writeFileSync(file, JSON.stringify({ version: 1, agents: [{ id: 'chat', access: 'admin' }] }));
    let r = new Registry(packages);
    assert.equal(statusOf(r, 'agents')!.active, false);
    assert.match(statusOf(r, 'agents')!.reason ?? '', /KLATCHLY_AGENTS_FILE: agents\[0\] \(chat\)\.access: must be "limited", "extended" or "full"/);
    assert.equal(statusOf(r, 'hermes')!.active, true, 'the provider stays on');

    writeFileSync(file, JSON.stringify({ version: 1, chatDefault: 'chat', agents: [{ id: 'chat', label: 'Agent', offer: ['chat'], access: 'limited', disclosure: 'here' }] }));
    r = new Registry(packages);
    const app = createApp(r);
    await r.start();
    assert.equal(statusOf(r, 'agents')!.active, true);
    const agents = (await (await call(app, '/api/chatagent/agents')).json()) as { default: string; agents: { name: string; access: string | null; disclosure: unknown }[] };
    assert.equal(agents.default, 'chat');
    assert.deepEqual(agents.agents.map((a) => [a.name, a.access, a.disclosure]), [['chat', 'limited', { en: 'here' }]], "Hermes' own profile (added by the provider) is not offered in chats");
    const space = (await (await call(app, '/api/agents/agents')).json()) as { agents: { name: string }[] };
    assert.deepEqual(space.agents.map((a) => a.name), ['default']);
    await r.stop();
  } finally {
    delete process.env.KLATCHLY_AGENTS_FILE;
  }
});

test('Hermes off but its listener address configured: the app is still never served there', withHermes, async () => {
  delete process.env.KLATCHLY_HERMES_URL;
  process.env.KLATCHLY_HERMES_INBOUND_LISTEN = '127.0.0.1:1';
  const main = createServer((_, res) => res.end('app'));
  await new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve));
  const port = (main.address() as AddressInfo).port;
  const r = new Registry(packages);
  assert.equal(statusOf(r, 'hermes')!.active, false);
  await r.start({ server: main });
  const got = await new Promise<string>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/healthz', agent: false }, (res) => resolve(String(res.statusCode)));
    req.on('error', (e) => resolve(`error ${(e as NodeJS.ErrnoException).code ?? ''}`));
    req.end();
  });
  assert.match(got, /^error /);
  await r.stop();
  await new Promise<void>((resolve) => main.close(() => resolve()));
});

test('notifications open the Agents space (a conversation or its list); other paths do not', withHermes, async () => {
  const sw = load({ links: new Registry(packages).pushLinksScript() });
  await sw.fire('push', push({ title: 'Hermes', body: 'pong', tag: 'agents-x', url: '/agents/klatchly_20261029_120000_0a1b2c3d' }));
  assert.equal((sw.shown[0]![1].data as { url: string }).url, '/agents/klatchly_20261029_120000_0a1b2c3d');
  for (const url of ['/agents', '/agents/klatchly_20261029_120000_0a1b2c3d', '/agents/beep_20261029_120000_0a1b2c3d', '/agents/../api/jobs', '/agents/a/b', '/agents?x=1', '/hermesx']) {
    await sw.fire('notificationclick', { action: '', notification: { data: { url }, close: () => {} } });
  }
  // beep_…: made before 0.26.1, under the app's former name.
  assert.deepEqual(plain(sw.opened), ['/agents', '/agents/klatchly_20261029_120000_0a1b2c3d', '/agents/beep_20261029_120000_0a1b2c3d', '/', '/', '/', '/']);
});

test('the space was /hermes before 3.0: nothing is served there; notifications delivered before open the same place under /agents', withHermes, async () => {
  const r = new Registry(packages);
  const app = createApp(r);
  await r.start();
  for (const p of ['/hermes', '/hermes/beep_20261029_120000_0a1b2c3d', '/hermes/new', '/hermes/agents']) assert.equal((await call(app, p)).status, 404, p);
  for (const p of ['/api/hermes/status', '/api/hermes/sessions', '/api/hermes/agents']) assert.equal((await call(app, p)).status, 404, p);
  assert.equal((await call(app, '/api/agents/status')).status, 200);
  await r.stop();
  const sw = load({ links: new Registry(packages).pushLinksScript() });
  // Shown from a push sent by the old version (a queued one), and clicked from the notification centre.
  await sw.fire('push', push({ title: 'Hermes', body: 'pong', tag: 'hermes-x', url: '/hermes/beep_20261029_120000_0a1b2c3d' }));
  assert.equal((sw.shown[0]![1].data as { url: string }).url, '/agents/beep_20261029_120000_0a1b2c3d');
  const old = ['/hermes', '/hermes/beep_20261029_120000_0a1b2c3d', 'https://klatchly.example/hermes/beep_20261029_120000_0a1b2c3d', '/hermes/new', '/hermes/a/b', '/hermes/../api/jobs', '/hermesx'];
  for (const url of old) await sw.fire('notificationclick', { action: '', notification: { data: { url }, close: () => {} } });
  assert.deepEqual(plain(sw.opened), ['/agents', '/agents/beep_20261029_120000_0a1b2c3d', '/agents/beep_20261029_120000_0a1b2c3d', '/agents/new', '/', '/', '/']);
});

test('log paths keep no conversation, run or draft ids', () => {
  const r = new Registry(packages);
  assert.equal(r.logPath('/api/agents/sessions/klatchly_20261029_120000_0a1b2c3d/messages'), '/api/agents/sessions/:id/messages');
  assert.equal(r.logPath('/api/agents/runs/0123456789abcdef01234567/events'), '/api/agents/runs/:key/events');
  assert.equal(r.logPath('/api/chatagent/drafts/0123456789abcdef/send'), '/api/chatagent/drafts/:id/send');
});

test("what Hermes posts reaches the space through the provider's own listener; the app is not served there", withHermes, async () => {
  const free = createServer();
  await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
  const port = (free.address() as AddressInfo).port;
  await new Promise<void>((resolve) => free.close(() => resolve()));
  process.env.KLATCHLY_HERMES_INBOUND_LISTEN = `127.0.0.1:${port}`;
  const frames: { type: string }[] = [];
  const off = onBrowserFrame((f) => void frames.push(f));
  const r = new Registry(packages);
  await r.start();
  const post = (auth: string, body: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/hermes/inbound', method: 'POST', headers: { 'content-type': 'application/json', authorization: auth } }, (res) => {
        let b = '';
        res.on('data', (d: Buffer) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  assert.equal((await post('Bearer wrong-key-0123456789', { text: 'x' })).status, 404);
  // No conversation can be made (Hermes is down): kept with no conversation, never mirrored.
  const ok = await post(`Bearer ${INBOUND_KEY}`, { id: 'm1', chat: 'main', text: 'Rappel' });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, session_id: null });
  assert.ok(frames.some((f) => f.type === 'agents.inbound'), 'the browsers are told');
  await r.stop();
  off();
  await assert.rejects(post(`Bearer ${INBOUND_KEY}`, { text: 'x' }), 'closed with the packages');
});

// Its chat is Beeper's ('!…'): a build with hermes and beeper.
test("the chat agent gets the core's stream: an own mention calls it (here Hermes is down: logged in its activity)", { skip: withHermes.skip || withBeeper.skip }, async () => {
  // Next to the build's packages, a connector that lets no package send in its chats (other:…).
  const closed = fakeSource({ owns: (id) => id.startsWith('other:'), capabilities: { actorSend: false, flags: [] } }, 'closed');
  const r = new Registry([...packages, closed.pkg]);
  const app = createApp(r);
  await r.start();
  const chat = '!demo:beeper.local';
  assert.equal((await call(app, '/api/chatagent/chat', { method: 'PUT', body: JSON.stringify({ chatID: chat, agent: 'default' }) })).status, 200);
  emitChatEvent({ type: 'message.upserted', entries: [{ id: 'm1', chatID: chat, text: '@hermes une idée ?', isSender: true, type: 'TEXT', timestamp: new Date().toISOString() }] }, 'beeper');
  await new Promise((res) => setTimeout(res, 50));
  const st = (await (await call(app, `/api/chatagent/chat?chatID=${encodeURIComponent(chat)}`)).json()) as { supported: boolean; audit: { kind: string; detail?: string }[] };
  assert.equal(st.supported, true);
  assert.deepEqual(st.audit.slice(0, 2).map((a) => [a.kind, a.detail]), [['error', 'agent_unavailable'], ['settings', 'on:me:draft:disclose']]);
  // A chat whose connector does not allow it (capabilities.actorSend false): refused, and said so.
  assert.equal((await call(app, '/api/chatagent/chat', { method: 'PUT', body: JSON.stringify({ chatID: 'other:u:123' }) })).status, 400);
  assert.equal(((await (await call(app, `/api/chatagent/chat?chatID=${encodeURIComponent('other:u:123')}`)).json()) as { supported: boolean }).supported, false);
  assert.deepEqual(closed.calls, []);
  await r.stop();
});

test('catalogs: plurals and interpolation (their shape: ext/build.test.ts)', () => {
  assert.equal(launch.fr!.agentsUnread(2), 'Agents : 2 conversations non lues');
  assert.equal(agentsPushText.fr!.agentDraft('Agent', 'Famille'), 'Agent · brouillon pour Famille');
  assert.equal(agentsCatalog.fr!.agentSpace.fromAgent('Hermes'), 'Message d’Hermes');
  assert.equal(agentsCatalog.fr!.agentSpace.fromAgent('Lou'), 'Message de Lou');
});

test('privacy line: the chosen agent\'s disclosure, by language, and how many messages go; a warning when not said', () => {
  const disclosure = { en: 'Runtime X, then model Y', fr: 'Runtime X, puis modèle Y' };
  assert.equal(agentsCatalog.fr!.chatAgent.privacy(20, textIn(disclosure, 'fr')), 'Les 20 derniers messages de la discussion partent chez l’agent (Runtime X, puis modèle Y) à chaque appel.');
  assert.equal(agentsCatalog.en!.chatAgent.privacy(20, textIn(disclosure, 'de')), 'The last 20 messages of this chat are sent to the agent (Runtime X, then model Y) at each call.', 'English fallback');
  assert.equal(agentsCatalog.en!.chatAgent.privacy(12, textIn({ fr: 'Z' }, 'de')), 'The last 12 messages of this chat are sent to the agent (Z) at each call.', 'else the first language');
  assert.equal(
    agentsCatalog.fr!.chatAgent.privacy(20, textIn(null, 'fr')),
    'Les 20 derniers messages de la discussion partent chez l’agent à chaque appel ; l’hébergeur n’a pas dit à qui il les transmet.',
    'not said: said so',
  );
});

test('access: what the host declares, the strongest warning when nothing is', () => {
  const en = agentsCatalog.en!.chatAgent;
  assert.equal(en.limited('web search only, no memory'), 'limited: web search only, no memory');
  assert.equal(en.limited(), 'limited');
  assert.equal(en.fullWarning('Hermes', 'files, code, browser, connections…'), 'Hermes has a terminal and all its tools (files, code, browser, connections…).');
  assert.equal(en.extendedWarning('mail, connections, memory…'), 'This agent has more tools than the limited one (mail, connections, memory…).');
  assert.match(en.undeclaredWarning('Lou'), /has not said what Lou can reach: assume a terminal and all its tools/);
});

test('KLATCHLY_AGENTS_LABEL: one name for every language or a JSON object by language (English required), else none', () => {
  const read = (v: string | undefined) => {
    if (v === undefined) delete process.env.KLATCHLY_AGENTS_LABEL;
    else process.env.KLATCHLY_AGENTS_LABEL = v;
    const out = agentsLabel();
    delete process.env.KLATCHLY_AGENTS_LABEL;
    return out;
  };
  assert.equal(read(undefined), null);
  assert.equal(read('  '), null);
  assert.deepEqual(read(' My runtime '), { en: 'My runtime' });
  assert.deepEqual(read('{"en":" A ","fr":"B","pt-BR":"C","bad key":"D","de":"","es":3}'), { en: 'A', fr: 'B', 'pt-BR': 'C' });
  assert.equal(read('{"fr":"B"}'), null, 'no English');
  assert.equal(read('{"en":'), null, 'malformed');
  assert.equal(read('{"en":["A"]}'), null, 'not a name');
});


test('off and on again, twice: its subscription to the chat stream goes with it and comes back once', async () => {
  // Moved from ext/build.test.ts (which names no package; it checks that the count comes back for every package).
  const r = new Registry(packages, process.env);
  await r.start();
  try {
    const subscribers = chatEventSubscribers();
    for (let i = 0; i < 2; i++) {
      assert.equal((await r.setEnabled('agents', false)).ok, true, 'agents off');
      assert.equal(chatEventSubscribers(), subscribers - 1, 'its subscription to the stream is gone');
      assert.equal((await r.setEnabled('agents', true, { withRequired: true })).ok, true, 'agents on');
      assert.equal(chatEventSubscribers(), subscribers, 'subscribed again, once');
    }
  } finally {
    await r.stop();
  }
});
