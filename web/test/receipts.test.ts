import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryReceipts, readReceipts } from '../client/src/receipts.js';
import type { Message } from '../client/src/types.js';

const msg = (id: string, isSender: boolean, seen?: Record<string, string>, extra: Partial<Message> = {}): Message =>
  ({ id, chatID: 'c', accountID: 'a', senderID: isSender ? 'me' : 'bob', timestamp: '', sortKey: id, isSender, seen, ...extra }) as Message;

test('readReceipts: a reader covers every older message of ours, not the newer ones', () => {
  const T = '2026-10-30T00:00:00Z';
  // Newest first: m4 (ours, unread), m3 (theirs, Bob read up to here), m2 (ours), m1 (ours).
  const pages = [{ items: [msg('m4', true, { me: T }), msg('m3', false, { bob: T }), msg('m2', true), msg('m1', true)] }];
  const r = readReceipts(pages, new Set(['me']));
  assert.equal(r.get('m4'), '');
  assert.equal(r.get('m2'), 'bob');
  assert.equal(r.get('m1'), 'bob');
  assert.equal(r.has('m3'), false);
});

test('readReceipts: groups, hidden messages and older pages', () => {
  const T = '2026-10-30T00:00:00Z';
  const pages = [
    // A hidden reaction event still carries Carol's position.
    { items: [msg('m5', true), msg('r1', false, { carol: T }, { isHidden: true, type: 'REACTION' }), msg('m4', true, { bob: T })] },
    { items: [msg('m3', true), msg('m2', false, { dave: T })] },
    { items: [msg('m1', true)] },
  ];
  const r = readReceipts(pages, new Set(['me']));
  assert.equal(r.get('m5'), '');
  assert.equal(r.get('m4'), 'bob,carol');
  assert.equal(r.get('m3'), 'bob,carol');
  assert.equal(r.get('m1'), 'bob,carol,dave');
});

test('deliveryReceipts: same rule from delivered positions; Beeper messages have none', () => {
  const T = '2026-10-30T00:00:00Z';
  const pages = [{ items: [msg('m3', true), msg('m2', true, undefined, { delivered: { bob: T, me: T } }), msg('m1', true, { bob: T })] }];
  const d = deliveryReceipts(pages, new Set(['me']));
  assert.equal(d.get('m3'), '');
  assert.equal(d.get('m2'), 'bob');
  assert.equal(d.get('m1'), 'bob');
  assert.equal(readReceipts(pages, new Set(['me'])).get('m2'), '', 'delivered is not read');
  const beeper = deliveryReceipts([{ items: [msg('x2', true), msg('x1', false, { bob: T })] }], new Set(['me']));
  assert.equal(beeper.get('x2'), '');
});
