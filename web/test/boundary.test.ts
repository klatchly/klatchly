import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_SEGMENT } from '../server/settingspages.js';

// The line between the core and the packages (web/ext/), read from the sources:
// - the core (server/, client/src/ and its CSS, client/public/) imports nothing of ext/ but its two composition
//   roots, ext/packages.server.ts and ext/packages.client.ts; the core's tests (test/) import nothing of ext/ at
//   all, so this suite is the core alone;
// - a package's server code reaches the core only through #core/sdk.js (the curated API, server/sdk.ts);
// - a package's shared files (package.ts, locales/) take only types from the core's pure modules;
// - a package's client code reaches the core only through client/src/sdk.ts (the curated client API, named
//   exports only), types included: never another core module, client or server;
// - a package never reaches into another one, except for types from the public entry (ext/<id>/api.ts) of a
//   package it `requires` or `enhances` (a provider's API); that entry takes only types, from #core/sdk.js; the
//   roots import only each package's entry (the whole-build tests beside them, ext/*.test.ts, may import more);
// - what a package depends on is declared (0.15.5): every environment variable it reads is in its package.ts
//   (`config` or `optionalConfig`); both halves spread the same package.ts and declare the same spaces; its client
//   code uses the core's CSS classes (styles.css) and its own, never another package's or undefined ones;
// - what a package reaches outside the app is declared (1.16): its server code uses the Node modules and globals
//   that connect, listen, touch files or start programs only as far as its package.ts says (network, listen,
//   files, spawns), and declares nothing it does not use. An import and identifier scan: it keeps an honest
//   package's declaration true, it does not stop a malicious one (docs/extensions.md, "Security model").

const WEB = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const ROOTS = ['ext/packages.server', 'ext/packages.client'];

function files(dir: string, ext = /\.(ts|tsx|js|mjs|css)$/): string[] {
  return readdirSync(join(WEB, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === 'node_modules') return [];
    if (statSync(join(WEB, rel)).isDirectory()) return files(rel, ext);
    return ext.test(name) ? [rel] : [];
  });
}

interface Import {
  spec: string;
  typeOnly: boolean;
  /** Path under web/ it points at (no extension); null for node_modules, node: or what cannot be resolved. */
  target: string | null;
  /** A computed specifier (template literal): only its text is known. */
  dynamic?: boolean;
}

function targetOf(file: string, spec: string): string | null {
  let t: string | null = null;
  if (spec.startsWith('.')) t = relative(WEB, resolve(dirname(join(WEB, file)), spec));
  else if (spec.startsWith('#core/')) t = `server/${spec.slice(6)}`;
  else if (spec.startsWith('#ext/')) t = `ext/${spec.slice(5)}`;
  else if (spec.startsWith('/') && file.startsWith('client/public/')) t = `client/public${spec}`;
  return t?.split(sep).join('/').replace(/\.(js|ts|tsx)$/, '') ?? null;
}

