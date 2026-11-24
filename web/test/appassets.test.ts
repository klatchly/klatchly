import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeAssetList, isPrivateAsset, readAssetList, PRIVATE_ASSET_CACHE, type BundleItem } from '../server/appassets.js';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { sessions, store } from '../server/context.js';

// The client's public and private halves (server/appassets.ts, docs/auth-security.md "Code served signed out"): the
// build's lists from the bundle's graph, and the server's gating of /assets/ (anonymous: 302 to /, never 401/403/404).

const chunk = (fileName: string, o: { entry?: boolean; imports?: string[]; modules?: string[]; css?: string[]; assets?: string[] } = {}): BundleItem => ({
  type: 'chunk',
  fileName,
  isEntry: !!o.entry,
  imports: o.imports ?? [],
  moduleIds: o.modules ?? [`/src/${fileName}`],
  viteMetadata: { importedCss: new Set(o.css ?? []), importedAssets: new Set(o.assets ?? []) },
});
const asset = (fileName: string): BundleItem => ({ type: 'asset', fileName });

// A build like the real one: index.html → boot (index-*.js), Auth lazy and shared with the app, the app's entry and
// its libraries and screens, pdf.js on demand.
const bundle = (): Record<string, BundleItem> => {
  const items = [
    asset('index.html'),
    chunk('assets/index-a.js', { entry: true, imports: ['assets/react-b.js', 'assets/runtime-c.js'], modules: ['/web/client/index.html', '/web/client/src/boot.tsx', '/web/client/src/i18n.ts'], css: ['assets/index-d.css'] }),
    chunk('assets/react-b.js', { modules: ['/web/node_modules/react/index.js'] }),
    chunk('assets/runtime-c.js', { modules: ['\0rolldown/runtime'] }),
    asset('assets/index-d.css'),
    chunk('assets/Auth-e.js', { imports: ['assets/index-a.js'], modules: ['/web/client/src/Auth.tsx', '/web/node_modules/@simplewebauthn/browser/x.js'] }),
    chunk('assets/appmain-f.js', { imports: ['assets/index-a.js', 'assets/vendor-g.js', 'assets/registry-h.js'], modules: ['/web/client/src/appmain.tsx', '/web/client/src/App.tsx'], css: ['assets/appmain-i.css'] }),
    chunk('assets/vendor-g.js', { modules: ['/web/node_modules/@tanstack/query-core/x.js'] }),
    chunk('assets/registry-h.js', { imports: ['assets/vendor-g.js'], modules: ['/web/client/src/registry.ts', '/web/ext/example/client/index.tsx'] }),
    asset('assets/appmain-i.css'),
    chunk('assets/Example-j.js', { imports: ['assets/registry-h.js'], modules: ['/web/ext/example/client/Example.tsx'], css: ['assets/Example-k.css'] }),
    asset('assets/Example-k.css'),
    chunk('assets/PdfView-l.js', { imports: ['assets/pdfjs-m.js'], modules: ['/web/client/src/PdfView.tsx'], assets: ['assets/pdf.worker.min-n.mjs'] }),
    chunk('assets/pdfjs-m.js', { modules: ['/web/node_modules/pdfjs-dist/build/pdf.mjs'] }),
    asset('assets/pdf.worker.min-n.mjs'),
  ];
  return Object.fromEntries(items.map((i) => [i.fileName, i]));
};
const options = {
  version: '9.9.9',
  publicLazy: (id: string) => /[\\/]client[\\/]src[\\/]Auth\.tsx$/.test(id),
  forbidden: (id: string) => /[\\/]ext[\\/]/.test(id) || /[\\/]client[\\/]src[\\/](appmain|App|registry)\.tsx?$/.test(id) || /node_modules[\\/]@tanstack[\\/]/.test(id),
  onDemand: (f: string) => /^assets\/(pdfjs-|pdf\.worker)/.test(f),
};

