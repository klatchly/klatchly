import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { sessions, store, type Env } from '../server/context.js';
import { badgeCount, noteChat } from '../server/badgecount.js';
import { chatActor } from '../server/chatactor.js';
import { chatReader } from '../server/chatread.js';
import { ConnectorError, type Chat, type Message, type Page } from '../server/connector.js';
import { decodeState, encodeState, firstState, mergePages, ms, type MergeState } from '../server/merge.js';
import { Registry } from '../server/registry.js';
import { failureOf } from '../server/sources.js';
import { capped } from '../server/upload.js';
import { fakeSource, testPackage, type FakeSource } from './fakesource.js';

// More than one connector (0.15.4): lists merged by time with merged cursors, accounts that survive a failing
// connector, errors answered by the connector that threw them, chats and accounts of a connector that is off,
// uploads cut at their length and tied to their connector, media named by exact parameters, a connector's own
// media routes, and what packages read and may do in a connector's chats.

const sid = store.mutate((s) => sessions.create(s));
const cookie = { cookie: `sid=${sid}` };
const get = (app: Hono<Env>, path: string) => app.request(path, { headers: cookie });
const send = (app: Hono<Env>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { ...cookie, origin: config().origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

const at = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();
const chat = (id: string, d: number, isPinned = false): Chat => ({ id, lastActivity: at(d), isPinned });
const pg = <T>(items: T[], hasMore = false, oldestCursor: string | null = null): Page<T> => ({ items, hasMore, oldestCursor, newestCursor: null });
const chatItem = (c: Chat) => ({ at: ms(c.lastActivity), pinned: !!c.isPinned });

test('merge: each item of every source on exactly one page, in time order, pinned ones first', () => {
  // A paged source (the first connector's pages) and one that gives its whole list at once.
  const pages = [pg([chat('pin', 1, true), chat('b20', 20), chat('b18', 18)], true, 'c0'), pg([chat('b15', 15), chat('b10', 10)], true, 'c1'), pg([chat('b5', 5)])];
  const whole = pg([chat('opin', 2, true), chat('o25', 25), chat('o19', 19), chat('o18', 18), chat('o12', 12), chat('o1', 1)]);
  const seen: string[] = [];
  let state: MergeState | null = firstState(['main', 'other']);
  let n = 0;
  while (state) {
    const s: MergeState = state;
    const main = s.sources.main;
    const p = mergePages(
      [
        ...(main ? [{ id: 'main', page: pages[main.cursor ? Number(main.cursor.slice(1)) + 1 : 0]!, again: main.again }] : []),
        ...(s.sources.other ? [{ id: 'other', page: whole, again: s.sources.other.again }] : []),
      ],
      s,
      chatItem,
    );
    seen.push(...p.items.map((c) => c.id));
    // The cursor goes through the browser and back.
    state = p.next && decodeState(encodeState(p.next), ['main', 'other']);
    assert.ok(++n < 10);
  }
  assert.deepEqual(seen, ['pin', 'opin', 'o25', 'b20', 'o19', 'b18', 'o18', 'b15', 'o12', 'b10', 'b5', 'o1']);
});

test('merged cursors: strict, only of the sources in play', () => {
  const s = encodeState({ upper: 1760000000000, sources: { main: { cursor: 'abc:def', again: false }, other: { cursor: null, again: true } } });
  assert.deepEqual(decodeState(s, ['main', 'other']), { upper: 1760000000000, sources: { main: { cursor: 'abc:def', again: false }, other: { cursor: null, again: true } } });
  for (const bad of ['plain', 'mx1:{', 'mx1:[]', 'mx1:{"s":{"x":[null]}}', 'mx1:{"u":-1,"s":{}}', 'mx1:{"s":{"main":["a",2]}}', 'mx1:{"s":{"main":[""]}}', 'mx1:{"s":{"main":[5]}}', 'mx1:{"s":{"main":["a\\u0000b"]}}', 'mx1:{"s":{"main":["a\\nb"]}}', `mx1:{"s":{"main":["${'c'.repeat(513)}"]}}`]) {
    assert.equal(decodeState(bad, ['main', 'other']), null, bad);
  }
});

/** Two connectors: a legacy catch-all without owns (main) and one that owns o:… chats and the account 'other'. */
function two(over: { main?: Parameters<typeof fakeSource>[0]; other?: Parameters<typeof fakeSource>[0] } = {}): { main: FakeSource; other: FakeSource; app: Hono<Env>; registry: Registry } {
  const main = fakeSource(over.main);
  const other = fakeSource({ owns: (id) => id.startsWith('o:'), ownsAccount: (a) => a === 'other', ...over.other }, 'other');
  const registry = new Registry([main.pkg, other.pkg]);
  return { main, other, app: createApp(registry), registry };
}

test('GET /api/chats over two connectors: merged pages, merged cursors, every chat once', async () => {
  const mainPages = [pg([chat('pin', 1, true), chat('b20', 20), chat('b18', 18)], true, 'c0'), pg([chat('b15', 15), chat('b10', 10)], true, 'c1'), pg([chat('b5', 5)])];
  const asked: string[] = [];
  const { app } = two({
    main: {
      listChats: async (q) => {
        asked.push(`main ${q.cursor ?? '-'} ${q.direction ?? '-'} ${q.limit ?? '-'}`);
        return mainPages[q.cursor ? Number(q.cursor.slice(1)) + 1 : 0]!;
      },
    },
    other: {
      listChats: async (q) => {
        asked.push(`other ${q.cursor ?? '-'} ${q.accountIDs ?? '-'}`);
        return pg([chat('o:pin', 2, true), chat('o:25', 25), chat('o:19', 19), chat('o:12', 12), chat('o:1', 1)]);
      },
    },
  });
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 6; i++) {
    const r = await get(app, `/api/chats?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}&direction=before` : ''}`);
    assert.equal(r.status, 200);
    const p = (await r.json()) as Page<Chat>;
    ids.push(...p.items.map((c) => c.id));
    if (!p.hasMore) {
      assert.equal(p.oldestCursor, null);
      break;
    }
    assert.ok(p.oldestCursor!.startsWith('mx1:') && p.oldestCursor!.length <= 512);
    cursor = p.oldestCursor!;
  }
  assert.deepEqual(ids, ['pin', 'o:pin', 'o:25', 'b20', 'o:19', 'b18', 'b15', 'o:12', 'b10', 'b5', 'o:1']);
  assert.deepEqual(asked.slice(0, 2), ['main - - 50', 'other - -']);
  assert.ok(asked.includes('main c0 before 50'));
  // A cursor that is not this list's: 400, nothing asked.
  const n = asked.length;
  assert.equal((await get(app, '/api/chats?cursor=c0')).status, 400);
  assert.equal(asked.length, n);
  // The network filter: one connector in play, its own page and cursors as they are.
  const only = (await (await get(app, '/api/chats?accountIDs=fake')).json()) as Page<Chat>;
  assert.equal(only.oldestCursor, 'c0');
  assert.deepEqual(asked.at(-1), 'main - - -');
  const mine = (await (await get(app, '/api/chats?accountIDs=other')).json()) as Page<Chat>;
  assert.deepEqual(mine.items.map((c) => c.id), ['o:pin', 'o:25', 'o:19', 'o:12', 'o:1']);
  assert.deepEqual(asked.at(-1), 'other - other');
});

test('searches over two connectors: chats by time (no pinned first), messages with their chats', async () => {
  const { app } = two({
    main: {
      searchChats: async () => pg([chat('b1', 10, true), chat('b2', 5)]),
      searchMessages: async () => ({ ...pg<Message>([{ id: 'm1', chatID: 'b1', timestamp: at(3) }]), chats: { b1: chat('b1', 10) } }),
    },
    other: {
      searchChats: async (q) => pg(q.inbox === 'low-priority' ? [] : [chat('o:1', 7)]),
      searchMessages: async (q) => ({ ...pg<Message>([{ id: 'm2', chatID: 'o:1', timestamp: at(4) }].filter((m) => !q.chatIDs || q.chatIDs.includes(m.chatID))), chats: { 'o:1': chat('o:1', 7) } }),
    },
  });
  const found = (await (await get(app, '/api/chats/search?query=x')).json()) as Page<Chat>;
  assert.deepEqual(found.items.map((c) => c.id), ['b1', 'o:1', 'b2']);
  const low = (await (await get(app, '/api/chats/search?inbox=low-priority')).json()) as Page<Chat>;
  assert.deepEqual(low.items.map((c) => c.id), ['b1', 'b2']);
  const msgs = (await (await get(app, '/api/messages/search?query=x')).json()) as Page<Message> & { chats: Record<string, Chat> };
  assert.deepEqual(msgs.items.map((m) => m.id), ['m2', 'm1']);
  assert.deepEqual(Object.keys(msgs.chats).sort(), ['b1', 'o:1']);
  // One chat: its connector alone.
  const one = (await (await get(app, `/api/messages/search?query=x&chatID=${encodeURIComponent('o:1')}`)).json()) as Page<Message>;
  assert.deepEqual(one.items.map((m) => m.id), ['m2']);
});

test('GET /api/accounts: a failing connector is left out, all failing is an error', async () => {
  const down = () => Object.assign(new Error('down'), { name: 'FakeNotFound' });
  const { app } = two({ other: { accounts: async () => Promise.reject(down()) } });
  assert.deepEqual(await (await get(app, '/api/accounts')).json(), [{ accountID: 'fake', network: 'Fake' }]);
  const both = two({ main: { accounts: async () => Promise.reject(new Error('x')) }, other: { accounts: async () => Promise.reject(down()) } });
  // The first failure's answer: main's error maps to nothing (502).
  assert.equal((await get(both.app, '/api/accounts')).status, 502);
});

test("errors: answered by the connector that threw them, never another's mapping", async () => {
  // main maps every error to 404, other to 422: each answer says whose mapping was asked.
  const { app, main, other } = two({ main: { failure: () => ({ status: 404 }) }, other: { failure: () => ({ status: 422 }) } });
  other.chats.set('o:1', { id: 'o:1' });
  const boom = new Error('boom');
  other.module.messages = async () => Promise.reject(boom);
  other.module.chat = async () => Promise.reject(boom);
  assert.equal((await get(app, '/api/chats/o%3A1/messages')).status, 422);
  assert.equal(failureOf(boom, other.module).status, 422);
  assert.equal(failureOf(boom, main.module).status, 404);
  assert.equal(failureOf(new Error('anon')).status, 502, 'unknown origin: nobody guesses');
  assert.deepEqual(failureOf(new ConnectorError(409, 'unsupported')), { status: 409, code: 'unsupported' });
  // A package's reads (reader, actor): the error remembers its connector, so other's mapping answers.
  const seen = (status: number) => (e: unknown) => (assert.equal(failureOf(e).status, status), true);
  await assert.rejects(chatReader('t').recentMessages('o:1'), seen(422));
  await assert.rejects(chatActor('t').recentMessages('o:1'), seen(422));
  await assert.rejects(chatActor('t').chat('o:1'), seen(422));
  main.module.messages = async () => Promise.reject(new Error('down'));
  await assert.rejects(chatReader('t').recentMessages('c1'), seen(404));
});

test("chats and accounts of a connector that is off belong to nobody (404), not to the legacy catch-all", async () => {
  const main = fakeSource();
  const other = fakeSource({ owns: (id) => id.startsWith('o:'), ownsAccount: (a) => a === 'other', newChat: undefined }, 'other');
  const app = createApp(new Registry([main.pkg, testPackage({ id: 'gone', config: ['KLATCHLY_UNSET_X'], modules: [other.module] })], {}));
  assert.equal((await get(app, '/api/chats/o%3A1')).status, 404);
  assert.equal((await get(app, '/api/chats/o%3A1/messages')).status, 404);
  assert.equal((await send(app, 'POST', '/api/notify/read', { chatID: 'o:1' })).status, 404);
  assert.equal((await get(app, '/api/accounts/other/new-chat')).status, 404);
  assert.deepEqual(main.calls, []);
});

test('uploads: cut at their length, tied to the connector that took them', async () => {
  // The cap, on its own: a body longer than declared errors the stream there.
  const long = new Blob([new Uint8Array(10)]).stream();
  await assert.rejects(new Response(capped(long, 4)).arrayBuffer(), /longer than declared/);
  assert.equal((await new Response(capped(new Blob([new Uint8Array(4)]).stream(), 4)).arrayBuffer()).byteLength, 4);

  const got: string[] = [];
  const upload = (who: string) => async (f: { body: ReadableStream<Uint8Array>; size: number }) => {
    const n = (await new Response(f.body).arrayBuffer()).byteLength;
    got.push(`${who} ${n}/${f.size}`);
    return { status: 200, body: { uploadID: `${who}-up` } };
  };
  const { app, main, other } = two({ main: { upload: upload('main') }, other: { upload: upload('other') } });
  main.chats.set('c1', { id: 'c1' });
  other.chats.set('o:1', { id: 'o:1' });
  const up = (q: string, to = app) => send(to, 'POST', `/api/upload${q}`, 'abcd', { 'content-type': 'application/octet-stream', 'content-length': '4' });
  // Two connectors take uploads without a chat: which one is the chat's to say (1.25: no default connector).
  const both = await up('');
  assert.equal(both.status, 400);
  assert.deepEqual(await both.json(), { error: 'chat_required' });
  assert.deepEqual(await (await up(`?chatID=${encodeURIComponent('c1')}`)).json(), { uploadID: 'main-up' });
  assert.deepEqual(await (await up(`?chatID=${encodeURIComponent('o:1')}`)).json(), { uploadID: 'other-up' });
  assert.deepEqual(got, ['main 4/4', 'other 4/4']);
  assert.equal((await up('?chat=1')).status, 400);
  // A send carries only an upload of its own connector; an unknown one, with two plain uploaders: nobody's.
  const msg = (chatID: string, uploadID: string, to = app) => send(to, 'POST', `/api/chats/${encodeURIComponent(chatID)}/messages`, { attachment: { uploadID } });
  assert.equal((await msg('c1', 'other-up')).status, 400);
  assert.equal((await msg('o:1', 'main-up')).status, 400);
  assert.equal((await msg('o:1', 'unknown')).status, 400);
  assert.equal((await msg('c1', 'main-up')).status, 200);
  assert.equal((await msg('o:1', 'other-up')).status, 200);
  assert.equal((await msg('c1', 'unknown')).status, 400);
  // One connector takes uploads without a chat (the other only for its chats): an upload without one, and an unknown
  // upload ID (from before a restart), are its own.
  got.length = 0;
  const one = two({ main: { upload: upload('main') }, other: { uploadFor: async (_chatID, f) => upload('other')(f) } });
  one.main.chats.set('c1', { id: 'c1' });
  one.other.chats.set('o:1', { id: 'o:1' });
  assert.deepEqual(await (await up('', one.app)).json(), { uploadID: 'main-up' });
  assert.deepEqual(got, ['main 4/4']);
  assert.equal((await msg('c1', 'unknown', one.app)).status, 200);
  assert.equal((await msg('o:1', 'unknown', one.app)).status, 400);
  // A connector without uploads: 409 for both; none takes uploads without a chat: 409 too.
  const text = two();
  text.other.chats.set('o:1', { id: 'o:1' });
  assert.equal((await send(text.app, 'POST', `/api/upload?chatID=${encodeURIComponent('o:1')}`, 'abcd', { 'content-type': 'application/octet-stream', 'content-length': '4' })).status, 409);
  assert.equal((await send(text.app, 'POST', `/api/chats/${encodeURIComponent('o:1')}/messages`, { attachment: { uploadID: 'x' } })).status, 409);
  assert.equal((await up('', text.app)).status, 409);
});

/** Two connectors that each claim their chats and accounts (no legacy catch-all), and an app on them. */
function owners(over: { a?: Parameters<typeof fakeSource>[0]; b?: Parameters<typeof fakeSource>[0] } = {}) {
  const a = fakeSource({ owns: (id) => id.startsWith('a:'), ownsAccount: (x) => x === 'a', ...over.a }, 'a');
  const b = fakeSource({ owns: (id) => id.startsWith('b:'), ownsAccount: (x) => x === 'b', ...over.b }, 'b');
  const registry = new Registry([a.pkg, b.pkg]);
  return { a, b, registry, app: createApp(registry) };
}

test('routing without a catch-all: an unclaimed chat or account is nobody\'s; one connector off leaves the other', async () => {
  const { a, b, registry, app } = owners();
  a.chats.set('a:1', { id: 'a:1', lastActivity: at(2) });
  b.chats.set('b:1', { id: 'b:1', lastActivity: at(1), unreadCount: 2 });
  for (const [method, path, body] of [
    ['GET', '/api/chats/!x', undefined],
    ['GET', '/api/chats/!x/messages', undefined],
    ['POST', '/api/chats/!x/read', {}],
    ['PATCH', '/api/chats/!x', { isPinned: true }],
    ['GET', '/api/accounts/zz/new-chat', undefined],
  ] as const) {
    assert.equal((await send(app, method, path, body)).status, 404, `${method} ${path}`);
  }
  assert.deepEqual(a.calls, []);
  assert.deepEqual(b.calls, []);
  const list = (await (await get(app, '/api/chats')).json()) as Page<Chat>;
  assert.deepEqual(list.items.map((c) => c.id), ['a:1', 'b:1']);
  assert.equal(registry.startProblem(), null);
  await registry.start();
  try {
    noteChat({ id: 'b:1', unreadCount: 2, isMuted: false, isArchived: false, isLowPriority: false });
    const before = badgeCount();
    assert.equal((await send(app, 'PUT', '/api/extensions/b', { enabled: false })).status, 200);
    assert.equal(badgeCount(), before - 2, "its chats leave the badge");
    assert.equal((await get(app, '/api/chats/b%3A1')).status, 404);
    assert.equal((await get(app, '/api/chats/a%3A1')).status, 200);
    assert.equal(registry.startProblem(), null);
    // The last one on cannot go.
    assert.equal((await send(app, 'PUT', '/api/extensions/a', { enabled: false })).status, 409);
  } finally {
    await registry.stop();
  }
});

test('a connector that has not learned its accounts yet (accountsPending) gets the unclaimed ones meanwhile, never another\'s', async () => {
  // b (second in the order) learns its accounts from its upstream: on a first start it knows none yet.
  let pending = true;
  const { a, b, app } = owners({ b: { accountsPending: () => pending } });
  a.chats.set('a:1', { id: 'a:1', lastActivity: at(2) });
  b.chats.set('b:1', { id: 'b:1', lastActivity: at(1) });
  const ids = async (q: string) => ((await (await get(app, `/api/chats?${q}`)).json()) as Page<Chat>).items.map((c) => c.id);
  // A saved network filter on one of b's accounts still reaches b (not an empty list), a's own account stays a's.
  assert.deepEqual(await ids('accountIDs=learning'), ['b:1']);
  assert.deepEqual(await ids('accountIDs=a'), ['a:1']);
  assert.deepEqual(await ids('accountIDs=a&accountIDs=learning'), ['a:1', 'b:1']);
  assert.equal((await send(app, 'PUT', '/api/reading/learning', { discreet: false })).status, 200);
  // Learnt: an account no connector claims is nobody's again.
  pending = false;
  assert.deepEqual(await ids('accountIDs=learning'), []);
  assert.equal((await send(app, 'PUT', '/api/reading/learning', { discreet: false })).status, 404);
  assert.deepEqual(await ids('accountIDs=b'), ['b:1']);
});

test('media by parse with two owners: each one\'s parameters reach only its own fetch, /api/thumb too', async () => {
  const fetched: string[] = [];
  const mediaOf = (id: string, param: string) => ({
    params: [param],
    parse: (q: Record<string, string>) => (q[param] && /^[a-z0-9]{1,16}$/.test(q[param]!) ? { kind: id, key: `${id}|${q[param]}`, original: `/api/media/m.jpg?${param}=${q[param]}` } : null),
    async fetch(ref: { key: string }) {
      fetched.push(ref.key);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      return { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) }, body: new Blob([png]).stream() };
    },
  });
  const { app } = owners({ a: { media: mediaOf('a', 'p') }, b: { media: mediaOf('b', 'q') } });
  assert.equal((await get(app, '/api/media/m.jpg?p=one')).status, 200);
  assert.equal((await get(app, '/api/media/m.jpg?q=two')).status, 200);
  assert.deepEqual(fetched, ['a|one', 'b|two']);
  for (const q of ['p=one&q=two', 'r=x', 'p=../x', '']) assert.equal((await get(app, `/api/media/m.jpg?${q}`)).status, 400, q);
  fetched.length = 0;
  assert.equal((await get(app, '/api/thumb/w144.webp?q=three')).status, 200);
  assert.deepEqual(fetched, ['b|three']);
  assert.equal((await get(app, '/api/thumb/w144.webp?r=x')).status, 400);
});

test('long reaction keys: only where the chat\'s connector says they are its own', async () => {
  const reacted: string[] = [];
  const react = async (chatID: string, _mid: string, key: string) => void reacted.push(`${chatID} ${key}`);
  const long = `img:${'x'.repeat(80)}`;
  const { a, b, app } = owners({ a: { react, unreact: react, longReactionKey: (k) => k.startsWith('img:') }, b: { react, unreact: react } });
  a.chats.set('a:1', { id: 'a:1' });
  b.chats.set('b:1', { id: 'b:1' });
  const post = (chat: string, key: string) => send(app, 'POST', `/api/chats/${encodeURIComponent(chat)}/messages/m1/reactions`, { reactionKey: key });
  const del = (chat: string, key: string) => send(app, 'DELETE', `/api/chats/${encodeURIComponent(chat)}/messages/m1/reactions/${encodeURIComponent(key)}`);
  assert.equal((await post('a:1', long)).status, 200);
  assert.equal((await del('a:1', long)).status, 200);
  assert.equal((await post('b:1', long)).status, 400);
  assert.equal((await del('b:1', long)).status, 400);
  assert.equal((await post('a:1', `other:${'x'.repeat(80)}`)).status, 400);
  assert.equal((await post('b:1', '👍')).status, 200);
  // Shape first (400), then an unknown chat (404) before the long-key check.
  assert.equal((await post('a:1', `img:${'x'.repeat(260)}`)).status, 400);
  assert.equal((await post('!x', long)).status, 404);
  assert.deepEqual(reacted, [`a:1 ${long}`, `a:1 ${long}`, 'b:1 👍']);
});

test('GET /api/media: exactly a connector\'s parameters, besides the relay\'s own', async () => {
  const { app, main } = two();
  main.media.set('abc', Buffer.from('xyz'));
  assert.equal((await get(app, '/api/media/m.jpg?m=abc&type=image%2Fjpeg&name=a.jpg&r=1')).status, 200);
  for (const q of ['m=abc&x=1', 'm=abc&url=mxc%3A%2F%2Fa%2Fb', 'c=o%3A1&m=abc', '']) assert.equal((await get(app, `/api/media/m.jpg?${q}`)).status, 400, q);
});

test("a connector's own media routes keep their own headers; its other routes get the app's", async () => {
  const routes = new Hono<Env>()
    .get('/media/:file', (c) => c.body('x', 200, { 'Content-Security-Policy': "sandbox; default-src 'none'" }))
    .get('/other', (c) => c.json({ ok: true }));
  const main = fakeSource();
  const own = fakeSource({ owns: (id) => id.startsWith('o:'), routes, mediaRoutes: ['media'] }, 'own');
  const app = createApp(new Registry([main.pkg, own.pkg]));
  const media = await get(app, '/api/own/media/m.jpg');
  assert.equal(media.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(media.headers.get('x-robots-tag'), null);
  const other = await get(app, '/api/own/other');
  assert.match(other.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.throws(() => new Registry([main.pkg, fakeSource({ owns: () => false, mediaRoutes: ['media'] }, 'bad').pkg]), /mediaRoutes/);
});

test('read all (low priority): the badge drops each chat as it is marked', async () => {
  let release!: () => void;
  const marked = new Promise<void>((r) => (release = r));
  let during = -1;
  const main = fakeSource({
    async readAllLowPriority(onRead) {
      onRead?.('lp1');
      during = badgeCount();
      await marked;
      return { total: 1, read: ['lp1'], failed: 0, complete: true };
    },
  });
  const app = createApp(new Registry([main.pkg]));
  noteChat({ id: 'lp1', unreadCount: 3, isMuted: false, isArchived: false, isLowPriority: false });
  const before = badgeCount();
  const r = send(app, 'POST', '/api/inbox/low-priority/read-all');
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(during, before - 3);
  release();
  assert.equal((await r).status, 200);
});

test("packages in a connector's chats: what it says is not there reads as nothing; no details or sends without actorSend", async () => {
  const notThere = () => Promise.reject(new ConnectorError(404, 'not_found'));
  const { other } = two({ other: { capabilities: { actorSend: false, flags: [] }, message: notThere, messages: notThere } });
  const reader = chatReader('t');
  assert.equal(await reader.readMessage('o:1', 'x'), null);
  assert.deepEqual(await reader.recentMessages('o:1'), []);
  const actor = chatActor('t');
  assert.deepEqual(await actor.recentMessages('o:1'), []);
  assert.equal(actor.canSend('o:1'), false);
  await assert.rejects(actor.chat('o:1'), /unsupported chat/);
  await assert.rejects(actor.send('o:1', 'hi'), /unsupported chat/);
  assert.ok(!other.calls.some((c) => c.startsWith('send') || c.startsWith('chat ')));
  assert.equal(actor.canSend('c1'), true);
});

test('packages in a connector\'s chats: the details say whether a send may quote a message (capabilities.reply)', async () => {
  const caps = { reply: 0, edit: 0 };
  const { main } = two({ other: { chat: async (id: string) => ({ id, title: 'Z', type: 'single', capabilities: caps }) as never } });
  main.chats.set('c1', { id: 'c1', title: 'B', type: 'single' } as never);
  const actor = chatActor('t');
  assert.equal((await actor.chat('o:1')).replies, false);
  assert.equal((await actor.chat('c1')).replies, true, 'no capabilities known: no restriction');
});

test('packages read a message\'s picture: its source\'s bytes, pictures only, capped (ChatReader.readImage)', async () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const opened: string[] = [];
  const { main } = two();
  main.module.attachmentSource = (m, a) => () => {
    opened.push(`${m.id} ${a.id}`);
    const big = a.id === 'big';
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': big ? 'image/jpeg' : 'image/png', ...(big ? { 'content-length': String(9 * 1024 * 1024) } : {}) },
      body: new Blob([PNG]).stream(),
    });
  };
  main.messages.set('c1', [
    {
      id: 'm1',
      chatID: 'c1',
      attachments: [
        { id: 'p', type: 'img', mimeType: 'image/png' },
        { id: 's', type: 'img', mimeType: 'image/webp', isSticker: true },
        { id: 'd', type: 'unknown', mimeType: 'application/pdf' },
        { id: 'big', type: 'img', mimeType: 'image/jpeg' },
        { id: 'h', type: 'img', mimeType: 'image/heic' },
        { id: 'n', type: 'img' },
      ],
    },
  ]);
  const reader = chatReader('t');
  const img = await reader.readImage('c1', 'm1', 0);
  assert.ok(img && img !== 'too_large');
  assert.equal(img.mime, 'image/png');
  assert.deepEqual([...img.data], [...PNG]);
  assert.equal(await reader.readImage('c1', 'm1', 1), null, 'a sticker');
  assert.equal(await reader.readImage('c1', 'm1', 2), null, 'a PDF');
  assert.equal(await reader.readImage('c1', 'm1', 3), 'too_large');
  assert.equal(await reader.readImage('c1', 'm1', 4), null, 'a type models do not read');
  assert.equal((await reader.readImage('c1', 'm1', 5)) !== null, true, 'no declared type: the served one decides');
  assert.equal(await reader.readImage('c1', 'm1', 9), null);
  assert.equal(await reader.readImage('c1', 'm1', -1), null);
  assert.deepEqual(opened, ['m1 p', 'm1 big', 'm1 n'], 'only pictures are fetched');
});

test('packages read a message\'s sound: its source\'s bytes, audio only, capped (ChatReader.readAudio)', async () => {
  const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
  const opened: string[] = [];
  const { main } = two();
  main.module.attachmentSource = (m, a) => () => {
    opened.push(`${m.id} ${a.id}`);
    if (a.id === 'gone') return Promise.resolve({ status: 404, headers: {}, body: null });
    if (a.id === 'down') return Promise.resolve({ status: 502, headers: {}, body: null });
    const big = a.id === 'big' || a.id === 'stream';
    const served = a.id === 'oct' ? 'application/octet-stream' : a.id === 'm4a' ? 'audio/mp4' : 'audio/ogg; codecs=opus';
    return Promise.resolve({
      status: 200,
      headers: { 'content-type': served, ...(a.id === 'big' ? { 'content-length': String(26 * 1024 * 1024) } : {}) },
      body: a.id === 'stream' ? new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]).stream() : new Blob([big ? new Uint8Array(1) : OGG]).stream(),
    });
  };
  main.messages.set('c1', [
    {
      id: 'm2',
      chatID: 'c1',
      attachments: [
        { id: 'v', type: 'audio', mimeType: 'audio/ogg', isVoiceNote: true, duration: 4.5 },
        { id: 'p', type: 'img', mimeType: 'image/png' },
        { id: 'big', type: 'audio', mimeType: 'audio/ogg' },
        { id: 'm4a', type: 'unknown', mimeType: 'audio/x-m4a' },
        { id: 'oct', type: 'audio', mimeType: 'video/mp4' },
        { id: 'gone', type: 'audio' },
        { id: 'down', type: 'audio' },
        { id: 'stream', type: 'audio' },
        { id: 's', type: 'audio', isSticker: true },
        { id: 'vid', type: 'video', mimeType: 'video/mp4' },
      ],
    },
  ]);
  const reader = chatReader('t');
  const v = await reader.readAudio('c1', 'm2', 0);
  assert.ok(v && v !== 'too_large');
  assert.deepEqual({ ...v, data: [...v.data] }, { mime: 'audio/ogg', data: [...OGG], duration: 4.5, voiceNote: true });
  assert.equal(await reader.readAudio('c1', 'm2', 1), null, 'a picture');
  assert.equal(await reader.readAudio('c1', 'm2', 2), 'too_large', 'by its declared length');
  const m4a = await reader.readAudio('c1', 'm2', 3);
  assert.ok(m4a && m4a !== 'too_large' && m4a.mime === 'audio/mp4' && m4a.duration === undefined && m4a.voiceNote === undefined, 'audio by its declared type');
  const oct = await reader.readAudio('c1', 'm2', 4);
  assert.ok(oct && oct !== 'too_large' && oct.mime === 'video/mp4', 'a sound in an mp4 container: the declared type when the served one says nothing');
  assert.equal(await reader.readAudio('c1', 'm2', 5), null, 'gone at its source');
  await assert.rejects(reader.readAudio('c1', 'm2', 6), /audio 502/);
  assert.equal(await reader.readAudio('c1', 'm2', 7), 'too_large', 'while streaming');
  assert.equal(await reader.readAudio('c1', 'm2', 8), null, 'a sticker');
  assert.equal(await reader.readAudio('c1', 'm2', 9), null, 'a video');
  assert.equal(await reader.readAudio('c1', 'm2', 10), null);
  assert.deepEqual(opened, ['m2 v', 'm2 big', 'm2 m4a', 'm2 oct', 'm2 gone', 'm2 down', 'm2 stream'], 'only audio is fetched');
});

test('new chats: an account of existing conversations only creates nothing (400 before the connector is asked)', async () => {
  const made: string[] = [];
  const newChat = {
    caps: async (accountID: string) => ({
      accountID,
      network: 'Other',
      connected: true,
      start: false,
      lookup: { phone: false, email: false, username: false },
      contactList: true,
      group: null,
      existingOnly: true,
    }),
    searchContacts: async () => [{ id: 'o:1', fullName: 'Someone' }],
    listContacts: async () => ({ items: [{ id: 'o:1' }], hasMore: false, oldestCursor: null }),
    start: async () => (made.push('start'), {}),
    create: async () => (made.push('create'), {}),
  };
  const { app } = two({ other: { newChat } });
  assert.equal((await get(app, '/api/accounts/other/new-chat')).status, 200);
  assert.deepEqual(await (await get(app, '/api/accounts/other/contacts?query=so')).json(), { items: [{ id: 'o:1', fullName: 'Someone' }] });
  assert.equal((await send(app, 'POST', '/api/chats/start', { accountID: 'other', user: { id: 'x' } })).status, 400);
  assert.equal((await send(app, 'POST', '/api/chats', { accountID: 'other', type: 'group', participantIDs: ['a', 'b'] })).status, 400);
  assert.deepEqual(made, []);
});

test('forward: a target whose connector takes no uploads takes text only', async () => {
  const { app, main, other } = two({ main: { upload: async () => ({ status: 200, body: { uploadID: 'u' } }) } });
  main.chats.set('c1', { id: 'c1' });
  main.messages.set('c1', [{ id: 'm1', chatID: 'c1', text: 'hello', attachments: [{ type: 'img', mimeType: 'image/jpeg', srcURL: 'x' }] }, { id: 'm2', chatID: 'c1', text: 'just text' }]);
  main.module.attachmentSource = () => async () => ({ status: 200, headers: { 'content-length': '3' }, body: new Blob(['abc']).stream() });
  other.chats.set('o:1', { id: 'o:1' });
  const r = (await (await send(app, 'POST', '/api/forward', { from: [{ chatID: 'c1', messageID: 'm1' }], to: ['o:1'] })).json()) as { results: { error?: string }[] };
  assert.equal(r.results[0]!.error, 'text_only');
  const t = (await (await send(app, 'POST', '/api/forward', { from: [{ chatID: 'c1', messageID: 'm2' }], to: ['o:1'] })).json()) as { results: { ok: boolean }[] };
  assert.equal(t.results[0]!.ok, true);
  assert.ok(other.calls.includes('send o:1 {"text":"just text"}'));
});
