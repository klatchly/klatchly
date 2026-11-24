import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultReaction,
  groupReactions,
  planToggle,
  quickReactions,
  reactionView,
  rememberReaction,
  recentReactions,
  sendableKey,
  type ChatCapabilities,
  type Reaction,
} from '../client/src/reactions.js';
import { useConnectorTraits } from '../client/src/connectors.js';
import { localMxc, SELF } from './fixtures/identities.js';

// Image reactions are a connector's media references (connectors.ts): a made-up connector whose references are
// content URIs, as the fixture's (the core assumes none; Beeper's real traits are tested in ext/beeper).
const imageConnector = { id: 'img', name: 'Img', mediaQuery: (u: string) => (/^mxc:\/\/[a-z0-9.-]+\/[\w-]+$/.test(u) ? `u=${encodeURIComponent(u)}` : undefined) };
useConnectorTraits([imageConnector]);

const ME = SELF.id;
const self = new Set([ME]);
// A LINE sticker reaction key: a local-bridge mxc URI, 92 characters in all (synthetic media id).
const LINE_IMG = localMxc('FakeLineSticker' + 'x'.repeat(92 - localMxc('FakeLineSticker').length));
const r = (participantID: string, reactionKey: string, extra: Partial<Reaction> = {}): Reaction => ({ id: participantID + reactionKey, participantID, reactionKey, ...extra });

// LINE-like capabilities, as reported for real LINE chats (subset of the 122 allowed emoji).
const LINE: ChatCapabilities = { reaction: 1, reactionCount: 1, allowedReactions: ['❤️', '😂', '😮', '😢', '👍️', '🙏', '☕️', '🎉'] };

test('reaction kinds: emoji, image (LINE shape), shortcode; never the raw key', () => {
  assert.deepEqual(reactionView(r(ME, '👍', { emoji: true })), { kind: 'emoji', text: '👍' });
  assert.deepEqual(reactionView(r(ME, LINE_IMG, { emoji: false, imgURL: LINE_IMG })), { kind: 'image', text: '', img: LINE_IMG });
  // An mxc key without imgURL is still an image.
  assert.equal(reactionView(r(ME, LINE_IMG)).kind, 'image');
  assert.deepEqual(reactionView(r(ME, ':party_parrot:', { emoji: false })), { kind: 'shortcode', text: ':party_parrot:' });
  assert.deepEqual(reactionView(r(ME, 'smiling-face', { emoji: false })), { kind: 'shortcode', text: ':smiling-face:' });
  // emoji flag missing: guessed from the key.
  assert.equal(reactionView(r(ME, '❤️‍🔥')).kind, 'emoji');
  assert.equal(reactionView(r(ME, '🇫🇷')).kind, 'emoji');
  assert.equal(reactionView(r(ME, '1️⃣')).kind, 'emoji');
  assert.equal(reactionView(r(ME, 'heart')).kind, 'shortcode');
  // An imgURL that is none of a connector's media is never used (only what a connector's relay names).
  assert.equal(reactionView(r(ME, 'x', { emoji: false, imgURL: 'file:///etc/passwd' })).kind, 'shortcode');
  assert.equal(reactionView(r(ME, 'x', { emoji: false, imgURL: 'https://example.org/a.png' })).kind, 'shortcode');
  // No connector of the build names the key: a shortcode, never a picture.
  useConnectorTraits([]);
  try {
    assert.equal(reactionView(r(ME, LINE_IMG)).kind, 'shortcode');
    assert.equal(reactionView(r(ME, LINE_IMG, { emoji: false, imgURL: LINE_IMG })).kind, 'shortcode');
  } finally {
    useConnectorTraits([imageConnector]);
  }
});

test('grouping: same emoji with/without FE0F together, image by picture, ours first, counts', () => {
  const g = groupReactions(
    [r('@a', '👍️'), r(ME, '👍'), r('@b', '👍'), r('@a', LINE_IMG, { emoji: false, imgURL: LINE_IMG }), r(ME, LINE_IMG, { emoji: false, imgURL: LINE_IMG }), r('@c', '😂')],
    self,
  );
  assert.equal(g.length, 3);
  assert.deepEqual(g[0]!.who, [ME, '@a', '@b']);
  assert.equal(g[0]!.count, 3);
  assert.equal(g[0]!.mine, true);
  assert.equal(g[0]!.key, '👍', 'our own spelling is the key to remove');
  assert.equal(g[1]!.view.kind, 'image');
  assert.equal(g[1]!.count, 2);
  assert.equal(g[2]!.mine, false);
  // Duplicate participant entries are counted once; junk entries are ignored.
  assert.equal(groupReactions([r('@a', '👍'), r('@a', '👍'), { id: 'x' } as Reaction], self)[0]!.count, 1);
});

