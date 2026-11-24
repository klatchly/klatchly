import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { Env } from '../server/context.js';
import { HTML_VIEW_CSP, HTML_VIEW_MAX, htmlViewRoutes, prepareHtml, resetHtmlViewForTests } from '../server/htmlview.js';

// The routes as app.ts mounts them, a session set by a header here (the app's own cookie middleware there).
const app = new Hono<Env>()
  .use('*', async (c, next) => {
    c.set('session', c.req.header('x-session') ?? 's1');
    await next();
  })
  .route('/api', htmlViewRoutes);
const post = (body: string | Uint8Array, session = 's1') => app.request('/api/htmlview', { method: 'POST', headers: { 'x-session': session }, body: body as never });
const get = (id: string, session = 's1') => app.request(`/api/htmlview/${id}`, { headers: { 'x-session': session } });

test('html view: base target first in the head, bytes kept as they are', () => {
  const out = (s: string) => prepareHtml(Buffer.from(s, 'utf8')).toString('utf8');
  assert.equal(out('<!doctype html><html><head><title>é</title></head></html>'), '<!doctype html><html><head><base target="_blank"><title>é</title></head></html>');
  assert.equal(out('<HEAD lang="fr"><p>x'), '<HEAD lang="fr"><base target="_blank"><p>x');
  assert.equal(out('<!DOCTYPE html>\n<p>x'), '<!DOCTYPE html><base target="_blank">\n<p>x');
  assert.equal(out('<p>x</p>'), '<base target="_blank"><p>x</p>');
  assert.equal(out('<header>t</header>'), '<base target="_blank"><header>t</header>', 'a <header> is not the head');
  assert.equal(out('\ufeff<p>x</p>'), '\ufeff<base target="_blank"><p>x</p>', 'after a UTF-8 BOM');
  const utf16 = Buffer.from([0xff, 0xfe, 0x3c, 0, 0x70, 0, 0x3e, 0]);
  assert.deepEqual(prepareHtml(utf16), utf16, 'UTF-16 left as it is');
  const latin = Buffer.from([0x3c, 0x70, 0x3e, 0xe9]);
  assert.deepEqual(prepareHtml(latin).subarray(-4), latin);
});

test('html view: served sandboxed, no scripts, nothing fetched; only to the session that sent it', async () => {
  resetHtmlViewForTests();
  const r = await post('<!doctype html><head><meta charset="windows-1252"></head><script>alert(1)</script><p>CR</p>');
  assert.equal(r.status, 200);
  const { id } = (await r.json()) as { id: string };
  assert.match(id, /^[a-f0-9]{32}$/);
  const page = await get(id);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html', 'its own charset');
  const csp = page.headers.get('content-security-policy')!;
  assert.equal(csp, HTML_VIEW_CSP);
  assert.match(csp, /^sandbox allow-popups allow-popups-to-escape-sandbox;/);
  assert.doesNotMatch(csp, /allow-scripts|allow-same-origin|allow-forms|allow-top-navigation/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src data:;/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-dns-prefetch-control'), 'off');
  assert.match(await page.text(), /<base target="_blank">/);
  assert.equal((await get(id, 's2')).status, 404, 'another session');
  assert.equal((await get('0'.repeat(32))).status, 404);
  // No charset named: read as UTF-8.
  const utf = (await (await post('<p>Réunion</p>')).json()) as { id: string };
  assert.equal((await get(utf.id)).headers.get('content-type'), 'text/html; charset=utf-8');
});

test('html view: empty or too large refused; a few kept per session, the oldest dropped', async () => {
  resetHtmlViewForTests();
  assert.equal((await post('')).status, 400);
  assert.equal((await post(new Uint8Array(HTML_VIEW_MAX + 1))).status, 413);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(((await (await post(`<p>${i}</p>`)).json()) as { id: string }).id);
  assert.equal((await get(ids[0]!)).status, 404, 'the oldest of five dropped');
  for (const id of ids.slice(1)) assert.equal((await get(id)).status, 200);
});