function imports(file: string, src = readFileSync(join(WEB, file), 'utf8')): Import[] {
  const out: Import[] = [];
  const add = (spec: string, typeOnly = false) => out.push({ spec, typeOnly, target: targetOf(file, spec) });
  const statics = /\b(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(statics)) add(m[3] ?? m[4] ?? m[5]!, !!m[2]);
  // import(`…`): only its text is known.
  for (const m of src.matchAll(/\bimport\(\s*(?:\/\*.*?\*\/\s*)?`([^`]*)`/g)) out.push({ spec: m[1]!, typeOnly: false, target: null, dynamic: true });
  // import.meta.glob('…') / (['…', '…'])
  for (const m of src.matchAll(/import\.meta\.glob(?:<[^>]*>)?\(\s*(\[[^\]]*\]|['"][^'"]+['"])/g)) for (const g of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) add(g[1]!);
  // CSS @import, service worker importScripts.
  for (const m of src.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/g)) add(m[1]!);
  for (const m of src.matchAll(/\bimportScripts\(([^)]*)\)/g)) for (const g of m[1]!.matchAll(/['"]([^'"]+)['"]/g)) add(g[1]!);
  return out;
}

const inExt = (i: Import) => (i.dynamic ? /(^|[^\w])(#?ext)\//.test(i.spec) : !!i.target && (i.target === 'ext' || i.target.startsWith('ext/')));
const pkgOf = (path: string) => /^ext\/([^/]+)\//.exec(path)?.[1];
/** A field of a package's package.ts, as written there (`requires: { llm: '^1.0' }` -> { llm: '^1.0' }). */
function depsOf(pkg: string, field: 'requires' | 'enhances'): Record<string, string> {
  const src = readFileSync(join(WEB, `ext/${pkg}/package.ts`), 'utf8');
  const m = new RegExp(`\\b${field}:\\s*\\{([^}]*)\\}`).exec(src);
  return Object.fromEntries([...(m?.[1] ?? '').matchAll(/['"]?([a-z][a-z0-9-]*)['"]?\s*:\s*['"]([^'"]+)['"]/g)].map((x) => [x[1]!, x[2]!]));
}
/** The packages a package requires or enhances (it may import their public entry's types). */
const requiresOf = (pkg: string): string[] => [...Object.keys(depsOf(pkg, 'requires')), ...Object.keys(depsOf(pkg, 'enhances'))];
/** A list field of a package's package.ts (`config: ['A', 'B']`). */
function listOf(pkg: string, field: 'config' | 'optionalConfig'): string[] {
  const src = readFileSync(join(WEB, `ext/${pkg}/package.ts`), 'utf8');
  const m = new RegExp(`\\b${field}:\\s*\\[([^\\]]*)\\]`).exec(src);
  return [...(m?.[1] ?? '').matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)].map((x) => x[1]!);
}
const packageIds = () => readdirSync(join(WEB, 'ext')).filter((d) => statSync(join(WEB, 'ext', d)).isDirectory() && d !== 'node_modules');
const coreFiles = () => [...files('server'), ...files('client/src'), ...files('client/public', /\.js$/), 'vite.config.ts', 'client/index.html'];

test('the core imports only the composition roots of ext/', () => {
  // The scanner sees every kind of import this file is about (else a pattern could silently match nothing).
  assert.ok(imports('client/src/catalogs.ts').some((i) => i.target === 'server/locales/*'), 'import.meta.glob');
  assert.ok(imports('client/src/lazy.tsx').some((i) => i.dynamic), 'a computed import()');
  assert.ok(imports('ext/example/client/index.tsx').some((i) => i.target === 'ext/example/client/space.css'), 'a stylesheet');
  assert.ok(imports('ext/writing/server/ai.ts').some((i) => i.typeOnly && i.target === 'ext/llm/api'), 'an import type');
  assert.ok(inExt({ spec: '../../ext/${x}', typeOnly: false, target: null, dynamic: true }));
  assert.deepEqual(requiresOf('writing'), ['llm']);
  const bad: string[] = [];
  const roots = new Set<string>();
  for (const f of coreFiles()) {
    for (const i of imports(f)) {
      if (!inExt(i)) continue;
      if (!i.dynamic && ROOTS.includes(i.target!)) roots.add(`${f} -> ${i.target}`);
      else bad.push(`${f}: ${i.spec}`);
    }
  }
  assert.deepEqual(bad, []);
  // One import per side.
  assert.deepEqual([...roots].sort(), ['client/src/registry.ts -> ext/packages.client', 'server/index.ts -> ext/packages.server']);
  // The two roots are generated from the package list (scripts/compose-packages.mjs, ext/build.test.ts checks them).
  for (const r of ROOTS) assert.match(readFileSync(join(WEB, `${r}.ts`), 'utf8'), /^\/\/ Generated by scripts\/compose-packages\.mjs /, r);
});

test("the core's tests do not import ext/ (they are the core alone)", () => {
  const bad = files('test')
    .filter((f) => !f.startsWith('test/e2e/'))
    .flatMap((f) => imports(f).filter(inExt).map((i) => `${f}: ${i.spec}`));
  assert.deepEqual(bad, []);
});

test("packages' server code reaches the core through #core/sdk.js only", () => {
  const bad: string[] = [];
  for (const f of files('ext')) {
    if (!/^ext\/[^/]+\/server\//.test(f) && f !== 'ext/packages.server.ts') continue;
    for (const i of imports(f)) if ((i.target && !i.target.startsWith('ext/') && i.target !== 'ext') || i.dynamic) if (i.spec !== '#core/sdk.js') bad.push(`${f}: ${i.spec}`);
  }
  assert.deepEqual(bad, []);
});

test("a package's public entry (api.ts) takes only types, from #core/sdk.js", () => {
  const bad: string[] = [];
  for (const f of files('ext').filter((x) => /^ext\/[^/]+\/api\.ts$/.test(x))) {
    for (const i of imports(f)) if (!i.typeOnly || i.spec !== '#core/sdk.js') bad.push(`${f}: ${i.spec}`);
  }
  assert.deepEqual(bad, []);
});

test("packages' shared files take only types from the core's pure modules", () => {
  const bad: string[] = [];
  for (const f of files('ext')) {
    if (!/^ext\/[^/]+\/(package\.ts|locales\/)/.test(f)) continue;
    for (const i of imports(f)) {
      if (!i.target || i.target.startsWith('ext/')) continue;
      if (!i.typeOnly || !/^server\/(extension|locales\/[a-z-]+)$/.test(i.target)) bad.push(`${f}: ${i.spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("packages' client code reaches the core through client/src/sdk.ts only (types too)", () => {
  // The scanner sees a package's client imports of the core (a guard against a pattern that matches nothing).
  assert.ok(imports('ext/example/client/index.tsx').some((i) => i.target === 'client/src/sdk'), 'example imports the client sdk');
  const bad: string[] = [];
  for (const f of files('ext')) {
    if (!/^ext\/[^/]+\/client\//.test(f)) continue;
    for (const i of imports(f)) {
      if (i.dynamic) {
        if (!i.spec.startsWith('./')) bad.push(`${f}: import(\`${i.spec}\`)`);
        continue;
      }
      // Its own files (and, for types, a required provider's api.ts: the next tests) and node_modules aside.
      if (!i.target || i.target === 'ext' || i.target.startsWith('ext/')) continue;
      if (i.target !== 'client/src/sdk') bad.push(`${f}: ${i.spec} (import it from client/src/sdk.ts; add it there if it is meant to be public)`);
    }
  }
  assert.deepEqual(bad, []);
});

test('client/src/sdk.ts re-exports by name (no export *) and holds no code of its own', () => {
  const src = readFileSync(join(WEB, 'client/src/sdk.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /export\s+(type\s+)?\*/, 'export * would make whatever a module adds public');
  // Only `export { … } from '…'` / `export type { … } from '…'`: a barrel (vite.config.ts declares it free of side
  // effects, so a package's launch entry pulls only what it uses).
  const rest = src.replace(/export\s+(type\s+)?\{[^}]*\}\s+from\s+'[^']+';/g, '').trim();
  assert.equal(rest, '', 'only named re-exports');
});

test("packages' client code imports no server code (types aside)", () => {
  const bad: string[] = [];
  for (const f of files('ext')) {
    if (!/^ext\/[^/]+\/client\//.test(f) && f !== 'ext/packages.client.ts') continue;
    for (const i of imports(f)) {
      if (i.typeOnly) continue;
      const t = i.target ?? '';
      if (t.startsWith('server/') || /^ext\/[^/]+\/server(\/|$)/.test(t) || t === 'ext/packages.server') bad.push(`${f}: ${i.spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('a package never reaches into another; the roots import only entries', () => {
  const bad: string[] = [];
  for (const f of files('ext')) {
    const own = pkgOf(f);
    // The whole-build tests (ext/build.test.ts…) load the packages, by name too, to check them together.
    if (/^ext\/[^/]+\.test\.ts$/.test(f)) continue;
    for (const i of imports(f)) {
      if (!inExt(i)) continue;
      if (i.dynamic) bad.push(`${f}: ${i.spec}`);
      else if (own) {
        // A package's tests may build the app from the roots.
        const rootFromTest = /^ext\/[^/]+\/test\//.test(f) && ROOTS.includes(i.target!);
        const other = pkgOf(`${i.target}/`);
        // Types of a required package's public entry (a provider's API: ext/llm/api.ts for writing).
        const providerTypes = i.typeOnly && other !== undefined && i.target === `ext/${other}/api` && requiresOf(own).includes(other);
        if (other !== own && !rootFromTest && !providerTypes) bad.push(`${f}: ${i.spec}`);
      } else if (f === 'ext/packages.server.ts' ? !/^ext\/[^/]+\/server\/index$/.test(i.target!) : !/^ext\/[^/]+\/client\/index$/.test(i.target!)) {
        bad.push(`${f}: ${i.spec}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('every environment variable a package reads is declared in its package.ts (config or optionalConfig)', () => {
  const bad: string[] = [];
  for (const pkg of packageIds()) {
    const declared = new Set([...listOf(pkg, 'config'), ...listOf(pkg, 'optionalConfig')]);
    const read = new Set<string>();
    for (const f of files(`ext/${pkg}`).filter((x) => !x.includes('/test/'))) {
      const src = readFileSync(join(WEB, f), 'utf8');
      for (const m of src.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"`]([^'"`]+)['"`]\s*\])/g)) read.add(m[1] ?? m[2]!);
      // A computed name (process.env[x]) cannot be checked: refused.
      if (/process\.env\[\s*[^'"`\s]/.test(src)) bad.push(`${f}: process.env[<computed>]`);
    }
    for (const v of read) if (!declared.has(v)) bad.push(`${pkg} reads ${v}: add it to config (needed) or optionalConfig (has a default) in ext/${pkg}/package.ts`);
    for (const v of declared) if (!read.has(v)) bad.push(`${pkg} declares ${v} but never reads it`);
  }
  assert.deepEqual(bad, []);
});

test('both halves of a package spread the same package.ts and declare the same spaces', () => {
  const bad: string[] = [];
  // definePackage({ ...<x>Package, …: the shared declaration, with no field of it written again beside it.
  const head = (src: string) => /definePackage\(\{\s*\.\.\.(\w+),([\s\S]*?)\bmodules:/.exec(src);
  const spacesIn = (src: string) => [...src.matchAll(/\bspace\(\{\s*\.\.\.(\w+),/g)].map((m) => m[1]!).sort();
  const shadowed = /\b(id|version|Klatchly|requires|enhances|config|optionalConfig|order|network|listen|files|spawns):/;
  for (const pkg of packageIds()) {
    const server = readFileSync(join(WEB, `ext/${pkg}/server/index.ts`), 'utf8');
    const sh = head(server);
    if (!sh) bad.push(`ext/${pkg}/server/index.ts: definePackage({ ...<package.ts declaration>, … }) expected`);
    else if (shadowed.test(sh[2]!)) bad.push(`ext/${pkg}/server/index.ts: a field of package.ts written again`);
    // Spaces as declared in package.ts (their SpaceInfo), never written in place.
    if (/\bspace\(\{(?!\s*\.\.\.)/.test(server)) bad.push(`ext/${pkg}/server/index.ts: a space not spread from package.ts`);
    let client: string;
    try {
      client = readFileSync(join(WEB, `ext/${pkg}/client/index.tsx`), 'utf8');
    } catch {
      continue; // server only (a provider)
    }
    const ch = head(client);
    if (!ch) bad.push(`ext/${pkg}/client/index.tsx: definePackage({ ...<package.ts declaration>, … }) expected`);
    else {
      if (shadowed.test(ch[2]!)) bad.push(`ext/${pkg}/client/index.tsx: a field of package.ts written again`);
      if (sh && ch[1] !== sh[1]) bad.push(`${pkg}: the halves spread different declarations (${sh[1]} / ${ch[1]})`);
    }
    if (/\bspace\(\{(?!\s*\.\.\.)/.test(client)) bad.push(`ext/${pkg}/client/index.tsx: a space not spread from package.ts`);
    for (const decl of [...spacesIn(server), ...spacesIn(client)]) {
      const body = (src: string) => src.slice(src.indexOf(`...${decl},`), src.indexOf('}),', src.indexOf(`...${decl},`)));
      for (const [half, src] of [['server', server], ['client', client]] as const) if (src.includes(`...${decl},`) && /^[^]*?\b(id|path|segment):/.test(body(src))) bad.push(`${pkg} ${half}: space ${decl} overrides its URLs`);
    }
    if (JSON.stringify(spacesIn(server)) !== JSON.stringify(spacesIn(client))) bad.push(`${pkg}: spaces differ (server ${spacesIn(server)} / client ${spacesIn(client)})`);
  }
  assert.deepEqual(bad, []);
});

test("the packages' Settings pages: ids that fit their URL (/settings/ext/<package>/<page>), unique in each package", () => {
  const bad: string[] = [];
  const root = readFileSync(join(WEB, 'ext/packages.client.ts'), 'utf8');
  const entries = [...root.matchAll(/from '\.\/([^/']+)\/client\/index'/g)].map((m) => m[1]!);
  assert.ok(entries.length > 0, `the walk sees the client entries (${entries.join(',') || 'none'})`);
  for (const pkg of entries) {
    const id = /\bid:\s*'([^']+)'/.exec(readFileSync(join(WEB, `ext/${pkg}/package.ts`), 'utf8'))?.[1];
    if (id !== pkg || !SETTINGS_SEGMENT.test(id)) bad.push(`${pkg}: package id ${id} (its folder, one URL segment)`);
    const src = readFileSync(join(WEB, `ext/${pkg}/client/index.tsx`), 'utf8');
    const at = src.search(/\bsettings:\s*\[/);
    if (at < 0) continue;
    // The array's text, brackets matched; its pages' ids are written in place, as literals.
    let depth = 0;
    let end = src.indexOf('[', at);
    for (; end < src.length; end++) if (src[end] === '[') depth++;
    else if (src[end] === ']' && --depth === 0) break;
    const body = src.slice(src.indexOf('[', at) + 1, end);
    const ids = [...body.matchAll(/\bid:\s*([^,}\s]+)/g)].map((m) => m[1]!);
    const seen = new Set<string>();
    for (const raw of ids) {
      const v = /^'([^']*)'$/.exec(raw)?.[1];
      if (v === undefined) bad.push(`${pkg}: a Settings page id not written as a literal (${raw})`);
      else if (!SETTINGS_SEGMENT.test(v)) bad.push(`${pkg}: Settings page id '${v}' is not one URL segment`);
      else if (seen.has(v)) bad.push(`${pkg}: Settings page id '${v}' twice`);
      else seen.add(v);
    }
    if (!ids.length) bad.push(`${pkg}: settings without a page id`);
  }
  assert.deepEqual(bad, []);
});

/** Class names a stylesheet defines. */
function cssClasses(paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const f of paths) for (const m of readFileSync(join(WEB, f), 'utf8').replace(/\/\*[^]*?\*\//g, '').matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(m[1]!);
  return out;
}

/**
 * Class names a component sets: className="…", className={…} (its string pieces, not those compared with ===,
 * nor words built from a value: `sec-${id}`), classList.add/remove/toggle('…').
 */
function classesUsed(src: string): Set<string> {
  const out = new Set<string>();
  const words = (text: string) => {
    for (const w of text.replace(/\S*\$\{[^}]*\}\S*/g, ' ').split(/\s+/)) if (/^[A-Za-z_][\w-]*$/.test(w)) out.add(w);
  };
  for (const m of src.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\})/g)) {
    if (m[3] === undefined) {
      words(m[1] ?? m[2] ?? '');
      continue;
    }
    const expr = m[3];
    for (const t of expr.matchAll(/`([^`]*)`/g)) words(t[1]!);
    for (const q of expr.matchAll(/(===?|!==?)?\s*'([^']*)'|(===?|!==?)?\s*"([^"]*)"/g)) if (!q[1] && !q[3]) words(q[2] ?? q[4] ?? '');
  }
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(\s*['"]([^'"]+)['"]/g)) words(m[1]!);
  return out;
}

test("a package's client code uses the core's CSS classes and its own: never another package's, never undefined ones", () => {
  const core = cssClasses(['client/src/boot.css', 'client/src/styles.css']);
  const own = new Map(packageIds().map((p) => [p, cssClasses(files(`ext/${p}`, /\.css$/))]));
  // The scanner sees what it is about (a guard against patterns that silently match nothing).
  assert.deepEqual([...classesUsed(`<a className={\`x ${'$'}{on ? 'on' : ''} sec-${'$'}{id}\`} /><b className="y z" /><i className={k === 'me' ? 'w' : ''} />`)].sort(), ['on', 'w', 'x', 'y', 'z']);
  const bad: string[] = [];
  for (const pkg of packageIds()) {
    if (!existsSync(join(WEB, `ext/${pkg}/client`))) continue; // server only
    for (const f of files(`ext/${pkg}/client`, /\.(ts|tsx)$/)) {
      for (const c of classesUsed(readFileSync(join(WEB, f), 'utf8'))) {
        if (core.has(c) || own.get(pkg)!.has(c)) continue;
        const others = [...own].filter(([p, set]) => p !== pkg && set.has(c)).map(([p]) => p);
        bad.push(others.length ? `${f}: .${c} is ${others.join(', ')}'s (shared pieces go to client/src/styles.css, e.g. .space-*)` : `${f}: .${c} is defined nowhere`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("a package's strings come from the core's catalogs or its own (never another package's)", () => {
  const bad: string[] = [];
  for (const f of files('ext')) {
    const own = pkgOf(f);
    if (!own || /^ext\/[^/]+\/test\//.test(f)) continue;
    for (const i of imports(f)) {
      const other = i.target ? pkgOf(`${i.target}/`) : undefined;
      if (other && other !== own && /\/locales(\/|$)/.test(i.target!)) bad.push(`${f}: ${i.spec}`);
    }
    // The core's messages are read through useT()/t() (client/src/i18n.ts), typed: a missing key fails the build.
  }
  assert.deepEqual(bad, []);
});

// ── Capabilities (PackageInfo network / listen / files / spawns, 1.16) ───────────────────────────────────────────

type Capability = 'network' | 'listen' | 'files' | 'spawns';
/** Modules that connect, touch files or start programs (with or without node:), and the npm network clients met so far. */
const SENSITIVE: Record<string, Capability> = Object.fromEntries([
  ...['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises'].flatMap((m) => [[m, 'network'], [`node:${m}`, 'network']]),
  // npm clients: a new one is added here when a package brings it (the scan knows only what is listed).
  ...['ws', 'undici', 'node-fetch', 'axios', 'got', 'eventsource', '@beeper/desktop-api'].map((m) => [m, 'network']),
  ...['fs', 'fs/promises'].flatMap((m) => [[m, 'files'], [`node:${m}`, 'files']]),
  ...['child_process', 'worker_threads', 'cluster'].flatMap((m) => [[m, 'spawns'], [`node:${m}`, 'spawns']]),
] as [string, Capability][]);
/** Globals and calls: a global fetch (not a method `fetch(…) {` nor `x.fetch(…)`), WebSocket, EventSource; ctx.listen. */
const GLOBALS: [RegExp, Capability, string][] = [
  [/(?<![\w.$])(?:globalThis\.)?fetch\s*\((?![^)\n]*\)\s*(?::[^{\n]*)?\{)/, 'network', 'fetch()'],
  [/(?<![\w.$])globalThis\.fetch\b/, 'network', 'fetch()'],
  [/\bnew\s+(?:globalThis\.)?(WebSocket|EventSource)\s*\(/, 'network', 'new WebSocket/EventSource'],
  [/\.listen!?\s*\(/, 'listen', '.listen()'],
];
const CAP_HELP: Record<Capability, string> = {
  network: "network: ['KLATCHLY_X_URL'] (the declared variable holding the address), a host name, or '*'",
  listen: "listen: ['KLATCHLY_X_LISTEN'] (the declared variable holding host:port)",
  files: "files: ['data'] (its files in the data volume) and/or the declared variables holding a path",
  spawns: 'spawns: true',
};

/** Source text without its comments (block, and line ones not inside a URL or a string's '//'). */
const withoutComments = (src: string) => src.replace(/\/\*[^]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

type Declared = Record<Capability, boolean>;
const NONE: Declared = { network: false, listen: false, files: false, spawns: false };
/** What a package.ts declares, as written there (a list field non-empty, spawns: true). */
function declaredOf(raw: string): Declared {
  const src = withoutComments(raw);
  const list = (field: string) => /'[^']+'|"[^"]+"/.test(new RegExp(`\\b${field}:\\s*\\[([^\\]]*)\\]`).exec(src)?.[1] ?? '');
  return { network: list('network'), listen: list('listen'), files: list('files'), spawns: /\bspawns:\s*true\b/.test(src) };
}

/**
 * What a package's server-side sources use that its declaration does not cover, and what it declares but never
 * uses: one line each, saying what to write. `sources`: [path under web/, its text] (comments are left out).
 */
function capabilityProblems(pkg: string, sources: readonly [string, string][], declared: Declared): string[] {
  const used = new Map<Capability, string[]>();
  const note = (c: Capability, where: string) => {
    const list = used.get(c) ?? [];
    if (!list.includes(where)) used.set(c, [...list, where]);
  };
  for (const [f, raw] of sources) {
    const src = withoutComments(raw);
    for (const i of imports(f, src)) {
      const c = !i.typeOnly && !i.dynamic ? SENSITIVE[i.spec] : undefined;
      if (c) note(c, `${f}: ${i.spec}`);
    }
    for (const [re, c, what] of GLOBALS) if (re.test(src)) note(c, `${f}: ${what}`);
  }
  const bad: string[] = [];
  for (const [c, where] of used) if (!declared[c]) bad.push(`${pkg}: ${where.join(', ')} without a declaration: add ${CAP_HELP[c]} to ext/${pkg}/package.ts`);
  for (const c of Object.keys(CAP_HELP) as Capability[]) if (declared[c] && !used.has(c)) bad.push(`${pkg} declares ${c} but its server code uses none of it (remove it from ext/${pkg}/package.ts)`);
  return bad;
}

/** A package's server-side sources: everything but its client half, its tests and its catalogs. */
const serverSources = (pkg: string): [string, string][] =>
  files(`ext/${pkg}`, /\.(ts|tsx|js|mjs)$/)
    .filter((f) => !/^ext\/[^/]+\/(client|test|locales)\//.test(f) && !/\.test\.ts$/.test(f))
    .map((f) => [f, readFileSync(join(WEB, f), 'utf8')]);

test('the capability scan: undeclared use fails, declared or type-only use passes', () => {
  const scan = (src: string, d: Partial<Declared> = {}) => capabilityProblems('fake', [['ext/fake/server/index.ts', src]], { ...NONE, ...d });
  // An undeclared connection, file access, program, listener: each named, with the line to add.
  assert.match(scan("import { connect } from 'node:net';").join(), /^fake: ext\/fake\/server\/index\.ts: node:net without a declaration: add network: /);
  assert.match(scan("import { request } from 'http';").join(), /: http without a declaration: add network/);
  assert.match(scan("import WebSocket from 'ws';").join(), /: ws without a declaration/);
  assert.match(scan('const r = await fetch(url);').join(), /fetch\(\) without a declaration/);
  assert.match(scan('const f = globalThis.fetch;').join(), /fetch\(\) without a declaration/);
  assert.match(scan('const s = new WebSocket(u);').join(), /WebSocket\/EventSource without a declaration/);
  assert.match(scan("const { spawn } = await import('node:child_process');").join(), /node:child_process without a declaration: add spawns: true/);
  assert.match(scan("import { readFileSync } from 'node:fs';").join(), /add files: /);
  assert.match(scan('await ctx.listen!(host, port, handler);').join(), /\.listen\(\) without a declaration: add listen: /);
  // Declared: nothing to say.
  assert.deepEqual(scan("import { connect } from 'node:net';\nawait fetch(u);", { network: true }), []);
  // Types only, a method named fetch, a call of x.fetch, a comment: not a use.
  assert.deepEqual(scan("import type { IncomingMessage } from 'node:http';"), []);
  assert.deepEqual(scan('const m = { fetch(ref, headers, signal) { return go(ref); }, async fetch(a): Promise<X> { return a; } };\nm.fetch(1);'), []);
  assert.deepEqual(scan('// we never fetch(url) here\n/* new WebSocket(x) */'), []);
  // Declared but unused: flagged too.
  assert.match(scan('', { network: true }).join(), /^fake declares network but its server code uses none of it/);
  // The declaration as package.ts writes it.
  assert.deepEqual(declaredOf("network: ['KLATCHLY_X_URL', '*'],\n  files: [],\n  // listen: ['KLATCHLY_X_LISTEN'],\n  spawns: true,"), { network: true, listen: false, files: false, spawns: true });
});

test("what a package's server code reaches outside the app is declared in its package.ts (network, listen, files, spawns)", () => {
  const all = new Map(packageIds().map((p) => [p, serverSources(p)]));
  // The scan sees what it is about in the tree (a guard against patterns that silently match nothing).
  const sees = (pkg: string, c: Capability) => capabilityProblems(pkg, all.get(pkg)!, NONE).some((x) => x.includes(`add ${CAP_HELP[c]}`));
  if (all.has('example')) assert.ok(sees('example', 'files'), 'example: its node:fs');
  if (all.has('llm')) assert.ok(sees('llm', 'network'), 'llm: its fetch()');
  // (A listener: no public package has one; the synthetic case above covers its pattern.)
  const bad: string[] = [];
  for (const [pkg, sources] of all) bad.push(...capabilityProblems(pkg, sources, declaredOf(readFileSync(join(WEB, `ext/${pkg}/package.ts`), 'utf8'))));
  assert.deepEqual(bad, []);
});
