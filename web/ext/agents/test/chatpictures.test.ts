import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { ChatActor, ReadImage } from '#core/sdk.js';
import {
  buildPrompt,
  chatAgentRoutes,
  configFor,
  defaultConfig,
  handleChatAgentEvent,
  MAX_PICTURES,
  mergeConfig,
  picturePrompt,
  readPictures,
  resetChatAgentForTests,
  setChatAgent,
  setChatAgentDepsForTests,
  type ChatAgentConfig,
  type ChatPicture,
  type IncomingMsg,
} from '../server/chatagent.js';
import type { PicturePrompt } from '../server/llmruntime.js';
import { agentList } from '../server/runtimes.js';
import { fakeRuntime, NONE, useFakeRuntimes } from './fake.js';

// The chat agent's images option (agents 3.0): per chat, off by default, only for an agent of the llm runtime; the
// latest pictures among the messages the agent reads (the core's ChatReader.readImage), sent with the prompt
// through llm's completePicturesFor; the privacy line says so.

const CHAT = '!pictures:local-whatsapp.localhost';
const hermes = fakeRuntime('hermes', [{ id: 'chat', label: 'Agent', space: false }]);
const llm = fakeRuntime('llm', [{ id: 'brief', label: 'Brief', space: false }], { ...NONE });
useFakeRuntimes({ hermes: hermes.runtime, llm: llm.runtime });
const actor: ChatActor = {
  recentMessages: async () => [],
  chat: async () => ({ title: '', type: 'single', network: '', selfName: null, source: 'test', replies: true }),
  canSend: () => true,
  send: async () => ({}),
};
setChatAgent(true, actor, () => {});

const NOW = Date.parse('2026-11-12T10:00:00Z');
let seq = 0;
const msg = (o: Partial<IncomingMsg> & { attachments?: number }, at: number): IncomingMsg & { attachments?: number } => ({
  id: `p${++seq}`,
  chatID: CHAT,
  senderID: '@linh:local-whatsapp.localhost',
  senderName: 'Linh',
  timestamp: new Date(at).toISOString(),
  type: 'TEXT',
  isSender: false,
  text: '',
  ...o,
});
const png = (n: number): ReadImage => ({ mime: 'image/png', data: new Uint8Array(n).fill(7) });

test('settings: off by default; on only for an llm agent; another agent turns it off', () => {
  const agents = agentList();
  const d = defaultConfig(agents, NOW);
  assert.equal(d.images, false);
  assert.deepEqual(mergeConfig(null, { agent: 'chat', images: true }, agents), { error: 'no_pictures' }, 'a Hermes agent takes no pictures in chats');
  assert.deepEqual(mergeConfig(null, { agent: 'brief', images: 'yes' }, agents), { error: 'bad_request' });
  const on = mergeConfig(null, { agent: 'brief', images: true }, agents, NOW) as ChatAgentConfig;
  assert.equal(on.images, true);
  const moved = mergeConfig(on, { agent: 'chat' }, agents, NOW) as ChatAgentConfig;
  assert.equal(moved.images, false, 'the option goes off with an agent that cannot take pictures');
  const off = mergeConfig(on, { images: false }, agents, NOW) as ChatAgentConfig;
  assert.equal(off.images, false);
});

test('reading: the latest pictures of the messages read, at most MAX_PICTURES, too big ones left out, oldest first', async () => {
  const reads: string[] = [];
  const pics = new Map<string, (ReadImage | 'too_large' | null)[]>();
  const reader = {
    readImage: async (chatID: string, id: string, i: number) => {
      assert.equal(chatID, CHAT);
      reads.push(`${id}#${i}`);
      return pics.get(id)?.[i] ?? null;
    },
  };
  const old = msg({ attachments: 1 }, NOW - 60 * 60_000);
  // 20 later messages push the old one out of what the agent reads.
  const later = Array.from({ length: 20 }, (_, i) => msg({ text: `m${i}` }, NOW - (20 - i) * 60_000));
  const a = msg({ attachments: 2 }, NOW - 30_000);
  const b = msg({ attachments: 1, isSender: true }, NOW - 20_000);
  const c = msg({ attachments: 3 }, NOW - 10_000);
  const deleted = msg({ attachments: 1, isDeleted: true }, NOW - 5_000);
  pics.set(old.id as string, [png(10)]);
  pics.set(a.id as string, [png(1), png(2)]);
  pics.set(b.id as string, [null]);
  pics.set(c.id as string, ['too_large', png(6 * 1024 * 1024), png(3)]);
  pics.set(deleted.id as string, [png(4)]);
  // Newest first, as a source gives them; replace the 3 newest plain ones so that a, b, c stay in the window.
  const items = [deleted, c, b, a, ...later.slice(3).reverse(), old];
  const got = await readPictures(reader, CHAT, items);
  assert.deepEqual(got.map((p) => [p.messageID, p.data.length]), [[a.id, 1], [a.id, 2], [c.id, 3]]);
  assert.ok(!reads.some((r) => r.startsWith(String(old.id)) || r.startsWith(String(deleted.id))), 'nothing outside what the agent reads');
  // More pictures than allowed: the latest MAX_PICTURES.
  const many = Array.from({ length: 6 }, (_, i) => msg({ attachments: 1 }, NOW - (6 - i) * 1000));
  for (const m of many) pics.set(m.id as string, [png(5)]);
  const capped = await readPictures(reader, CHAT, [...many].reverse());
  assert.equal(capped.length, MAX_PICTURES);
  assert.deepEqual(capped.map((p) => p.messageID), many.slice(-MAX_PICTURES).map((m) => m.id));
});

