// Per-frame recording of a message list while it scrolls (scrollup.e2e.js, ext/zalo/test/scrollzalo.e2e.cjs): where
// the messages on screen are at each painted frame, the scroll position and height, the input since the last frame,
// the scroll calls (Virtuoso's corrections and the app's), the rows that changed height (and what they hold) and the
// pages fetched; then whether the messages moved by what the reader scrolled and nothing else.
const { writeFileSync } = require('fs');
const { SHOTS } = require('./lib');

/** Starts recording every painted frame in the page (window.__rec). */
const startRecording = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid=messages] [data-virtuoso-scroller]');
    const rec = { frames: [], calls: [], fetches: [], resizes: [], inputs: [], roNotices: 0, broken: {}, stop: false };
    window.__rec = rec;
    const t0 = performance.now();
    const now = () => Math.round(performance.now() - t0);
    // Scroll calls on the scroller: Virtuoso's corrections and the app's own.
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(sc, 'scrollTop', {
      configurable: true,
      get: () => desc.get.call(sc),
      set: (v) => {
        rec.calls.push({ t: now(), kind: 'scrollTop=', from: Math.round(desc.get.call(sc)), to: Math.round(v) });
        desc.set.call(sc, v);
      },
    });
    for (const k of ['scrollTo', 'scrollBy']) {
      const orig = sc[k].bind(sc);
      sc[k] = (...a) => {
        rec.calls.push({ t: now(), kind: k, arg: JSON.stringify(a[0]).slice(0, 60), from: Math.round(desc.get.call(sc)) });
        return orig(...a);
      };
    }
    window.addEventListener('error', (e) => /ResizeObserver loop/.test(e.message) && rec.roNotices++);
    for (const type of ['wheel', 'touchmove']) window.addEventListener(type, () => rec.inputs.push(now()), { capture: true, passive: true });
    const of = window.fetch;
    window.fetch = (...a) => {
      const u = String(a[0]?.url ?? a[0]);
      if (u.includes('/messages')) rec.fetches.push({ t: now(), url: u.replace(/^.*\/api\//, '').slice(0, 80) });
      return of(...a);
    };
    // Rows that change height once drawn: which, by how much, where (above the screen: < 0), and what they hold.
    const heights = new WeakMap();
    const ro = new ResizeObserver((es) => {
      for (const e of es) {
        const el = e.target;
        const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
        const was = heights.get(el);
        heights.set(el, h);
        if (was === undefined || was === h || !h) continue;
        const kinds = [...el.querySelectorAll('.link-slot, .link-card, .att-img, .reactions, .att-audio-wrap, img')].map((x) => x.className.split(' ')[0] || x.tagName).join(',');
        rec.resizes.push({ t: now(), mid: el.querySelector('[data-mid]')?.dataset.mid, from: was, to: h, y: Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top), kinds: kinds.slice(0, 80) });
      }
    });
    const watch = () => sc.querySelectorAll('[data-item-index]').forEach((n) => (heights.has(n) ? 0 : (heights.set(n, undefined), ro.observe(n))));
    new MutationObserver(watch).observe(sc, { childList: true, subtree: true });
    watch();
    // Sampled as each frame is painted: in a resize observer of a probe resized every frame, made after the list's
    // own (observers are called in the order they were made, after layout, before paint): what the list fixes in its
    // observer is in, a render that a task makes after the frame (not painted yet) is not.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;height:1px;width:1px;pointer-events:none;opacity:0';
    document.body.append(probe);
    let w = 1;
    const tick = () => {
      const top = sc.getBoundingClientRect().top;
      const h = sc.clientHeight;
      const rows = {};
      for (const n of sc.querySelectorAll('[data-mid]')) {
        const r = n.getBoundingClientRect();
        if (r.bottom > top && r.top < top + h) rows[n.dataset.mid] = Math.round((r.top - top) * 10) / 10;
        if (r.bottom > top && r.top < top + h && n.querySelector('[data-testid=media-error]')) rec.broken[n.dataset.mid] = 1;
      }
      rec.frames.push({ t: now(), st: Math.round(sc.scrollTop * 10) / 10, sh: sc.scrollHeight, rows, mt: sc.querySelector('[data-testid=virtuoso-item-list]')?.style.marginTop });
    };
    new ResizeObserver(() => rec.stop || tick()).observe(probe);
    const frame = () => requestAnimationFrame(() => ((probe.style.width = `${(w = 3 - w)}px`), rec.stop || frame()));
    frame();
  });

const stopRecording = (page) =>
  page.evaluate(() => {
    const rec = window.__rec;
    rec.stop = true;
    const { frames, calls, fetches, resizes, inputs, roNotices } = rec;
    // Pictures that failed (expired links) seen on screen.
    return { frames, calls, fetches, resizes, inputs, roNotices, broken: Object.keys(rec.broken).length };
  });

