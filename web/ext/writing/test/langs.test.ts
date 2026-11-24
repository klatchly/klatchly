import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Hono } from 'hono';
import { dataPath } from '#core/sdk.js';
import { DEFAULT_LANG_PREFS, LANG_NAMES, LANGS, isLang, langName, validLangList } from '../langs.js';
import { assistRoutes } from '../server/assist.js';
import { langPrefs } from '../server/langs.js';
import { defaultTarget, draftTargets, langChoices, quickAction, quickChoices } from '../client/choices.js';

// The translation languages (Settings → Translation languages): the supported set, the user's lists (validated,
// stored app-wide), and what the composer offers from them.

test('supported languages: a closed set, each named in English for the prompts and in the UI language', () => {
  assert.deepEqual([...LANGS], ['vi', 'fr', 'en', 'ja', 'zh', 'ko', 'th', 'es', 'de', 'it', 'pt', 'ru']);
  assert.deepEqual(Object.keys(LANG_NAMES).sort(), [...LANGS].sort());
  assert.ok(isLang('ja') && !isLang('xx') && !isLang('FR') && !isLang(undefined) && !isLang('constructor'));
  assert.equal(langName('vi', 'fr'), 'vietnamien');
  assert.equal(langName('ja', 'en'), 'Japanese');
  assert.equal(langName('de', 'not a tag!'), 'German', 'a bad UI tag: the English name');
});

test('lists: 1 to max distinct supported languages, in order', () => {
  assert.ok(validLangList(['vi', 'fr', 'en'], 3));
  assert.ok(validLangList(['ja'], 3));
  for (const bad of [[], ['vi', 'fr', 'en', 'ja'], ['fr', 'fr'], ['xx'], 'fr', null, [1]]) assert.ok(!validLangList(bad, 3), JSON.stringify(bad));
  assert.ok(!validLangList(['fr', 'en', 'ja'], 2));
  assert.deepEqual(DEFAULT_LANG_PREFS, { draftLangs: ['vi', 'fr', 'en'], readLangs: ['fr', 'en'] });
});

test('stored app-wide: defaults, PUT validated and kept in data/langs.json (0600)', async () => {
  const app = new Hono().route('/api/assist', assistRoutes);
  const put = (body: unknown) => app.request('/api/assist/langs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual(await (await app.request('/api/assist/langs')).json(), DEFAULT_LANG_PREFS, 'first run: the defaults');
  const r = await put({ draftLangs: ['ja', 'vi'] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { draftLangs: ['ja', 'vi'], readLangs: ['fr', 'en'] }, 'only the list given changes');
  assert.deepEqual(await (await put({ readLangs: ['en'] })).json(), { draftLangs: ['ja', 'vi'], readLangs: ['en'] });
  for (const bad of [
    {},
    { draftLangs: [] },
    { draftLangs: ['vi', 'fr', 'en', 'ja'] },
    { readLangs: ['fr', 'en', 'ja'] },
    { readLangs: ['fr', 'fr'] },
    { draftLangs: ['xx'] },
    { draftLangs: 'vi' },
    { draftLangs: ['vi'], other: 1 },
  ]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(langPrefs(), { draftLangs: ['ja', 'vi'], readLangs: ['en'] }, 'a refused PUT changes nothing');
  assert.deepEqual(JSON.parse(readFileSync(dataPath('langs.json'), 'utf8')), { draftLangs: ['ja', 'vi'], readLangs: ['en'] });
  assert.equal(statSync(dataPath('langs.json')).mode & 0o777, 0o600);
  // The file cannot be written (its temporary name taken by a directory): 500, nothing changed.
  const tmp = join(dirname(dataPath('langs.json')), 'langs.json.tmp');
  mkdirSync(tmp);
  const failed = await put({ readLangs: ['ko'] });
  rmdirSync(tmp);
  assert.equal(failed.status, 500);
  assert.deepEqual(langPrefs(), { draftLangs: ['ja', 'vi'], readLangs: ['en'] }, 'a failed write changes nothing');
  await put(DEFAULT_LANG_PREFS);
});

test('composer: translations offered from the list, the chat language first, its saved choices kept', () => {
  assert.deepEqual(draftTargets(undefined, ['vi', 'fr', 'en']), ['vi', 'fr', 'en']);
  assert.deepEqual(draftTargets('en', ['vi', 'fr', 'en']), ['en', 'vi', 'fr'], 'the chat language first');
  assert.deepEqual(draftTargets('ko', ['vi', 'fr']), ['ko', 'vi', 'fr'], 'shown first even outside the list');
  assert.equal(defaultTarget(undefined, ['ja', 'vi']), 'ja', 'Ctrl+Shift+L: the first of the list…');
  assert.equal(defaultTarget('fr', ['ja', 'vi']), 'fr', '…unless the chat has its language');
  assert.deepEqual(quickChoices(['ja']), ['spelling', 'grammar', 'rephrase', 'translate:ja']);
  assert.deepEqual(quickChoices(['ja'], 'translate:vi'), ['spelling', 'grammar', 'rephrase', 'translate:ja', 'translate:vi'], 'a saved choice stays visible');
  assert.deepEqual(quickChoices(['ja'], 'grammar'), ['spelling', 'grammar', 'rephrase', 'translate:ja']);
  assert.deepEqual(langChoices(['ja', 'vi'], 'en'), ['ja', 'vi', 'en']);
  assert.deepEqual(langChoices(['ja', 'vi'], 'vi'), ['ja', 'vi']);
  assert.deepEqual(quickAction('translate:ko'), { mode: 'translate', target: 'ko' });
  assert.deepEqual(quickAction('rephrase'), { mode: 'rephrase' });
});
