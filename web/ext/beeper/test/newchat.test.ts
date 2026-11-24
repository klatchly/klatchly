import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { newChatRoutes } from '#core/newchat.js';
import { summarize } from '../server/newchat.js';
import { desktop } from '../server/desktop.js';

import { mockUpstream } from '../../../test/mock.js';
import './setup.js';

const WA = 'whatsapp.817000000000';
const FB = 'facebookgo.1000';
const DC = 'discordgo.364000';
const LI = 'linkedin.ACoAAA0000';
// LinkedIn's search matches accents as typed ("michael" never finds Michaël); its handles are internal ids.
const LI_PEOPLE = [
  { id: 'ACoAAMichaelOther00000000000000000000001', username: 'ACoAAMichaelOther00000000000000000000001', fullName: 'Michael Fakeman' },
  { id: 'ACoAAMichaelKnown00000000000000000000002', username: 'ACoAAMichaelKnown00000000000000000000002', fullName: 'Michaël Fakeman' },
  { id: 'ACoAAFakemann000000000000000000000000003', username: 'ACoAAFakemann000000000000000000000000003', fullName: 'Michael Fakemann' },
];
const liSearch = (q: string) =>
  LI_PEOPLE.filter((p) => q.toLowerCase().split(' ').every((w) => p.fullName.toLowerCase().split(' ').some((n) => n.startsWith(w))));

const up = mockUpstream({
  'GET /v1/accounts': () => [
    200,
    [
      { accountID: 'matrix', network: 'Beeper', status: 'connected', bridge: { id: 'matrix', type: 'matrix', provider: 'cloud' }, user: { id: '@me:beeper.com' } },
      { accountID: WA, network: 'WhatsApp', status: 'connected', bridge: { id: 'whatsapp', type: 'whatsapp', provider: 'cloud' }, user: { id: 'me' } },
      { accountID: FB, network: 'Facebook', status: 'connected', bridge: { id: 'facebookgo', type: 'facebookgo', provider: 'cloud' }, user: { id: 'me' } },
      { accountID: DC, network: 'Discord', status: 'connected', bridge: { id: 'discordgo', type: 'discordgo', provider: 'cloud' }, user: { id: 'me' } },
      { accountID: LI, network: 'LinkedIn', status: 'connected', bridge: { id: 'linkedin', type: 'linkedin', provider: 'cloud' }, user: { id: 'me' } },
    ],
  ],
  'GET /v1/bridges/matrix/capabilities': () => [400, { message: 'Invalid bridgeID', code: 'invalid_parameter' }],
  'GET /v1/bridges/whatsapp/capabilities': () => [
    200,
    {
      resolve_identifier: { create_dm: true, lookup_phone: true, lookup_email: false, lookup_username: false, any_phone: false, contact_list: true, search: false },
      group_creation: { group: { type_description: 'a group chat', name: { allowed: true, max_length: 100 }, participants: { allowed: true, required: true, min_length: 1 } } },
    },
  ],
  'GET /v1/bridges/facebookgo/capabilities': () => [
    200,
    {
      resolve_identifier: { create_dm: true, lookup_phone: false, lookup_email: false, lookup_username: false, any_phone: false, contact_list: false, search: true },
      group_creation: { group: { type_description: 'a group', name: { allowed: false }, participants: { allowed: true, required: true, min_length: 2, max_length: 250 } } },
    },
  ],
  'GET /v1/bridges/discordgo/capabilities': () => [
    200,
    { resolve_identifier: { create_dm: false, lookup_phone: false, lookup_email: false, lookup_username: true, any_phone: false, contact_list: true, search: true }, group_creation: {} },
  ],
  [`GET /v1/accounts/${WA}/contacts`]: () => [
    200,
    { items: [{ id: 'wa-1', phoneNumber: '+33600000001', fullName: 'Alice', imgURL: 'mxc://local.beeper.com/a', secret: 'x' }, { id: 'bad id' }, { nope: 1 }] },
  ],
  [`GET /v1/accounts/${WA}/contacts/list`]: () => [200, { items: [{ id: '@whatsapp_lid-1:beeper.local', fullName: 'Bob' }], hasMore: true, oldestCursor: 'c1', newestCursor: 'c0' }],
  [`GET /v1/accounts/${LI}/contacts`]: (req) => [200, { items: liSearch(new URL(req.url!, 'http://x').searchParams.get('query') ?? '') }],
  // The account's chats: Michaël in a direct chat, a group with someone else.
  'GET /v1/chats': (req) =>
    new URL(req.url!, 'http://x').searchParams.get('accountIDs') === LI
      ? [
          200,
          {
            items: [
              { id: '!michael:beeper.local', type: 'single', participants: { items: [{ id: 'me', isSelf: true }, { id: '@linkedin_x:beeper.local', username: LI_PEOPLE[1]!.id }] } },
              { id: '!group:beeper.local', type: 'group', participants: { items: [{ id: '@linkedin_y:beeper.local', username: LI_PEOPLE[2]!.id }] } },
            ],
            hasMore: false,
          },
        ]
      : [200, { items: [], hasMore: false }],
  [`GET /v1/accounts/${FB}/contacts`]: () => [502, { message: 'network down', code: 'bridge_error' }],
  'POST /v1/chats/start': (_req, body) => {
    const b = JSON.parse(body) as { user: { id?: string } };
    if (b.user.id === 'missing') return [404, { message: 'User not found', code: 'not_found' }];
    return [200, { id: '!new:beeper.local', chatID: '!new:beeper.local', status: 'created', accountID: WA, network: 'WhatsApp', title: 'Alice', type: 'single', unreadCount: 0 }];
  },
  'POST /v1/chats': () => [200, { id: '!group:beeper.local', chatID: '!group:beeper.local', accountID: WA, network: 'WhatsApp', title: 'Team', type: 'group', unreadCount: 0 }],
});

