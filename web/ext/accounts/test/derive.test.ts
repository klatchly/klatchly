import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceAccount as ReadAccount } from '#core/sdk.js';
import type { SourceAccount } from '../shapes.js';
import { networksSpace } from '../package.js';
import { accountSlug, slugAccount } from '../slug.js';
import { addChats, capabilitiesOf, cleanAccount, FORGET_MS, healthOf, parseSince, recentOf, STUCK_MS, trackSince, viewsOf, type SinceMap } from '../server/derive.js';
import { spacePlace } from '#core/extension.js';

// The dashboard's derivations on canned Desktop API shapes (docs/desktop-api-openapi-4.3.229.json, Account and
// Chat): cleaning, health, since when, figures, capabilities, account ids in URLs. Neutral fake identities.

const WA = {
  accountID: 'local-whatsapp_ba_Q0FBQUFBQkFBQUFC',
  loginID: 'ba_Q0FBQUFBQkFBQUFC',
  bridge: { id: 'local-whatsapp', type: 'whatsapp', provider: 'local' },
  network: 'WhatsApp',
  user: { id: 'ba_Q0FBQUFBQkFBQUFC', phoneNumber: '+15550100000', fullName: 'Alex Sample', imgURL: 'file:///tmp/a.jpg', isSelf: true },
  status: 'connected',
  capabilities: { reply: 1, edit: 2, delete: 0, reaction: 1, thread: -1, readReceipts: true, archive: false, maxTextLength: 65536 },
};
const SLACK = {
  accountID: 'slackgo.T0001-U0001',
  bridge: { id: 'slackgo', type: 'slackgo', provider: 'cloud' },
  network: 'Slack',
  user: { id: 'U0001', username: 'alex', email: 'alex@example.test' },
  status: 'reconnect_required',
  statusText: 'Session expired\u0007, sign in again',
};

/** An account as the core's chatSources hands it over (its projection of the connector's Account). */
const read = (a: typeof WA | typeof SLACK): ReadAccount => ({
  source: 'beeper',
  accountID: a.accountID,
  network: a.network,
  status: a.status as ReadAccount['status'],
  ...('statusText' in a ? { statusText: a.statusText } : {}),
  bridge: { type: a.bridge.type, provider: a.bridge.provider },
  user: Object.fromEntries(Object.entries(a.user).filter(([k]) => ['fullName', 'username', 'phoneNumber', 'email'].includes(k))),
  ...('capabilities' in a ? { capabilities: a.capabilities } : {}),
});

test('an account, cleaned for display: control characters out, its source kept, a status it does not give unknown', () => {
  const a = cleanAccount(read(WA))!;
  assert.deepEqual(a, {
    accountID: WA.accountID,
    source: 'beeper',
    network: 'WhatsApp',
    bridge: { type: 'whatsapp', provider: 'local' },
    user: { fullName: 'Alex Sample', phoneNumber: '+15550100000' },
    status: 'connected',
    capabilities: WA.capabilities,
  });
  const s = cleanAccount(read(SLACK))!;
  assert.equal(s.statusText, 'Session expired , sign in again');
  assert.deepEqual(s.user, { username: 'alex', email: 'alex@example.test' });
  // Older Desktop versions: no bridge, no status, no network; another source's account by its plain id.
  assert.deepEqual(cleanAccount({ source: 'beeper', accountID: 'matrix', user: {} }), { accountID: 'matrix', source: 'beeper', network: 'matrix', user: {}, status: 'unknown' });
  assert.deepEqual(cleanAccount({ source: 'other', accountID: 'other', network: 'Other', status: 'connecting', user: {} }), { accountID: 'other', source: 'other', network: 'Other', user: {}, status: 'connecting' });
  assert.equal(cleanAccount({ ...read(WA), bridge: { type: 'whatsapp', provider: 'elsewhere' } })!.bridge?.provider, undefined);
  for (const bad of ['', 'a b', 'a\u0000b', 'x'.repeat(201)]) assert.equal(cleanAccount({ source: 'beeper', accountID: bad, user: {} }), null, JSON.stringify(bad));
});

test('health: what needs the user is trouble; connecting turns into trouble once stuck, an unknown status never', () => {
  const now = 10 * STUCK_MS;
  assert.equal(healthOf('connected', 0, now), 'ok');
  assert.equal(healthOf('backfilling', 0, now), 'busy');
  assert.equal(healthOf('connecting', now - 60_000, now), 'busy');
  assert.equal(healthOf('connecting', now - STUCK_MS - 1, now), 'trouble');
  assert.equal(healthOf('unknown', now, now), 'busy');
  // A source that gives no status (older Desktop versions) is not "stuck connecting".
  assert.equal(healthOf('unknown', 0, now), 'busy');
  assert.equal(healthOf('disabled', 0, now), 'off');
  for (const s of ['connection_required', 'reconnect_required', 'attention_required', 'disconnected'] as const) assert.equal(healthOf(s, now, now), 'trouble', s);
});

