import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { IncomingMessage } from 'node:http';
import { isRoomLink, parseRoomTarget } from '../matrix.js';
import { matrixRoutes, setMatrixTimingsForTests, stopMatrix } from '../server/matrix.js';
import beeper from '../server/index.js';
import { mockUpstream } from '../../../test/mock.js';

// Joining and leaving Matrix rooms with the Beeper account (server/matrix.ts) against a canned beeper-server: the
// inputs it takes, join → wait for /v1/chats → mute → the chat id, the refusals, leave only for the Matrix account.

type Handler = (req: IncomingMessage, body: string) => [number, unknown?];
// The SDK may or may not percent-encode ':' in a path: both spellings answer.
const both = (method: string, path: string, h: Handler): Record<string, Handler> => ({
  [`${method} ${path}`]: h,
  [`${method} ${path.replace(/:/g, '%3A')}`]: h,
});

// How many times /v1/chats was asked for a room before it knows it.
const asked = new Map<string, number>();
const appears = (id: string, after: number, chat: Record<string, unknown> = {}): Handler => () => {
  const n = (asked.get(id) ?? 0) + 1;
  asked.set(id, n);
  return n > after ? [200, { id, accountID: 'matrix', network: 'Beeper (Matrix)', type: 'group', isMuted: false, ...chat }] : [404, { message: 'chat not found' }];
};
let freshPatches = 0;
const joins: Record<string, Handler> = {
  '#room:example.org': () => [200, { room_id: '!room:example.org' }],
  '#mine:example.org': () => [200, { room_id: '!mine:example.org' }],
  '#slow:example.org': () => [200, { room_id: '!slow:example.org' }],
  '#late:example.org': () => [200, { room_id: '!late:example.org' }],
  '#private:example.org': () => [403, { errcode: 'M_FORBIDDEN', error: 'You are not invited to this room.' }],
  '#nope:example.org': () => [404, { errcode: 'M_NOT_FOUND', error: 'Room alias not found' }],
  '#busy:example.org': () => [429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 2000 }],
  '!fresh:example.org': () => [200, { room_id: '!fresh:example.org' }],
  '#odd:example.org': () => [200, { room_id: 'not-a-room' }],
  '#crlf:example.org': () => [400, { errcode: 'M_BAD\r\n2026-01-01T00:00:00Z core forged line', error: 'x' }],
  '#plain:example.org': () => [400, { errcode: 'M_BAD_JSON', error: 'x' }],
};

const up = mockUpstream({
  ...Object.fromEntries(Object.entries(joins).map(([room, h]) => [`POST /_matrix/client/v3/join/${encodeURIComponent(room)}`, h])),
  ...both('GET', '/v1/chats/!room:example.org', appears('!room:example.org', 2)),
  ...both('GET', '/v1/chats/!mine:example.org', appears('!mine:example.org', 0, { isMuted: false })),
  ...both('GET', '/v1/chats/!slow:example.org', appears('!slow:example.org', 1000)),
  ...both('GET', '/v1/chats/!late:example.org', appears('!late:example.org', 5)),
  ...both('GET', '/v1/chats/!fresh:example.org', appears('!fresh:example.org', 2)),
  ...both('GET', '/v1/chats/!wa:beeper.local', () => [200, { id: '!wa:beeper.local', accountID: 'whatsapp', network: 'WhatsApp', type: 'single' }]),
  ...both('PATCH', '/v1/chats/!room:example.org', (_r, b) => [200, { id: '!room:example.org', ...JSON.parse(b) }]),
  ...both('PATCH', '/v1/chats/!late:example.org', (_r, b) => [200, { id: '!late:example.org', ...JSON.parse(b) }]),
  // The first mute fails, the next one (in the background) goes through.
  ...both('PATCH', '/v1/chats/!fresh:example.org', (_r, b) => (++freshPatches === 1 ? [500, { message: 'boom' }] : [200, { id: '!fresh:example.org', ...JSON.parse(b) }])),
  ...both('POST', '/_matrix/client/v3/rooms/!mine:example.org/leave', () => [200, {}]),
  ...both('GET', '/v1/chats/!dm:example.org', () => [200, { id: '!dm:example.org', accountID: 'matrix', network: 'Beeper (Matrix)', type: 'single' }]),
});

