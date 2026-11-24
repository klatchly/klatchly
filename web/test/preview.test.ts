import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BlockedError, guardedGet, imageRef, isPublicIP, parseHead, parseTarget, preview, verifyImageRef, type Guard } from '../server/preview.js';

test('SSRF guard: only public unicast addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4007:80e::200e']) assert.ok(isPublicIP(ip), ip);
  for (const ip of [
    '10.1.2.3', '172.16.0.1', '172.17.0.2', '172.31.255.255', '192.168.1.1', '127.0.0.1', '127.255.0.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.254', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
    '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '192.0.0.8',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:7f00:1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001::1', '100::1', 'fec0::1',
    'localhost', '', 'not-an-ip', '1.2.3', '::ffff:10.0.0.1',
  ]) assert.ok(!isPublicIP(ip), ip);
});

test('target URLs: http(s) only, no credentials', () => {
  assert.equal(parseTarget('https://example.com/a?b=1#frag')?.href, 'https://example.com/a?b=1');
  for (const u of ['ftp://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://u:p@example.com/', 'http://', 'https://exa mple.com/', 42, 'x'.repeat(3000)]) {
    assert.equal(parseTarget(u), null, String(u).slice(0, 40));
  }
});

// Local fake web server; a test guard maps fake hostnames to it.
let port = 0;
const hits: string[] = [];
const srv = createServer((req, res) => {
  hits.push(`${req.headers.host} ${req.url}`);
  const u = req.url ?? '/';
  if (u === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'a=b' });
    res.end(`<html><head><title>Fallback</title><meta property="og:title" content="Caf&eacute; &amp; Co" /><meta name="description" content='Desc "q"'>
      <meta property="og:image" content="/img.png"><meta property="og:site_name" content="Site"></head><body>x</body></html>`);
  } else if (u === '/plain') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  } else if (u === '/huge') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<head><title>Huge</title></head>');
    res.end('x'.repeat(2 * 1024 * 1024));
  } else if (u === '/bigimg') {
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.alloc(6 * 1024 * 1024));
  } else if (u === '/img.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.from('89504e47', 'hex'));
  } else if (u === '/to-private') {
    res.writeHead(302, { Location: 'http://10.0.0.1/admin' }).end();
  } else if (u === '/to-meta') {
    res.writeHead(301, { Location: 'http://169.254.169.254/latest/meta-data/' }).end();
  } else if (u === '/to-ok') {
    res.writeHead(302, { Location: `http://ok.test:${port}/page` }).end();
  } else if (u.startsWith('/loop')) {
    res.writeHead(302, { Location: `/loop${u.length}` }).end();
  } else if (u === '/hang') {
    // never answers
  } else res.writeHead(404).end();
});

const names: Record<string, string[]> = {
  'ok.test': ['127.0.0.1'],
  'rebind.test': ['127.0.0.1'], // not in real DNS: works only because we connect to the vetted address
  'mixed.test': ['127.0.0.1', '10.0.0.1'],
  'private.test': ['10.0.0.1'],
};
const resolved: string[] = [];
const guard: Guard = {
  resolve: async (h) => (resolved.push(h), names[h] ?? []),
  allowIP: (ip) => ip === '127.0.0.1',
  allowPort: (p) => p === port || p === 80,
};
const html = (t: string) => t === 'text/html';

before(() => new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => ((port = (srv.address() as AddressInfo).port), r()))));
after(() => srv.close());

test('preview of a page: og tags, entities, relative image, signed image ref, no cookies kept', async () => {
  const p = await preview(new URL(`http://ok.test:${port}/page`), 'fr', guard);
  assert.equal(p.title, 'Café & Co');
  assert.equal(p.description, 'Desc "q"');
  assert.equal(p.siteName, 'Site');
  const ref = new URL(p.image!, 'http://x');
  assert.equal(ref.searchParams.get('u'), `http://ok.test:${port}/img.png`);
  assert.ok(verifyImageRef(ref.searchParams.get('u')!, ref.searchParams.get('s')!));
  assert.ok(!verifyImageRef('http://evil/x.png', ref.searchParams.get('s')!));
  assert.ok(imageRef('http://a/b').startsWith('/api/preview-img/p.jpg?u='));
  const n = hits.length;
  await preview(new URL(`http://ok.test:${port}/page`), 'fr', guard);
  assert.equal(hits.length, n, 'cached');
});

