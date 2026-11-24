import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countText } from '../words.js';

// The ✨ entry's arithmetic, without a browser: a pure function, tested like any other module.

test('words: letters and digits in any script; punctuation, emoji and spaces do not count', () => {
  assert.deepEqual(countText(''), { words: 0, characters: 0 });
  assert.deepEqual(countText('   '), { words: 0, characters: 0 });
  assert.equal(countText('Hello, world!').words, 2);
  assert.equal(countText("l'été est là — c’est 2026").words, 5);
  assert.equal(countText('mother-in-law ... ok?').words, 2);
  assert.equal(countText('Xin chào các bạn 👋').words, 4);
  assert.equal(countText('🎉 🎉').words, 0);
});

test('characters: as the user sees them (an emoji, an accented letter is one), trimmed', () => {
  assert.equal(countText('  été  ').characters, 3);
  assert.equal(countText('👍🏽!').characters, 2);
  assert.equal(countText('é').characters, 1);
});
