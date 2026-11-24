import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTE_ERRORS, noteError } from '../client/errors.js';
import en from '../locales/en.js';
import fr from '../locales/fr.js';

// The page's half where it can be checked without a browser: the refusal codes the page has a sentence for (under a
// voice note, and a provider Test's result), the strings, and the launch-path files read as text (as
// ext/writing/test/package.test.ts does): focus and the live region of a note, where the transcript's language goes,
// the touch targets and the contrast of the voice notes' block.

const source = (f: string) => readFileSync(new URL(`../../../../ext/transcribe/client/${f}`, import.meta.url), 'utf8');

test('refusal codes: a sentence for each, in every language; anything else is "failed", never a raw code', () => {
  for (const c of NOTE_ERRORS) {
    assert.ok(en.note.error[c] && fr.note.error[c], c);
    assert.equal(noteError(c), c);
  }
  for (const other of ['unsupported_format', 'not_found', '502', 'network', undefined, null, 7]) assert.equal(noteError(other), 'failed', String(other));
  // A failed Test shows that sentence, not 'échec (rejected)'.
  assert.equal(fr.settings.testFail(fr.note.error[noteError('rejected')]), 'échec : Le fournisseur l’a refusé (clé, modèle ou format).');
  assert.equal(en.settings.testFail(en.note.error[noteError('rate_limited')]), 'failed: Too many transcriptions: wait a few minutes.');
  assert.ok(en.note.copy && fr.note.copy);
});

test('a note: focus follows the tap, a live region there before it, the language on the transcript only', () => {
  const tsx = source('Messages.tsx');
  assert.match(tsx, /className="transcribe-slot"/, 'one stable wrapper');
  assert.match(tsx, /<span className="transcribe-sr" role="status" aria-live="polite">/, 'the live region mounted before the tap');
  assert.doesNotMatch(tsx, /transcribe-note[^\n]*aria-live/, 'no live region added with its content');
  assert.match(tsx, /ref=\{noteRef\} tabIndex=\{-1\}/);
  assert.match(tsx, /btnRef\.current\?\.focus\(\)/, '✕ gives focus back to Transcribe');
  assert.match(tsx, /data-testid=\{`\$\{tid\}-text`\} lang=/, 'lang on the transcript');
  assert.doesNotMatch(tsx, /transcribe-note[^\n]*lang=/, 'not on the label and buttons');
  assert.match(tsx, /aria-describedby=\{status\.label \? privacyId : undefined\}/, 'who gets the sound: read, not only a tooltip');
  assert.match(tsx, /invalidateQueries\(\{ queryKey: \['transcribe', 'status'\] \}\)/, "'unavailable' refreshes the status");
  assert.match(tsx, /data-testid="menu-transcript-copy"/, 'the transcript copied from the menu');
});

test('the block under a voice note: 44 px targets, the ✕ off the transcript, readable text on a sent bubble', () => {
  const css = source('transcribe.css');
  const coarse = css.slice(css.indexOf('@media (pointer: coarse)'), css.indexOf('/* Settings'));
  assert.doesNotMatch(css, /transcribe-close::after/, 'no hit area over the first line');
  assert.match(coarse, /\.transcribe-close \{ min-width: 44px; min-height: 44px;/);
  assert.match(coarse, /\.transcribe-retry \{ min-height: 44px; \}/);
  assert.match(css, /\.transcribe-retry \{ font: inherit;/);
  assert.match(css, /\.transcribe-btn \{[^}]*color: var\(--text\);/);
  assert.match(css, /\.msg\.own \.transcribe-muted/);
  assert.match(css, /\.transcribe-sr \{ position: absolute;/);
});