/**
 * The frames' movement of the messages on screen: for each pair of frames, the median move of the rows on screen in
 * both. Scrolling up, the messages go down by what the input scrolled (`step` px per wheel notch or finger move since
 * the last frame) and by nothing else: a move up of more than `tol` px is a back-move, a move down beyond the input a
 * jump (other messages on screen, none in common with the frame before: a jump of 9999), and a jump and a back-move
 * within 4 frames an oscillation.
 */
function analyse({ frames, inputs }, step, tol = 3) {
  const moves = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].rows;
    const b = frames[i].rows;
    const d = Object.keys(b)
      .filter((k) => k in a)
      .map((k) => b[k] - a[k])
      .sort((x, y) => x - y);
    const n = inputs.filter((t) => t > frames[i - 1].t - 20 && t <= frames[i].t).length;
    // Rows on screen in both frames and none in common, the content changed or the scroll position barely: the list
    // jumped to other messages (a teleport), or drew none for a frame (blank). A scroll of more than a screen in a
    // frame (fast finger moves delivered in a burst) is not one.
    const dst = frames[i].st - frames[i - 1].st;
    const dsh = frames[i].sh - frames[i - 1].sh;
    if (!d.length && Object.keys(a).length && Object.keys(b).length && (Math.abs(dsh) > tol || Math.abs(dst) < 100)) d.push(9999);
    if (!d.length) continue;
    moves.push({ i, t: frames[i].t, d: Math.round(d[Math.floor(d.length / 2)] * 10) / 10, allowed: step * Math.max(1, n), dst: Math.round((frames[i].st - frames[i - 1].st) * 10) / 10, dsh: frames[i].sh - frames[i - 1].sh });
  }
  // A move past the input that is the scroll itself (the rows moved by what the scroll position did, the content
  // unchanged): input events delivered late in a burst (a busy frame), not the list moving the messages.
  const bad = moves.filter((m) => m.d < -tol || (m.d > m.allowed + tol && !(Math.abs(m.d + m.dst) <= tol && Math.abs(m.dsh) <= tol)));
  const back = bad.filter((m) => m.d < 0);
  let osc = 0;
  for (let j = 0; j < bad.length - 1; j++) if (bad[j + 1].i - bad[j].i <= 4 && Math.sign(bad[j + 1].d) !== Math.sign(bad[j].d)) osc++;
  const seen = new Set();
  for (const f of frames) for (const k of Object.keys(f.rows)) seen.add(k);
  const worst = bad.reduce((w, m) => Math.max(w, m.d < 0 ? -m.d : m.d - m.allowed), 0);
  return { frames: frames.length, rowsSeen: seen.size, jumps: bad.length - back.length, back: back.length, osc, worst: Math.round(worst), bad };
}

/** The busy chat opened from its URL, its list placed and still. */
async function openList(page, url) {
  await page.goto(url);
  await page.waitForSelector('[data-testid=messages] [data-virtuoso-scroller] [data-mid]', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.list-placing') || getComputedStyle(document.querySelector('.list-placing')).display === 'none', null, { timeout: 10000 });
  await page.waitForTimeout(1500);
}

/** Logs the summary; on a bad frame, what happened around the first ones, and the whole record in $SHOTS. */
function report(label, rec, a, prefix = 'scrollup') {
  console.log(`     ${label}: ${JSON.stringify({ frames: a.frames, rowsSeen: a.rowsSeen, back: a.back, jumps: a.jumps, osc: a.osc, worst: a.worst, fetches: rec.fetches.length, scrollCalls: rec.calls.length, rowResizes: rec.resizes.length, resizeObserverNotices: rec.roNotices, brokenPictures: rec.broken })}`);
  if (!a.bad.length) return;
  for (const m of a.bad.slice(0, 6)) {
    console.log(`       ${m.d < 0 ? 'back-move' : 'jump'} ${JSON.stringify(m)}`);
    const near = (x) => x.t > m.t - 60 && x.t <= m.t;
    for (const c of rec.calls.filter(near)) console.log(`         call ${JSON.stringify(c)}`);
    for (const r of rec.resizes.filter(near)) console.log(`         row resized ${JSON.stringify(r)}`);
  }
  const file = `${SHOTS}/${prefix}-${label.replace(/\W+/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(rec));
  console.log(`       record: ${file}`);
}

/** A phone context (390 × 844, iOS user agent, touch, the home-screen app) signed in as `ctx`, GET requests only. */
async function phoneContext(browser, ctx) {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, userAgent: UA, isMobile: true, hasTouch: true, locale: 'en-US', storageState: await ctx.storageState() });
  await phone.route('**/api/**', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
  await phone.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  return phone;
}

module.exports = { startRecording, stopRecording, analyse, report, openList, phoneContext };