test('prompt: pictures after the text, each introduced by who and when; the system prompt says they are untrusted', () => {
  const m = msg({ attachments: 1, senderName: 'Linh' }, NOW);
  const base = buildPrompt({ label: 'Brief', cause: 'ask', chat: { title: 'T', type: 'single', network: 'WhatsApp' }, disclose: true, notes: '', lines: [], owner: 'Alex', pictures: 1 }, 'n');
  assert.match(base[0]!.content, /picture after the conversation .* UNTRUSTED/);
  assert.doesNotMatch(buildPrompt({ label: 'Brief', cause: 'ask', chat: { title: 'T', type: 'single', network: 'WhatsApp' }, disclose: true, notes: '', lines: [], owner: 'Alex' }, 'n')[0]!.content, /picture/);
  const pics: ChatPicture[] = [{ messageID: m.id as string, mime: 'image/png', data: new Uint8Array([1, 2, 3]) }];
  const out = picturePrompt(base, pics, [m], 'Alex', ['Brief']);
  assert.equal(out[0]!.content, base[0]!.content, 'the system message unchanged');
  const parts = out[1]!.content as Exclude<PicturePrompt[number]['content'], string>;
  assert.deepEqual(parts[0], { type: 'text', text: base[1]!.content });
  assert.deepEqual(parts[1], { type: 'text', text: 'Picture from Linh at 10:00:' });
  assert.deepEqual(parts[2], { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } });
});

// ── Flow ─────────────────────────────────────────────────────────────────────

const app = new Hono().route('/api/chatagent', chatAgentRoutes);
const json = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
let calls: { kind: 'text' | 'pictures'; agent: string; messages: unknown }[] = [];
let picturesRead = 0;
let history: IncomingMsg[] = [];

beforeEach(() => {
  resetChatAgentForTests();
  calls = [];
  picturesRead = 0;
  history = [];
  setChatAgentDepsForTests({
    usable: async () => true,
    complete: async (agent, messages) => {
      calls.push({ kind: 'text', agent, messages });
      return 'Une photo de chat.';
    },
    completePictures: async (agent, messages) => {
      calls.push({ kind: 'pictures', agent, messages });
      return 'Une photo de chat.';
    },
    pictures: async () => {
      picturesRead++;
      return [{ messageID: 'x1', mime: 'image/jpeg', data: new Uint8Array([9]) }];
    },
    recent: async () => history,
    chat: async () => ({ title: 'Test', type: 'single', network: 'WhatsApp', selfName: 'Alex', source: 'test', replies: true }),
    send: async () => ({ pendingMessageID: 'pending' }),
    notify: async () => {},
  });
});
const flush = () => new Promise((r) => setTimeout(r, 20));

test('flow: option on -> the pictures go with the call (completePictures); off -> none read, a text call', async () => {
  assert.equal((await json('PUT', '/api/chatagent/chat', { chatID: CHAT, agent: 'brief', images: true })).status, 200);
  assert.equal(configFor(CHAT)!.images, true);
  const t1 = msg({ id: 'x1', attachments: 1, isSender: true, text: '@brief décris la photo' }, Date.now());
  history = [t1];
  handleChatAgentEvent({ type: 'message.upserted', entries: [t1] });
  await flush();
  assert.deepEqual(calls.map((c) => [c.kind, c.agent]), [['pictures', 'brief']]);
  assert.equal(picturesRead, 1);
  const audit = (await (await json('GET', `/api/chatagent/chat?chatID=${encodeURIComponent(CHAT)}`)).json()) as { audit: { kind: string; detail?: string }[] };
  assert.ok(audit.audit.some((a) => a.kind === 'settings' && a.detail?.endsWith(':images')));

  resetChatAgentForTests();
  calls = [];
  picturesRead = 0;
  await json('PUT', '/api/chatagent/chat', { chatID: CHAT, agent: 'brief' });
  const t2 = msg({ id: 'x2', attachments: 1, isSender: true, text: '@brief décris la photo' }, Date.now());
  history = [t2];
  handleChatAgentEvent({ type: 'message.upserted', entries: [t2] });
  await flush();
  assert.deepEqual(calls.map((c) => c.kind), ['text']);
  assert.equal(picturesRead, 0, 'off by default: no picture read');
});

test('route: asking for images with a Hermes agent is refused; the agents list says which take pictures', async () => {
  const r = await json('PUT', '/api/chatagent/chat', { chatID: CHAT, agent: 'chat', images: true });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'no_pictures' });
  const list = (await (await json('GET', '/api/chatagent/agents')).json()) as { maxPictures: number; agents: { name: string; pictures: boolean }[] };
  assert.equal(list.maxPictures, MAX_PICTURES);
  assert.deepEqual(list.agents.map((a) => [a.name, a.pictures]), [['chat', false], ['brief', true]]);
});
