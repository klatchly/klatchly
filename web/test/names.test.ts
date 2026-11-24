import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRawUserID, senderLabel } from '../server/names.js';
import { payloadFor } from '../server/pushwatch.js';
import { RAW_TELEGRAM_MEMBER as RAW, RAW_TELEGRAM_MEMBER_TAIL as TAIL } from './fixtures/identities.js';

const member = (tail: string) => (tail ? `Member ·${tail}` : 'Member');

test('real names pass through, raw Matrix IDs become a member label', () => {
  assert.equal(senderLabel('Alice', '@whatsapp_123:beeper.local', member), 'Alice');
  assert.equal(senderLabel(RAW, RAW, member), `Member ·${TAIL}`);
  assert.equal(senderLabel(undefined, RAW, member), `Member ·${TAIL}`);
  assert.equal(senderLabel('  ', undefined, member), undefined);
  assert.equal(isRawUserID('@a:b'), true);
  assert.equal(isRawUserID('@alice'), false);
  assert.equal(isRawUserID('Alice @ work: hi'), false);
});

test('push title never shows a raw member ID', () => {
  const p = payloadFor(
    { id: '1', chatID: '!c:beeper.local', senderName: RAW, senderID: RAW, text: 'hi', type: 'TEXT', timestamp: new Date().toISOString() },
    { title: 'Group', type: 'group' },
    'fr',
  );
  assert.ok(!JSON.stringify(p).includes('@telegram_'), JSON.stringify(p));
  assert.ok(JSON.stringify(p).includes(`Membre ·${TAIL}`));
});
