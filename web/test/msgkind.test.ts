import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKindCard, kindLine } from '../server/msgkind.js';
import { messages } from '../server/i18n.js';
import { payloadFor } from '../server/pushwatch.js';

// Messages of a kind without a body of their own (a call, a shared contact…): which ones show as a card, and their
// one line in previews and push bodies.

test('which messages are cards of their kind', () => {
  assert.ok(isKindCard({ type: 'CALL' }));
  assert.ok(isKindCard({ type: 'CONTACT', text: 'Hoa' }));
  assert.ok(isKindCard({ type: 'UNSUPPORTED' }));
  assert.ok(isKindCard({ type: 'LOCATION' }), 'a location without coordinates or text');
  assert.ok(!isKindCard({ type: 'LOCATION', text: 'geo:1,2' }), 'a location with text renders as before');
  assert.ok(!isKindCard({ type: 'CALL', attachments: [{}] }));
  for (const type of ['TEXT', 'IMAGE', 'NOTICE', undefined]) assert.ok(!isKindCard({ type }), String(type));
});

test('one line: the kind, then its detail, in the language asked', () => {
  const fr = messages('fr').types;
  const en = messages('en').types;
  assert.equal(kindLine({ type: 'CALL' }, fr), '📞 Appel');
  assert.equal(kindLine({ type: 'CALL_MISSED' }, fr), '📞 Appel manqué');
  assert.equal(kindLine({ type: 'CALL', text: '3:05' }, fr), '📞 Appel · 3:05');
  assert.equal(kindLine({ type: 'CALL' }, en), '📞 Call');
  assert.equal(kindLine({ type: 'CONTACT', text: 'Hoa\n84900000001' }, en), '👤 Contact · Hoa 84900000001');
  assert.equal(kindLine({ type: 'UNSUPPORTED' }, fr), 'Message non pris en charge');
  assert.equal(kindLine({ type: 'TEXT', text: 'hi' }, en), undefined);
});

test('push bodies of a call and a contact card', () => {
  const at = new Date().toISOString();
  const call = payloadFor({ id: '1', chatID: 'other:u:1', senderName: 'Minh', type: 'CALL', timestamp: at }, { title: 'Minh', type: 'single' }, 'fr');
  assert.equal(call.body, '📞 Appel');
  const card = payloadFor({ id: '2', chatID: 'other:u:1', senderName: 'Minh', type: 'CONTACT', text: 'Hoa', timestamp: at }, { title: 'Minh', type: 'single' }, 'en');
  assert.equal(card.body, '👤 Contact · Hoa');
  const other = payloadFor({ id: '3', chatID: 'other:u:1', senderName: 'Minh', type: 'UNSUPPORTED', timestamp: at }, { title: 'Minh', type: 'single' }, 'en');
  assert.equal(other.body, 'Unsupported message');
});
