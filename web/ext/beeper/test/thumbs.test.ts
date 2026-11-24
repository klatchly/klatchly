import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import sharp from 'sharp';
import { thumbSource } from '#core/app.js';
import { parseThumbRequest, thumbHandler, thumbName, type ThumbSource } from '#core/thumbs.js';
import './setup.js';

// Thumbnails of Beeper media: ?url=<mxc> exactly, validated by the connector (mxc.ts), the original read from
// /v1/assets/serve with the token; the fallback is the /api/media relay. The cache name is the one of before.

const mxc = 'mxc://local.beeper.com/user_abcDEF123';
const plain = ({ open: _, ...ref }: ThumbSource) => ref;

test('mxc sources: the relay parameter exactly, strictly validated', () => {
  assert.deepEqual(plain(parseThumbRequest('w320.webp', { url: mxc }, thumbSource)!.source), {
    kind: 'mxc',
    key: `mxc|${mxc}`,
    original: `/api/media/m.jpg?url=${encodeURIComponent(mxc)}`,
  });
  const bad: Record<string, string>[] = [
    { url: 'file:///data/account.db' },
    { url: 'http://169.254.169.254/latest/meta-data' },
    { url: 'https://example.com/a.jpg' },
    { url: 'mxc://local.beeper.com/../x' },
    { url: 'mxc://local-signal.localhost/ba/../../account.db' },
    { url: `${mxc}?x=1` },
    { url: mxc, c: 'x:u:1', m: '1' },
    { url: mxc, type: 'image/jpeg' },
    { url: mxc, r: 'x' },
  ];
  for (const q of bad) assert.equal(parseThumbRequest('w320.webp', q, thumbSource), null, JSON.stringify(q));
  assert.equal(parseThumbRequest('w320.webp', { url: mxc, r: '2' }, thumbSource)?.source.key, `mxc|${mxc}`);
});

const port = Number(new URL(process.env.KLATCHLY_UPSTREAM!).port);
const seen: { url: string; auth?: string; range?: string }[] = [];
let pic: Buffer;
const upstream = createServer((req, res) => {
  seen.push({ url: req.url ?? '', auth: req.headers.authorization, range: req.headers.range });
  res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(pic.length) });
  res.end(pic);
});
before(async () => {
  pic = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#468' } }).jpeg().toBuffer();
  await new Promise<void>((r) => upstream.listen(port, '127.0.0.1', () => r()));
});
after(() => new Promise<void>((r) => upstream.close(() => r())));

test('the original comes from /v1/assets/serve with the token, whole', async () => {
  const app = new Hono().get('/api/thumb/:file{w[0-9]{3}\\.webp}', thumbHandler(thumbSource));
  const r = await app.request(`http://x/api/thumb/w320.webp?url=${encodeURIComponent(mxc)}`, { headers: { Range: 'bytes=0-10' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('etag'), `"t${thumbName(320, { key: `mxc|${mxc}` })}"`);
  assert.equal((await sharp(Buffer.from(await r.arrayBuffer())).metadata()).width, 320);
  assert.deepEqual(seen, [{ url: `/v1/assets/serve?url=${encodeURIComponent(mxc)}`, auth: 'Bearer test-token', range: undefined }]);
});
