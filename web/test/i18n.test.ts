import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLanguage, languages, messages } from '../server/i18n.js';
import { assertSameShape, languageFiles } from './catalogs.js';

// Every catalog of the core has exactly the keys of the English reference (test/catalogs.ts): the launch catalog
// (server/locales/, shared with the server) and the chunks' own (client/src/locales/<chunk>/). fr and en are
// complete; any other language is a file in each folder, picked up from there.
test('catalogs: every language matches English, fr and en are there', async () => {
  assert.ok(languages().includes('en') && languages().includes('fr'));
  assert.ok(isLanguage('fr') && !isLanguage('xx') && !isLanguage('__proto__'));
  assertSameShape(Object.fromEntries(languages().map((l) => [l, messages(l)])), 'server/locales');
  const chunk = await languageFiles(new URL('../client/src/locales/extensions/', import.meta.url));
  assert.ok(chunk.en && chunk.fr);
  assertSameShape(Object.fromEntries(Object.entries(chunk).map(([l, m]) => [l, m.default])), 'client/src/locales/extensions');
  for (const l of Object.keys(chunk)) assert.ok(isLanguage(l), `client/src/locales/extensions/${l}: not a language of server/locales`);
  const signin = await languageFiles(new URL('../client/src/locales/signin/', import.meta.url));
  assert.ok(signin.en && signin.fr);
  assertSameShape(Object.fromEntries(Object.entries(signin).map(([l, m]) => [l, m.default])), 'client/src/locales/signin');
  // The signed-out screens' catalog (the public boot entry's only one, client/src/i18n.ts): its languages are the
  // ones the boot detects, so exactly those of server/locales/.
  const boot = await languageFiles(new URL('../client/src/locales/boot/', import.meta.url));
  assertSameShape(Object.fromEntries(Object.entries(boot).map(([l, m]) => [l, m.default])), 'client/src/locales/boot');
  assert.deepEqual(Object.keys(boot).sort(), [...languages()].sort(), 'client/src/locales/boot: the languages of server/locales');
  const reading = await languageFiles(new URL('../client/src/locales/reading/', import.meta.url));
  assert.ok(reading.en && reading.fr);
  assertSameShape(Object.fromEntries(Object.entries(reading).map(([l, m]) => [l, m.default])), 'client/src/locales/reading');
});

test('catalog functions and plural rules', () => {
  assert.equal(messages('en').conv.members(1), '1 member');
  assert.equal(messages('en').conv.members(3), '3 members');
  assert.equal(messages('fr').conv.members(0), '0 membre');
  assert.equal(messages('fr').conv.members(2), '2 membres');
  assert.equal(messages('fr').push.groupTitle('Bob', 'Famille'), 'Bob · Famille');
  assert.equal(messages('unknown').shell.signOut, 'Sign out');
});