test('since when: an unchanged status keeps its time, a change restarts it, gone accounts are dropped', () => {
  const a = cleanAccount(read(WA))!;
  const b = cleanAccount(read(SLACK))!;
  const none = new Set<string>();
  const first = trackSince({}, [a, b], none, 1000);
  assert.ok(first.changed);
  assert.deepEqual(first.next, {
    [a.accountID]: { status: 'connected', since: 1000, seen: 1000, source: 'beeper' },
    [b.accountID]: { status: 'reconnect_required', since: 1000, seen: 1000, source: 'beeper' },
  });
  const same = trackSince(first.next, [a, b], none, 2000);
  assert.ok(!same.changed);
  assert.equal(same.next[a.accountID]!.since, 1000);
  assert.equal(same.next[a.accountID]!.seen, 2000);
  const fixed = trackSince(same.next, [a, { ...b, status: 'connected' }], none, 3000);
  assert.ok(fixed.changed);
  assert.deepEqual(fixed.next[b.accountID], { status: 'connected', since: 3000, seen: 3000, source: 'beeper' });
  const gone = trackSince(fixed.next, [a], none, 4000);
  assert.ok(gone.changed);
  assert.deepEqual(Object.keys(gone.next), [a.accountID]);
});

test('since when: a source down for a minute keeps its accounts\' times; forgotten after 30 days unseen', () => {
  const a = cleanAccount(read(WA))!;
  const z = { ...cleanAccount(read(WA))!, accountID: 'other', source: 'other' };
  const t0 = Date.UTC(2026, 0, 1);
  const first = trackSince({}, [a, z], new Set(), t0);
  // Beeper does not answer for a minute: its account is not listed, its entry stays (and nothing to save).
  const down = trackSince(first.next, [z], new Set(['beeper']), t0 + 60_000);
  assert.ok(!down.changed);
  assert.deepEqual(down.next[a.accountID], { status: 'connected', since: t0, seen: t0, source: 'beeper' });
  const back = trackSince(down.next, [a, z], new Set(), t0 + 120_000);
  assert.equal(back.next[a.accountID]!.since, t0, 'since kept');
  // Down for good: the entry goes once it was not listed for FORGET_MS.
  const later = trackSince(back.next, [z], new Set(['beeper']), t0 + 120_000 + FORGET_MS);
  assert.ok(later.changed);
  assert.ok(!(a.accountID in later.next));
});

test('accounts.json read back: only well-formed entries', () => {
  const ok = { status: 'connected', since: 5, seen: 9, source: 'beeper' };
  assert.deepEqual(
    parseSince({
      since: {
        good: ok,
        legacy: { status: 'disconnected', since: 7 },
        badStatus: { ...ok, status: 'exploded' },
        badSince: { ...ok, since: 'yesterday' },
        nan: { ...ok, since: null },
        badSeen: { ...ok, seen: '1' },
        'bad id': ok,
        notObj: 3,
      },
    }),
    { good: ok, legacy: { status: 'disconnected', since: 7, seen: 7 } },
  );
  for (const raw of [null, [], 'x', { since: [] }, { since: 'x' }]) assert.deepEqual(parseSince(raw), {});
});

test('views: trouble first, then by network; no capabilities in them', () => {
  const list: SourceAccount[] = [cleanAccount(read(WA))!, cleanAccount(read(SLACK))!, { ...cleanAccount(read(WA))!, accountID: 'discordgo', network: 'Discord', status: 'disabled' }];
  const since: SinceMap = { [SLACK.accountID]: { status: 'reconnect_required', since: Date.UTC(2026, 0, 2), seen: Date.UTC(2026, 0, 2) } };
  const v = viewsOf(list, since, Date.UTC(2026, 0, 3));
  assert.deepEqual(v.map((x) => [x.accountID, x.health]), [[SLACK.accountID, 'trouble'], [WA.accountID, 'ok'], ['discordgo', 'off']]);
  assert.equal(v[0]!.since, '2026-01-02T00:00:00.000Z');
  // Not seen before: since now.
  assert.equal(v[1]!.since, '2026-01-03T00:00:00.000Z');
  assert.ok(v.every((x) => !('capabilities' in x)));
});

