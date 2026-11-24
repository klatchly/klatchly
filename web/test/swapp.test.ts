import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PRIVATE_COMPLETE_KEY, privateCacheName } from '../client/src/cachenames.js';

// client/sw-app.js (the service worker's cache of the app's private chunks) in a fake worker scope, with the values
// the build puts in (vite.config.ts privateSplit): the warm-up from GET /api/assets on install and on the page's
// request, never keeping a redirect or a non-script; the older versions' caches deleted on activate.

const VERSION = '9.9.9';
const CACHE = privateCacheName(VERSION);

type Res = { status: number; type?: string; redirected?: boolean; ct?: string; body?: unknown };
function load(routes: Record<string, Res>, existing: Record<string, string[]> = {}) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const stores = new Map<string, Map<string, unknown>>(Object.entries(existing).map(([k, v]) => [k, new Map(v.map((u) => [u, {}]))]));
  const fetched: { url: string; init: Record<string, unknown> }[] = [];
  const response = (r: Res) => ({
    status: r.status,
    type: r.type ?? 'basic',
    redirected: !!r.redirected,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? (r.ct ?? null) : null) },
    json: async () => r.body,
  });
  const scope = {
    self: { addEventListener: (t: string, fn: (e: unknown) => void) => (handlers[t] = fn) },
    caches: {
      keys: async () => [...stores.keys()],
      delete: async (k: string) => stores.delete(k),
      open: async (k: string) => {
        if (!stores.has(k)) stores.set(k, new Map());
        const m = stores.get(k)!;
        return { match: async (u: string) => m.get(u), put: async (u: string, r: unknown) => void m.set(u, r) };
      },
    },
    fetch: async (url: string, init: Record<string, unknown>) => {
      fetched.push({ url, init });
      const r = routes[url];
      return response(r ?? { status: 404 });
    },
    setTimeout,
    Promise,
    Array,
    Response: class {
      constructor(readonly body: string) {}
    },
  };
  const code = readFileSync(new URL('../../client/sw-app.js', import.meta.url), 'utf8').replaceAll('__KLATCHLY_VERSION__', VERSION).replaceAll('__KLATCHLY_PRIVATE_CACHE__', CACHE).replaceAll('__KLATCHLY_PRIVATE_DONE__', PRIVATE_COMPLETE_KEY);
  runInNewContext(code, scope);
  const fire = async (type: string, e: Record<string, unknown> = {}) => {
    let p: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...e, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  // The chunks kept, and whether the completion marker was written (devicestore.ts hasPrivateCache reads it).
  const cached = (k = CACHE) => [...(stores.get(k)?.keys() ?? [])].filter((u) => u !== PRIVATE_COMPLETE_KEY).sort();
  const done = () => !!stores.get(CACHE)?.has(PRIVATE_COMPLETE_KEY);
  return { fire, fetched, cached, done, stores, handlers };
}

const js = (status = 200): Res => ({ status, ct: 'text/javascript; charset=utf-8' });
const list = (files: string[], version = VERSION): Res => ({ status: 200, ct: 'application/json', body: { version, files } });

test('install warms this version\'s cache: missing files only, fetched with the cookies, scripts and stylesheets only', async () => {
  const sw = load(
    {
      '/api/assets': list(['/assets/appmain-a.js', '/assets/appmain-b.css', '/assets/Space-c.js', '/assets/odd-d.js', '../etc/passwd', 42 as unknown as string]),
      '/assets/appmain-a.js': js(),
      '/assets/appmain-b.css': { status: 200, ct: 'text/css; charset=utf-8' },
      // Already there: not fetched again.
      '/assets/Space-c.js': js(),
      // The app page instead of a script (a proxy's answer…): never kept.
      '/assets/odd-d.js': { status: 200, ct: 'text/html; charset=utf-8' },
    },
    { [CACHE]: ['/assets/Space-c.js'] },
  );
  await sw.fire('install');
  assert.deepEqual(sw.cached(), ['/assets/Space-c.js', '/assets/appmain-a.js', '/assets/appmain-b.css']);
  // One listed file could not be kept (odd-d.js): the cache is not complete.
  assert.equal(sw.done(), false);
  const urls = sw.fetched.map((f) => f.url);
  assert.equal(urls[0], '/api/assets');
  assert.ok(!urls.includes('/assets/Space-c.js') && !urls.includes('../etc/passwd'));
  for (const f of sw.fetched) {
    assert.equal(f.init.credentials, 'same-origin');
    assert.equal(f.init.redirect, 'manual');
  }
});

