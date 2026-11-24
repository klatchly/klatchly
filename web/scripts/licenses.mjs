// Third-party license material of the klatchly image, generated at build time, offline (docs/license-obligations.fr.md
// § 4–5): reads package-lock.json, node_modules and the build output only, never the network.
//
//   node scripts/licenses.mjs             after `vite build` (npm run build does it): writes dist/licenses/
//                                         THIRD_PARTY_LICENSES.txt and sbom.cdx.json (CycloneDX 1.6), and fails on a
//                                         package whose license is unknown or not allowed (POLICY below)
//   node scripts/licenses.mjs --check     the same inventory and policy, writes nothing (CI)
//   node scripts/licenses.mjs --installed after `npm prune --omit=dev` (web/Dockerfile): every package left in
//                                         node_modules must be one the SBOM lists as shipped with the server, and the
//                                         other way round
//
// What is covered, each with name, version, license, copyright lines and the full license text (identical texts once,
// by reference):
//   1. the server's production dependencies: the lockfile's non-dev packages present in node_modules (= what
//      `npm prune --omit=dev` keeps, checked by --installed in the image build);
//   2. the browser bundle: the packages of the module ids the build really bundled (dist/licenses/bundle-modules.json,
//      written by the bundleModules plugin of vite.config.ts), the bundler's own runtime helpers, and the Workbox
//      modules of the service worker (found by the "workbox:<module>:<version>" marker each one leaves in its code);
//   3. assets shipped as-is: the pdf.js data under dist/public/pdfjs/ and the license files next to them;
//   4. native code: libvips and the libraries bundled with it (prebuilt by sharp-libvips), LGPL-3.0-or-later: full
//      LGPL-3.0 and GPL-3.0 texts (scripts/licenses/, absent from the npm package) and where to get the source;
//   5. the runtime image (distroless Node.js, Debian): pointers, the base image read from ./Dockerfile when present.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'dist', 'licenses');
const PUBLIC = join(ROOT, 'dist', 'public');
const mode = process.argv[2] ?? 'write';
if (!['write', '--check', '--installed'].includes(mode)) {
  console.error('usage: node scripts/licenses.mjs [--check | --installed]');
  process.exit(2);
}

// POLICY: licenses allowed in shipped code. Permissive licenses, and MPL-2.0 (file-level copyleft: web-push, shipped
// unmodified with its source). LGPL-3.0-or-later only for sharp's prebuilt libvips (@img/sharp-libvips-*, and the
// "Apache-2.0 AND LGPL-3.0-or-later" wasm/Windows builds of @img/sharp-*): a shared library loaded dynamically, which
// can be replaced; its obligations (license text, source pointer) are met by § 4 of THIRD_PARTY_LICENSES.txt. Anything
// else (GPL, AGPL, SSPL, a missing or unparsable license) fails the build.
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'MPL-2.0', 'BlueOak-1.0.0']);
const ALLOWED_FOR = [{ license: 'LGPL-3.0-or-later', pkg: /^@img\/sharp-/ }];

const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const self = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const problems = [];

// ---------- --installed: the pruned node_modules against the SBOM written before the prune ----------

if (mode === '--installed') {
  const sbom = JSON.parse(readFileSync(join(OUT, 'sbom.cdx.json'), 'utf8'));
  const listed = new Set(sbom.components.filter((c) => prop(c, 'klatchly:location') === 'server').map((c) => prop(c, 'klatchly:path')));
  const installed = new Set(installedPackages(join(ROOT, 'node_modules')).map((d) => relative(ROOT, d).split(sep).join('/')));
  for (const d of installed) if (!listed.has(d)) problems.push(`installed but not in the SBOM / THIRD_PARTY_LICENSES: ${d}`);
  for (const d of listed) if (!installed.has(d)) problems.push(`in the SBOM but not installed: ${d}`);
  finish(`licenses: node_modules matches the SBOM (${installed.size} packages)`);
}

// ---------- packages ----------