test('figures per account from the chat list (archived wins over low priority)', () => {
  const stats = {};
  const chat = (id: string, over: Record<string, unknown> = {}) => ({ id, accountID: WA.accountID, type: 'single', unreadCount: 0, ...over });
  addChats(stats, [
    chat('!a:x', { unreadCount: 3, lastActivity: '2026-01-01T10:00:00Z' }),
    chat('!b:x', { type: 'group', isLowPriority: true, unreadCount: 2 }),
    chat('!c:x', { isArchived: true, isLowPriority: true, isMuted: true, lastActivity: '2026-01-02T08:00:00Z' }),
    chat('!d:x', { isMarkedUnread: true }),
    { id: 'other:u:1', accountID: 'other', type: 'single', unreadCount: 1, lastActivity: 'not a date' },
    { id: 'no account' },
    null,
    chat('!e:x', { unreadCount: -4 }),
  ]);
  assert.deepEqual(stats, {
    [WA.accountID]: { chats: 5, groups: 1, unreadChats: 3, unreadMessages: 5, lowPriority: 1, archived: 1, muted: 1, lastActivity: '2026-01-02T08:00:00.000Z' },
    other: { chats: 1, groups: 0, unreadChats: 1, unreadMessages: 1, lowPriority: 0, archived: 0, muted: 0, lastActivity: null },
  });
});

test('recent chats: newest first, at most n, titles and flags only', () => {
  const r = recentOf(
    [
      { id: '!old:x', title: 'Old', type: 'group', lastActivity: '2026-01-01T00:00:00Z', unreadCount: 0, preview: { text: 'secret' } },
      { id: '!new:x', title: 'New\u0000', type: 'single', lastActivity: '2026-01-03T00:00:00Z', unreadCount: 2, isMuted: true },
      { id: '!mid:x', title: 'Mid', lastActivity: '2026-01-02T00:00:00Z', isArchived: true },
      { title: 'no id' },
    ],
    2,
  );
  assert.deepEqual(r, [
    { id: '!new:x', title: 'New', type: 'single', lastActivity: '2026-01-03T00:00:00.000Z', unreadCount: 2, isArchived: false, isLowPriority: false, isMuted: true },
    { id: '!mid:x', title: 'Mid', type: 'single', lastActivity: '2026-01-02T00:00:00.000Z', unreadCount: 0, isArchived: true, isLowPriority: false, isMuted: false },
  ]);
});

test('capabilities in plain terms: levels from 1, booleans, attachments by kind, text length', () => {
  assert.deepEqual(capabilitiesOf(undefined), []);
  assert.deepEqual(capabilitiesOf({}), []);
  assert.deepEqual(
    capabilitiesOf({
      ...WA.capabilities,
      attachments: { 'm.image': { maxSize: 16_000_000 }, 'org.matrix.msc3245.voice': { maxSize: 100 }, 'm.file': { maxSize: 100_000_000 }, 'x.unknown': {} },
      disappearingTimer: { types: ['afterSend'] },
      poll: 'yes',
    }),
    [
      { key: 'reply', supported: true },
      { key: 'edit', supported: true },
      { key: 'delete', supported: false },
      { key: 'reaction', supported: true },
      { key: 'thread', supported: false },
      { key: 'readReceipts', supported: true },
      { key: 'archive', supported: false },
      { key: 'disappearingTimer', supported: true },
      { key: 'attachments', supported: true, kinds: ['image', 'voice', 'file'], limit: 100_000_000 },
      { key: 'maxTextLength', supported: true, limit: 65536 },
    ],
  );
  assert.deepEqual(capabilitiesOf({ attachments: {} }), [{ key: 'attachments', supported: false, kinds: [] }]);
});

test('account ids in URLs: reversible, one segment of the space, look-alikes refused', () => {
  const ids = ['matrix', 'discordgo', 'slackgo.T0001-U0001', 'local-whatsapp_ba_Q0FBQUFBQkFBQUFC', 'other', 'a:b@c=d+e', 'é'];
  for (const id of ids) {
    const slug = accountSlug(id);
    assert.equal(slugAccount(slug), id, id);
    assert.deepEqual(spacePlace(networksSpace, `/networks/${slug}`), { place: slug }, id);
  }
  assert.equal(accountSlug('slackgo.T0001-U0001'), 'slackgo_2eT0001-U0001');
  assert.equal(accountSlug('local-whatsapp_ba_X'), 'local-whatsapp_5fba_5fX');
  // Not made by accountSlug: an escape of a kept character, an upper-case escape, a broken escape, bad UTF-8.
  for (const bad of ['_61', '_2E', '_2', 'a_', '_ff', '', 'a.b', 'a/b']) assert.equal(slugAccount(bad), null, bad);
});