const app = new Hono().route('/api/beeper', matrixRoutes);
const post = (path: string, body: unknown, type = 'application/json') =>
  app.request(`/api/beeper/matrix/${path}`, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const callsTo = (re: RegExp) => up.calls.filter((c) => re.test(c.url));

before(async () => {
  setMatrixTimingsForTests([5, 5, 5, 5], [10, 10]);
  await up.start();
});
after(async () => {
  stopMatrix();
  await up.stop();
});

test('inputs: aliases, room ids and matrix.to links (with via); junk and user ids refused', () => {
  assert.deepEqual(parseRoomTarget('#dev-room:example.org'), { room: '#dev-room:example.org', kind: 'alias', via: [] });
  assert.deepEqual(parseRoomTarget('  !abc123:matrix.org '), { room: '!abc123:matrix.org', kind: 'id', via: [] });
  assert.deepEqual(parseRoomTarget('#chat:localhost:8448'), { room: '#chat:localhost:8448', kind: 'alias', via: [] });
  assert.deepEqual(parseRoomTarget('#café:example.org')?.kind, 'alias');
  // A room v12 id has no server part.
  assert.deepEqual(parseRoomTarget('!Gs0d9SeZ0nuuTfq5HFLs6J6f2CLiUpAdz46fsOE4FAk')?.kind, 'id');
  assert.deepEqual(parseRoomTarget('https://matrix.to/#/#lobby:example.net'), { room: '#lobby:example.net', kind: 'alias', via: [] });
  assert.deepEqual(parseRoomTarget('https://matrix.to/#/%23lobby%3Aexample.net'), { room: '#lobby:example.net', kind: 'alias', via: [] });
  assert.deepEqual(parseRoomTarget('https://matrix.to/#/!abc:matrix.org?via=matrix.org&via=example.org&via=matrix.org'), {
    room: '!abc:matrix.org',
    kind: 'id',
    via: ['matrix.org', 'example.org'],
  });
  // An event link: the room, the event dropped.
  assert.deepEqual(parseRoomTarget('https://matrix.to/#/!abc:matrix.org/$event123?via=matrix.org'), { room: '!abc:matrix.org', kind: 'id', via: ['matrix.org'] });
  assert.equal(parseRoomTarget('matrix.to/#/#room:example.org')?.room, '#room:example.org');
  for (const bad of [
    '',
    '   ',
    'room',
    '#room',
    '#:example.org',
    '#room:',
    '#ro om:example.org',
    '#room:exa mple.org',
    '#room:-bad-.org',
    '#room:example.org:99999',
    '#room:example.org\u0000',
    '@user:example.org',
    '+group:example.org',
    '$event:example.org',
    'https://matrix.to/#/@user:example.org',
    'https://matrix.to/#/',
    'https://matrix.to/#/%E0%A4%A',
    'https://matrix.to/#/#room:example.org?via=bad host',
    'https://matrix.to/#/#room:example.org?via=bad_host',
    'https://evil.example/#/#room:example.org',
    'http://matrix.to/#/#room:example.org',
    `#${'a'.repeat(250)}:example.org`,
    `https://matrix.to/#/#room:example.org?${Array.from({ length: 11 }, (_, i) => `via=s${i}.org`).join('&')}`,
    42,
    null,
    { room: '#room:example.org' },
  ]) {
    assert.equal(parseRoomTarget(bad), null, JSON.stringify(bad));
  }
});

test('room links: matrix.to links to a room only', () => {
  assert.equal(isRoomLink('https://matrix.to/#/#room:example.org'), true);
  assert.equal(isRoomLink('https://matrix.to/#/!abc:example.org?via=example.org'), true);
  assert.equal(isRoomLink('https://matrix.to/#/@user:example.org'), false);
  assert.equal(isRoomLink('https://example.org/#/#room:example.org'), false);
  assert.equal(isRoomLink('#room:example.org'), false);
});

test('the connector serves the routes', () => {
  const k = beeper.modules.find((m) => m.type === 'connector');
  assert.equal(k?.routes, matrixRoutes);
});

test('join: the room is joined, waited for, muted, and its chat id returned', async () => {
  const r = await post('join', { target: '#room:example.org' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { chatID: '!room:example.org', joined: true, ready: true, muted: true });
  const join = callsTo(/^\/_matrix\/client\/v3\/join\//).at(-1)!;
  assert.equal(join.method, 'POST');
  assert.equal(join.url, `/_matrix/client/v3/join/${encodeURIComponent('#room:example.org')}`);
  assert.deepEqual(JSON.parse(join.body), {});
  assert.equal(join.auth, 'Bearer test-token');
  const patch = up.calls.filter((c) => c.method === 'PATCH').at(-1)!;
  assert.match(patch.url, /^\/v1\/chats\/!room(:|%3A)example\.org$/);
  assert.deepEqual(JSON.parse(patch.body), { isMuted: true });
});

test('join: a matrix.to link passes its via servers as server_name (and via)', async () => {
  const r = await post('join', { target: 'https://matrix.to/#/%23room%3Aexample.org?via=matrix.org&via=example.org' });
  assert.equal(r.status, 200);
  const q = new URL(callsTo(/^\/_matrix\/client\/v3\/join\//).at(-1)!.url, 'http://x').searchParams;
  assert.deepEqual(q.getAll('server_name'), ['matrix.org', 'example.org']);
  assert.deepEqual(q.getAll('via'), ['matrix.org', 'example.org']);
});

test('join: a room one is already in opens as it is (no join for a known id, no mute)', async () => {
  const joinsBefore = callsTo(/^\/_matrix\//).length;
  const patches = up.calls.filter((c) => c.method === 'PATCH').length;
  const id = await post('join', { target: '!mine:example.org' });
  assert.deepEqual(await id.json(), { chatID: '!mine:example.org', joined: false, ready: true, muted: false });
  assert.equal(callsTo(/^\/_matrix\//).length, joinsBefore);
  // Through its alias: joined (a no-op upstream), known at once: not muted.
  const alias = await post('join', { target: '#mine:example.org' });
  assert.deepEqual(await alias.json(), { chatID: '!mine:example.org', joined: false, ready: true, muted: false });
  assert.equal(up.calls.filter((c) => c.method === 'PATCH').length, patches);
});

test('join: a new room id; a mute that fails does not fail the join, and is tried again later', async () => {
  const r = await post('join', { target: '!fresh:example.org' });
  assert.deepEqual(await r.json(), { chatID: '!fresh:example.org', joined: true, ready: true, muted: false });
  assert.equal(up.calls.filter((c) => c.method === 'PATCH' && /!fresh/.test(c.url)).length, 1);
  await new Promise((r) => setTimeout(r, 60));
  const patches = up.calls.filter((c) => c.method === 'PATCH' && /!fresh/.test(c.url));
  assert.equal(patches.length, 2);
  assert.deepEqual(JSON.parse(patches[1]!.body), { isMuted: true });
});

test('join: a room slow to show is not waited for forever; muted later once it shows', async () => {
  const slow = await post('join', { target: '#slow:example.org' });
  assert.deepEqual(await slow.json(), { chatID: '!slow:example.org', joined: true, ready: false, muted: false });
  const late = await post('join', { target: '#late:example.org' });
  assert.deepEqual(await late.json(), { chatID: '!late:example.org', joined: true, ready: false, muted: false });
  await new Promise((r) => setTimeout(r, 120));
  const patch = up.calls.filter((c) => c.method === 'PATCH' && /!late/.test(c.url));
  assert.equal(patch.length, 1);
  assert.deepEqual(JSON.parse(patch[0]!.body), { isMuted: true });
  assert.equal(up.calls.filter((c) => c.method === 'PATCH' && /!slow/.test(c.url)).length, 0);
});

test('join: refusals mapped (invite-only, unknown alias, rate limit, endpoint gone, odd answer)', async () => {
  const cases: [string, number, string][] = [
    ['#private:example.org', 409, 'room_forbidden'],
    ['#nope:example.org', 404, 'room_not_found'],
    ['#busy:example.org', 429, 'rate_limited'],
    // Not in the canned upstream: a plain 404 without M_NOT_FOUND, as when beeper-server drops the endpoint.
    ['#gone:example.org', 502, 'join_unavailable'],
    ['#odd:example.org', 502, 'upstream'],
  ];
  for (const [target, status, error] of cases) {
    const r = await post('join', { target });
    assert.equal(r.status, status, target);
    assert.deepEqual(await r.json(), { error }, target);
  }
});

test('join refused: only a plain Matrix errcode is logged (no CR/LF from upstream)', async (t) => {
  const out: string[] = [];
  const write = t.mock.method(process.stdout, 'write', (chunk: unknown) => (out.push(String(chunk)), true));
  const crlf = await post('join', { target: '#crlf:example.org' });
  const plain = await post('join', { target: '#plain:example.org' });
  write.mock.restore();
  assert.equal(crlf.status, 422);
  assert.equal(plain.status, 422);
  const lines = out.join('').split('\n').filter((l) => l.includes('matrix join refused'));
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines[0]!, /errcode=/);
  assert.match(lines[1]!, / errcode=M_BAD_JSON$/);
  assert.doesNotMatch(out.join(''), /forged line/);
});

test('join: bad bodies refused before any upstream call', async () => {
  const n = up.calls.length;
  assert.equal((await post('join', { target: '@user:example.org' })).status, 400);
  assert.deepEqual(await (await post('join', { target: 'junk' })).json(), { error: 'bad_target' });
  assert.equal((await post('join', { target: '#room:example.org', extra: 1 })).status, 400);
  assert.equal((await post('join', '{"target":"#room:example.org"}', 'text/plain')).status, 400);
  assert.equal((await post('join', { target: `#${'a'.repeat(5000)}:example.org` })).status, 413);
  assert.equal(up.calls.length, n);
});

test('leave: only a group room of the Matrix account', async () => {
  const r = await post('leave', { chatID: '!mine:example.org' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { left: true });
  const call = callsTo(/\/leave$/).at(-1)!;
  assert.equal(call.method, 'POST');
  assert.match(call.url, /^\/_matrix\/client\/v3\/rooms\/!mine(:|%3A)example\.org\/leave$/);
  assert.deepEqual(JSON.parse(call.body), {});

  const n = callsTo(/\/leave$/).length;
  const wa = await post('leave', { chatID: '!wa:beeper.local' });
  assert.equal(wa.status, 409);
  assert.deepEqual(await wa.json(), { error: 'not_matrix' });
  // A direct chat of the Matrix account: groups only.
  const dm = await post('leave', { chatID: '!dm:example.org' });
  assert.equal(dm.status, 409);
  assert.deepEqual(await dm.json(), { error: 'not_group' });
  assert.equal((await post('leave', { chatID: '!unknown:example.org' })).status, 404);
  for (const bad of [{ chatID: 'wa-1' }, { chatID: '' }, { chatID: '!a b' }, { chatID: 1 }, {}, { chatID: '!mine:example.org', x: 1 }]) {
    assert.equal((await post('leave', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(callsTo(/\/leave$/).length, n);
});

test('join is rate limited', async () => {
  let status = 0;
  for (let i = 0; i < 25 && status !== 429; i++) status = (await post('join', { target: 'junk' })).status;
  assert.equal(status, 429);
});