const nameOf = (path) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
const cache = new Map();
// One package, by its lockfile path (node_modules/a, node_modules/a/node_modules/@s/b).
function pkg(path) {
  if (cache.has(path)) return cache.get(path);
  const dir = join(ROOT, path);
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entry = lock.packages[path] ?? {};
  const license = licenseOf(meta) ?? entry.license;
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  const texts = files.filter((f) => /^(un)?licen[cs]e|^copying/i.test(f)).sort().map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));
  const notices = files.filter((f) => /^notice/i.test(f)).sort().map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));
  const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
  const p = { path, name: meta.name ?? nameOf(path), version: meta.version, license, texts, notices, integrity: entry.integrity, repo: repo?.replace(/^git\+/, ''), homepage: meta.homepage };
  if (!license) problems.push(`${p.name}@${p.version}: no license in package.json nor in the lockfile`);
  else if (!texts.length && FALLBACK[license]) {
    // No license file: the standard text of the license it declares, the copyright line from its author.
    const author = typeof meta.author === 'string' ? meta.author.replace(/\s*[<(].*$/, '') : meta.author?.name;
    p.texts = [{ file: `(standard ${license} text; the package ships no license file)`, text: (author ? `Copyright (c) ${author} (package.json author)\n\n` : '') + own(FALLBACK[license]) }];
  } else if (!texts.length && !SPECIAL_TEXT[p.name]) problems.push(`${p.name}@${p.version} (${license}): no license file in ${path}`);
  cache.set(path, p);
  return p;
}
function licenseOf(meta) {
  if (typeof meta.license === 'string') return meta.license;
  if (meta.license?.type) return meta.license.type;
  if (Array.isArray(meta.licenses) && meta.licenses.length) return meta.licenses.map((l) => l.type ?? l).join(' OR ');
}
// versions.json names → the names of the README's licensing table.
const LIB_ALIAS = { uhdr: 'libultrahdr', vips: 'libvips' };
const own = (f) => readFileSync(join(ROOT, 'scripts', 'licenses', f), 'utf8');
const FALLBACK = { MIT: 'MIT.txt', Unlicense: 'Unlicense.txt' };
// Packages that ship no license file, and where their text is in this file instead.
const SPECIAL_TEXT = { '@img/sharp-libvips-linux-x64': '§ 4', '@img/sharp-libvips-linuxmusl-x64': '§ 4', '@img/sharp-libvips-linux-arm64': '§ 4', '@img/sharp-libvips-linuxmusl-arm64': '§ 4' };

// Node's lookup from a directory: the nearest node_modules/<name> up the tree, as a lockfile path.
function resolveFrom(fromPath, name) {
  let base = fromPath;
  for (;;) {
    const cand = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[cand]) return cand;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i < 0 ? '' : base.slice(0, i);
  }
}

// 1. Server: the lockfile's production packages installed here.
const server = Object.entries(lock.packages)
  .filter(([path, e]) => path.startsWith('node_modules/') && !e.dev && !e.link && existsSync(join(ROOT, path, 'package.json')))
  .map(([path]) => pkg(path));

// 2. Browser bundle.
const bundle = new Map();
const modulesFile = join(OUT, 'bundle-modules.json');
if (!existsSync(modulesFile)) {
  console.error(`licenses: ${relative(ROOT, modulesFile)} missing: run vite build first (npm run build)`);
  process.exit(1);
}
for (let id of JSON.parse(readFileSync(modulesFile, 'utf8'))) {
  const generated = id.startsWith('\0') || id.startsWith('virtual:'); // a plugin's module, not a file
  id = id.replace(/^\0/, '').replace(/\?.*$/, '').split(sep).join('/');
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(id); // greedy: the innermost node_modules
  let path;
  if (m) {
    path = relative(ROOT, m[1].startsWith('/') ? m[1] : join(ROOT, m[1])).split(sep).join('/');
    // Outside web/ (node_modules linked from another checkout): keep the part from node_modules/ on.
    if (path.startsWith('..')) path = path.slice(path.indexOf('node_modules/'));
  } else if (/^(vite|rolldown)\//.test(id)) {
    path = `node_modules/${id.split('/')[0]}`; // the bundler's runtime helpers (preload, module runtime)
  } else if (generated) {
    problems.push(`bundle: module id with no package: ${JSON.stringify(id)}`);
    continue;
  } else continue; // klatchly's own code (client/, ext/, server/ modules shared with the client)
  if (!lock.packages[path]) problems.push(`bundle: ${path} (from ${id}) is not in package-lock.json`);
  else bundle.set(path, pkg(path));
}
const swMarkers = new Map();
for (const f of walk(PUBLIC)) {
  if (!f.endsWith('.js')) continue;
  for (const m of readFileSync(f, 'utf8').matchAll(/workbox:([a-z-]+):(\d+\.\d+\.\d+)/g)) swMarkers.set(`workbox-${m[1]}`, m[2]);
}
// The marker carries the version workbox-build was released with, which can lag its packages (7.4.0 in 7.4.1): the
// installed package of that name, the one of that exact version if there are several.
for (const [name, version] of swMarkers) {
  const paths = Object.keys(lock.packages).filter((k) => nameOf(k) === name && existsSync(join(ROOT, k, 'package.json')));
  const path = paths.find((k) => lock.packages[k].version === version) ?? (paths.length === 1 ? paths[0] : null);
  if (!path) problems.push(`service worker: ${name}@${version}: ${paths.length ? 'several versions installed' : 'not installed'}`);
  else bundle.set(path, pkg(path));
}

