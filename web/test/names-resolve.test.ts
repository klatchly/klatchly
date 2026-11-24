import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSenderName } from '../server/pushwatch.js';
import { fakeSource, withFake } from './fakesource.js';
import { RAW_TELEGRAM_MEMBER_2 as RAW } from './fixtures/identities.js';

const src = fakeSource();
src.messages.set('g1', [{ id: '9', chatID: 'g1', senderID: RAW, senderName: 'Артём' }]);
withFake(src);

test("a raw sender ID is resolved from the chat's latest messages (its connector), then remembered", async () => {
  const m = await withSenderName({ id: '10', chatID: 'g1', senderID: RAW, senderName: RAW }, 'g1');
  assert.equal(m.senderName, 'Артём');
  const lookups = src.calls.filter((c) => c === 'messages g1').length;
  const again = await withSenderName({ id: '11', chatID: 'g1', senderID: RAW, senderName: RAW }, 'g1');
  assert.equal(again.senderName, 'Артём');
  assert.equal(src.calls.filter((c) => c === 'messages g1').length, lookups, 'second lookup served from memory');
});

test('a real sender name is left alone without any lookup', async () => {
  const before = src.calls.length;
  const m = await withSenderName({ id: '12', chatID: 'g1', senderID: '@x:beeper.local', senderName: 'Alice' }, 'g1');
  assert.equal(m.senderName, 'Alice');
  assert.equal(src.calls.length, before);
});

test('a sender the lookup cannot resolve is not looked up again for every message; concurrent lookups share one', async () => {
  const unknown = '@unknown-member:beeper.local';
  src.messages.set('g2', [{ id: '1', chatID: 'g2', senderID: '@other:beeper.local', senderName: 'Someone' }]);
  const count = () => src.calls.filter((c) => c === 'messages g2').length;
  const [a, b] = await Promise.all([
    withSenderName({ id: '20', chatID: 'g2', senderID: unknown, senderName: unknown }, 'g2'),
    withSenderName({ id: '21', chatID: 'g2', senderID: unknown, senderName: unknown }, 'g2'),
  ]);
  assert.equal(a.senderName, unknown, 'the fallback label stays');
  assert.equal(b.senderName, unknown);
  assert.equal(count(), 1, 'one lookup for both');
  await withSenderName({ id: '22', chatID: 'g2', senderID: unknown, senderName: unknown }, 'g2');
  assert.equal(count(), 1, 'remembered as unresolved: no new lookup');
});

test('a failed lookup (upstream saturated) is not remembered as unresolved: asked again next time', async () => {
  const member = '@late-member:beeper.local';
  let failing = true;
  const get = src.messages.get.bind(src.messages);
  src.messages.get = (k: string) => {
    if (k === 'g3' && failing) throw new Error('upstream timeout');
    return get(k);
  };
  src.messages.set('g3', [{ id: '1', chatID: 'g3', senderID: member, senderName: 'Bảo' }]);
  const count = () => src.calls.filter((c) => c === 'messages g3').length;
  const first = await withSenderName({ id: '30', chatID: 'g3', senderID: member, senderName: member }, 'g3');
  assert.equal(first.senderName, member, 'the fallback label meanwhile');
  assert.equal(count(), 1);
  failing = false;
  const next = await withSenderName({ id: '31', chatID: 'g3', senderID: member, senderName: member }, 'g3');
  assert.equal(count(), 2, 'looked up again once upstream answers');
  assert.equal(next.senderName, 'Bảo');
});
