import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIdentifier, normalizePhone } from '../server/identifier.js';
import { cleanContact, contactQuery, parseCreate, parseStart } from '../server/newchat.js';
import { SELF, WHATSAPP_ACCOUNT } from './fixtures/identities.js';

const WA = WHATSAPP_ACCOUNT;
const FB = 'facebookgo.1000';
const DC = 'discordgo.364000';

test('identifiers: phone, email, @username, other text', () => {
  assert.deepEqual(classifyIdentifier('+33 6 12 34 56 78'), { kind: 'phone', value: '+33612345678' });
  assert.deepEqual(classifyIdentifier('06.12.34.56.78'), { kind: 'phone', value: '0612345678' });
  assert.deepEqual(classifyIdentifier('Alice@Example.org'), { kind: 'email', value: 'alice@example.org' });
  assert.deepEqual(classifyIdentifier(`@${SELF.username}`), { kind: 'username', value: `@${SELF.username}` });
  assert.deepEqual(classifyIdentifier(SELF.id), { kind: 'username', value: SELF.id });
  for (const t of [SELF.firstName, SELF.username, '12345', '+1 2', 'a@b', '@', '@a b', '', 'x'.repeat(300)]) assert.equal(classifyIdentifier(t), null, t);
  assert.equal(normalizePhone('+1234567890123456'), null);
});

test('contact query validation', () => {
  assert.equal(contactQuery(` ${SELF.firstName} `), SELF.firstName);
  for (const q of [undefined, '', '   ', 'a\u0000b', 'x'.repeat(201)]) assert.equal(contactQuery(q), null, String(q));
});

test('start body: only accountID and the documented user fields', () => {
  assert.deepEqual(parseStart({ accountID: WA, user: { id: 'wa-1', fullName: 'Alice' } }), { accountID: WA, user: { id: 'wa-1', fullName: 'Alice' } });
  assert.deepEqual(parseStart({ accountID: WA, user: { phoneNumber: '+33 6 12 34 56 78' } }), { accountID: WA, user: { phoneNumber: '+33612345678' } });
  const bad: unknown[] = [
    { accountID: WA },
    { accountID: WA, user: {} },
    { accountID: WA, user: { fullName: 'Only a name' } },
    { accountID: WA, user: { id: 'x' }, messageText: 'hello' },
    { accountID: WA, user: { id: 'x' }, allowInvite: false },
    { accountID: WA, user: { id: 'x', extra: 1 } },
    { accountID: WA, user: { id: 'a b' } },
    { accountID: WA, user: { phoneNumber: 'abc' } },
    { accountID: WA, user: { email: 'not-an-email' } },
    { accountID: WA, user: { username: 'has space' } },
    { accountID: WA, user: { id: 'x', fullName: 'a\nb' } },
    { accountID: 'bad/account', user: { id: 'x' } },
    { accountID: WA, user: ['x'] },
  ];
  for (const b of bad) assert.equal(parseStart(b as Record<string, unknown>), null, JSON.stringify(b));
});

test('create body: type, unique participants, optional title', () => {
  assert.deepEqual(parseCreate({ accountID: WA, type: 'group', participantIDs: ['a', 'b'], title: ' Team ' }), {
    accountID: WA,
    type: 'group',
    participantIDs: ['a', 'b'],
    title: 'Team',
  });
  assert.ok(parseCreate({ accountID: WA, type: 'single', participantIDs: ['a'] }));
  const bad: unknown[] = [
    { accountID: WA, type: 'group', participantIDs: [] },
    { accountID: WA, type: 'group', participantIDs: ['a', 'a'] },
    { accountID: WA, type: 'group', participantIDs: ['a b'] },
    { accountID: WA, type: 'group', participantIDs: Array.from({ length: 251 }, (_, i) => `u${i}`) },
    { accountID: WA, type: 'single', participantIDs: ['a', 'b'] },
    { accountID: WA, type: 'single', participantIDs: ['a'], title: 'x' },
    { accountID: WA, type: 'channel', participantIDs: ['a'] },
    { accountID: WA, type: 'group', participantIDs: ['a'], title: '' },
    { accountID: WA, type: 'group', participantIDs: ['a'], title: 'x'.repeat(301) },
    { accountID: WA, type: 'group', participantIDs: ['a'], messageText: 'hi' },
  ];
  for (const b of bad) assert.equal(parseCreate(b as Record<string, unknown>), null, JSON.stringify(b).slice(0, 60));
});

test('contacts are cleaned to the documented fields', () => {
  assert.deepEqual(cleanContact({ id: 'u', fullName: 'A', other: 'x', isSelf: true }), { id: 'u', fullName: 'A', isSelf: true });
  assert.equal(cleanContact({ fullName: 'no id' }), null);
});