// 3. Assets shipped as-is: pdf.js data copied to dist/public/pdfjs/ (pdfAssets in vite.config.ts).
const pdfjsDir = join(PUBLIC, 'pdfjs');
const assets = existsSync(pdfjsDir)
  ? readdirSync(pdfjsDir).flatMap((d) => {
      const dir = join(pdfjsDir, d);
      if (!statSync(dir).isDirectory()) return [];
      const files = readdirSync(dir);
      return [{ dir: `pdfjs/${d}/`, count: files.filter((f) => !/^licen[cs]e/i.test(f)).length, texts: files.filter((f) => /^licen[cs]e/i.test(f)).sort().map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') })) }];
    })
  : [];
for (const a of assets) if (!a.texts.length) problems.push(`assets: dist/public/${a.dir} has no license file`);
const pdfjsPath = resolveFrom('', 'pdfjs-dist');

// 4. Native: libvips, through sharp.
const vipsPaths = server.filter((p) => /^@img\/sharp-libvips-/.test(p.name));
const vips = vipsPaths.map((p) => {
  const dir = join(ROOT, p.path);
  const versions = JSON.parse(readFileSync(join(dir, 'versions.json'), 'utf8'));
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  const table = new Map([...readme.matchAll(/^\|\s*([a-z0-9-]+)\s*\|\s*(.+?)\s*\|$/gim)].filter((m) => !/^-+$/.test(m[1]) && m[1] !== 'Library').map((m) => [m[1], m[2].replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>')]));
  return { pkg: p, versions, table, licensing: readme.slice(readme.indexOf('## Licensing')) };
});

// 5. Runtime base image.
let runtimeImage = '';
if (existsSync(join(ROOT, 'Dockerfile'))) {
  const froms = [...readFileSync(join(ROOT, 'Dockerfile'), 'utf8').matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  runtimeImage = froms.at(-1) ?? '';
}

// ---------- policy ----------

function allowed(expr, name) {
  const t = expr.replace(/[()]/g, ' ').trim();
  if (/\sOR\s/i.test(t)) return t.split(/\s+OR\s+/i).some((x) => allowed(x, name));
  if (/\sAND\s/i.test(t)) return t.split(/\s+AND\s+/i).every((x) => allowed(x, name));
  return ALLOWED.has(t) || ALLOWED_FOR.some((a) => a.license === t && a.pkg.test(name));
}
const shipped = [...new Map([...server, ...bundle.values()].map((p) => [p.path, p])).values()];
for (const p of shipped) if (p.license && !allowed(p.license, p.name)) problems.push(`${p.name}@${p.version}: license ${p.license} not allowed in shipped code (POLICY in scripts/licenses.mjs)`);

// ---------- THIRD_PARTY_LICENSES.txt ----------

// A copyright line: "Copyright …", "(c) 2020 …", "© …", but not the license's own wording ("copyright notice",
// "(c) You must retain…") nor its templates ("Copyright [yyyy] [name of copyright owner]", "<year>  <name of author>").
const COPYRIGHT = /^\s*(?:copyright\b(?!\s+(?:notice|owner|statement|holders?|law|license|and\b|or\b|\[|\{|protection))|\(c\)\s+(?!you\b)|©)(?!.*(?:<year>|\[yyyy\]|\{yyyy\}))/i;
const bodies = new Map(); // normalized text → { ref, text, ids:Set }
function textRef(text, id) {
  const kept = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => !COPYRIGHT.test(l));
  const key = kept.join(' ').replace(/\s+/g, ' ').trim();
  let b = bodies.get(key);
  if (!b) bodies.set(key, (b = { ref: `L${bodies.size + 1}`, text: kept.join('\n').replace(/^\n+|\s+$/g, ''), ids: new Set() }));
  b.ids.add(id);
  return b.ref;
}
const copyrights = (texts) => [...new Set(texts.flatMap((t) => t.text.split(/\r?\n/).filter((l) => COPYRIGHT.test(l)).map((l) => l.trim())))];

const W = [];
const line = (s = '') => W.push(s);
const rule = (c = '=') => line(c.repeat(78));
function entry(p, where) {
  line(`--- ${p.name} ${p.version} ---`);
  line(`License: ${p.license}`);
  if (p.repo || p.homepage) line(`Source: ${p.repo ?? p.homepage}`);
  if (where) line(`In the image: ${where}`);
  for (const c of copyrights(p.texts)) line(c);
  if (p.texts.length) line(`License text: ${p.texts.map((t) => `${t.file} → [${textRef(t.text, p.license)}]`).join(', ')}`);
  else line(`License text: see ${SPECIAL_TEXT[p.name]}`);
  // A file-level notice (web-push) rather than the license itself: the full text too.
  if (p.license === 'MPL-2.0' && !p.texts.some((t) => /Mozilla Public License Version 2\.0/.test(t.text))) line('Full MPL-2.0 text: [MPL-2.0] in § 6');
  for (const n of p.notices) {
    line(`${n.file}:`);
    for (const l of n.text.replace(/\s+$/, '').split(/\r?\n/)) line(`    ${l}`);
  }
  line();
}
const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true });

line(`THIRD-PARTY SOFTWARE NOTICES AND LICENSES — ${self.name} ${self.version}`);
line();
line('Generated at build time by web/scripts/licenses.mjs from package-lock.json, node_modules and the build output.');
line("klatchly's own notice: NOTICE (next to this file). Machine-readable inventory: sbom.cdx.json (CycloneDX).");
line('License texts identical across packages are printed once, in § 6, and referenced as [L<n>]; the copyright');
line('lines of each package are listed with the package.');
line();
line('  1. Server: Node.js packages in /app/node_modules');
line('  2. Web app: packages bundled into the browser code (/app/dist/public)');
line('  3. Data files shipped as-is (pdf.js)');
line('  4. Native libraries: libvips and its dependencies (through sharp), LGPL-3.0-or-later');
line('  5. Runtime image: Node.js and Debian packages of the base image');
line('  6. License texts');
line();
rule();
line(`1. SERVER — ${server.length} packages in /app/node_modules (the production dependencies of package.json)`);
rule();
line();
for (const p of [...server].sort(byName)) entry(p, `/app/${p.path}`);
rule();
line(`2. WEB APP — ${bundle.size} packages bundled into /app/dist/public (JavaScript chunks, service worker)`);
rule();
line();
line('These packages are compiled into the browser bundle; their own folders are not in the image. The list is');
line("what the build bundled (module ids of every chunk), plus the bundler's runtime helpers (vite, rolldown) and the");
line('Workbox modules of the service worker (sw.js, workbox-*.js).');
line();
for (const p of [...bundle.values()].sort(byName)) entry(p);
rule();
line('3. DATA FILES SHIPPED AS-IS — /app/dist/public/pdfjs/');
rule();
line();
if (pdfjsPath) line(`Copied from pdfjs-dist ${lock.packages[pdfjsPath].version} (Apache-2.0, § 2), each folder with its own license files:`);
line('Adobe CMaps, the standard fonts (Foxit; Liberation, GPL-2.0 with the font exception, Red Hat: the font files');
line('are their own source form, upstream https://github.com/liberationfonts), ICC profiles, and the non-WebAssembly');
line('OpenJPEG and JBIG2 decoders of pdf.js (https://github.com/mozilla/pdf.js).');
line();
for (const a of assets) {
  line(`--- ${a.dir} (${a.count} files) ---`);
  for (const t of a.texts) {
    for (const c of copyrights([t])) line(c);
    line(`${t.file} → [${textRef(t.text, `${a.dir}${t.file}`)}]`);
  }
  line();
}
rule();
line('4. NATIVE LIBRARIES — libvips and its dependencies, through sharp');
rule();
line();
for (const v of vips) {
  line(`--- libvips ${v.versions.vips} (npm package ${v.pkg.name} ${v.pkg.version}) ---`);
  line('License: LGPL-3.0-or-later (libvips and several bundled libraries; the others as listed below)');
  line(`In the image: /app/${v.pkg.path}/lib/ (shared libraries loaded at run time by sharp's native addon)`);
  line();
  line('Prebuilt by the sharp-libvips project; the library versions inside this build (versions.json):');
  for (const [lib, ver] of Object.entries(v.versions)) {
    const lic = v.table.get(lib) ?? v.table.get(LIB_ALIAS[lib] ?? `lib${lib}`) ?? '(not in the README table)';
    line(`    ${lib.padEnd(14)} ${String(ver).padEnd(10)} ${lic}`);
  }
  line('(licenses from the README.md of the package, which also says:)');
  for (const l of v.licensing.split('\n').filter((l) => l.trim() && !l.startsWith('|') && !l.startsWith('#'))) line(`    ${l.trim()}`);
  line();
  line('SOURCE CODE (LGPL-3.0 § 4, GPL-3.0 § 6): the Corresponding Source of this build is published by its makers:');
  line(`  - build scripts and patches: https://github.com/lovell/sharp-libvips (release v${v.pkg.version}, the npm`);
  line(`    package ${v.pkg.name}@${v.pkg.version}); they download the upstream tarballs at the versions above;`);
  line(`  - libvips itself: https://github.com/libvips/libvips/releases/tag/v${v.versions.vips}`);
  line('Written offer: for at least three years from the date the image containing this file was distributed, the');
  line('distributor of that image will give anyone who asks a copy of that Corresponding Source, on a medium customarily');
  line('used for software interchange, for no more than the cost of physically performing the distribution. Ask through');
  line("the project's source repository (the org.opencontainers.image.source label of the image, or NOTICE).");
  line('libvips is loaded as a separate shared library: you may replace it with a compatible build of your own.');
  line();
}
line('The full GNU LGPL-3.0 text is [LGPL-3.0] in § 6; it supplements the GNU GPL-3.0, [GPL-3.0] in § 6. The MPL-1.1');
line('text (cairo) is [MPL-1.1] in § 6. The other bundled libraries are under the permissive licenses listed above,');
line('whose texts are in each project at the version listed.');
line();
rule();
line('5. RUNTIME IMAGE — Node.js and Debian packages of the base image');
rule();
line();
if (runtimeImage) line(`Base image: ${runtimeImage}`);
line('Node.js (MIT, with the licenses of the components it bundles: V8, OpenSSL, ICU, libuv, …): the full text is');
line('/nodejs/LICENSE in this image; source at https://github.com/nodejs/node for the version of /nodejs/bin/node.');
line('Debian packages of the base (glibc, libgcc, libstdc++, OpenSSL, ca-certificates, tzdata, …): their copyright');
line('files are /usr/share/doc/<package>/copyright in this image, their sources at https://snapshot.debian.org/ for');
line('the exact versions (listed in /var/lib/dpkg/status.d/ and in the build attestation: docker buildx build');
line('--sbom=true, docs/self-hosting.md).');
line();
rule();
line('6. LICENSE TEXTS');
rule();
line();
for (const b of bodies.values()) {
  line(`[${b.ref}] ${[...b.ids].join(', ')}`);
  line('-'.repeat(78));
  line(b.text);
  line();
}
const fullTexts = [['LGPL-3.0', 'LGPL-3.0.txt'], ['GPL-3.0', 'GPL-3.0.txt'], ['MPL-1.1', 'MPL-1.1.txt']];
if (W.some((l) => l.startsWith('Full MPL-2.0 text'))) fullTexts.push(['MPL-2.0', 'MPL-2.0.txt']);
for (const [ref, f] of fullTexts) {
  line(`[${ref}]`);
  line('-'.repeat(78));
  line(own(f).replace(/\s+$/, ''));
  line();
}

// ---------- SBOM (CycloneDX 1.6) ----------

function purl(name, version) {
  const [ns, n] = name.startsWith('@') ? name.split('/') : [null, name];
  return `pkg:npm/${ns ? `${encodeURIComponent(ns)}/` : ''}${n}@${version}`;
}
function hashes(integrity) {
  const m = /^sha(512|384|256|1)-(.+)$/.exec(integrity ?? '');
  return m ? [{ alg: m[1] === '1' ? 'SHA-1' : `SHA-${m[1]}`, content: Buffer.from(m[2], 'base64').toString('hex') }] : undefined;
}
const licenses = (expr) => (/\s(AND|OR|WITH)\s/.test(expr) ? [{ expression: expr }] : [{ license: { id: expr } }]);
function component(p, location) {
  return {
    type: 'library',
    'bom-ref': `${location}:${p.path}`,
    name: p.name,
    version: p.version,
    purl: purl(p.name, p.version),
    licenses: licenses(p.license),
    hashes: hashes(p.integrity),
    externalReferences: p.repo ? [{ type: 'vcs', url: p.repo }] : undefined,
    properties: [{ name: 'klatchly:location', value: location }, { name: 'klatchly:path', value: p.path }],
  };
}
const components = [
  ...[...server].sort(byName).map((p) => component(p, 'server')),
  ...[...bundle.values()].sort(byName).map((p) => component(p, 'browser-bundle')),
  ...vips.map((v) => ({
    type: 'library',
    'bom-ref': `native:libvips@${v.versions.vips}`,
    name: 'libvips',
    version: v.versions.vips,
    purl: `pkg:github/libvips/libvips@v${v.versions.vips}`,
    licenses: [{ license: { id: 'LGPL-3.0-or-later' } }],
    externalReferences: [{ type: 'vcs', url: 'https://github.com/libvips/libvips' }, { type: 'build-meta', url: 'https://github.com/lovell/sharp-libvips' }],
    properties: [{ name: 'klatchly:location', value: 'native' }, { name: 'klatchly:path', value: `${v.pkg.path}/lib` }],
    components: Object.entries(v.versions).filter(([k]) => k !== 'vips').map(([k, ver]) => ({ type: 'library', 'bom-ref': `native:${k}@${ver}`, name: k, version: String(ver) })),
  })),
];
if (runtimeImage) components.push({ type: 'container', 'bom-ref': 'runtime-base', name: runtimeImage.split('@')[0].replace(/:[^/:]+$/, ''), version: runtimeImage.split('@')[1] ?? runtimeImage.split(':').at(-1), description: 'Base image (Node.js, Debian packages): inventory in the buildx SBOM attestation (docker buildx build --sbom=true)' });
const sbomBody = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: {
    tools: { components: [{ type: 'application', name: 'klatchly scripts/licenses.mjs' }] },
    component: { type: 'application', 'bom-ref': 'klatchly', name: self.name, version: self.version },
    properties: [{ name: 'klatchly:note', value: 'npm packages (server and browser bundle) and native libraries of the klatchly layer; the base image is listed as one component' }],
  },
  components,
  dependencies: [{ ref: 'klatchly', dependsOn: components.map((c) => c['bom-ref']) }],
};
// A stable serial number: the same inputs give the same file.
const digest = createHash('sha256').update(JSON.stringify(sbomBody)).digest('hex');
const sbom = { $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json', bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`, ...sbomBody };

const summary = `licenses: server ${server.length}, browser bundle ${bundle.size}, pdf.js data ${assets.length} folders, libvips ${vips.map((v) => v.versions.vips).join(', ') || 'none'}; ${bodies.size} distinct license texts`;
if (mode === '--check') {
  const counts = {};
  for (const p of shipped) counts[p.license] = (counts[p.license] ?? 0) + 1;
  console.log(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${n} ${k}`).join('\n'));
  finish(summary);
}
if (problems.length) finish();
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'THIRD_PARTY_LICENSES.txt'), W.join('\n') + '\n');
writeFileSync(join(OUT, 'sbom.cdx.json'), JSON.stringify(sbom, null, 1) + '\n');
finish(`${summary} → ${relative(ROOT, OUT)}/THIRD_PARTY_LICENSES.txt, sbom.cdx.json`);

// ---------- helpers ----------

function finish(ok) {
  if (problems.length) {
    console.error(`licenses: ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(ok);
  process.exit(0);
}
function prop(c, name) {
  return c.properties?.find((x) => x.name === name)?.value;
}
function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) yield* walk(p);
    else yield p;
  }
}
// Every package folder under a node_modules (scoped and nested), the way npm lays them out.
function installedPackages(nm) {
  const out = [];
  if (!existsSync(nm)) return out;
  for (const d of readdirSync(nm, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dirs = d.name.startsWith('@') ? readdirSync(join(nm, d.name), { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => join(nm, d.name, x.name)) : [join(nm, d.name)];
    for (const p of dirs) {
      if (existsSync(join(p, 'package.json'))) out.push(p);
      out.push(...installedPackages(join(p, 'node_modules')));
    }
  }
  return out;
}
