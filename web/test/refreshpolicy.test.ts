import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTER_EMPTY_PAGES, FILTER_PAGES, fillDone, MAX_RETRY_MS, ReconnectBackoff, refetchedOnReconnect, shouldFill, STABLE_MS, UNREAD_PAGES } from '../client/src/refreshpolicy.js';
import { MISSED_PONGS, PING_MS, PongWatch } from '../server/keepalive.js';

// What a reconnect and the filtered chat lists load (client/src/refreshpolicy.ts), 2026-11-18.

test('a reconnect never refetches single messages, and reloads lists, conversations and accounts its own way', () => {
  for (const k of ['message', 'reaction-target', 'messages', 'chats', 'chats-lowpri', 'accounts']) assert.equal(refetchedOnReconnect([k, 'x']), false, k);
  for (const k of ['chat', 'chats-archived', 'extensions', 'quiet', 'networks']) assert.equal(refetchedOnReconnect([k]), true, k);
});

const base = { accounts: ['acc'], unread: false, pages: 1, shown: 0, hasNextPage: true, busy: false };

test('network filter: a few pages at most for matches (the server filters), more while none shows', () => {
  assert.equal(shouldFill({ ...base, shown: 5 }), true);
  assert.equal(shouldFill({ ...base, shown: 5, pages: FILTER_PAGES }), false, 'capped');
  assert.equal(shouldFill({ ...base, shown: 0, pages: FILTER_PAGES }), true, 'nothing to show yet');
  assert.equal(shouldFill({ ...base, shown: 0, pages: FILTER_EMPTY_PAGES }), false);
  assert.equal(shouldFill({ ...base, shown: 20 }), false, 'enough shown');
  assert.equal(shouldFill({ ...base, busy: true }), false);
  assert.equal(shouldFill({ ...base, hasNextPage: false }), false);
  assert.equal(shouldFill({ ...base, accounts: [] }), false, 'no filter: no paging by itself');
});

test('unread only: up to its 10 pages; an empty list says so once it would load no more', () => {
  assert.equal(shouldFill({ ...base, accounts: [], unread: true, pages: UNREAD_PAGES - 1, shown: 3 }), true);
  assert.equal(shouldFill({ ...base, accounts: [], unread: true, pages: UNREAD_PAGES, shown: 3 }), false);
  assert.equal(fillDone({ ...base, hasNextPage: false }), true);
  assert.equal(fillDone({ ...base, pages: 2 }), false);
  assert.equal(fillDone({ ...base, pages: FILTER_EMPTY_PAGES }), true);
  assert.equal(fillDone({ ...base, accounts: [], unread: true, pages: UNREAD_PAGES }), true);
});

test('the live socket: its backoff grows while the server keeps dropping it, starts over after a lasting connection', () => {
  const b = new ReconnectBackoff();
  const mid = () => 0.5;
  assert.equal(b.next(0, mid), 750, 'first try: about a second');
  // Connected, then dropped for missed pongs a minute later: no start over.
  b.ready(1_000);
  assert.equal(b.next(61_000, mid), 1_500);
  b.ready(62_000);
  assert.equal(b.next(140_000, mid), 3_000);
  // Up longer than STABLE_MS: from the start again.
  b.ready(150_000);
  assert.equal(b.next(150_000 + STABLE_MS, mid), 750);
  for (let i = 0; i < 20; i++) b.next(0, () => 1);
  assert.equal(b.next(0, () => 1), MAX_RETRY_MS, 'capped');
  b.reset();
  assert.equal(b.next(0, mid), 750, 'started over on purpose (back from the background)');
});

test("the server drops a browser socket after two unanswered pings, not one; the client's backoff outlasts that", () => {
  const w = new PongWatch();
  assert.equal(w.ping(), true);
  assert.equal(w.ping(), true, 'one late pong tolerated');
  w.pong();
  assert.equal(w.ping(), true);
  assert.equal(w.ping(), true);
  assert.equal(w.ping(), false, 'two in a row unanswered: dropped');
  assert.equal(MISSED_PONGS, 2);
  assert.ok(STABLE_MS > PING_MS * (MISSED_PONGS + 1), 'a socket dropped for missed pongs never lasted long enough to start the backoff over');
});
