import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampView, downloadName, galleryOf, IDENTITY, mediaKind, swipeStep, toggleZoom, zoomAt } from '../client/src/gallery.js';

test('mediaKind: photos, GIFs and real videos open in the lightbox; stickers and Lottie do not', () => {
  assert.equal(mediaKind({ type: 'img', mimeType: 'image/jpeg' }), 'img');
  assert.equal(mediaKind({ type: 'img', mimeType: 'image/gif' }), 'img');
  assert.equal(mediaKind({ type: 'video', isGif: true, mimeType: 'video/mp4' }), 'gif');
  assert.equal(mediaKind({ type: 'img', isSticker: true, mimeType: 'image/webp' }), undefined);
  assert.equal(mediaKind({ type: 'img', mimeType: 'application/x-lottie+json' }), undefined);
  assert.equal(mediaKind({ type: 'video', mimeType: 'video/mp4' }), 'video');
  assert.equal(mediaKind({ type: 'unknown' }), undefined);
});

test('galleryOf: loaded pictures in list order, keyed by message and attachment index', () => {
  const src = (a: { srcURL?: string }) => (a.srcURL ? `/api/media?url=${a.srcURL}` : undefined);
  const items = galleryOf(
    [
      { id: 'a', timestamp: '1', attachments: [{ type: 'img', srcURL: 'mxc://x/1', size: { width: 10, height: 20 } }, { type: 'unknown', srcURL: 'mxc://x/f' }, { type: 'img', srcURL: 'mxc://x/2' }] },
      { id: 'b', timestamp: '2', text: 'caption', attachments: [{ type: 'video', isGif: true, srcURL: 'mxc://x/3' }] },
      { id: 'c', timestamp: '3', isDeleted: true, attachments: [{ type: 'img', srcURL: 'mxc://x/4' }] },
      { id: 'd', timestamp: '4', attachments: [{ type: 'img' }] },
      { id: 'e', timestamp: '5', text: 'no picture' },
    ],
    src,
  );
  assert.deepEqual(items.map((i) => i.key), ['a:0', 'a:2', 'b:0']);
  assert.equal(items[0]!.width, 10);
  assert.equal(items[2]!.kind, 'gif');
  assert.equal(items[2]!.caption, 'caption');
});

test('galleryOf: videos in the list order, with their poster and length; one list for a whole chat', () => {
  const src = (a: { srcURL?: string }) => (a.srcURL ? `/api/media?url=${a.srcURL}` : undefined);
  const poster = (a: { posterImg?: string }) => (a.posterImg ? `/api/media?url=${a.posterImg}` : undefined);
  const msgs = [
    { id: 'p1', timestamp: '1', attachments: [{ type: 'img', srcURL: 'mxc://x/1' }] },
    { id: 'v1', timestamp: '2', attachments: [{ type: 'video', srcURL: 'mxc://x/v', posterImg: 'mxc://x/vp', duration: 12, mimeType: 'video/mp4', size: { width: 1280, height: 720 } }] },
    { id: 'v2', timestamp: '3', attachments: [{ type: 'video', srcURL: 'mxc://x/w', mimeType: 'video/mp4' }] },
    { id: 'g1', timestamp: '4', attachments: [{ type: 'video', isGif: true, srcURL: 'mxc://x/g' }] },
    { id: 's1', timestamp: '5', attachments: [{ type: 'img', isSticker: true, srcURL: 'mxc://x/s' }] },
  ];
  const items = galleryOf(msgs, src, poster);
  assert.deepEqual(items.map((i) => `${i.key}=${i.kind}`), ['p1:0=img', 'v1:0=video', 'v2:0=video', 'g1:0=gif']);
  assert.equal(items[1]!.poster, '/api/media?url=mxc://x/vp');
  assert.equal(items[1]!.duration, 12);
  assert.equal(items[1]!.width, 1280);
  assert.equal(items[2]!.poster, undefined);
  // Pictures only carry no video fields.
  assert.equal('poster' in items[0]!, false);
  // Without a poster resolver: videos still listed.
  assert.equal(galleryOf(msgs, src).filter((i) => i.kind === 'video').length, 2);
  assert.equal(downloadName({ kind: 'video', mime: 'video/mp4' }), 'video.mp4');
  assert.equal(downloadName({ kind: 'video', mime: 'video/quicktime' }), 'video.mov');
  assert.equal(downloadName({ kind: 'video' }), 'video.mp4');
});

test('downloadName: own name (sanitised) or one built from the type', () => {
  assert.equal(downloadName({ fileName: 'IMG_1.jpg', kind: 'img' }), 'IMG_1.jpg');
  assert.equal(downloadName({ fileName: 'a/b:c.png', kind: 'img' }), 'a_b_c.png');
  assert.equal(downloadName({ mime: 'image/jpeg', kind: 'img' }), 'image.jpg');
  assert.equal(downloadName({ mime: 'image/svg+xml', kind: 'img' }), 'image.svg');
  assert.equal(downloadName({ kind: 'gif' }), 'image.mp4');
});

test('zoom keeps the point under the cursor fixed; pan stays inside the picture', () => {
  const v = zoomAt(IDENTITY, 2, { x: 100, y: 50 });
  // content point under (100, 50) before: (100 - 0) / 1; after: x + 2 * 100 must be 100
  assert.deepEqual(v, { s: 2, x: -100, y: -50 });
  const media = { w: 400, h: 300 };
  const stage = { w: 500, h: 500 };
  // 800 wide in a 500 stage: ±150 of pan; 600 high: ±50.
  assert.deepEqual(clampView({ s: 2, x: -1000, y: 1000 }, media, stage), { s: 2, x: -150, y: 50 });
  // A side that fits stays centred.
  assert.deepEqual(clampView({ s: 1, x: 30, y: -30 }, media, stage), { s: 1, x: 0, y: 0 });
  const z = toggleZoom(IDENTITY, { x: 0, y: 0 }, media, stage);
  assert.equal(z.s, 2.5);
  assert.deepEqual(toggleZoom(z, { x: 10, y: 10 }, media, stage), IDENTITY);
});

test('swipeStep: distance or flick, never past the ends', () => {
  assert.equal(swipeStep(-100, 500, 400, true, true), 1);
  assert.equal(swipeStep(100, 500, 400, true, true), -1);
  assert.equal(swipeStep(-40, 500, 400, true, true), 0);
  assert.equal(swipeStep(-40, 150, 400, true, true), 1);
  assert.equal(swipeStep(-100, 500, 400, true, false), 0);
  assert.equal(swipeStep(100, 500, 400, false, true), 0);
});
