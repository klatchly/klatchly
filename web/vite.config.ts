import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };
import { PRIVATE_COMPLETE_KEY, privateCacheName, THUMB_CACHE } from './client/src/cachenames';
import { ASSET_LIST_FILE, computeAssetList, type AssetList, type BundleItem } from './server/appassets';

// pdf.js data read at run time from /pdfjs/ (client/src/PdfView.tsx): CMaps, standard fonts, ICC profiles and
// the non-WebAssembly image decoders (the page CSP allows no WebAssembly). Fetched only by PDFs that need them.
function pdfAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    apply: 'build',
    writeBundle(opts) {
      const out = `${opts.dir}/pdfjs`;
      const src = 'node_modules/pdfjs-dist';
      mkdirSync(`${out}/wasm`, { recursive: true });
      for (const d of ['cmaps', 'standard_fonts', 'iccs']) cpSync(`${src}/${d}`, `${out}/${d}`, { recursive: true });
      for (const f of ['openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_PDFJS_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_JBIG2']) {
        cpSync(`${src}/wasm/${f}`, `${out}/wasm/${f}`);
      }
    },
  };
}

// The modules that end up in the browser bundle, for scripts/licenses.mjs (THIRD_PARTY_LICENSES.txt, SBOM): every
// module id of every chunk and the source of every emitted asset (pdf.js worker…), written next to dist/public.
// The real bundled set, not the dependency list: tree-shaken packages and lazy chunks are what the build says.
function bundleModules(): Plugin {
  const ids = new Set<string>();
  return {
    name: 'klatchly-bundle-modules',
    apply: 'build',
    generateBundle(_opts, bundle) {
      for (const out of Object.values(bundle)) {
        if (out.type === 'chunk') for (const id of out.moduleIds) ids.add(id);
        else for (const f of out.originalFileNames ?? []) ids.add(f);
      }
    },
    writeBundle(opts) {
      mkdirSync(`${opts.dir}/../licenses`, { recursive: true });
      writeFileSync(`${opts.dir}/../licenses/bundle-modules.json`, JSON.stringify([...ids].sort(), null, 1) + '\n');
    },
  };
}

// client/src/sdk.ts, the packages' client entry, only re-exports: declared free of side effects, so that a package's
// launch entry importing definePackage from it does not pull every module it re-exports (StepUp, Composer…) into
// the launch chunk. Without this the bundle changes as soon as packages import through it.
function sdkBarrel(): Plugin {
  return {
    name: 'klatchly-sdk-barrel',
    transform(code, id) {
      if (/[\\/]client[\\/]src[\\/]sdk\.ts$/.test(id)) return { code, map: null, moduleSideEffects: false };
    },
  };
}

