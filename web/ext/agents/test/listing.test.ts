import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeFilterCount, applyFilter, cleanTitle, defaultFilter, parseFilter, presentSources, previewLine, sourceLabel, sourceOf, type ListedSession } from '../client/listing.js';

// The Agents space's list without React (client/listing.ts): title hygiene, one-line previews, sources, and the
// filter of the one control row (agent, sources with the terminal hidden by default, unread only, search).

test('titles: no leading emoji, no "· Nov 12 07:20", Hermes\' "#N" kept apart; nothing usable: null (never the preview)', () => {
  assert.deepEqual(cleanTitle('📬 Compte Zalo est revenu'), { text: 'Compte Zalo est revenu', suffix: null });
  assert.deepEqual(cleanTitle('🇫🇷👍🏽 Bonjour'), { text: 'Bonjour', suffix: null });
  assert.deepEqual(cleanTitle('iris-alerte · Nov 12 07:20'), { text: 'iris-alerte', suffix: null });
  assert.deepEqual(cleanTitle('iris-alerte · Nov 2 7:05 #3'), { text: 'iris-alerte', suffix: '#3' });
  assert.deepEqual(cleanTitle('🍝 Dîner de samedi #2'), { text: 'Dîner de samedi', suffix: '#2' });
  assert.deepEqual(cleanTitle('  Facture   Free  '), { text: 'Facture Free', suffix: null });
  assert.deepEqual(cleanTitle('Version #12 du plan'), { text: 'Version #12 du plan', suffix: null }, '#N only at the end');
  assert.deepEqual(cleanTitle('Rendez-vous · lundi'), { text: 'Rendez-vous · lundi', suffix: null }, 'only Hermes\' date shape goes');
  for (const empty of [null, undefined, '', '   ', '📬', '🎉 · Nov 12 07:20']) assert.equal(cleanTitle(empty), null, String(empty));
});

test('previews: one line, Markdown out, at most 90 characters', () => {
  assert.equal(previewLine('**Tri du matin** :\n\n- 3 mails\n- [lien](https://x.example)'), 'Tri du matin : - 3 mails - lien');
  assert.equal(previewLine('a'.repeat(200)).length, 90);
  assert.equal(previewLine(null), '');
});

test('sources: Klatchly for a conversation made here; names for the known ones, the terminal in the caller\'s words', () => {
  assert.equal(sourceOf({}), 'klatchly');
  assert.equal(sourceLabel('telegram'), 'Telegram');
  assert.equal(sourceLabel('whatsapp'), 'WhatsApp');
  assert.equal(sourceLabel('cli', 'Ligne de commande'), 'Ligne de commande');
  assert.equal(sourceLabel('mon_plugin'), 'Mon plugin');
  const s = (id: string, source?: string) => ({ id, agent: 'a', title: null, preview: null, unread: 0, ...(source ? { source } : {}) });
  assert.deepEqual(presentSources([s('1', 'telegram'), s('2'), s('3', 'cli'), s('4', 'telegram')]), ['klatchly', 'cli', 'telegram']);
});

test('filter: stored as JSON (an agent id alone before 3.1), the terminal hidden by default, anything odd back to the default', () => {
  assert.deepEqual(parseFilter(null), { agent: null, hide: ['cli'], unread: false });
  assert.deepEqual(parseFilter('assistant'), { agent: 'assistant', hide: ['cli'], unread: false });
  assert.deepEqual(parseFilter('{"agent":"default","hide":[],"unread":true}'), { agent: 'default', hide: [], unread: true });
  assert.deepEqual(parseFilter('{"agent":"../x","hide":["../y","telegram"],"unread":"yes"}'), { agent: null, hide: ['telegram'], unread: false });
  assert.deepEqual(parseFilter('{nope'), defaultFilter());
  // Saved before 0.26.1: Klatchly's own source was "beep", read as "klatchly".
  assert.deepEqual(parseFilter('{"agent":null,"hide":["beep","cli"],"unread":false}'), { agent: null, hide: ['klatchly', 'cli'], unread: false });
  assert.deepEqual(parseFilter('{"hide":["beep","klatchly"]}').hide, ['klatchly']);
});

test('filter: agent, sources, unread only (the open one stays), search in titles, previews, agents and sources', () => {
  const rows: ListedSession[] = [
    { id: 'b1', agent: 'default', title: 'Recette du pain', preview: 'Deux heures de pousse', unread: 0 },
    { id: 'b2', agent: 'assistant', title: 'Résumé d’article', preview: null, unread: 2 },
    { id: 'e1', agent: 'default', title: 'Livraison colis', preview: 'Demain matin', unread: 1, source: 'telegram' },
    { id: 'e2', agent: 'default', title: 'Débogage', preview: null, unread: 0, source: 'cli' },
  ];
  const names = { agent: (id: string) => (id === 'assistant' ? 'Assistant' : 'Hermes'), source: (s: string) => sourceLabel(s) };
  const ids = (f = defaultFilter(), q = '', keep?: string) => applyFilter(rows, f, q, names, keep).map((r) => r.id);
  assert.deepEqual(ids(), ['b1', 'b2', 'e1'], 'terminal sessions hidden by default');
  assert.deepEqual(ids({ ...defaultFilter(), hide: [] }), ['b1', 'b2', 'e1', 'e2'], 'shown through the filter');
  assert.deepEqual(ids({ ...defaultFilter(), agent: 'default' }), ['b1', 'e1']);
  assert.deepEqual(ids({ ...defaultFilter(), hide: ['cli', 'klatchly'] }), ['e1']);
  assert.deepEqual(ids({ ...defaultFilter(), unread: true }), ['b2', 'e1']);
  assert.deepEqual(ids({ ...defaultFilter(), unread: true }, '', 'b1'), ['b1', 'b2', 'e1'], 'the open conversation stays');
  assert.deepEqual(ids(defaultFilter(), 'resume'), ['b2'], 'accents and case folded');
  assert.deepEqual(ids(defaultFilter(), 'telegram'), ['e1'], 'the source name');
  assert.deepEqual(ids(defaultFilter(), 'assistant'), ['b2'], 'the agent name');
  assert.deepEqual(ids(defaultFilter(), 'pain pousse'), ['b1'], 'every word');
  assert.deepEqual(ids(defaultFilter(), 'débogage'), [], 'a hidden source stays hidden');
});

test('the Filter button counts what differs from the default (agent, sources, unread only)', () => {
  const present = ['klatchly', 'cli', 'telegram'];
  assert.equal(activeFilterCount(defaultFilter(), present), 0);
  assert.equal(activeFilterCount({ ...defaultFilter(), agent: 'x' }, present), 1);
  assert.equal(activeFilterCount({ ...defaultFilter(), hide: [] }, present), 1, 'terminal shown');
  assert.equal(activeFilterCount({ ...defaultFilter(), hide: [] }, ['klatchly']), 0, 'no terminal session: nothing differs');
  assert.equal(activeFilterCount({ agent: 'x', hide: ['telegram', 'cli'], unread: true }, present), 3);
});
