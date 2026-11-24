// No personal data in the source tree (docs/tests.md, "Personal data"). Two lists:
// - generic patterns, committed here: phone numbers and bridged network IDs that don't look synthetic
//   (synthetic ones carry 000, a 1234 sequence or the fictional 555 range: test/fixtures/identities.ts);
// - the owner's own strings (names, Matrix ID, production domains), never committed: one per line in the
//   git-ignored test/.privacy-denylist and/or in KLATCHLY_PRIVACY_DENYLIST (comma or newline separated). Plain
//   text matches case-insensitively; /…/ is a regular expression (flag i). Without either, that part is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// build-test/test/privacy.test.js → web/
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIRS = ['server', 'client/src', 'client/public', 'client/index.html', 'ext', 'test', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'build-test', 'build-server', 'dist', 'shots']);
const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.md', '.sh', '.txt', '.svg', '.webmanifest']);
const DENYLIST_FILE = join(ROOT, 'test', '.privacy-denylist');

function files(p: string, out: string[] = []): string[] {
  if (!existsSync(p)) return out;
  if (!statSync(p).isDirectory()) {
    if (TEXT.has(extname(p)) && !p.endsWith('.privacy-denylist')) out.push(p);
    return out;
  }
  for (const d of readdirSync(p, { withFileTypes: true })) if (!(d.isDirectory() && SKIP_DIRS.has(d.name))) files(join(p, d.name), out);
  return out;
}

const tree = DIRS.flatMap((d) => files(join(ROOT, d))).map((f) => ({ f: relative(ROOT, f), text: readFileSync(f, 'utf8') }));

const SYNTHETIC = (digits: string) => /000|1234|555|(\d)\1{4}/.test(digits);
const GENERIC: { what: string; re: RegExp; real: (m: RegExpExecArray) => boolean }[] = [
  // "+33 6 12 34 56 78", "+15550100001": an international number, 9 digits or more.
  { what: 'phone number', re: /\+\d[\d .-]{7,}\d/g, real: (m) => m[0].replace(/\D/g, '').length >= 9 && !SYNTHETIC(m[0].replace(/\D/g, '')) },
  // "@telegram_6692…:beeper.local", "telegram.8753…", "whatsapp.33…": a bridged network's numeric user id.
  { what: 'network user id', re: /\b(?:telegram|whatsapp|signal|instagram|facebook\w*|twitter|discord\w*|zalo)[_.](\d{6,})\b/gi, real: (m) => !SYNTHETIC(m[1]!) },
];

function local(): RegExp[] {
  const lines = [...(existsSync(DENYLIST_FILE) ? readFileSync(DENYLIST_FILE, 'utf8').split('\n') : []), ...(process.env.KLATCHLY_PRIVACY_DENYLIST ?? '').split(/[,\n]/)]
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines.map((l) => (/^\/.+\/$/.test(l) ? new RegExp(l.slice(1, -1), 'i') : new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')));
}

test('the scan sees the source tree', () => {
  assert.ok(tree.length > 100, `${tree.length} files`);
  assert.ok(tree.some((x) => x.f === 'server/names.ts'));
});

test('no real-looking phone number or network user id', () => {
  const hits: string[] = [];
  for (const { f, text } of tree) {
    for (const g of GENERIC) {
      for (const m of text.matchAll(g.re)) if (g.real(m as RegExpExecArray)) hits.push(`${f}: ${g.what} ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], 'use a synthetic value from test/fixtures/identities.ts');
});

test('none of the local denylist (owner names, Matrix ID, domains)', (t) => {
  const deny = local();
  if (!deny.length) return t.skip('no test/.privacy-denylist nor KLATCHLY_PRIVACY_DENYLIST');
  const hits: string[] = [];
  for (const { f, text } of tree) {
    text.split('\n').forEach((line, i) => {
      // The entry itself is not printed: the report stays free of what it looks for.
      deny.forEach((re, k) => re.test(line) && hits.push(`${f}:${i + 1} (entry ${k + 1})`));
    });
  }
  assert.deepEqual(hits, []);
});
