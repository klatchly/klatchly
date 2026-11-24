// npm test, after the composition (scripts/compose-packages.mjs) and the compilation (tsconfig.test.json →
// build-test/): runs the unit tests with node --test, one process per file, for the package list of the build.
//   - the core's (test/*.test.ts) and the whole build's (ext/*.test.ts): always;
//   - a listed package's own (ext/<id>/test/*.test.ts): all of them;
//   - a package of the tree left out of the list: only its tests that do not load the build
//     (ext/packages.server.ts): those test the package by itself, whatever the list; the others test it inside the
//     build and wait until it is listed, unless they say they hold for any list (a line `// klatchly-test: any-list`,
//     as ext/example/test/package.test.ts, which adds the package to the build itself when it is not listed).
// So the suite holds for any list: KLATCHLY_PACKAGES=beeper,accounts,llm,writing,example npm test (see docs/tests.md).
// Extra arguments go to node --test (e.g. --test-name-pattern=…).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = join(WEB, 'build-test');
const tests = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.test.js')).sort().map((f) => join(d, f)) : []);

// The ids of the build: the imports of the composition file (what compose-packages.mjs wrote from the list).
const listed = new Set([...readFileSync(join(WEB, 'ext/packages.server.ts'), 'utf8').matchAll(/from '\.\/([a-z][a-z0-9-]*)\/server\/index\.js'/g)].map((m) => m[1]));
const files = [...tests(join(BUILT, 'test')), ...tests(join(BUILT, 'ext'))];
const skipped = [];
for (const id of readdirSync(join(BUILT, 'ext')).sort()) {
  for (const f of tests(join(BUILT, 'ext', id, 'test'))) {
    const src = readFileSync(f, 'utf8');
    if (listed.has(id) || !/packages\.server\.js['"]/.test(src) || /^\/\/ klatchly-test: any-list$/m.test(src)) files.push(f);
    else skipped.push(`${id}/test/${f.split('/').pop()}`);
  }
}
console.log(`run-tests: packages ${[...listed].join(', ')}${skipped.length ? `; left out with their package (they load the build): ${skipped.join(', ')}` : ''}`);
const r = spawnSync(process.execPath, ['--test', '--conditions=klatchly-test', '--import', './build-test/test/env.js', ...process.argv.slice(2), ...files.map((f) => f.slice(WEB.length + 1))], { cwd: WEB, stdio: 'inherit' });
process.exit(r.status ?? 1);
