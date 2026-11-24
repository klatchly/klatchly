import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dataPath, log } from '#core/sdk.js';
import { DEFAULT_LANG_PREFS, MAX_DRAFT, MAX_READ, validLangList, type LangPrefs } from '../langs.js';

// The user's translation languages (Settings → Translation languages), app-wide, in data/langs.json: what the
// composer offers to translate a draft into, and what received messages are translated into. A list missing or
// invalid in the file reads as its default. Routes in assist.ts (/api/assist/langs).

let prefs: LangPrefs | undefined;
const file = () => dataPath('langs.json');

export function langPrefs(): LangPrefs {
  if (!prefs) {
    let raw: Partial<Record<keyof LangPrefs, unknown>> = {};
    try {
      raw = JSON.parse(readFileSync(file(), 'utf8')) ?? {};
    } catch {
      // first run
    }
    prefs = {
      draftLangs: validLangList(raw.draftLangs, MAX_DRAFT) ? raw.draftLangs : [...DEFAULT_LANG_PREFS.draftLangs],
      readLangs: validLangList(raw.readLangs, MAX_READ) ? raw.readLangs : [...DEFAULT_LANG_PREFS.readLangs],
    };
  }
  return prefs;
}

/**
 * Replaces the lists given (already validated); written at once, it is a rare change. Throws when the file cannot be
 * written, and then keeps the lists as they were.
 */
export function setLangPrefs(p: Partial<LangPrefs>): LangPrefs {
  const next = { ...langPrefs(), ...p };
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next) + '\n', { mode: 0o600 });
    renameSync(tmp, file());
  } catch (e) {
    log('assist', 'langs write failed');
    throw e;
  }
  prefs = next;
  return prefs;
}