const app = new Hono().route('/api', newChatRoutes);
const json = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const writes = () => up.calls.filter((c) => c.method === 'POST');

// The accounts Beeper lists are its own (accounts.ts): the client lists them before it starts a chat.
before(async () => {
  await up.start();
  await desktop.accounts();
});
after(() => up.stop());

test('capabilities summary', () => {
  const s = summarize({ accountID: 'x', network: 'Telegram', status: 'connected' }, {
    resolve_identifier: { create_dm: true, lookup_phone: true, lookup_username: true, contact_list: true },
    group_creation: { group: { name: { allowed: true, required: true, max_length: 255 }, participants: { allowed: true, required: true, min_length: 1, max_length: 200 } } },
  });
  assert.deepEqual(s.group, { nameAllowed: true, nameRequired: true, nameMax: 255, min: 1, max: 200 });
  assert.deepEqual(s.lookup, { phone: true, email: false, username: true });
  assert.equal(summarize({ accountID: 'm', network: 'Beeper' }, null).group, null);
  assert.equal(summarize({ accountID: 'm', network: 'Beeper' }, { resolve_identifier: {}, group_creation: {} }).start, false);
});

test('GET new-chat caps (bridge, Beeper without bridge, unknown account)', async () => {
  const wa = (await (await json('GET', `/api/accounts/${WA}/new-chat`)).json()) as { start: boolean; group: { min: number; nameAllowed: boolean } };
  assert.equal(wa.start, true);
  assert.equal(wa.group.min, 1);
  const m = (await (await json('GET', '/api/accounts/matrix/new-chat')).json()) as { start: boolean; group: unknown };
  assert.equal(m.start, true);
  assert.equal(m.group, null);
  assert.equal((await json('GET', '/api/accounts/nope.1/new-chat')).status, 404);
  assert.equal((await json('GET', '/api/accounts/bad%2Fid/new-chat')).status, 400);
});

