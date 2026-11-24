import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { Limiter, makeThumb, parseThumbRequest, sniff, thumbHandler, thumbName, ThumbStore, withinLimits, type ThumbSource } from '../server/thumbs.js';
import { thumbSource } from '../server/app.js';
import { fakeSource, withFake } from './fakesource.js';

// The core's sources here: a fake connector's media (?m=<id>, test/fakesource.ts) and a second connector's
// (?c=<chat>&m=<message>, as a connector with its own media routes names them). The Beeper connector's
// (?url=<mxc>, strictly validated) are in ext/beeper/test/thumbs.test.ts.
const src = fakeSource();
const other = fakeSource(
  {
    owns: (id) => id.startsWith('o:'),
    media: {
      params: ['c', 'm'],
      parse: (q) => (/^o:\d{1,9}$/.test(q.c ?? '') && /^\d{1,9}$/.test(q.m ?? '') ? { kind: 'other', key: `other|${q.c}|${q.m}`, original: `/api/other/media/m.jpg?c=${encodeURIComponent(q.c!)}&m=${q.m}` } : null),
      fetch: async () => ({ status: 404, headers: {}, body: null }),
    },
  },
  'other',
);
withFake(src, [other.pkg]);
const plain = ({ open: _, ...ref }: ThumbSource) => ref;

test('thumbnail requests: widths and sources', () => {
  assert.deepEqual(plain(parseThumbRequest('w320.webp', { m: 'abc' }, thumbSource)!.source), { kind: 'fake', key: 'fake|abc', original: '/api/media/m.jpg?m=abc' });
  assert.equal(parseThumbRequest('w320.webp', { m: 'abc' }, thumbSource)?.width, 320);
  for (const w of [144, 640, 960]) assert.equal(parseThumbRequest(`w${w}.webp`, { m: 'abc' }, thumbSource)?.width, w);
  for (const f of ['w100.webp', 'w0320.webp', 'w320.png', 'w320.webp.jpg', 'x320.webp', '', undefined]) assert.equal(parseThumbRequest(f, { m: 'abc' }, thumbSource), null, String(f));
  assert.deepEqual(plain(parseThumbRequest('w640.webp', { c: 'o:123456', m: '789' }, thumbSource)!.source), {
    kind: 'other',
    key: 'other|o:123456|789',
    original: '/api/other/media/m.jpg?c=o%3A123456&m=789',
  });
  assert.equal(parseThumbRequest('w640.webp', { c: 'o:42', m: '7', r: '2' }, thumbSource)?.source.key, 'other|o:42|7');
});

test('thumbnail requests: nothing but validated relay sources (no SSRF)', () => {
  const bad: Record<string, string>[] = [
    { m: '../x' },
    { m: 'abc', type: 'image/jpeg' },
    { m: 'abc', r: 'x' },
    { m: 'abc', c: 'o:1' },
    { c: 'o:1' },
    { c: 'o:1', m: '1/../../avatar' },
    { c: 'x:1', m: '1' },
    { c: '!room:beeper.com', m: '1' },
    { c: 'o:1&thread=2', m: '1' },
    { url: 'https://example.com/a.jpg' },
    {},
  ];
  for (const q of bad) assert.equal(parseThumbRequest('w320.webp', q, thumbSource), null, JSON.stringify(q));
});