test('signed out (the list or a file answers with a redirect): nothing kept, the install still completes', async () => {
  const out = load({ '/api/assets': { status: 0, type: 'opaqueredirect' } });
  await out.fire('install');
  assert.deepEqual(out.cached(), []);
  assert.deepEqual(out.fetched.map((f) => f.url), ['/api/assets']);
  // Signed out meanwhile: the redirect is not kept and the warm-up stops.
  const mid = load({ '/api/assets': list(['/assets/a.js', '/assets/b.js', '/assets/c.js', '/assets/d.js', '/assets/e.js', '/assets/f.js']), '/assets/a.js': { status: 0, type: 'opaqueredirect' } });
  await mid.fire('install');
  assert.deepEqual(mid.cached(), []);
  assert.equal(mid.done(), false);
  assert.ok(mid.fetched.length < 7, `${mid.fetched.length} requests`);
  // The server down: the install is not failed.
  const down = load({});
  await down.fire('install');
  assert.deepEqual(down.cached(), []);
});

test('another build answering (a deploy in between): its files are not fetched', async () => {
  const sw = load({ '/api/assets': list(['/assets/appmain-a.js'], '9.9.10'), '/assets/appmain-a.js': js() });
  await sw.fire('install');
  assert.deepEqual(sw.cached(), []);
  assert.deepEqual(sw.fetched.map((f) => f.url), ['/api/assets']);
});

test('the page asks for a warm-up (after a sign-in); other messages are ignored', async () => {
  const sw = load({ '/api/assets': list(['/assets/appmain-a.js']), '/assets/appmain-a.js': js() });
  await sw.fire('message', { data: { type: 'SKIP_WAITING' } });
  await sw.fire('message', { data: 'klatchly-warm' });
  assert.equal(sw.fetched.length, 0);
  await sw.fire('message', { data: { type: 'klatchly-warm' } });
  assert.deepEqual(sw.cached(), ['/assets/appmain-a.js']);
  assert.equal(sw.done(), true);
});

test('the completion marker: only once every listed file is in the cache, not for a cache the runtime route started', async () => {
  // A file missing (404 meanwhile): the files kept stay, no marker; the next warm-up, complete, writes it.
  const routes: Record<string, Res> = { '/api/assets': list(['/assets/a.js', '/assets/b.js']), '/assets/a.js': js() };
  const sw = load(routes, { [CACHE]: ['/assets/c.js'] });
  await sw.fire('install');
  assert.deepEqual(sw.cached(), ['/assets/a.js', '/assets/c.js']);
  assert.equal(sw.done(), false);
  routes['/assets/b.js'] = js();
  await sw.fire('message', { data: { type: 'klatchly-warm' } });
  assert.equal(sw.done(), true);
  assert.deepEqual(sw.fetched.map((f) => f.url).filter((u) => u === '/assets/a.js'), ['/assets/a.js']);
});

test('activate deletes the older versions\' private caches, nothing else', async () => {
  const sw = load({}, { [CACHE]: ['/assets/a.js'], [privateCacheName('9.9.8')]: ['/assets/old.js'], [privateCacheName('0.1.0')]: [], 'shell-precache-v2': [], thumbs: [], pdfjs: [] });
  await sw.fire('activate');
  assert.deepEqual([...sw.stores.keys()].sort(), [CACHE, 'pdfjs', 'shell-precache-v2', 'thumbs'].sort());
});
