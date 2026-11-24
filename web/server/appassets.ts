import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The client code's two halves (docs/auth-security.md, "Code served signed out"): the public boot entry
// (client/src/boot.tsx: session check, sign-in and enrolment screens, service worker registration) and everything
// else (client/src/appmain.tsx: App, Shell, the registry, every package's client code). The build lists the public files
// under /assets/ (vite.config.ts, from the bundle's graph: computeAssetList) into public-assets.json, next to
// index.html; the server reads it at start (readAssetList). Any other file under /assets/ is private: served to a
// session only (anonymous: 302 to /, never 401/403/404), never kept by a shared cache. Files outside /assets/
// (index.html, the manifest, icons, the service worker and its scripts, launch images, pdf.js data) are public.

/** The list's file, in the public directory (never served itself). */
export const ASSET_LIST_FILE = 'public-assets.json';
/** Cache-Control of a private chunk: hashed name, so immutable, but for this browser only. */
export const PRIVATE_ASSET_CACHE = 'private, max-age=31536000, immutable';

export interface AssetList {
  /** The client's version (package.json), as the service worker names its private cache. */
  version: string;
  /** The public files under /assets/ (paths from the site root). */
  public: string[];
  /** The private files the service worker fetches ahead once signed in (GET /api/assets): all but the on-demand ones. */
  warm: string[];
}

/** The parts of a Rollup/Rolldown output bundle this reads (vite.config.ts passes the real one). */
export type BundleItem =
  | {
      type: 'chunk';
      fileName: string;
      isEntry: boolean;
      imports: readonly string[];
      moduleIds: readonly string[];
      viteMetadata?: { importedCss: ReadonlySet<string>; importedAssets: ReadonlySet<string> };
    }
  | { type: 'asset'; fileName: string };

export interface AssetListOptions {
  version: string;
  /** Lazy modules whose chunk is public with its static imports, besides the entry (index.html → boot.tsx): Auth. */
  publicLazy: (moduleId: string) => boolean;
  /** Modules that must never reach a public chunk (the app's entry, the registry, the packages): the build fails. */
  forbidden: (moduleId: string) => boolean;
  /** Private files fetched on demand only, left out of the warm-up (pdf.js and its worker). */
  onDemand: (fileName: string) => boolean;
  /**
   * The app's private entry (appmain.tsx): its chunk, static imports and styles head the warm list, so a warm-up cut
   * off half way has most likely kept what the app needs to open; the lazy screens follow.
   */
  appEntry?: (moduleId: string) => boolean;
}

/**
 * The only paths a list may hold, written (computeAssetList: the build fails otherwise) and read back (readAssetList):
 * the server and client/sw-app.js accept nothing else. A chunk named with other characters (Rolldown keeps '@', '~',
 * '(' …) must fail the build, not the list at start.
 */
export const ASSET_PATH_RE = /^\/assets\/[\w.-]+$/;

/**
 * The public and warm lists of a build. Public: the entry chunk, the chunks of `publicLazy` and everything they import statically
 * (the browser loads it with them), with their stylesheets and assets. Throws when a public chunk holds a forbidden
 * module: a static import from the boot's graph into the app would hand its code to every visitor.
 */
export function computeAssetList(bundle: Readonly<Record<string, BundleItem>>, o: AssetListOptions): AssetList {
  const items = Object.values(bundle);
  const pub = new Set<string>();
  const visit = (fileName: string) => {
    if (pub.has(fileName)) return;
    const item = bundle[fileName];
    if (!item) return;
    pub.add(fileName);
    if (item.type !== 'chunk') return;
    const bad = item.moduleIds.filter(o.forbidden);
    if (bad.length) throw new Error(`public chunk ${fileName} holds private modules: ${bad.join(', ')}`);
    for (const f of item.imports) visit(f);
    for (const f of item.viteMetadata?.importedCss ?? []) visit(f);
    for (const f of item.viteMetadata?.importedAssets ?? []) visit(f);
  };
  // A lazy screen's chunk by the modules it holds (its facade is null when other chunks import it statically too).
  const roots = items.filter((i) => i.type === 'chunk' && (i.isEntry || i.moduleIds.some(o.publicLazy)));
  if (!roots.some((i) => i.type === 'chunk' && i.isEntry)) throw new Error('no entry chunk in the bundle');
  for (const r of roots) visit(r.fileName);
  const assets = (f: string) => f.startsWith('assets/');
  const path = (f: string) => `/${f}`;
  // The app entry's closure (static imports, styles, assets): first in the warm list.
  const first = new Set<string>();
  const reach = (fileName: string) => {
    const item = bundle[fileName];
    if (!item || first.has(fileName)) return;
    first.add(fileName);
    if (item.type !== 'chunk') return;
    for (const f of [...item.imports, ...(item.viteMetadata?.importedCss ?? []), ...(item.viteMetadata?.importedAssets ?? [])]) reach(f);
  };
  if (o.appEntry) for (const i of items) if (i.type === 'chunk' && i.moduleIds.some(o.appEntry)) reach(i.fileName);
  const warm = items
    .map((i) => i.fileName)
    .filter((f) => assets(f) && !pub.has(f) && !o.onDemand(f))
    .sort();
  const list = {
    version: o.version,
    public: [...pub].filter(assets).sort().map(path),
    warm: [...warm.filter((f) => first.has(f)), ...warm.filter((f) => !first.has(f))].map(path),
  };
  const bad = [...list.public, ...list.warm].filter((p) => !ASSET_PATH_RE.test(p));
  if (bad.length) throw new Error(`file names the server would refuse in ${ASSET_LIST_FILE} (letters, digits, _ . - only): ${bad.join(', ')}`);
  return list;
}

/** A list read back: only well-formed paths under /assets/. */
function parse(raw: unknown): AssetList | null {
  const r = raw as Partial<AssetList> | null;
  const paths = (v: unknown) => (Array.isArray(v) && v.every((p) => typeof p === 'string' && ASSET_PATH_RE.test(p)) ? (v as string[]) : null);
  if (!r || typeof r !== 'object' || typeof r.version !== 'string') return null;
  const pub = paths(r.public);
  const warm = paths(r.warm);
  return pub && warm ? { version: r.version, public: pub, warm } : null;
}

/**
 * The build's list, or null when there is none (a build from before 0.24.0, a hand-made public directory): then every
 * file is served as before, public (the caller logs it). A list that is there but unreadable or malformed throws: the
 * server refuses to start rather than serve the private code signed out.
 */
export function readAssetList(publicDir: string): AssetList | null {
  const file = join(publicDir, ASSET_LIST_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: unreadable (${e instanceof Error ? e.message : String(e)}); rebuild the client`);
  }
  const list = parse(raw);
  if (!list) throw new Error(`${file}: malformed (a version and two lists of /assets/ paths expected); rebuild the client`);
  return list;
}

/** Whether a static file needs a session: under /assets/ and not on the public list (no list: none does). */
export function isPrivateAsset(path: string, list: AssetList | null, publicSet: ReadonlySet<string> = new Set(list?.public)): boolean {
  return !!list && path.startsWith('/assets/') && !publicSet.has(path);
}