test('cache names: per source and width, stable (the cache of before the connectors still matches)', () => {
  const mxc = 'mxc://local.beeper.com/user_abcDEF123';
  const a = { key: `mxc|${mxc}` };
  const z = { key: 'other|o:1|2' };
  // The name of before (v1|<width>|mxc|<url>; a package's own key, v1|<width>|<its id>|…: in its tests).
  assert.equal(thumbName(320, a), createHash('sha256').update(`v1|320|mxc|${mxc}`).digest('base64url').slice(0, 32));
  assert.equal(thumbName(320, z), createHash('sha256').update('v1|320|other|o:1|2').digest('base64url').slice(0, 32));
  assert.match(thumbName(320, a), /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(thumbName(320, a), thumbName(640, a));
  assert.notEqual(thumbName(320, a), thumbName(320, z));
  assert.notEqual(thumbName(320, z), thumbName(320, { key: 'other|o:12|' }));
});

test('disk cache: least recently used evicted beyond the cap, order rebuilt from mtimes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thumbs-'));
  const n = (i: number) => `${String(i).padStart(32, 'a')}`;
  const s = new ThumbStore(dir, 100);
  for (let i = 0; i < 3; i++) await s.put(n(i), Buffer.alloc(30, i));
  assert.equal(s.size, 90);
  assert.ok(await s.get(n(0))); // 0 becomes the most recent
  await s.put(n(3), Buffer.alloc(30, 3)); // 120 > 100: down to ≤ 90, oldest (1) first
  assert.equal(await s.get(n(1)), null);
  assert.ok(await s.get(n(0)));
  assert.ok(await s.get(n(2)));
  assert.ok(await s.get(n(3)));
  assert.equal(s.size, 90);
  assert.equal(readdirSync(dir).length, 3);
  await s.put(n(9), Buffer.alloc(200)); // larger than the whole cache: not kept
  assert.equal(await s.get(n(9)), null);

  // Restart: files and their age read back; temporary leftovers removed.
  await new Promise((r) => setTimeout(r, 30)); // the hits' own mtime updates
  const t = Date.now() / 1000;
  utimesSync(join(dir, `${n(2)}.webp`), t - 300, t - 300);
  utimesSync(join(dir, `${n(0)}.webp`), t - 200, t - 200);
  utimesSync(join(dir, `${n(3)}.webp`), t - 100, t - 100);
  writeFileSync(join(dir, `${n(5)}.tmp-abc`), 'x');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const s2 = new ThumbStore(dir, 70);
  assert.equal(await s2.get(n(4)), null);
  assert.equal(s2.count, 2); // 90 > 70: down to ≤ 63 → the oldest (2) removed
  assert.equal(await s2.get(n(2)), null);
  assert.ok(await s2.get(n(0)));
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')));
  assert.ok(readdirSync(dir).includes('notes.txt'));
});

test('limiter: n at a time, a bounded queue, then busy', async () => {
  const l = new Limiter(2, 1);
  let running = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  const task = () =>
    l.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => release.push(r));
      running--;
    });
  const a = task();
  const b = task();
  const c = task();
  await assert.rejects(task(), /busy/);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(release.length, 2);
  release.shift()!();
  await a;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(release.length, 2);
  release.splice(0).forEach((r) => r());
  await Promise.all([b, c]);
  assert.equal(peak, 2);
  assert.equal(l.pending, 0);
});

test('input formats and size limits', () => {
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg');
  assert.equal(sniff(Buffer.from('GIF89a\0\0\0\0\0\0')), 'gif');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniff(Buffer.from('\0\0\0\x1cftypavif\0\0')), 'avif');
  // HEIC (no HEVC decoder in the prebuilt libvips), SVG, PDF: not decoded here.
  assert.equal(sniff(Buffer.from('\0\0\0\x18ftypheic\0\0')), undefined);
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
  assert.equal(sniff(Buffer.from('%PDF-1.7\n%....')), undefined);
  assert.equal(withinLimits('jpeg', 8064, 6048, 1), null); // 48 MP iPhone photo
  assert.equal(withinLimits('png', 8064, 6048, 1), 'pixels');
  assert.equal(withinLimits('png', 1284, 2778, 1), null);
  assert.equal(withinLimits('jpeg', 20000, 20000, 1), 'pixels');
  assert.equal(withinLimits('gif', 480, 270, 120), null);
  assert.equal(withinLimits('gif', 480, 270, 500), 'frames');
  assert.equal(withinLimits('gif', 1920, 1080, 60), 'frames');
  assert.equal(withinLimits('png', 0, 0, 1), 'decode');
});

const jpeg = (w: number, h: number, orientation?: number) => {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } });
  return (orientation ? img.withMetadata({ orientation }) : img).jpeg().toBuffer();
};

