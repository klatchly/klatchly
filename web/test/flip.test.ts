import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissDecision, fitRect, flipClip, flipFrom, flipTransform, onScreen, pull, velocity } from '../client/src/flip.js';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('fitRect: centred, inside the padding, never enlarged', () => {
  assert.deepEqual(fitRect({ w: 400, h: 800 }, { w: 1600, h: 1000 }), { x: 8, y: 280, w: 384, h: 240 });
  const tall = fitRect({ w: 400, h: 800 }, { w: 900, h: 1800 });
  close(tall.w, 384);
  close(tall.h, 768);
  close(tall.x, 8);
  close(tall.y, 16);
  const tallScreen = fitRect({ w: 1200, h: 800 }, { w: 900, h: 1800 });
  close(tallScreen.h, 784);
  close(tallScreen.y, 8);
  // Small pictures keep their size.
  assert.deepEqual(fitRect({ w: 400, h: 800 }, { w: 160, h: 120 }), { x: 120, y: 340, w: 160, h: 120 });
  // Unknown size: an empty rect at the centre.
  assert.deepEqual(fitRect({ w: 400, h: 800 }, { w: 0, h: 0 }), { x: 200, y: 400, w: 0, h: 0 });
});

test('flipFrom: an uncropped thumbnail maps onto the full view by translate + uniform scale, no clip', () => {
  const full = { x: 8, y: 280, w: 384, h: 240 }; // 1.6 : 1
  const thumb = { x: 100, y: 600, w: 200, h: 125 }; // same ratio
  const f = flipFrom(thumb, full, 12);
  close(f.s, 200 / 384);
  close(f.x, 200 - 200);
  close(f.y, 662.5 - 400);
  assert.deepEqual(f.clip, { t: 0, r: 0, b: 0, l: 0 });
  close(f.radius, 12 / f.s);
  // Applying it to the full rect gives the thumbnail rect (transform-origin: centre).
  const cx = full.x + full.w / 2 + f.x;
  const cy = full.y + full.h / 2 + f.y;
  close(cx - (full.w * f.s) / 2, thumb.x);
  close(cy - (full.h * f.s) / 2, thumb.y);
});

test('flipFrom: a square tile of a wide picture covers it and clips the sides', () => {
  const full = { x: 0, y: 200, w: 400, h: 300 }; // 4 : 3
  const tile = { x: 50, y: 50, w: 139, h: 139 };
  const f = flipFrom(tile, full);
  // Cover: the height decides.
  close(f.s, 139 / 300);
  // Visible part in the full view's own px: 300 × 300 in the middle.
  close(f.clip.l, 50);
  close(f.clip.r, 50);
  close(f.clip.t, 0);
  close(f.clip.b, 0);
  // Once scaled, the visible part is the tile.
  close((full.w - f.clip.l - f.clip.r) * f.s, tile.w);
  close((full.h - f.clip.t - f.clip.b) * f.s, tile.h);
  assert.equal(flipTransform(f), `translate(${Math.round(f.x * 1000) / 1000}px, ${Math.round(f.y * 1000) / 1000}px) scale(0.463)`);
  assert.match(flipClip(f), /^inset\(0px 50px 0px 50px round 0px\)$/);
  // Tall picture in a wide tile: top and bottom clipped.
  const g = flipFrom({ x: 0, y: 0, w: 280, h: 160 }, { x: 0, y: 0, w: 300, h: 600 });
  close(g.s, 280 / 300);
  assert.ok(g.clip.t > 0 && g.clip.l < 1e-9);
  close((600 - 2 * g.clip.t) * g.s, 160);
  // Degenerate rects: identity.
  assert.deepEqual(flipFrom({ x: 0, y: 0, w: 0, h: 0 }, full), { x: 0, y: 0, s: 1, clip: { t: 0, r: 0, b: 0, l: 0 }, radius: 0 });
});

test('onScreen: enough of the thumbnail visible to fly back to', () => {
  const view = { x: 0, y: 60, w: 390, h: 700 };
  assert.equal(onScreen({ x: 10, y: 100, w: 200, h: 200 }, view), true);
  assert.equal(onScreen({ x: 10, y: -300, w: 200, h: 200 }, view), false); // scrolled away
  assert.equal(onScreen({ x: 10, y: 0, w: 200, h: 100 }, view), true); // 40 % under the header
  assert.equal(onScreen({ x: 10, y: 0, w: 200, h: 200 }, view, 0.8), false);
  assert.equal(onScreen({ x: 0, y: 0, w: 0, h: 0 }, view), false);
});

test('pull: follows the finger, shrinks going down, backdrop clears in proportion', () => {
  assert.deepEqual(pull(0, 0, 800), { x: 0, y: 0, s: 1, fade: 1 });
  const p = pull(30, 200, 800);
  assert.equal(p.x, 30);
  assert.equal(p.y, 200);
  close(p.s, 1 - 0.35 * 0.25);
  close(p.fade, 1 - 200 / 360);
  assert.equal(pull(0, 800, 800).s, 0.65);
  assert.equal(pull(0, 2000, 800).s, 0.65);
  assert.equal(pull(0, 400, 800).fade, 0);
  // Up: resisted, no shrinking.
  const up = pull(0, -90, 800);
  assert.equal(up.y, -30);
  assert.equal(up.s, 1);
});

test('dismissDecision: far enough or a flick down; a flick back up cancels', () => {
  assert.equal(dismissDecision(150, 0, 800), true);
  assert.equal(dismissDecision(60, 0.1, 800), false);
  assert.equal(dismissDecision(60, 0.8, 800), true); // flick
  assert.equal(dismissDecision(20, 2, 800), false); // too short even if fast
  assert.equal(dismissDecision(300, -0.5, 800), false); // thrown back up
  assert.equal(dismissDecision(-150, 0, 800), false);
  // Small screens: 15 % of the height.
  assert.equal(dismissDecision(80, 0, 500), true);
});

test('velocity: over the last 100 ms', () => {
  assert.equal(velocity([]), 0);
  assert.equal(velocity([{ t: 0, v: 0 }]), 0);
  close(velocity([{ t: 0, v: 0 }, { t: 50, v: 10 }, { t: 100, v: 60 }]), 0.6);
  // Old samples ignored: a slow drag ending in a flick reads as the flick.
  close(velocity([{ t: 0, v: 0 }, { t: 500, v: 20 }, { t: 560, v: 80 }, { t: 600, v: 140 }]), 120 / 100);
  // A stop before release: slow.
  close(velocity([{ t: 0, v: 0 }, { t: 100, v: 100 }, { t: 400, v: 101 }]), 0);
});
