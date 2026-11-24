// The packages of the build the offline instances run (what `npm test` compiled into build-test/: the composition
// file scripts/compose-packages.mjs wrote from the list, KLATCHLY_PACKAGES or ext/packages.json), and what each brings
// for the end-to-end run: its fake service (ext/<id>/test/offline.mjs, started by server.mjs) and its scripts
// (ext/<id>/test/*.e2e.cjs, run by run.mjs with the core's test/e2e/*.e2e.js).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The ids of the build, in the order of the list. */
export function builtPackages(root) {
  const file = join(root, 'build-test/ext/packages.server.js');
  if (!existsSync(file)) throw new Error(`${file} is missing: run npm test first (from web/)`);
  return [...readFileSync(file, 'utf8').matchAll(/from '\.\/([a-z][a-z0-9-]*)\/server\/index\.js'/g)].map((m) => m[1]);
}

/** The fake service of each package of the build that has one: [id, path]. */
export const packageFakes = (root) =>
  builtPackages(root)
    .map((id) => [id, join(root, 'ext', id, 'test/offline.mjs')])
    .filter(([, f]) => existsSync(f));

/** The end-to-end scripts of each package of the build, as paths from test/e2e. */
export const packageScripts = (root) =>
  builtPackages(root).flatMap((id) => {
    const dir = join(root, 'ext', id, 'test');
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.e2e.cjs')).sort().map((f) => `../../ext/${id}/test/${f}`) : [];
  });

/** The core's end-to-end scripts, as paths from test/e2e. */
export const coreScripts = (root) => readdirSync(join(root, 'test/e2e')).filter((f) => f.endsWith('.e2e.js')).sort();
