import { test } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { serveMedia } from '#core/media.js';
import { isAllowedMediaUrl } from '../server/mxc.js';

const base = 'mxc://local.beeper.com/user_abcDEF123';
const info = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString('base64url');
const good = {
  hashes: { sha256: 'gYAHgDrMV841FmNSYxqd5REVyTDj4CKlPScMZUA1Tsk' },
  iv: '1em5Q7BExXEAAAAAAAAAAA',
  key: { alg: 'A256CTR', ext: true, k: '8wfwhFDrwIohT_vXCwe2XUdqi6dd_lhc5zVtPl5eRBc', key_ops: ['encrypt', 'decrypt'], kty: 'oct' },
  url: base,
  v: 'v2',
};

test('plain mxc URLs', () => {
  assert.ok(isAllowedMediaUrl(base));
  assert.ok(isAllowedMediaUrl('localmxc://beeper.local/abc'));
  assert.ok(!isAllowedMediaUrl('file:///data/account.db'));
  assert.ok(!isAllowedMediaUrl('mxc://local.beeper.com/../x'));
  // Local bridges' cache layout for our own just-sent files: <server>/<account>/<!room>/<file>.
  assert.ok(isAllowedMediaUrl('mxc://local-signal.localhost/ba_Abc123/!E1_Room-9/1793342859275-hj8me_image.png'));
  assert.ok(!isAllowedMediaUrl('mxc://local-signal.localhost/ba_Abc123/../../account.db'));
  assert.ok(!isAllowedMediaUrl('mxc://local.beeper.com/a%2f'));
});

test('encrypted media parameter', () => {
  assert.ok(isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info(good)}`));
  const { url: _u, ...noUrl } = good;
  assert.ok(isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info(noUrl)}`));
  // inner url must be the same mxc:// URI
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...good, url: 'file:///data/account.db' })}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...good, url: 'mxc://local.beeper.com/other' })}`));
  // unknown keys, wrong algorithm, extra parameters, non-JSON
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...good, path: '/etc/passwd' })}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...good, key: { ...good.key, alg: 'none' } })}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info(good)}&x=1`));
  assert.ok(!isAllowedMediaUrl(`${base}?other=${info(good)}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${Buffer.from('not json at all!!').toString('base64url')}`));
  assert.ok(!isAllowedMediaUrl(`file:///x?encryptedFileInfoJSON=${info(good)}`));
});

// Beeper's floe encryption (beeper-server 4.3.284, new WhatsApp pictures/videos/GIFs): it was refused (400),
// so these showed "Video unavailable" and Retry asked the same refused URL again.
const floe = {
  floe_header: '5Cv35zdeTPr66pNOayB0IM+w7/qEP44vFjpzM7KIDsHFLjvwC4uc6LlvYuQ755FRxEqTDvNNBZ48aiTCx48pcF9MngpRy/mPZxs',
  floe_key: '6WC6nLDONT2pgvxOq8FjGFbb86SZ8bbEvaG/kMOe9S8',
  url: base,
  v: 'com.beeper.floe.v1',
};

test('floe-encrypted media parameter', () => {
  assert.ok(isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info(floe)}`));
  const { url: _u, ...noUrl } = floe;
  assert.ok(isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info(noUrl)}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...floe, url: 'file:///data/account.db' })}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...floe, url: 'mxc://local.beeper.com/other' })}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...floe, path: '/etc/passwd' })}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...floe, v: 'com.beeper.floe.v9' })}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...floe, floe_key: '../../x' })}`));
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...floe, floe_header: 42 })}`));
  // the two shapes are not mixed: Matrix fields on a floe object are refused
  assert.ok(!isAllowedMediaUrl(`${base}?encryptedFileInfoJSON=${info({ ...floe, iv: good.iv })}`));
});

test('serveMedia: real type and file name for documents, security headers kept', async () => {
  const pdf = Buffer.from('%PDF-1.4\n%fake\n');
  const port = Number(new URL(process.env.KLATCHLY_UPSTREAM!).port);
  const server = createServer((req, res) => {
    assert.ok(req.url?.startsWith('/v1/assets/serve?url='));
    // beeper-server's cache often answers without a type
    res.writeHead(200, { 'content-length': String(pdf.length) });
    res.end(pdf);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  try {
    const app = new Hono().get('/api/media/:file', serveMedia);
    const name = 'Hợp đồng.pdf'.normalize('NFD');
    const r = await app.request(`/api/media/m.bin?url=${encodeURIComponent('mxc://local.beeper.com/abc')}&type=application%2Fpdf&name=${encodeURIComponent(name)}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('content-disposition'), `inline; filename="Hop _ong.pdf"; filename*=UTF-8''${encodeURIComponent('Hợp đồng.pdf'.normalize('NFC'))}`);
    assert.equal(r.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), pdf);
    // a hint outside the allowlist is ignored: bytes as a download
    const h = await app.request(`/api/media/m.bin?url=${encodeURIComponent('mxc://local.beeper.com/abc')}&type=text%2Fhtml&name=x.html`);
    assert.equal(h.headers.get('content-type'), 'application/octet-stream');
    assert.ok(h.headers.get('content-disposition')!.startsWith('attachment; filename="x.html"'));
    await h.arrayBuffer();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
