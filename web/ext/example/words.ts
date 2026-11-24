// What the ✨ entry computes, as a pure function: no React, no DOM, no import, so the package's unit tests
// (test/words.test.ts, run by Node) can check it without a browser. Keep logic like this out of components.

export interface Count {
  words: number;
  characters: number;
}

// Characters as the user sees them (an emoji or an accented letter is one), via the platform's segmenter.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Words: runs of letters, digits or marks, whatever the script; punctuation and emoji do not count.
const WORD = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/gu;

/** Counts the words and characters of a draft (trimmed). */
export function countText(text: string): Count {
  const t = text.trim();
  return { words: t.match(WORD)?.length ?? 0, characters: [...graphemes.segment(t)].length };
}