test('computeAssetList: the entry, the public lazy screens and their static imports and styles are public; the rest is warmed but pdf.js', () => {
  const l = computeAssetList(bundle(), options);
  assert.equal(l.version, '9.9.9');
  assert.deepEqual(l.public, ['/assets/Auth-e.js', '/assets/index-a.js', '/assets/index-d.css', '/assets/react-b.js', '/assets/runtime-c.js']);
  assert.deepEqual(l.warm, ['/assets/Example-j.js', '/assets/Example-k.css', '/assets/PdfView-l.js', '/assets/appmain-f.js', '/assets/appmain-i.css', '/assets/registry-h.js', '/assets/vendor-g.js']);
  // Nothing outside /assets/ (index.html is public by the server's rule), nothing both public and private.
  assert.ok(!l.public.includes('/index.html') && !l.warm.includes('/index.html'));
  assert.ok(l.public.every((p) => !l.warm.includes(p)));
});

test('computeAssetList: the app entry\'s chunk, static imports and styles head the warm list; a name the server refuses fails the build', () => {
  const l = computeAssetList(bundle(), { ...options, appEntry: (id: string) => /[\\/]client[\\/]src[\\/]appmain\.tsx$/.test(id) });
  assert.deepEqual(l.warm, ['/assets/appmain-f.js', '/assets/appmain-i.css', '/assets/registry-h.js', '/assets/vendor-g.js', '/assets/Example-j.js', '/assets/Example-k.css', '/assets/PdfView-l.js']);
  // Rolldown keeps '(' ')' '@' '~' '!' in chunk names: the server's list reader would refuse the whole list.
  for (const name of ['assets/Panel(old)-x.js', 'assets/@scope-y.js', 'assets/x~y!-z.js']) {
    const b = bundle();
    b[name] = chunk(name, { modules: ['/web/client/src/Panel.tsx'] });
    assert.throws(() => computeAssetList(b, options), /file names the server would refuse/, name);
  }
});

test('computeAssetList: the build fails when the boot reaches the app, the registry, a package or the app libraries', () => {
  const b = bundle();
  // The boot importing the registry statically: the registry's chunk would be public.
  (b['assets/index-a.js'] as unknown as { imports: string[] }).imports.push('assets/registry-h.js');
  assert.throws(() => computeAssetList(b, options), /public chunk assets\/registry-h\.js holds private modules: .*registry\.ts/);
  // A package module merged into a public chunk.
  const c = bundle();
  (c['assets/Auth-e.js'] as unknown as { moduleIds: string[] }).moduleIds.push('/web/ext/example/client/x.ts');
  assert.throws(() => computeAssetList(c, options), /Auth-e\.js holds private modules/);
  // No entry at all.
  const d = bundle();
  delete d['assets/index-a.js'];
  (d['assets/Auth-e.js'] as unknown as { imports: string[] }).imports = [];
  assert.throws(() => computeAssetList(d, options), /no entry chunk/);
});

test('readAssetList: the build file, well-formed only; missing: null (every file public, as before); there but broken: throws (no start)', () => {
  const dir = join(config().dataDir, 'lists');
  mkdirSync(dir, { recursive: true });
  assert.equal(readAssetList(join(dir, 'none')), null);
  const write = (v: unknown) => writeFileSync(join(dir, 'public-assets.json'), typeof v === 'string' ? v : JSON.stringify(v));
  write({ version: '1.0.0', public: ['/assets/a.js'], warm: ['/assets/b.js'] });
  assert.deepEqual(readAssetList(dir), { version: '1.0.0', public: ['/assets/a.js'], warm: ['/assets/b.js'] });
  for (const bad of ['{', { version: 1, public: [], warm: [] }, { version: 'x', public: ['/etc/passwd'], warm: [] }, { version: 'x', public: [], warm: ['/assets/../x'] }, { version: 'x', public: [] }, { version: 'x', public: ['/assets/Panel(old)-x.js'], warm: [] }]) {
    write(bad);
    assert.throws(() => readAssetList(dir), /public-assets\.json: (unreadable|malformed)/, JSON.stringify(bad));
  }
});