// The client's two halves (server/appassets.ts, docs/auth-security.md): the public boot entry (client/src/boot.tsx)
// and its lazy sign-in screens, and the private rest (client/src/appmain.tsx and all it imports). From the bundle's own
// graph: the public files under /assets/ go to public-assets.json (read by the server at start, which serves the rest
// to a session only), and the service worker precaches only them (workbox.manifestTransforms below). Fails the build
// when the boot's graph reaches the app, the registry, a package or the app's libraries. Also writes /sw-app.js, the
// worker's private cache (client/sw-app.js) with this version's names.
const PRIVATE_CACHE = privateCacheName(pkg.version);
// pdf.js and its worker: private like any chunk of the app, but cached when a PDF is opened (the 'pdfjs' cache), never
// fetched ahead.
const ON_DEMAND = /^assets\/(pdfjs-|pdf\.worker)/;
let assetList: AssetList | undefined;
function privateSplit(): Plugin {
  return {
    name: 'klatchly-private-split',
    apply: 'build',
    // After Vite's own clean-up of the bundle (pure CSS chunks removed, their stylesheets moved to the importers).
    generateBundle: {
      order: 'post',
      handler(_opts, bundle) {
        try {
          assetList = computeAssetList(bundle as unknown as Record<string, BundleItem>, {
            version: pkg.version,
            publicLazy: (id) => /[\\/]client[\\/]src[\\/]Auth\.tsx$/.test(id),
            forbidden: (id) =>
              /[\\/]ext[\\/]/.test(id) ||
              /[\\/]client[\\/]src[\\/](appmain|App|Shell|registry|endpoints|catalogs|styles)\.(tsx?|css)$/.test(id) ||
              /[\\/]server[\\/]locales[\\/]/.test(id) ||
              /node_modules[\\/](@tanstack|react-virtuoso|wouter|simple-icons|pdfjs-dist)[\\/]/.test(id),
            onDemand: (f) => ON_DEMAND.test(f),
            appEntry: (id) => /[\\/]client[\\/]src[\\/]appmain\.tsx$/.test(id),
          });
        } catch (e) {
          // Printed here: the worker's generation (closeBundle) fails next and would hide it.
          console.error(`klatchly-private-split: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
      },
    },
    writeBundle(opts) {
      if (!assetList) throw new Error('klatchly-private-split: no asset list');
      writeFileSync(`${opts.dir}/${ASSET_LIST_FILE}`, JSON.stringify(assetList, null, 1) + '\n');
      const sw = readFileSync(new URL('./client/sw-app.js', import.meta.url), 'utf8');
      writeFileSync(`${opts.dir}/sw-app.js`, sw.replaceAll('__KLATCHLY_VERSION__', pkg.version).replaceAll('__KLATCHLY_PRIVATE_CACHE__', PRIVATE_CACHE).replaceAll('__KLATCHLY_PRIVATE_DONE__', PRIVATE_COMPLETE_KEY));
    },
  };
}

// Whether this build has the share package (ext/packages.client.ts, composed by npm run compose before vite build).
const HAS_SHARE = (() => {
  try {
    return readFileSync(new URL('./ext/packages.client.ts', import.meta.url), 'utf8').includes("from './share/client/index'");
  } catch {
    return false;
  }
})();

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        // Libraries of the launch path in their own chunks: they change far less often than the app, so a new
        // version only refetches (and re-precaches) the app chunks. Libraries of lazy screens (simplewebauthn)
        // stay with those screens. The other launch chunks (named after a module, e.g. "i18n", "format") are
        // Rolldown's own split of app modules shared with the lazy screens; "i18n" also holds both locales,
        // eager because t() is synchronous.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 2 },
            { name: 'vendor', test: /node_modules[\\/](@tanstack|react-virtuoso|wouter|regexparam|use-sync-external-store|simple-icons)[\\/]/, priority: 1 },
            // Only for the file viewer (PdfView), not precached (see workbox below).
            { name: 'pdfjs', test: /node_modules[\\/]pdfjs-dist[\\/]/, priority: 2 },
          ],
        },
      },
    },
  },
  plugins: [
    react(),
    sdkBarrel(),
    pdfAssets(),
    bundleModules(),
    privateSplit(),
    VitePWA({
      injectRegister: null,
      registerType: 'autoUpdate',
      filename: 'sw.js',
      manifestFilename: 'manifest.webmanifest',
      // The manifest fetched with the cookies: behind an access proxy (Cloudflare Access) it is otherwise refused.
      useCredentials: true,
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'favicon-32.png'],
      manifest: {
        name: '•',
        short_name: '•',
        description: '',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Dark theme colours (styles.css): page background for the launch screen, pane for the bars.
        background_color: '#14191e',
        theme_color: '#1b2127',
        // Android (Chrome): the installed app is a target of the system share sheet. A GET with the shared title, text
        // and link opens /share (the share package's page, which picks the chat and pre-fills its composer: nothing is
        // sent by itself); no service-worker handling. iOS Safari ignores it (the share package's Shortcut covers iOS).
        // Only in a build that has that package (the composed list, written before this build): without it there would
        // be nothing to open. Turned off at run time (Settings → Extensions), the installed app stays in the share sheet
        // until reinstalled and /share is an empty page.
        ...(HAS_SHARE ? { share_target: { action: '/share', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } } } : {}),
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // The public shell, precached: index.html, the boot entry's chunks and stylesheet, the sign-in screens, icons
        // and the manifest (never a private file: the server would answer a signed-out install with a redirect, and a
        // failed precache fails the install). Not the iOS launch images: 80 files of which one device ever uses four,
        // read by iOS itself rather than through the worker. The app's private chunks: the 'app-private-<version>'
        // runtime cache below, filled on use and ahead once signed in (client/sw-app.js). Plus bubble thumbnails;
        // never other /api responses, originals, videos or PDFs. pdf.js (≈ 0.45 MB + a 1.3 MB worker, and its data
        // under /pdfjs/) is cached the first time a PDF is opened.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['splash/**', 'pdfjs/**', 'assets/pdfjs-*.js', 'sw-app.js'],
        manifestTransforms: [
          (entries) => {
            // Read back from the file privateSplit wrote (this callback may run in another instance of this config).
            const file = new URL(`./dist/public/${ASSET_LIST_FILE}`, import.meta.url);
            if (!existsSync(file)) throw new Error(`no ${ASSET_LIST_FILE}: the build failed before (see klatchly-private-split above)`);
            const list = JSON.parse(readFileSync(file, 'utf8')) as AssetList;
            const pub = new Set(list.public.map((p) => p.slice(1)));
            return { manifest: entries.filter((e) => !e.url.startsWith('assets/') || pub.has(e.url)), warnings: [] };
          },
        ],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && (/^\/assets\/(pdfjs-|pdf\.worker)/.test(url.pathname) || url.pathname.startsWith('/pdfjs/')),
            handler: 'CacheFirst',
            options: { cacheName: 'pdfjs', expiration: { maxEntries: 80 } },
          },
          {
            // The app's private chunks (every /assets/ file the precache does not hold, its routes coming first):
            // cache-first in this version's cache, so a launch signed in opens without the network. Only a real
            // script or stylesheet is kept: signed out, the server answers with a redirect to the app page.
            // Older versions' caches go when a new worker activates, all of them at sign-out (client/sw-app.js,
            // devicestore.ts).
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: PRIVATE_CACHE,
              plugins: [
                {
                  cacheWillUpdate: async ({ response }) =>
                    response.status === 200 && !response.redirected && /javascript|css/.test(response.headers.get('content-type') || '') ? response : null,
                },
              ],
            },
          },
          {
            // Thumbnails (server/thumbs.ts) are immutable: cache-first, so a chat opened again shows its pictures
            // without the network. Only real thumbnails are kept: a 307 to the original (HEIC, oversized) ends
            // as another type, and a signed-out request as the app page. Emptied at sign-out (App.tsx).
            // ≈ 500 × 20–60 KB at most.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/api/thumb/'),
            handler: 'CacheFirst',
            options: {
              cacheName: THUMB_CACHE,
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 86400, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200], headers: { 'content-type': 'image/webp' } },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        cacheId: 'shell',
        // Push and notificationclick handlers (client/public/push-sw.js), after the spaces' notification targets
        // (/push-links.js, written by the server from the packages that are on: server/registry.ts); then the private
        // cache's warm-up and clean-up (client/sw-app.js, written by privateSplit above).
        importScripts: ['/push-links.js', '/push-sw.js', '/sw-app.js'],
      },
    }),
  ],
});
