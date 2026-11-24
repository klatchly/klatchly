// Server build: the core (server/) and the packages' server halves (ext/, from ext/packages.server.ts) are one
// TypeScript program, emitted to build-server/{server,ext}. The image runs the flat layout of before: the core
// in dist/ (/app/dist/index.js, cli.js; ops scripts import dist/upstream.js, dist/config.js…), the packages in
// dist/ext/. The two trees only reach each other through package.json "imports" (#core/*, #ext/*), which
// point at dist/ at run time, so moving them does not break an import.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
rmSync('build-server', { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.server.json'], { stdio: 'inherit' });
rmSync('dist/ext', { recursive: true, force: true });
cpSync('build-server/server', 'dist', { recursive: true });
cpSync('build-server/ext', 'dist/ext', { recursive: true });
rmSync('build-server', { recursive: true, force: true });