test('isPrivateAsset: under /assets/ and not listed; nothing private without a list', () => {
  const list = { version: '1', public: ['/assets/index-a.js'], warm: [] };
  assert.equal(isPrivateAsset('/assets/index-a.js', list), false);
  assert.equal(isPrivateAsset('/assets/appmain-f.js', list), true);
  assert.equal(isPrivateAsset('/sw.js', list), false);
  assert.equal(isPrivateAsset('/push-sw.js', list), false);
  assert.equal(isPrivateAsset('/assets/appmain-f.js', null), false);
});

test('server: a private chunk needs a session (anonymous: 302 to /), served private and immutable; public files unchanged', async () => {
  const pub = config().publicDir;
  mkdirSync(join(pub, 'assets'), { recursive: true });
  writeFileSync(join(pub, 'assets', 'index-a.js'), 'console.log("boot")');
  writeFileSync(join(pub, 'assets', 'index-d.css'), 'body{}');
  writeFileSync(join(pub, 'assets', 'appmain-f.js'), 'console.log("app")');
  writeFileSync(join(pub, 'assets', 'appmain-i.css'), '.shell{}');
  writeFileSync(join(pub, 'push-sw.js'), '/* push */');
  writeFileSync(join(pub, 'public-assets.json'), JSON.stringify({ version: '9.9.9', public: ['/assets/index-a.js', '/assets/index-d.css'], warm: ['/assets/appmain-f.js', '/assets/appmain-i.css'] }));
  const app = createApp();
  const sid = store.mutate((s) => sessions.create(s));
  const anon = (path: string, method = 'GET') => app.request(path, { method });
  const signed = (path: string, method = 'GET') => app.request(path, { method, headers: { cookie: `sid=${sid}` } });

  // Anonymous: the public half as before…
  for (const path of ['/assets/index-a.js', '/assets/index-d.css']) {
    const r = await anon(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', path);
  }
  const sw = await anon('/push-sw.js');
  assert.equal(sw.status, 200);
  assert.equal(await sw.text(), '/* push */');
  // …the private half: back to /, never 401/403/404, never the file.
  for (const path of ['/assets/appmain-f.js', '/assets/appmain-i.css']) {
    for (const method of ['GET', 'HEAD']) {
      const r = await anon(path, method);
      assert.equal(r.status, 302, `${method} ${path}`);
      assert.equal(r.headers.get('location'), '/', `${method} ${path}`);
      // A cache in front must not keep the redirect for a signed-in device (by-extension CDN caching).
      assert.equal(r.headers.get('cache-control'), 'no-store', `${method} ${path}`);
      assert.doesNotMatch(await r.text(), /app|shell/, `${method} ${path}`);
    }
  }
  // An expired or forged cookie is anonymous.
  const forged = await app.request('/assets/appmain-f.js', { headers: { cookie: `sid=${'A'.repeat(43)}` } });
  assert.equal(forged.status, 302);

  // Signed in: the private half too, for this browser only.
  const priv = await signed('/assets/appmain-f.js');
  assert.equal(priv.status, 200);
  assert.equal(priv.headers.get('cache-control'), PRIVATE_ASSET_CACHE);
  assert.equal(PRIVATE_ASSET_CACHE, 'private, max-age=31536000, immutable');
  assert.match(priv.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.equal(await priv.text(), 'console.log("app")');
  const css = await signed('/assets/appmain-i.css', 'HEAD');
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('cache-control'), PRIVATE_ASSET_CACHE);
  assert.equal((await signed('/assets/index-a.js')).headers.get('cache-control'), 'public, max-age=31536000, immutable');

  // The list itself is never served (anonymous: 302 like any unknown path; signed in: 404).
  assert.equal((await anon('/public-assets.json')).status, 302);
  assert.equal((await signed('/public-assets.json')).status, 404);

  // GET /api/assets: the files to fetch ahead, for a session only.
  const none = await anon('/api/assets');
  assert.equal(none.status, 302);
  const list = await signed('/api/assets');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await list.json(), { version: '9.9.9', files: ['/assets/appmain-f.js', '/assets/appmain-i.css'] });
});
