import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumable, coverWidth, durationLabel, groupAlbums, isAlbum, joins, mosaic, tileKind, type AlbumMessage } from '../client/src/albums.js';

const T0 = Date.parse('2026-10-31T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const img = { type: 'img', srcURL: 'mxc://x/1', mimeType: 'image/jpeg', size: { width: 1200, height: 900 } };
const vid = { type: 'video', srcURL: 'mxc://x/v', mimeType: 'video/mp4' };
let n = 0;
const msg = (s: number, extra: Partial<AlbumMessage> = {}): AlbumMessage => ({ id: `m${++n}`, senderID: '@bob', timestamp: at(s), attachments: [img], ...extra });
const ids = (runs: AlbumMessage[][]) => runs.map((r) => r.map((m) => m.id).join('+'));
// Day boundaries in tests: by UTC date (the app uses the local day).
const utcDay = (iso: string) => iso.slice(0, 10);

test('tiles: photos and real videos; not stickers, Lottie, network GIFs, missing sources', () => {
  assert.equal(tileKind(img), 'img');
  assert.equal(tileKind({ ...img, mimeType: 'image/gif' }), 'img');
  assert.equal(tileKind(vid), 'video');
  assert.equal(tileKind({ ...vid, isGif: true }), undefined);
  assert.equal(tileKind({ ...img, isSticker: true }), undefined);
  assert.equal(tileKind({ ...img, mimeType: 'application/x-lottie+json' }), undefined);
  assert.equal(tileKind({ type: 'img' }), undefined);
  assert.equal(tileKind({ type: 'unknown', srcURL: 'mxc://x/f' }), undefined);
});

test('albumable: only tiles, shown normally', () => {
  assert.equal(albumable(msg(0)), true);
  assert.equal(albumable(msg(0, { attachments: [img, vid] })), true);
  assert.equal(albumable(msg(0, { attachments: [img, { type: 'unknown', srcURL: 'mxc://x/f' }] })), false);
  assert.equal(albumable(msg(0, { attachments: [] })), false);
  assert.equal(albumable(msg(0, { attachments: undefined, text: 'hi' })), false);
  assert.equal(albumable(msg(0, { isDeleted: true })), false);
  assert.equal(albumable(msg(0, { type: 'NOTICE' })), false);
  assert.equal(albumable(msg(0, { sendStatus: { status: 'PENDING' } })), false);
  assert.equal(albumable(msg(0, { sendStatus: { status: 'FAILED_NETWORK' } })), false);
  assert.equal(albumable({ ...msg(0), id: '~local' }), false);
});

test('joins: same sender, same day, within 60 s, no caption or reply on the joining item', () => {
  const a = msg(0);
  assert.equal(joins(a, msg(10)), true);
  assert.equal(joins(a, msg(60)), true);
  assert.equal(joins(a, msg(61)), false);
  assert.equal(joins(a, msg(-5)), false); // out of order
  assert.equal(joins(a, msg(5, { senderID: '@ann' })), false);
  assert.equal(joins({ ...a, isSender: true, senderID: '@me-wa' }, msg(5, { isSender: true, senderID: '@me-sig' })), true); // our own, any of our IDs
  assert.equal(joins(a, msg(5, { isSender: true })), false);
  assert.equal(joins(a, msg(5, { text: 'caption' })), false); // a caption starts an album
  assert.equal(joins(msg(0, { text: 'caption' }), msg(5)), true); // the first item may carry it
  assert.equal(joins(a, msg(5, { text: '   ' })), true);
  assert.equal(joins(a, msg(5, { linkedMessageID: 'q' })), false); // a reply starts an album
  assert.equal(joins(msg(0, { linkedMessageID: 'q' }), msg(5)), true);
  assert.equal(joins(a, msg(5, { reactions: [{}] } as Partial<AlbumMessage>)), true); // reactions stay on their tile
  const b = msg(5);
  assert.equal(joins(a, b, b.id), false); // unread divider
  assert.equal(joins(a, msg(5, { attachments: [{ type: 'audio', srcURL: 'mxc://x/a' }] })), false);
  // Midnight: 30 s apart, different days.
  const late = { ...msg(0), timestamp: '2026-10-31T23:59:50Z' };
  const early = { ...msg(0), timestamp: '2026-11-01T00:00:20Z' };
  assert.equal(joins(late, early, undefined, utcDay), false);
});

test('groupAlbums: runs, multi-attachment messages, other messages in between', () => {
  n = 0;
  const list = [
    msg(0), // m1
    msg(5), // m2
    msg(9), // m3
    msg(12, { attachments: undefined, text: 'hello' }), // m4 text between
    msg(14), // m5 alone
    msg(100, { attachments: [img, vid, img] }), // m6 one message, three tiles
    msg(105), // m7 joins m6
    msg(300, { text: 'cap' }), // m8 caption on the first
    msg(301), // m9
    msg(302, { text: 'second caption' }), // m10 starts again
  ];
  const runs = groupAlbums(list);
  assert.deepEqual(ids(runs), ['m1+m2+m3', 'm4', 'm5', 'm6+m7', 'm8+m9', 'm10']);
  assert.deepEqual(runs.map(isAlbum), [true, false, false, true, true, false]);
  assert.equal(isAlbum([msg(0, { attachments: [img, img] })]), true);
  assert.equal(isAlbum([msg(0, { attachments: [img, { type: 'unknown', srcURL: 'mxc://x/f' }] })]), false);
  assert.deepEqual(groupAlbums([]), []);
});

test('groupAlbums is stable: older pages and new messages only change the boundary they touch', () => {
  n = 0;
  const all = Array.from({ length: 12 }, (_, i) => (i === 6 ? msg(i * 20, { attachments: undefined, text: 'x' }) : msg(i * 20)));
  // 0..5 joined (20 s apart), 6 text, 7..11 joined.
  const full = ids(groupAlbums(all));
  assert.deepEqual(full, ['m1+m2+m3+m4+m5+m6', 'm7', 'm8+m9+m10+m11+m12']);
  for (let cut = 0; cut < all.length; cut++) {
    // Only the newest messages loaded (older pages prepended later): every run is the tail of the full one.
    const part = ids(groupAlbums(all.slice(cut)));
    const fullRuns = groupAlbums(all);
    const tail = fullRuns
      .map((r) => r.filter((m) => all.indexOf(m) >= cut))
      .filter((r) => r.length)
      .map((r) => r.map((m) => m.id).join('+'));
    assert.deepEqual(part, tail, `from ${cut}`);
    // Newest messages not arrived yet: every run is the head of the full one.
    const head = ids(groupAlbums(all.slice(0, cut + 1)));
    const heads = fullRuns
      .map((r) => r.filter((m) => all.indexOf(m) <= cut))
      .filter((r) => r.length)
      .map((r) => r.map((m) => m.id).join('+'));
    assert.deepEqual(head, heads, `to ${cut}`);
  }
});

test('mosaic: 2 side by side (stacked if both wide), 3 = one large + two, 4+ = 2×2 with +N', () => {
  const two = mosaic(2, [0.75, 1]);
  assert.equal(two.cols, '1fr 1fr');
  assert.equal(two.tiles.length, 2);
  assert.equal(two.ratio, 280 / 200);
  assert.deepEqual(two.tiles.map((t) => [t.col, t.row]), [['1', '1'], ['2', '1']]);
  const wide = mosaic(2, [16 / 9, 4 / 3]);
  assert.equal(wide.rows, '1fr 1fr');
  assert.deepEqual(wide.tiles.map((t) => [t.col, t.row]), [['1', '1'], ['1', '2']]);
  assert.ok(wide.ratio < 1);
  // One wide, one tall: side by side.
  assert.equal(mosaic(2, [16 / 9, 0.6]).cols, '1fr 1fr');
  const three = mosaic(3, [0.75]);
  assert.deepEqual(three.tiles.map((t) => [t.col, t.row]), [['1', '1 / 3'], ['2', '1'], ['2', '2']]);
  assert.ok(three.tiles[0]!.w > three.tiles[1]!.w && three.tiles[0]!.h > three.tiles[1]!.h);
  const threeWide = mosaic(3, [1.6]);
  assert.deepEqual(threeWide.tiles.map((t) => [t.col, t.row]), [['1 / 3', '1'], ['1', '2'], ['2', '2']]);
  assert.equal(threeWide.tiles[0]!.w, 280);
  // Unknown sizes: the default (large on the left).
  assert.equal(mosaic(3, []).tiles[0]!.row, '1 / 3');
  for (const k of [4, 5, 9]) {
    const m = mosaic(k);
    assert.equal(m.tiles.length, 4);
    assert.equal(m.ratio, 1);
    assert.equal(m.more, k - 4);
    assert.deepEqual(m.tiles.map((t) => [t.col, t.row]), [['1', '1'], ['2', '1'], ['1', '2'], ['2', '2']]);
    assert.equal(m.tiles[0]!.w, 139);
  }
  assert.equal(mosaic(4).more, 0);
  // Every tile fits in the box (2 px gaps), whatever the count.
  for (const k of [2, 3, 4, 7]) {
    for (const r of [[0.75, 0.75], [1.8, 1.8], [1.8]]) {
      const m = mosaic(k, r);
      const h = 280 / m.ratio;
      for (const t of m.tiles) assert.ok(t.w <= 280 && t.h <= h + 0.01, `${k} ${r}: ${t.w}×${t.h} in 280×${h}`);
    }
  }
});

test('coverWidth: the thumbnail width that covers a tile', () => {
  assert.equal(coverWidth({ w: 139, h: 139 }, 4 / 3), 186); // wide picture in a square: wider than the tile
  assert.equal(coverWidth({ w: 139, h: 139 }, 0.75), 139); // tall picture: the tile's width
  assert.equal(coverWidth({ w: 280, h: 160 }, 1), 280);
  assert.equal(coverWidth({ w: 110, h: 119 }, undefined), 119);
});

test('durationLabel', () => {
  assert.equal(durationLabel(0), '0:00');
  assert.equal(durationLabel(5.4), '0:05');
  assert.equal(durationLabel(65), '1:05');
  assert.equal(durationLabel(3723), '1:02:03');
  assert.equal(durationLabel(undefined), undefined);
  assert.equal(durationLabel(Infinity), undefined);
  assert.equal(durationLabel(NaN), undefined);
});
