import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeListHead, mergeNewest } from '../client/src/newest.js';

// A conversation brought up to date with its newest page alone (client/src/newest.ts): what a reconnect or a return
// to the app reads now instead of every loaded page.

type M = { id: string; timestamp: string; text?: string; delivered?: boolean };
type P = { items: M[]; hasMore: boolean; oldestCursor: string | null; newestCursor: string | null };
const t = (n: number) => new Date(Date.UTC(2026, 10, 18, 10, n)).toISOString();
const m = (id: string, n: number, text = id): M => ({ id, timestamp: t(n), text });
const page = (items: M[], oldestCursor: string | null, hasMore = !!oldestCursor): P => ({ items, hasMore, oldestCursor, newestCursor: null });

test('new messages on top, edits replaced, the cached tail and its cursor kept', () => {
  const data = { pages: [page([m('e', 5), m('d', 4), m('c', 3)], 'cur-c'), page([m('b', 2), m('a', 1)], null)], pageParams: [undefined, 'cur-c'] };
  const fresh = page([m('g', 7), m('f', 6), m('e', 5, 'edited'), m('d', 4)], 'cur-d');
  const out = mergeNewest(data, fresh);
  assert.deepEqual(out.pages[0]!.items.map((x) => x.id), ['g', 'f', 'e', 'd', 'c']);
  assert.equal(out.pages[0]!.items[2]!.text, 'edited');
  assert.equal(out.pages[0]!.oldestCursor, 'cur-c', 'the cached tail goes on from where it did');
  assert.deepEqual(out.pages[1], data.pages[1]);
  assert.deepEqual(out.pageParams, data.pageParams);
});

test('a message gone upstream within the new range leaves; what a later page also holds leaves that page', () => {
  const data = { pages: [page([m('d', 4), m('x', 3)], 'cur-x'), page([m('c', 2), m('b', 1)], 'cur-b')], pageParams: [undefined, 'cur-x'] };
  // x was deleted; the new page reaches down into the second page.
  const fresh = page([m('e', 5), m('d', 4), m('c', 2)], 'cur-c2');
  const out = mergeNewest(data, fresh);
  assert.deepEqual(out.pages[0]!.items.map((x) => x.id), ['e', 'd', 'c']);
  assert.equal(out.pages[0]!.oldestCursor, 'cur-c2', 'nothing of the old first page beyond it: its own cursor');
  assert.deepEqual(out.pages[1]!.items.map((x) => x.id), ['b']);
});

test('nothing in common: the conversation starts again from the new page (what came between may be missing)', () => {
  const data = { pages: [page([m('b', 2), m('a', 1)], null)], pageParams: [undefined] };
  const fresh = page([m('z', 30), m('y', 29)], 'cur-y');
  const out = mergeNewest(data, fresh);
  assert.deepEqual(out.pages, [fresh]);
  assert.deepEqual(out.pageParams, [undefined]);
});

test('keep: what the old copy keeps (delivered ticks the server infers)', () => {
  const data = { pages: [page([{ ...m('a', 1), delivered: true }], null)], pageParams: [undefined] };
  const out = mergeNewest(data, page([m('b', 2), m('a', 1)], null), (old: M, fresh: M) => (old.delivered && !fresh.delivered ? { ...fresh, delivered: true } : fresh));
  assert.equal(out.pages[0]!.items[1]!.delivered, true);
});

test('a message that came in live while the newest page was being read stays on top', () => {
  // The cache got h (message.upserted) after the server had answered with g..e.
  const data = { pages: [page([m('h', 8), m('f', 6), m('e', 5)], 'cur-e'), page([m('d', 4)], null)], pageParams: [undefined, 'cur-e'] };
  const fresh = page([m('g', 7), m('f', 6), m('e', 5)], 'cur-e2');
  const out = mergeNewest(data, fresh);
  assert.deepEqual(out.pages[0]!.items.map((x) => x.id), ['h', 'g', 'f', 'e']);
  assert.deepEqual(out.pages[1]!.items.map((x) => x.id), ['d']);
  // Even with nothing in common (the conversation starts again from the page), it is kept.
  const apart = mergeNewest({ pages: [page([m('z', 40)], null)], pageParams: [undefined] }, page([m('y', 30), m('x', 29)], 'c'));
  assert.deepEqual(apart.pages[0]!.items.map((x) => x.id), ['z', 'y', 'x']);
});

test('a later page loses what it holds within the new range that the server no longer has', () => {
  const data = { pages: [page([m('e', 5)], 'cur-e'), page([m('gone', 4), m('c', 3), m('a', 1)], 'cur-a')], pageParams: [undefined, 'cur-e'] };
  const out = mergeNewest(data, page([m('f', 6), m('e', 5), m('c', 3)], 'cur-c'));
  assert.deepEqual(out.pages[0]!.items.map((x) => x.id), ['f', 'e', 'c']);
  assert.deepEqual(out.pages[1]!.items.map((x) => x.id), ['a'], 'gone (deleted) and c (on top now) leave it');
});

type C = { id: string; lastActivity: string; isPinned?: boolean };
type CP = { items: C[]; hasMore: boolean; oldestCursor: string | null; newestCursor: string | null };
const c = (id: string, n: number, pinned = false): C => ({ id, lastActivity: t(n), ...(pinned ? { isPinned: true } : {}) });
const cpage = (items: C[], oldestCursor: string | null): CP => ({ items, hasMore: !!oldestCursor, oldestCursor, newestCursor: null });

test('a chat list scrolled far: its top read again, the pages beyond kept where the user reads them', () => {
  const data = {
    pages: [cpage([c('pin', 0, true), c('a', 9), c('b', 8)], 'p1'), cpage([c('x', 7), c('d', 6)], 'p2'), cpage([c('e', 5), c('f', 4)], 'p3'), cpage([c('g', 3), c('h', 2)], 'p4')],
    pageParams: [undefined, 'p1', 'p2', 'p3'],
  };
  // e got a message (now on top); x was archived; live meanwhile: n arrived after the server answered.
  const withLive = { ...data, pages: [{ ...data.pages[0]!, items: [data.pages[0]!.items[0]!, c('n', 20), ...data.pages[0]!.items.slice(1)] }, ...data.pages.slice(1)] };
  const top = cpage([c('pin', 0, true), c('e', 10), c('a', 9), c('b', 8), c('d', 6)], 'q1');
  const out = mergeListHead(withLive, top);
  assert.deepEqual(
    out.pages.flatMap((p) => p.items.map((x) => x.id)),
    ['pin', 'n', 'e', 'a', 'b', 'd', 'f', 'g', 'h'],
  );
  assert.equal(out.pages.length, 4, 'pages beyond the top kept');
  assert.equal(out.pages[3]!.oldestCursor, 'p4', 'scrolling goes on from where it was');
});

test('a chat list whose top is the whole list now: nothing else kept', () => {
  const data = { pages: [cpage([c('a', 9)], 'p1'), cpage([c('b', 8)], null)], pageParams: [undefined, 'p1'] };
  const out = mergeListHead(data, cpage([c('a', 9)], null));
  assert.deepEqual(out.pages.flatMap((p) => p.items.map((x) => x.id)), ['a']);
  assert.equal(out.pages.length, 1);
});