test('toggle: add and remove on a network without limits', () => {
  const p1 = planToggle([r('@a', '👍')], '❤️', self, ME);
  assert.deepEqual(p1.remove, []);
  assert.equal(p1.add, '❤️');
  assert.equal(p1.next.length, 2);
  const p2 = planToggle([r(ME, '❤️'), r(ME, '👍')], '❤️', self, ME);
  assert.deepEqual(p2.remove, ['❤️']);
  assert.equal(p2.add, undefined);
  assert.deepEqual(p2.next.map((x) => x.reactionKey), ['👍']);
  // FE0F-insensitive: removing "👍" when we reacted "👍️".
  assert.deepEqual(planToggle([r(ME, '👍️')], '👍', self, ME).remove, ['👍️']);
});

test('toggle: reactionCount = 1 replaces our reaction (DELETE old, then POST new)', () => {
  const before = [r('@a', '😂'), r(ME, '❤️')];
  const p = planToggle(before, '😂', self, ME, 1);
  assert.deepEqual(p.remove, ['❤️']);
  assert.equal(p.add, '😂');
  assert.deepEqual(p.next.filter((x) => x.participantID === ME).map((x) => x.reactionKey), ['😂']);
  assert.equal(p.next.filter((x) => x.participantID === '@a').length, 1, 'other people keep theirs');
  // Our image reaction (made in the LINE app) is replaced the same way.
  const img = planToggle([r(ME, LINE_IMG, { emoji: false, imgURL: LINE_IMG })], '❤️', self, ME, 1);
  assert.deepEqual(img.remove, [LINE_IMG]);
  // Tapping our current one removes it, nothing added.
  const off = planToggle([r(ME, '❤️')], '❤️', self, ME, 1);
  assert.deepEqual([off.remove, off.add, off.next.length], [['❤️'], undefined, 0]);
  // reactionCount = 2: the newest one stays (API order: newest first), the older goes.
  const two = planToggle([r(ME, '🎉'), r(ME, '❤️')], '😂', self, ME, 2);
  assert.deepEqual(two.remove, ['❤️']);
  assert.deepEqual(two.next.filter((x) => x.participantID === ME).map((x) => x.reactionKey), ['😂', '🎉']);
});

test('allowed reactions: network spelling, refusals, image reactions', () => {
  assert.equal(sendableKey('👍', LINE), '👍️', 'sent with the FE0F the network lists');
  assert.equal(sendableKey('🦄', LINE), undefined);
  assert.equal(sendableKey(LINE_IMG, LINE), undefined, 'image reactions are not offered for +1 on LINE');
  assert.equal(sendableKey('🦄', undefined), '🦄');
  assert.equal(sendableKey(LINE_IMG, undefined), LINE_IMG, 'native Beeper chats (no capabilities) take custom ones');
  assert.equal(sendableKey(LINE_IMG, { reaction: 2 }), undefined);
  assert.equal(sendableKey(LINE_IMG, { reaction: 2, customEmojiReactions: true }), LINE_IMG);
});

test('quick bar: recent first, defaults, filtered by and completed from the allowed list', () => {
  assert.deepEqual(quickReactions(undefined), ['❤️', '😂', '😮', '😢', '👍', '🙏']);
  assert.deepEqual(quickReactions(undefined, ['🦄', '❤️']), ['🦄', '❤️', '😂', '😮', '😢', '👍']);
  const allowed = LINE.allowedReactions!;
  assert.deepEqual(quickReactions(allowed, ['🦄', '🎉']), ['🎉', '❤️', '😂', '😮', '😢', '👍️']);
  assert.deepEqual(quickReactions(['☕️', '🎉'], []), ['☕️', '🎉']);
  assert.deepEqual(quickReactions(undefined, [LINE_IMG]).includes(LINE_IMG), false);
  assert.equal(defaultReaction(undefined), '❤️');
  assert.equal(defaultReaction(['😂', '☕️']), '😂');
  assert.equal(defaultReaction(['☕️']), '☕️');
});

test('recent reactions survive missing or broken storage', () => {
  const g = globalThis as { localStorage?: unknown };
  delete g.localStorage;
  assert.deepEqual(recentReactions(), []);
  rememberReaction('👍'); // no throw
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  rememberReaction('👍');
  rememberReaction('❤️');
  rememberReaction('👍️');
  rememberReaction(LINE_IMG);
  assert.deepEqual(recentReactions(), ['👍️', '❤️']);
  store.set('reactions.recent', '{bad json');
  assert.deepEqual(recentReactions(), []);
  g.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(recentReactions(), []);
  rememberReaction('🎉');
  delete g.localStorage;
});