test('contact search and list relay', async () => {
  const r = await json('GET', `/api/accounts/${WA}/contacts?query=${encodeURIComponent(' Alice ')}`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { items: [{ id: 'wa-1', phoneNumber: '+33600000001', fullName: 'Alice', imgURL: 'mxc://local.beeper.com/a' }] });
  assert.ok(up.calls.some((c) => /\/contacts\?query=Alice$/.test(c.url)));
  for (const q of ['', '?query=', `?query=${'x'.repeat(201)}`, '?query=%00']) {
    assert.equal((await json('GET', `/api/accounts/${WA}/contacts${q}`)).status, 400, q);
  }
  const l = (await (await json('GET', `/api/accounts/${WA}/contacts/list`)).json()) as { items: unknown[]; hasMore: boolean; oldestCursor: string };
  assert.equal(l.items.length, 1);
  assert.equal(l.oldestCursor, 'c1');
  assert.match(up.calls.at(-1)!.url, /limit=100/);
  assert.equal((await json('GET', `/api/accounts/${WA}/contacts/list?limit=5`)).status, 400);
  const f = await json('GET', `/api/accounts/${FB}/contacts?query=x`);
  assert.equal(f.status, 502);
  assert.deepEqual(await f.json(), { error: 'upstream', code: 'bridge_error' });
});

test('start: forwards exactly {accountID, user}; refusals', async () => {
  const before = writes().length;
  const r = await json('POST', '/api/chats/start', { accountID: WA, user: { id: 'wa-1', fullName: 'Alice' } });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { id: string }).id, '!new:beeper.local');
  const call = writes().at(-1)!;
  assert.equal(call.url, '/v1/chats/start');
  assert.deepEqual(JSON.parse(call.body), { accountID: WA, user: { id: 'wa-1', fullName: 'Alice' } });
  assert.equal(writes().length, before + 1);

  const nf = await json('POST', '/api/chats/start', { accountID: WA, user: { id: 'missing' } });
  assert.equal(nf.status, 404);
  assert.deepEqual(await nf.json(), { error: 'upstream', code: 'not_found' });

  // Discord's bridge cannot create DMs: refused here, nothing sent.
  const n = writes().length;
  assert.equal((await json('POST', '/api/chats/start', { accountID: DC, user: { id: 'x' } })).status, 409);
  assert.equal((await json('POST', '/api/chats/start', { accountID: WA, user: { id: 'x' }, messageText: 'hi' })).status, 400);
  assert.equal((await app.request('/api/chats/start', { method: 'POST', body: '{"accountID":"a","user":{"id":"x"}}' })).status, 400); // no JSON type
  assert.equal(writes().length, n);
});

test('create: groups only within the bridge limits', async () => {
  const r = await json('POST', '/api/chats', { accountID: WA, type: 'group', participantIDs: ['a', 'b'], title: 'Team' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(writes().at(-1)!.body), { accountID: WA, type: 'group', participantIDs: ['a', 'b'], title: 'Team' });
  const n = writes().length;
  // Facebook: no title allowed, at least 2 participants.
  assert.equal((await json('POST', '/api/chats', { accountID: FB, type: 'group', participantIDs: ['a', 'b'], title: 'x' })).status, 400);
  assert.equal((await json('POST', '/api/chats', { accountID: FB, type: 'group', participantIDs: ['a'] })).status, 400);
  // Discord, Beeper: no documented group creation.
  assert.equal((await json('POST', '/api/chats', { accountID: DC, type: 'group', participantIDs: ['a', 'b'] })).status, 409);
  assert.equal((await json('POST', '/api/chats', { accountID: 'matrix', type: 'group', participantIDs: ['a', 'b'] })).status, 409);
  assert.equal(writes().length, n);
});

test('contact search: accents and single words searched too; the people one talks to first, with their direct chat', async () => {
  const r = (await (await json('GET', `/api/accounts/${LI}/contacts?query=${encodeURIComponent('michael fakeman')}`)).json()) as {
    items: { id: string; fullName: string; inChats?: boolean; chatID?: string }[];
  };
  // "michael fakeman" alone finds the other Michael; "fakeman" finds Michaël, who comes first (a direct chat with him).
  assert.deepEqual(
    r.items.map((x) => [x.fullName, x.inChats ?? false, x.chatID ?? null]),
    [
      ['Michaël Fakeman', true, '!michael:beeper.local'],
      ['Michael Fakemann', true, null],
      ['Michael Fakeman', false, null],
    ],
  );
  const asked = up.calls.filter((c) => c.url.startsWith(`/v1/accounts/${LI}/contacts?`)).map((c) => new URL(c.url, 'http://x').searchParams.get('query'));
  assert.deepEqual(asked, ['michael fakeman', 'michael', 'fakeman']);
});