test('encoding: WebP, EXIF orientation applied, never enlarged, animation kept', async () => {
  const big = await makeThumb(await jpeg(2000, 1000, 6), 320);
  assert.ok(Buffer.isBuffer(big));
  const m = await sharp(big).metadata();
  assert.equal(m.format, 'webp');
  // 2000×1000 rotated 90° (orientation 6) = 1000×2000, then 320 wide.
  assert.deepEqual([m.width, m.height], [320, 640]);
  assert.equal(m.orientation, undefined);
  const small = await makeThumb(await sharp({ create: { width: 100, height: 50, channels: 4, background: '#0f0' } }).png().toBuffer(), 640);
  assert.ok(Buffer.isBuffer(small));
  assert.equal((await sharp(small).metadata()).width, 100);
  const frame = (c: string) => sharp({ create: { width: 400, height: 200, channels: 3, background: c } }).png().toBuffer();
  const gif = await sharp([await frame('#f00'), await frame('#00f'), await frame('#0f0')], { join: { animated: true } }).gif().toBuffer();
  const anim = await makeThumb(gif, 320);
  assert.ok(Buffer.isBuffer(anim));
  const am = await sharp(anim, { animated: true }).metadata();
  assert.equal(am.format, 'webp');
  assert.equal(am.pages, 3);
  assert.equal(am.width, 320);
  // Avatars: the shorter side at 144 (cropped to a circle on screen).
  const av = await makeThumb(await jpeg(1280, 640), 144);
  assert.ok(Buffer.isBuffer(av));
  assert.deepEqual([(await sharp(av).metadata()).width, (await sharp(av).metadata()).height], [288, 144]);
  assert.equal(await makeThumb(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0\0\0'), 320), 'format');
  assert.equal(await makeThumb(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 320), 'decode');
});

test('route: thumbnail, disk cache hit, 304, fallback to the original, source errors', async () => {
  const pic = await jpeg(1080, 1920);
  const calls: string[] = [];
  let mode: 'ok' | 'heic' | '404' = 'ok';
  // The app's resolver, each source's original read through the test's own fetch.
  const resolve = (q: Record<string, string>): ThumbSource | null => {
    const s = thumbSource(q);
    return s && {
      ...s,
      open: async () => {
        calls.push(s.key);
        if (mode === '404') return { status: 404, headers: {}, body: null };
        const b = mode === 'heic' ? Buffer.from('\0\0\0\x18ftypheic\0\0\0\0\0\0') : pic;
        return { status: 200, headers: { 'content-length': String(b.length) }, body: new Blob([new Uint8Array(b)]).stream() };
      },
    };
  };
  const app = new Hono();
  app.get('/api/thumb/:file{w[0-9]{3}\\.webp}', thumbHandler(resolve));
  const u = (q: string, w = 640) => `http://x/api/thumb/w${w}.webp?${q}`;
  const q = 'm=pic1';
  const r1 = await app.request(u(q));
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('content-type'), 'image/webp');
  assert.equal(r1.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.match(r1.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(r1.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r1.headers.get('x-thumb'), 'miss');
  const etag = r1.headers.get('etag')!;
  assert.match(etag, /^"t[A-Za-z0-9_-]{32}"$/);
  const body = Buffer.from(await r1.arrayBuffer());
  assert.equal((await sharp(body).metadata()).width, 640);
  assert.ok(body.length < pic.length);

  const r2 = await app.request(u(q));
  assert.equal(r2.headers.get('x-thumb'), 'hit');
  assert.equal(r2.headers.get('etag'), etag);
  assert.equal(calls.length, 1);
  const r3 = await app.request(u(q), { headers: { 'If-None-Match': etag } });
  assert.equal(r3.status, 304);

  // Concurrent requests for one thumbnail: one fetch.
  const zq = 'c=o%3A11&m=22';
  const [z1, z2] = await Promise.all([app.request(u(zq, 320)), app.request(u(zq, 320))]);
  assert.deepEqual([z1.status, z2.status], [200, 200]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'other|o:11|22');

  // Not decodable here: redirected to the original's own relay, remembered.
  mode = 'heic';
  const h = await app.request(u('m=pic2'));
  assert.equal(h.status, 307);
  assert.equal(h.headers.get('location'), '/api/media/m.jpg?m=pic2');
  assert.equal(h.headers.get('cache-control'), 'no-store');
  await app.request(u('m=pic2'));
  assert.equal(calls.length, 3);

  mode = '404';
  const nf = await app.request(u('m=pic3'));
  assert.equal(nf.status, 404);
  assert.equal(nf.headers.get('cache-control'), 'no-store');

  // Bad requests never reach the source.
  const n = calls.length;
  for (const bad of [u('m=..%2Fx'), u(q, 500), u(`${q}&c=o%3A1`)]) assert.equal((await app.request(bad)).status, 400, bad);
  assert.equal((await app.request(`http://x/api/thumb/w320.png?${q}`)).status, 404);
  assert.equal(calls.length, n);
});