test('connects to the vetted address (no re-resolution / rebinding)', async () => {
  const r = await guardedGet(new URL(`http://rebind.test:${port}/page`), { maxBytes: 1e6, accept: html, guard });
  assert.equal(r.status, 200);
  assert.ok(hits.at(-1)!.startsWith(`rebind.test:${port} `), 'Host header keeps the name');
  assert.equal(resolved.filter((h) => h === 'rebind.test').length, 1);
});

test('blocked: private answers, mixed answers, redirects to private/metadata, ports, loops', async () => {
  const bad = async (u: string, why: RegExp, opts: Partial<Parameters<typeof guardedGet>[1]> = {}) => {
    await assert.rejects(guardedGet(new URL(u), { maxBytes: 1e6, accept: html, guard, ...opts }), (e: unknown) => e instanceof BlockedError && why.test((e as Error).message), u);
  };
  await bad(`http://private.test:${port}/page`, /address/);
  await bad(`http://mixed.test:${port}/page`, /address/);
  await bad(`http://ok.test:${port}/to-private`, /address/);
  await bad(`http://ok.test:${port}/to-meta`, /address/);
  await bad(`http://ok.test:${port + 1}/page`, /port/);
  await bad(`http://ok.test:${port}/loop`, /redirects/);
  await bad(`http://ok.test:${port}/plain`, /status 200 application\/json/);
  await bad(`http://ok.test:${port}/bigimg`, /too large/, { accept: (t) => t === 'image/png', maxBytes: 5 * 1024 * 1024 });
  const ok = await guardedGet(new URL(`http://ok.test:${port}/to-ok`), { maxBytes: 1e6, accept: html, guard });
  assert.equal(ok.url.pathname, '/page');
});

test('huge pages are truncated, not buffered; hanging servers time out', async () => {
  const r = await guardedGet(new URL(`http://ok.test:${port}/huge`), { maxBytes: 512 * 1024, truncate: true, accept: html, guard });
  assert.equal(r.body.length, 512 * 1024);
  assert.equal(parseHead(r.body.toString(), r.url).title, 'Huge');
  const t0 = Date.now();
  await assert.rejects(guardedGet(new URL(`http://ok.test:${port}/hang`), { maxBytes: 1e6, accept: html, guard, timeoutMs: 300 }));
  assert.ok(Date.now() - t0 < 2000);
});

test('default guard refuses internal targets (loopback, docker, metadata, odd ports)', async () => {
  for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/', 'http://172.17.0.1/', 'http://10.0.0.1/', `http://example.com:${port}/`, 'http://beeper-server:23373/v1/chats']) {
    await assert.rejects(guardedGet(new URL(u), { maxBytes: 1e6, accept: html, timeoutMs: 3000 }), (e: unknown) => e instanceof Error, u);
  }
  // Failure -> empty preview (cached negative), never a throw.
  assert.deepEqual(await preview(new URL('http://127.0.0.1/x')), { url: 'http://127.0.0.1/x' });
});

test('image routes also answer under a static file name (CrowdSec counts extension-less GETs)', async () => {
  const { Hono } = await import('hono');
  const { previewRoutes } = await import('../server/preview.js');
  const app = new Hono().route('/api', previewRoutes);
  // Unsigned: refused by the handler (400), which proves the route matched (a missing route would be 404).
  for (const p of ['/api/preview-img?u=x&s=y', '/api/preview-img/p.jpg?u=x&s=y']) {
    assert.notEqual((await app.request(p)).status, 404, p);
  }
  assert.equal((await app.request('/api/preview-img/../x?u=x&s=y')).status, 404);
  assert.equal((await app.request('/api/preview-img/p.toolongext?u=x&s=y')).status, 404);
});
