import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// The rule of every catalog, the core's and the packages': English is the reference, and every other language has
// exactly its keys, with the same kinds (string, or function of the same arity), and no empty string. Used by
// test/i18n.test.ts (the core) and ext/build.test.ts (every package of the build).

/** A language file's name: its code (en.js, fr.js, pt-BR.js). */
export const LANGUAGE_FILE = /^([a-z]{2,3}(?:-[A-Z]{2})?)\.js$/;

function shape(v: unknown, path: string, out: Map<string, string>) {
  if (typeof v === 'string') {
    assert.ok(v.trim().length > 0, `empty string at ${path}`);
    out.set(path, 'string');
  } else if (typeof v === 'function') out.set(path, `fn/${v.length}`);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) shape(x, `${path}.${k}`, out);
  else assert.fail(`unexpected value at ${path}`);
}

/** Asserts that every language of `byLang` has the shape of its `en` entry; `what` names it in failures. */
export function assertSameShape(byLang: Readonly<Record<string, unknown>>, what: string): void {
  assert.ok(Object.hasOwn(byLang, 'en'), `${what}: no English`);
  const ref = new Map<string, string>();
  shape(byLang.en, what, ref);
  for (const [code, v] of Object.entries(byLang)) {
    const m = new Map<string, string>();
    shape(v, what, m);
    assert.deepEqual([...m].sort(), [...ref].sort(), `${what}: ${code} does not match en`);
  }
}

/** The language files of a folder (compiled), by code: each one's exports. */
export async function languageFiles(dir: URL): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const f of readdirSync(dir).sort()) {
    const code = LANGUAGE_FILE.exec(f)?.[1];
    if (code) out[code] = { ...((await import(new URL(f, dir).href)) as Record<string, unknown>) };
  }
  return out;
}
