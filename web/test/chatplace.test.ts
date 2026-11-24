import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatPlace, patchIn, placeChat, type ListChat, type Pages } from '../client/src/chatplace.js';

type C = ListChat & { title?: string; unreadCount?: number };
const chat = (id: string, o: Partial<C> = {}): C => ({ id, lastActivity: '2026-10-01T00:00:00Z', ...o });
const list = (...items: C[]): Pages<C> & { pageParams: unknown[] } => ({ pages: [{ items }], pageParams: [undefined] });
const ids = (d: Pages<C>) => d.pages.flatMap((p) => p.items.map((c) => c.id));

test('archive wins over low priority', () => {
  assert.equal(chatPlace({}), 'inbox');
  assert.equal(chatPlace({ isLowPriority: true }), 'lowPriority');
  assert.equal(chatPlace({ isLowPriority: true, isArchived: true }), null);
  assert.equal(chatPlace({ isArchived: true }), null);
});

test('a chat moved to low priority leaves the inbox and lands at the top of the low-priority list', () => {
  const inbox = list(chat('pin', { isPinned: true }), chat('a'), chat('bank'));
  const low = list(chat('promo'));
  const moved = chat('bank', { isLowPriority: true, isMuted: true } as Partial<C>);
  const where = chatPlace(moved);
  assert.deepEqual(ids(placeChat(inbox, moved, where === 'inbox')), ['pin', 'a']);
  const after = placeChat(low, moved, where === 'lowPriority');
  assert.deepEqual(ids(after), ['bank', 'promo']);
  assert.deepEqual(after.pageParams, [undefined], 'other InfiniteData fields are kept');
});

test('moving back: out of the low-priority list, into the inbox after pinned chats', () => {
  const inbox = list(chat('pin', { isPinned: true }), chat('a'));
  const low = list(chat('bank', { isLowPriority: true }), chat('promo', { isLowPriority: true }));
  const back = chat('bank', { isLowPriority: false });
  assert.deepEqual(ids(placeChat(low, back, chatPlace(back) === 'lowPriority')), ['promo']);
  assert.deepEqual(ids(placeChat(inbox, back, chatPlace(back) === 'inbox')), ['pin', 'bank', 'a']);
});

test('updates in place unless activity is newer; unrelated lists are left untouched', () => {
  const low = list(chat('x', { isLowPriority: true }), chat('bank', { isLowPriority: true, unreadCount: 0 }));
  const read = placeChat(low, chat('bank', { isLowPriority: true, unreadCount: 3 }), true);
  assert.deepEqual(ids(read), ['x', 'bank']);
  assert.equal(read.pages[0]!.items[1]!.unreadCount, 3);
  const newer = placeChat(low, chat('bank', { isLowPriority: true, lastActivity: '2026-10-02T00:00:00Z' }), true);
  assert.deepEqual(ids(newer), ['bank', 'x']);
  const inbox = list(chat('a'));
  assert.equal(placeChat(inbox, chat('bank', { isLowPriority: true }), false), inbox, 'same object when absent');
});

test('search results: a read chat loses its unread count in place, nothing added or moved', () => {
  const results = list(chat('a', { unreadCount: 2 }), chat('b', { unreadCount: 1 }));
  const read = patchIn<C, typeof results>(results, { id: 'a', unreadCount: 0, lastActivity: '2026-11-09T00:00:00Z' })!;
  assert.deepEqual(ids(read), ['a', 'b']);
  assert.equal(read.pages[0]!.items[0]!.unreadCount, 0);
  assert.equal(read.pages[0]!.items[1]!.unreadCount, 1);
  assert.equal(patchIn<C, typeof results>(results, { id: 'z', unreadCount: 0 }), results, 'a chat not in the results is not added');
  assert.equal(patchIn(undefined, { id: 'a' }), undefined);
});
