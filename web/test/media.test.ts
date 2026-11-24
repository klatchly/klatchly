import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { contentDisposition, mediaType, safeFileName, serveMedia } from '../server/media.js';
import { fakeSource, withFake } from './fakesource.js';

test('safeFileName: NFC, no controls, bidi overrides or path separators, length capped with the extension', () => {
  assert.equal(safeFileName('Báo cáo.pdf'), 'Báo cáo.pdf');
  assert.equal(safeFileName('a/b\\c:d*e?.txt'), 'a_b_c_d_e_.txt');
  assert.equal(safeFileName('x‮gpj.exe'), 'xgpj.exe');
  assert.equal(safeFileName('line\r\nbreak.txt'), 'linebreak.txt');
  assert.equal(safeFileName('...'), undefined);
  assert.equal(safeFileName(''), undefined);
  const long = safeFileName('é'.repeat(300) + '.docx')!;
  assert.equal([...long].length, 180);
  assert.ok(long.endsWith('.docx'));
});

test('contentDisposition: ASCII fallback and RFC 5987 UTF-8 name', () => {
  assert.equal(contentDisposition('attachment'), 'attachment');
  assert.equal(contentDisposition('inline', 'photo.jpg'), `inline; filename="photo.jpg"; filename*=UTF-8''photo.jpg`);
  assert.equal(
    contentDisposition('attachment', 'Báo cáo (final) 100%.pdf'),
    `attachment; filename="Bao cao (final) 100_.pdf"; filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20%28final%29%20100%25.pdf`,
  );
  assert.equal(contentDisposition('attachment', `it's "x".txt`), `attachment; filename="it's _x_.txt"; filename*=UTF-8''it%27s%20_x_.txt`);
  // Non-Latin names: the fallback is all underscores, the UTF-8 form carries the name.
  const cd = contentDisposition('attachment', '請求書.pdf');
  assert.ok(cd.startsWith('attachment; filename="___.pdf"; filename*=UTF-8\'\'%E8%AB%8B'), cd);
  // Header injection is impossible: no CR/LF or quote survives.
  assert.ok(!/[\r\n]/.test(contentDisposition('attachment', 'a\r\nSet-Cookie: x=1')));
});

test('mediaType: upstream type, else the allowlisted hint; PDFs inline, documents downloads', () => {
  assert.deepEqual(mediaType('image/jpeg', undefined), { type: 'image/jpeg', inline: true });
  assert.deepEqual(mediaType('image/jpg', undefined), { type: 'image/jpeg', inline: true });
  assert.deepEqual(mediaType(null, 'application/pdf'), { type: 'application/pdf', inline: true });
  assert.deepEqual(mediaType('application/octet-stream', 'application/pdf'), { type: 'application/pdf', inline: true });
  assert.deepEqual(mediaType(null, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    inline: false,
  });
  // never HTML, SVG or scripts from a hint; upstream HTML stays a download
  assert.deepEqual(mediaType(null, 'text/html'), { type: 'application/octet-stream', inline: false });
  assert.deepEqual(mediaType(null, 'image/svg+xml'), { type: 'application/octet-stream', inline: false });
  assert.deepEqual(mediaType('text/html; charset=utf-8', undefined), { type: 'text/html; charset=utf-8', inline: false });
  assert.deepEqual(mediaType('image/svg+xml', 'image/png'), { type: 'image/svg+xml', inline: false });
});

test('serveMedia: a connector names the media; the core sets type, name and the sandbox headers', async () => {
  const src = fakeSource();
  src.media.set('doc1', Buffer.from('%PDF-1.4\n'));
  withFake(src);
  const app = new Hono().get('/api/media/:file', serveMedia);
  const r = await app.request('/api/media/m.bin?m=doc1&type=application%2Fpdf&name=a.pdf');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), 'inline; filename="a.pdf"; filename*=UTF-8\'\'a.pdf');
  assert.equal(r.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(r.headers.get('cache-control'), 'private, max-age=604800');
  await r.arrayBuffer();
  // Parameters no connector takes: 400, sandboxed too; a source's 404 stays a 404.
  for (const q of ['', '?m=../x', '?url=mxc%3A%2F%2Fx%2Fy']) {
    const bad = await app.request(`/api/media/m.bin${q}`);
    assert.equal(bad.status, 400, q);
    assert.equal(bad.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  }
  assert.equal((await app.request('/api/media/m.bin?m=gone')).status, 404);
});
