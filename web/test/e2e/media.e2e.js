// Media and file actions (0.14.18): message menu (open / save / copy image), lightbox save path, file bubbles,
// in-app file viewer (PDF drawn by pdf.js, Back returns), no broken-image icon, layout shift of a chat opening,
// another connector's chats (a package's). Thumbnails (0.14.19): bubbles on /api/thumb (originals in the viewer and for saving),
// placeholder frames, loading cost on an iPhone viewport, the worker's thumbnail cache and its sign-out purge.
// Albums, videos, viewer animation (0.14.20): album mosaics (grid, +N, tile → viewer index, long-press / right-click
// on a tile acts on that item, grouping unchanged by older pages, CLS), video posters → viewer (native controls, no
// zoom), open / close animation (transforms, end state, reduced motion), drag down, toolbar toggle, reply thumbnails.
// READ-ONLY on real chats: every test context aborts every non-GET /api request (mark-read
// included); Save / Share / Copy are never run for real: navigator.share, the clipboard and download clicks are
// stubbed in the page and only checked (files only, real name and type).
// Chats come from env (IDs only) or are found among the first chats of the list:
//   MEDIA_CHAT  a chat with pictures      FILE_CHAT  a chat with a PDF      OTHER_CHAT  another connector's chat with photos
//   (a package's connector: chat ids not from the Desktop API, which are Matrix room ids '!…'; its own checks, its
//   media relay for one, are in its scripts, ext/<id>/test/)
//   ALBUM_CHAT  a chat with an album      VIDEO_CHAT  a chat with a video   REPLY_CHAT  a reply to a photo
// sh web/test/e2e/run-offline.sh media.e2e.js
const { readFileSync } = require('fs');
const { join } = require('path');
const { BASE, check, open, enroll, logout, settingsPage, shot, done } = require('./lib');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const enc = encodeURIComponent;
const chatURL = (id) => `${BASE}/chat/${enc(id)}`;
const short = (id) => (id ? `${id.slice(0, 8)}…` : '-');

// Stubs: what Save / Share / Copy would have done, recorded instead.
function stubs() {
  window.__share = [];
  window.__clip = [];
  window.__dl = [];
  Object.defineProperty(navigator, 'canShare', { value: (d) => !!d && Array.isArray(d.files) && d.files.length > 0, configurable: true });
  Object.defineProperty(navigator, 'share', {
    value: (d) => {
      window.__share.push({ keys: Object.keys(d), files: (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) });
      return Promise.resolve();
    },
    configurable: true,
  });
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async () => {},
      write: async (items) => {
        for (const it of items) {
          const b = await it.getType('image/png');
          window.__clip.push({ types: [...it.types], type: b.type, size: b.size });
        }
      },
    },
    configurable: true,
  });
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download')) return void window.__dl.push({ href: this.getAttribute('href'), download: this.download });
    return click.call(this);
  };
  // The page's Cache Storage deletions (sign-out empties the worker's thumbnail cache).
  window.__cacheDeletes = [];
  try {
    const del = CacheStorage.prototype.delete;
    CacheStorage.prototype.delete = function (name) {
      const p = del.call(this, name);
      p.then((ok) => window.__cacheDeletes.push({ name, ok }), () => {});
      return p;
    };
  } catch {}
  // Layout shifts of the whole page life (CLS of a chat opening).
  window.__cls = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        // What moved (for the log when a CLS check fails): the node and its box before / after.
        const box = (r) => [r.x, r.y, r.width, r.height].map(Math.round).join(',');
        const name = (n) => (n instanceof Element ? `${n.tagName.toLowerCase()}${n.dataset.testid ? `[${n.dataset.testid}]` : ''}.${[...n.classList].slice(0, 2).join('.')}` : n?.nodeName || '?');
        window.__cls.push({ t: Math.round(e.startTime), v: e.value, src: (e.sources || []).slice(0, 3).map((s) => `${name(s.node)} ${box(s.previousRect)}→${box(s.currentRect)}`) });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  // When the message list was first shown (Conversation hides it while Virtuoso places its rows), for the log.
  window.__listShown = 0;
  const seen = () => {
    const l = document.querySelector('.conversation .message-list');
    if (!window.__listShown && l && getComputedStyle(l).visibility === 'visible') window.__listShown = Math.round(performance.now());
    if (!window.__listShown) requestAnimationFrame(seen);
  };
  requestAnimationFrame(seen);
  // First picture of a bubble decoded (ms since navigation).
  window.__firstImg = 0;
  document.addEventListener('load', (e) => {
    const t = e.target;
    if (!window.__firstImg && t instanceof HTMLImageElement && t.closest('.att-img:not(.sticker)') && t.naturalWidth) window.__firstImg = performance.now();
  }, true);
}

async function strictContext(s, phone, dpr, noWorker) {
  const ctx = await s.browser.newContext({
    // Without the worker, page.route() sees every request (thumbnails pass through the worker otherwise).
    ...(noWorker ? { serviceWorkers: 'block' } : {}),
    ...(phone ? { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, userAgent: UA, isMobile: true, hasTouch: true } : { viewport: { width: 1200, height: 800 } }),
    ...(dpr ? { deviceScaleFactor: dpr } : {}),
    locale: phone ? 'fr-FR' : 'en-US',
    storageState: await s.ctx.storageState(),
  });
  const blocked = [];
  await ctx.route('**/api/**', (r) => {
    if (r.request().method() === 'GET') return r.continue();
    blocked.push(`${r.request().method()} ${new URL(r.request().url()).pathname.replace(/\/chats\/([^/]{0,6})[^/]*/, '/chats/$1…').slice(0, 60)}`);
    return r.abort();
  });
  await ctx.addInitScript(stubs);
  if (phone) await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await ctx.addInitScript((lang) => localStorage.setItem('lang', lang), phone ? 'fr' : 'en');
  const page = await ctx.newPage();
  const csp = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.log(`Refused to (CSP) ${e.violatedDirective} ${e.blockedURI}`));
  });
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp, blocked, csp };
}

const touch = (cdp, type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
async function longPress(page, cdp, x, y, ms = 700) {
  await touch(cdp, 'touchStart', [[x, y]]);
  await page.waitForTimeout(ms);
  await touch(cdp, 'touchEnd', []);
}
async function tap(page, cdp, x, y) {
  await touch(cdp, 'touchStart', [[x, y]]);
  await page.waitForTimeout(40);
  await touch(cdp, 'touchEnd', []);
}
const poll = async (page, fn, arg, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) return v;
    await page.waitForTimeout(150);
  }
};
/** Where to touch `loc`: scrolled into view, once its box stays put (a scroll may still be settling). */
const center = async (loc) => {
  await loc.scrollIntoViewIfNeeded();
  let b = await loc.boundingBox();
  for (let i = 0; i < 20; i++) {
    await loc.page().waitForTimeout(60);
    const n = await loc.boundingBox();
    if (b && n && n.x === b.x && n.y === b.y && n.height === b.height) break;
    b = n;
  }
  return b && [b.x + b.width / 2, b.y + Math.min(b.height / 2, 60)];
};

/** Chats whose first page holds pictures / a PDF / another connector's photos (GET only), unless given in env. */
async function discover(page) {
  return page.evaluate(async (want) => {
    const get = (p) => fetch(`/api${p}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const list = (await get('/chats')) ?? { items: [] };
    const out = { media: want.media, file: want.file, other: want.other, heavy: want.media, album: want.album, albumN: 0, video: want.video, reply: want.reply, replyMsg: '' };
    let most = 0;
    let mostO = 0;
    // Same rules as client/src/albums.ts (joins), on the first page.
    const tile = (a) => !!a.srcURL && !a.isSticker && ((a.type === 'img' && !/lottie/i.test(a.mimeType || '')) || (a.type === 'video' && !a.isGif));
    const albumable = (m) => !m.isDeleted && m.type !== 'NOTICE' && (m.attachments || []).length > 0 && m.attachments.every(tile);
    const day = (t) => new Date(t).toDateString();
    const joins = (a, b) => albumable(a) && albumable(b) && (a.isSender ? 'me' : a.senderID) === (b.isSender ? 'me' : b.senderID) && !(b.text || '').trim() && !b.linkedMessageID && Date.parse(b.timestamp) - Date.parse(a.timestamp) >= 0 && Date.parse(b.timestamp) - Date.parse(a.timestamp) <= 60000 && day(a.timestamp) === day(b.timestamp);
    for (const c of list.items.slice(0, 60)) {
      const page = await get(`/chats/${encodeURIComponent(c.id)}/messages`);
      const atts = (page?.items ?? []).flatMap((m) => (m.isDeleted ? [] : (m.attachments ?? [])));
      const imgs = atts.filter((a) => a.type === 'img' && !a.isSticker).length;
      const pdf = atts.some((a) => a.type === 'unknown' && (/\.pdf$/i.test(a.fileName ?? '') || a.mimeType === 'application/pdf'));
      const other = !c.id.startsWith('!');
      if (other && !want.other && imgs > mostO) [mostO, out.other] = [imgs, c.id];
      if (!other && !out.media && imgs >= 2) out.media = c.id;
      // The chat with the most pictures in its first page: loading-cost measures.
      if (!other && !want.media && imgs > most) [most, out.heavy] = [imgs, c.id];
      if (!out.file && pdf) out.file = c.id;
      const items = (page?.items ?? []).filter((m) => m.type !== 'REACTION' && !m.isHidden).slice().reverse();
      let run = [];
      let best = 0;
      for (const m of items) {
        if (run.length && joins(run[run.length - 1], m)) run.push(m);
        else run = albumable(m) ? [m] : [];
        const tiles = run.reduce((n, x) => n + x.attachments.length, 0);
        if (tiles >= 2) best = Math.max(best, tiles);
      }
      if (!want.album && best > out.albumN && !other) [out.albumN, out.album] = [best, c.id];
      if (!out.video && !other && atts.some((a) => a.type === 'video' && !a.isGif && a.srcURL)) out.video = c.id;
      const byID = new Map(items.map((m) => [m.id, m]));
      const rep = items.find((m) => m.linkedMessageID && !m.isDeleted && (byID.get(m.linkedMessageID)?.attachments ?? []).some((a) => a.type === 'img' && !a.isSticker));
      if (!out.reply && !other && rep) [out.reply, out.replyMsg] = [c.id, rep.id];
    }
    return out;
  }, { media: process.env.MEDIA_CHAT || '', file: process.env.FILE_CHAT || '', other: process.env.OTHER_CHAT || '', album: process.env.ALBUM_CHAT || '', video: process.env.VIDEO_CHAT || '', reply: process.env.REPLY_CHAT || '' });
}

/** Pictures that failed to load and still show the browser's broken image (instead of our tile). */
const brokenImgs = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.messages img')].filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute('src')).length);

// Waits on a condition, checked in the page on every frame (each in its own page.evaluate: page.waitForFunction
// compiles its predicate with eval, which the app's CSP refuses and reports). They resolve true once it is met,
// false after their time limit (the checks that follow then fail on the state itself).

/**
 * Until the conversation is still: every picture on screen loaded (or failed), the list's height and scroll and the
 * pictures' places unchanged for `quiet` ms. Instead of fixed sleeps: as short as the page allows, as long as a
 * loaded machine needs (thumbnails are made by the server on demand), at most `ms`.
 */
const settle = (page, { quiet = 400, ms = 15000 } = {}) =>
  page
    .evaluate(
      ([quiet, ms]) =>
        new Promise((done) => {
          const end = performance.now() + ms;
          let last = { sig: '', at: 0 };
          const shown = (el) => {
            const r = el.getBoundingClientRect();
            return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && r.width > 0;
          };
          const tick = () => {
            const now = performance.now();
            if (now > end) return done(false);
            const sc = document.querySelector('.conversation [data-virtuoso-scroller]');
            const imgs = [...document.querySelectorAll('.conversation img')].filter(shown);
            const ready = imgs.every((i) => i.complete) && document.fonts.status === 'loaded';
            const sig = ready ? [sc?.scrollHeight, sc?.scrollTop, document.querySelectorAll('[data-testid=msg]').length, ...imgs.map((i) => Math.round(i.getBoundingClientRect().top))].join() : '';
            if (!sig || sig !== last.sig) last = { sig, at: now };
            else if (now - last.at >= quiet) return done(true);
            requestAnimationFrame(tick);
          };
          tick();
        }),
      [quiet, ms],
    )
    .catch(() => false);

async function openChat(page, id) {
  await page.goto(chatURL(id));
  await page.waitForSelector('[data-testid=msg]', { timeout: 30000 });
  await settle(page);
}

/** The layout shifts behind a CLS figure, for the log when a CLS check fails. */
async function clsDetail(page, label) {
  const [es, shown] = await page.evaluate(() => [(window.__cls || []).filter((e) => e.v >= 0.005), window.__listShown]);
  console.log(`     ${label}: message list shown at ${shown} ms`);
  for (const e of es) console.log(`     ${label} shift at ${e.t} ms: ${e.v.toFixed(3)} ${e.src.join(' | ')}`);
}
/** Until the last `sel`'s box stays put for three frames (after a scroll), or 3 s. */
const still = (page, sel) =>
  page
    .evaluate(
      (sel) =>
        new Promise((done) => {
          const end = performance.now() + 3000;
          let k0 = '';
          let n = 0;
          const tick = () => {
            const r = [...document.querySelectorAll(sel)].pop()?.getBoundingClientRect();
            const k = r ? [r.left, r.top, r.width, r.height].map(Math.round).join() : '';
            n = k && k === k0 ? n + 1 : 0;
            k0 = k;
            if (n >= 3 || performance.now() > end) return done(n >= 3);
            requestAnimationFrame(tick);
          };
          tick();
        }),
      sel,
    )
    .catch(() => false);
/**
 * Until the viewer's open animation is over (no data-anim left) and nothing in it still moves (the frame may still
 * ease to the original's size: a CSS transition), or 5 s.
 */
const opened = (page) =>
  page
    .evaluate(
      () =>
        new Promise((done) => {
          const end = performance.now() + 5000;
          const tick = () => {
            const d = document.querySelector('[data-testid=lightbox]');
            const ok = !!d && !d.dataset.anim && d.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity);
            if (ok || performance.now() > end) return done(ok);
            requestAnimationFrame(tick);
          };
          tick();
        }),
    )
    .catch(() => false);

/** The list is virtualised: scroll up until a row matching `sel` is rendered (the first page holds it). */
async function scrollTo(page, sel) {
  for (let i = 0; i < 30 && !(await page.locator(sel).count()); i++) {
    await page.evaluate(() => {
      const el = document.querySelector('.conversation [data-virtuoso-scroller]');
      // A wheel event first: the list stays pinned to the bottom unless the user scrolled.
      el?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -500 }));
      el?.scrollBy(0, -500);
    });
    await page.waitForTimeout(250);
  }
}

/** CLS of the chat opening (layout shifts since navigation, after the first messages show). */
const cls = (page) => page.evaluate(() => Math.round((window.__cls || []).reduce((a, e) => a + e.v, 0) * 1000) / 1000);

// ---------- Loading cost of picture chats (iPhone viewport, DPR 3, service worker active) ----------
// Bytes of pictures fetched over the network (not from the worker's cache or the HTTP cache), time to the first
// decoded picture, CLS; then the same chat opened again (thumbnails then come from the worker's cache).
const IMG_URL = /\/api\/(media|thumb|[a-z]+\/media|[a-z]+\/avatar)\//;
function track(cdp) {
  const reqs = new Map();
  cdp.on('Network.responseReceived', (e) => {
    if (!IMG_URL.test(e.response.url)) return;
    reqs.set(e.requestId, {
      url: e.response.url,
      type: e.type,
      status: e.response.status,
      sw: e.response.fromServiceWorker ? e.response.serviceWorkerResponseSource || 'network' : '',
      disk: !!e.response.fromDiskCache || !!e.response.fromPrefetchCache,
      len: Number(e.response.headers['content-length'] || e.response.headers['Content-Length'] || 0),
      ctype: e.response.headers['content-type'] || e.response.headers['Content-Type'] || '',
    });
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.enc = e.encodedDataLength;
  });
  return reqs;
}
function summary(reqs) {
  const all = [...reqs.values()].filter((r) => r.status === 200 || r.status === 206);
  const avatar = (r) => /\/thumb\/w144\./.test(r.url) || /\/api\/[a-z]+\/avatar\//.test(r.url) || (/\/api\/media\//.test(r.url) && !/[?&]type=/.test(r.url));
  // Not the videos (their first frame, CDP type Media): never in the worker's cache, and fetched in one or more
  // ranges depending on timing (a second range on a loaded machine doubled the "pictures over the network").
  const pics = all.filter((r) => !avatar(r) && r.type !== 'Media');
  const fromNet = (r) => !r.disk && r.sw !== 'cache-storage' && r.sw !== 'http-cache';
  const kb = (n) => Math.round(n / 1024);
  const sum = (xs) => xs.reduce((a, r) => a + (r.len || r.enc || 0), 0);
  return {
    pics: pics.length,
    picKB: kb(sum(pics.filter(fromNet))),
    picCached: pics.filter((r) => !fromNet(r)).length,
    thumbs: pics.filter((r) => /\/api\/thumb\//.test(r.url)).length,
    originals: pics.filter((r) => /\/api\/(media|[a-z]+\/media)\//.test(r.url) && r.type === 'Image').length,
    avatars: all.filter(avatar).length,
    avatarKB: kb(sum(all.filter(avatar).filter(fromNet))),
  };
}
async function perfOpen(p, id, label) {
  const reqs = track(p.cdp);
  await p.cdp.send('Network.enable');
  await p.page.goto(chatURL(id));
  await p.page.waitForSelector('[data-testid=msg]', { timeout: 30000 });
  await poll(p.page, () => window.__firstImg, null, 20000);
  await settle(p.page, { quiet: 800 });
  const r = { ...summary(reqs), firstImg: Math.round(await p.page.evaluate(() => window.__firstImg)), cls: await cls(p.page) };
  if (r.cls >= 0.1) await clsDetail(p.page, label);
  const line = (r) => `${r.pics} pictures, ${r.picKB} KB over the network (${r.picCached} from cache; ${r.thumbs} thumbnails, ${r.originals} originals), avatars ${r.avatars} (${r.avatarKB} KB)`;
  console.log(`     perf ${label}: ${line(r)}, first picture ${r.firstImg} ms, CLS ${r.cls}`);
  // Then four screens further up (older pictures come into view and load).
  for (let i = 0; i < 8; i++) {
    await p.page.evaluate(() => {
      const el = document.querySelector('.conversation [data-virtuoso-scroller]');
      el?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -400 }));
      el?.scrollBy(0, -400);
    });
    await settle(p.page, { quiet: 150, ms: 5000 });
  }
  await settle(p.page, { quiet: 800 });
  r.scrolled = summary(reqs);
  // Fetch time of the bubbles' pictures (resource timing): median and slowest.
  const t = await p.page.evaluate(() => {
    const d = performance.getEntriesByType('resource')
      .filter((e) => e.initiatorType === 'img' && ((/\/api\/thumb\//.test(e.name) && !/\/thumb\/w144\./.test(e.name)) || /\/api\/(media|[a-z]+\/media)\/.*[?&](type=image|c=[a-z]+)/.test(e.name)))
      .map((e) => e.duration)
      .sort((a, b) => a - b);
    return { n: d.length, med: Math.round(d[d.length >> 1] || 0), max: Math.round(d[d.length - 1] || 0), first: Math.round(window.__firstImg) };
  });
  r.scrolled.timing = t;
  console.log(`     perf ${label}, after scrolling up: ${line(r.scrolled)}; picture fetch median ${t.med} ms, slowest ${t.max} ms (${t.n}), first picture at ${t.first} ms`);
  await p.cdp.send('Network.disable');
  p.cdp.removeAllListeners('Network.responseReceived');
  p.cdp.removeAllListeners('Network.loadingFinished');
  return r;
}
async function perf(s, chats) {
  const out = {};
  const p = await strictContext(s, true, 3);
  try {
    await p.page.goto(`${BASE}/`);
    await p.page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
    // The installed app: the worker controls the page before any chat opens.
    await p.page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 15000))]));
    await poll(p.page, () => !!navigator.serviceWorker.controller, null, 10000);
    for (const [k, id] of [['heavy', chats.heavy || chats.media], ['other', chats.other]]) {
      if (!id) continue;
      out[k] = await perfOpen(p, id, `${k} first open`);
      await p.page.goto(`${BASE}/`);
      await p.page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
      out[`${k}Again`] = await perfOpen(p, id, `${k} second open`);
    }
    // The worker's thumbnail cache, emptied at sign-out. The logout POST never reaches the server here (the batch's
    // session is shared): it is answered in the page as the server would (0.17.3 retries a lost one for ~20 s
    // before giving up, without signing out), so the page drops what it kept while the server session lives on; the
    // app may find it again (session asked again for the sign-in methods), sign back in and cache the list's
    // thumbnails anew. So: the deletion itself, as the page made it.
    out.cached = await p.page.evaluate(async () => ((await caches.keys()).includes('thumbs') ? (await (await caches.open('thumbs')).keys()).length : -1));
    await p.page.route('**/api/auth/logout', (r) => r.fulfill({ json: { ok: true } }));
    await settingsPage(p.page, 'account');
    await p.page.click('[data-testid=logout]', { timeout: 10000 });
    await p.page.click('[data-testid=logout-confirm]', { timeout: 5000 });
    out.afterSignOut = await poll(p.page, () => window.__cacheDeletes.some((d) => d.name === 'thumbs' && d.ok), null, 10000);
    const after = await p.page.evaluate(async () => ({ deletes: window.__cacheDeletes, keys: await caches.keys(), unlock: !!document.querySelector('[data-testid=unlock]'), rows: document.querySelectorAll('[data-testid=chat-row]').length }));
    console.log(`     after sign-out: ${JSON.stringify(after)}`);
  } finally {
    await p.ctx.close().catch(() => {});
  }
  return out;
}

// ---------- Albums, videos in the viewer, open / close animation, reply thumbnails (0.14.20) ----------
const LB = '[data-testid=lightbox]';
/** Scroll the virtualised list until `sel` is rendered, then put the last match in the middle of the screen. */
async function bringIntoView(page, sel) {
  // A chat with many unread messages opens at the divider: from the bottom, then up.
  if (!(await page.locator(sel).count()) && (await page.isVisible('[data-testid=new-messages]'))) {
    await page.click('[data-testid=new-messages]');
    await settle(page, { quiet: 300, ms: 5000 });
  }
  await scrollTo(page, sel);
  await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].pop();
    el?.closest('[data-virtuoso-scroller]')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    el?.scrollIntoView({ block: 'center' });
  }, sel);
  await settle(page, { quiet: 300, ms: 5000 });
  return page.locator(sel).count();
}
/** Records every animation of the viewer (data-anim) with the frame's box and transform at its start. */
const watchAnims = (page) =>
  page.evaluate(() => {
    window.__anims = [];
    window.__animObs?.disconnect();
    window.__animObs = new MutationObserver((ms) => {
      for (const m of ms) {
        const el = m.target;
        if (m.attributeName === 'data-landed' && el.dataset.landed) window.__anims.push({ landed: el.dataset.landed.split(',').map(Number) });
        if (m.attributeName !== 'data-anim' || !el.dataset.anim) continue;
        const f = el.querySelector('[data-testid=lb-frame]');
        const r = f?.getBoundingClientRect();
        window.__anims.push({ anim: el.dataset.anim, t: f ? getComputedStyle(f).transform : '', clip: f ? getComputedStyle(f).clipPath : '', box: r ? [r.left, r.top, r.width, r.height] : null });
      }
    });
    window.__animObs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-anim', 'data-landed'] });
  });
const anims = (page) => page.evaluate(() => window.__anims || []);
const lbInfo = (page) =>
  page.evaluate(() => {
    const d = document.querySelector('[data-testid=lightbox]');
    if (!d) return null;
    const m = d.querySelector('[data-testid=lb-media]');
    const f = d.querySelector('[data-testid=lb-frame]');
    return {
      kind: d.dataset.kind,
      anim: d.dataset.anim || '',
      chrome: d.dataset.chrome,
      index: Number(d.dataset.index),
      counter: d.querySelector('[data-testid=lb-counter]')?.textContent,
      src: m?.getAttribute('src') || '',
      tag: m?.tagName || '',
      controls: !!m?.controls,
      inline: !!m?.playsInline,
      zoom: !!d.querySelector('[data-testid=lb-zoom]'),
      error: !!d.querySelector('[data-testid=lb-error]'),
      retry: !!d.querySelector('[data-testid=lb-retry]'),
      t: f ? getComputedStyle(f).transform : '',
      style: f?.style.transform || '',
      bd: Number(getComputedStyle(d.querySelector('[data-testid=lb-backdrop]')).opacity),
      bar: Number(getComputedStyle(d.querySelector('.lb-bar')).opacity),
      foot: d.querySelector('[data-testid=lb-sender]')?.textContent || '',
      cls: d.className,
      playing: [...d.querySelectorAll('video')].filter((v) => !v.paused).map((v) => v === m),
    };
  });
const rectOfSel = (page, sel) => page.evaluate((sel) => {
  const r = document.querySelector(sel)?.getBoundingClientRect();
  return r ? [r.left, r.top, r.width, r.height] : null;
}, sel);
/** The frame's box at the start of the open animation is the thumbnail (centre), covering it. */
const sameSpot = (box, t) => !!box && !!t && Math.abs(box[0] + box[2] / 2 - (t[0] + t[2] / 2)) < 3 && Math.abs(box[1] + box[3] / 2 - (t[1] + t[3] / 2)) < 3 && box[2] >= t[2] - 2 && box[3] >= t[3] - 2 && (Math.abs(box[2] - t[2]) < 3 || Math.abs(box[3] - t[3]) < 3);
async function swipeTouch(page, cdp, [x0, y0], [x1, y1], ms = 220, steps = 10, hold = 0) {
  await touch(cdp, 'touchStart', [[x0, y0]]);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', [[x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]]);
    await page.waitForTimeout(ms / steps);
  }
  if (hold) await page.waitForTimeout(hold);
  else await touch(cdp, 'touchEnd', []);
}

async function albums(s, chats, all) {
  // ---- Desktop: the album's grid, tiles → viewer, animation, menu, stable grouping ----
  const d = await strictContext(s, false);
  all.push(d);
  const { page } = d;
  if (chats.album) {
    await openChat(page, chats.album);
    const c0 = await cls(page);
    console.log(`     album chat CLS while opening: ${c0}`);
    if (c0 >= 0.1) await clsDetail(page, 'album chat');
    check(c0 < 0.1, 'album chat: opening shifts the layout by < 0.1');
    const n = await bringIntoView(page, '[data-testid=album]');
    check(n > 0, `album chat: albums drawn (${n} on screen)`);
    const alb = page.locator('[data-testid=album]').last();
    const info = await alb.evaluate((a) => {
      const r = a.getBoundingClientRect();
      const [rw, rh = 1] = getComputedStyle(a).aspectRatio.split('/').map((x) => Number(x.trim()));
      const tiles = [...a.querySelectorAll('[data-testid=album-tile]')];
      return {
        n: Number(a.dataset.count),
        w: r.width,
        h: r.height,
        ratio: rw / rh,
        tiles: tiles.length,
        more: a.querySelector('[data-testid=album-more]')?.textContent || '',
        mid: a.closest('[data-mid]').dataset.mid,
        pics: tiles.map((t) => {
          const i = t.querySelector('img');
          return i ? { thumb: /\/api\/thumb\//.test(i.currentSrc || i.src), cover: getComputedStyle(i).objectFit, fill: Math.abs(i.getBoundingClientRect().width - t.getBoundingClientRect().width) < 1.5 && Math.abs(i.getBoundingClientRect().height - t.getBoundingClientRect().height) < 1.5, sizes: Number(i.getAttribute('sizes')?.replace('px', '')), tw: t.getBoundingClientRect().width } : null;
        }),
      };
    });
    console.log(`     album: ${info.n} items, ${info.tiles} tiles, ${Math.round(info.w)}×${Math.round(info.h)}, more "${info.more}"`);
    check(info.n >= 2 && info.tiles === Math.min(4, info.n), `album: ${info.n} items in ${info.tiles} tiles`);
    check(info.n > 4 ? info.more === `+${info.n - 4}` : !info.more, `album: "+N" only beyond 4 (${info.more || 'none'})`);
    check(info.w > 200 && info.w <= 281 && Math.abs(info.w / info.h - info.ratio) < 0.03, `album: fixed proportions, picture-bubble wide (${Math.round(info.w)} px, ratio ${info.ratio.toFixed(2)})`);
    const pics = info.pics.filter(Boolean);
    check(pics.length > 0 && pics.every((x) => x.thumb && x.cover === 'cover' && x.fill && x.sizes >= x.tw - 1), 'album tiles: thumbnails sized for the tile, cropped to it');
    await shot(page, 'media-album-desktop');

    // Tile → viewer at that item, flying from the tile and back to it.
    for (const k of [0, info.tiles - 1]) {
      const tileSel = `[data-mid="${info.mid}"] [data-testid=album-tile]:nth-child(${k + 1}) a[data-media-key]`;
      const a = page.locator(tileSel);
      const href = await a.getAttribute('href');
      await a.scrollIntoViewIfNeeded();
      await still(page, tileSel);
      const tr = await rectOfSel(page, tileSel);
      await watchAnims(page);
      await a.click();
      await page.waitForSelector(LB);
      await opened(page);
      const st = await lbInfo(page);
      const op = (await anims(page))[0];
      check(st.src === href, `tile ${k + 1}: the viewer opens on that item (${st.counter})`);
      check(op?.anim === 'open' && /^matrix/.test(op.t) && sameSpot(op.box, tr), `tile ${k + 1}: opens from the tile (${op?.anim}, ${op?.t?.slice(0, 40)})`);
      check(!st.anim && st.t === 'none', `open animation ends on the full view (no transform left: ${st.anim || '-'} ${st.t.slice(0, 40)})`);
      check(await page.evaluate((sel) => document.querySelector(sel)?.classList.contains('lb-src'), tileSel), "the tile's place stays empty while it is in the viewer");
      if (k === 0) await shot(page, 'media-album-viewer');
      await page.keyboard.press('Escape');
      await page.waitForSelector(LB, { state: 'detached', timeout: 3000 });
      const cl = await anims(page);
      const close = cl.find((x) => x.anim === 'close');
      const landed = cl.find((x) => x.landed)?.landed;
      check(!!close && sameSpot(landed, tr), `closing flies back onto the tile (${close?.anim}, landed ${landed?.map(Math.round).join(',')} vs ${tr?.map(Math.round).join(',')})`);
      check(!(await page.evaluate((sel) => document.querySelector(sel)?.classList.contains('lb-src'), tileSel)), 'the tile shows again');
    }
    // Reduced motion: a fade, no movement.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await watchAnims(page);
    await page.locator(`[data-mid="${info.mid}"] [data-testid=album-tile] a[data-media-key]`).first().click();
    await page.waitForSelector(LB);
    await opened(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector(LB, { state: 'detached', timeout: 3000 });
    const rm = (await anims(page)).map((x) => x.anim).filter(Boolean);
    check(rm[0] === 'fade' && rm.includes('fade-out') && !rm.includes('open') && !rm.includes('close'), `reduced motion: fades only (${rm.join(', ')})`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // Right-click on a tile: the menu of that item.
    const last = page.locator(`[data-mid="${info.mid}"] [data-testid=album-tile]`).nth(info.tiles - 1);
    const want = { mid: await last.getAttribute('data-tile-mid'), att: await last.getAttribute('data-att') };
    await last.click({ button: 'right' });
    await page.waitForSelector('[data-testid=message-menu]');
    const mm = await page.evaluate(() => {
      const m = document.querySelector('[data-testid=message-menu]');
      return { mid: m.dataset.menuMid, att: m.dataset.menuAtt, ids: [...m.querySelectorAll('.menu-list button')].map((b) => b.dataset.testid) };
    });
    check(mm.mid === want.mid && mm.att === want.att && mm.ids[0] === 'menu-open', `right-click on tile ${info.tiles}: that item's menu (${mm.ids.slice(0, 3).join(', ')})`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=message-menu]', { state: 'detached', timeout: 3000 }).catch(() => {});

    // Grouping does not change when older pages load (albums.ts: pairwise rule).
    const counts = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-album]')].map((m) => [m.dataset.mid, m.dataset.album])));
    const before = await counts();
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => {
        const el = document.querySelector('.conversation [data-virtuoso-scroller]');
        el?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1500 }));
        el?.scrollBy(0, -1500);
      });
      await settle(page, { quiet: 200, ms: 3000 });
    }
    if (await page.isVisible('[data-testid=new-messages]')) await page.click('[data-testid=new-messages]');
    await settle(page, { quiet: 300, ms: 5000 });
    await bringIntoView(page, `[data-mid="${info.mid}"]`);
    const after = await counts();
    const same = Object.keys(before).filter((k) => k in after);
    check(same.length > 0 && same.every((k) => before[k] === after[k]), `albums unchanged after loading older pages (${same.length} compared)`);
  } else console.log('     (no album found: album checks skipped)');

  // ---- Desktop: a real video opens in the viewer ----
  if (chats.video) {
    await openChat(page, chats.video);
    const vsel = '.att-vid[data-media-key], [data-testid=album-tile][data-kind=video] a[data-media-key]';
    const vn = await bringIntoView(page, vsel);
    const v = page.locator(vsel).last();
    const tile = await v.evaluate((a) => ({
      play: !!a.querySelector('.vid-play'),
      poster: a.querySelector('img') ? 'poster' : a.querySelector('[data-testid=vid-frame]') ? 'frame' : a.querySelector('[data-testid=vid-blank]') ? 'blank' : 'none',
      controls: !!a.querySelector('video[controls]'),
      href: a.getAttribute('href'),
    }));
    check(vn > 0 && tile.play && tile.poster !== 'none' && !tile.controls, `video in the list: poster (${tile.poster}) with ▶, no inline player`);
    await shot(page, 'media-video-tile');
    await v.click();
    await page.waitForSelector(LB);
    const v0 = await lbInfo(page);
    // Until the video can play here, or has failed (error tile).
    await poll(page, () => {
      const d = document.querySelector('[data-testid=lightbox]');
      return !!d?.querySelector('[data-testid=lb-error]') || d?.querySelector('video[data-testid=lb-media]')?.readyState >= 2;
    }, null, 10000);
    const v1 = await lbInfo(page);
    console.log(`     video viewer: ${JSON.stringify({ tag: v0.tag, controls: v0.controls, inline: v0.inline, error: v1.error })}`);
    // Playwright's Chromium has no H.264: real WhatsApp videos end on the error with Retry there.
    check(v0.kind === 'video' && ((v0.tag === 'VIDEO' && v0.controls && v0.inline) || v0.error) && !v0.zoom, 'video opens in the viewer: native controls, playsinline, no zoom button');
    check(!v1.error || v1.retry, `video that cannot be played here: error with Retry (${v1.error ? 'error' : 'loaded'})`);
    check(v1.src === tile.href || v1.src.startsWith(tile.href) || v1.error, 'the viewer plays the original');
    await shot(page, 'media-video-viewer');
    await page.keyboard.press('Escape');
    await page.waitForSelector(LB, { state: 'detached', timeout: 3000 });

    // Playback: first frame as the poster, plays in the viewer, paused when swiped away. Here when the video plays
    // in this Chromium (the offline instance's VP9 clip); else (a real H.264 video) in a context where that chat's
    // videos are answered with the recorded test clip (GET only, mocked in the browser, no worker in between).
    let vp = page;
    if (v1.error) {
      const vctx = await strictContext(s, false, undefined, true);
      all.push(vctx);
      const webm = readFileSync(join(__dirname, 'offline/fixtures/clip.webm'));
      await vctx.page.route((u) => u.pathname === '/api/media/m.mp4', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'video/webm', body: webm }) : r.abort()));
      await openChat(vctx.page, chats.video);
      await bringIntoView(vctx.page, vsel);
      vp = vctx.page;
    }
    const vt = vp.locator(vsel).last();
    await poll(vp, () => [...document.querySelectorAll('[data-testid=vid-frame]')].some((v) => v.readyState >= 1), null, 10000);
    const fr = await vt.evaluate((a) => {
      const v = a.querySelector('[data-testid=vid-frame]');
      return { frame: !!v && v.readyState >= 1, fade: !!v && /fade/.test(v.className), src: v?.getAttribute('src') || '' };
    });
    check(fr.frame && fr.fade && /#t=0\.1$/.test(fr.src), `video without poster: its first frame stands for it (${fr.frame ? 'drawn' : 'missing'})`);
    await vt.scrollIntoViewIfNeeded();
    await shot(vp, 'media-video-frame');
    await vt.click();
    await vp.waitForSelector(LB);
    await opened(vp);
    // Autoplay after the tap (the browser may refuse: then its play button waits). Then until it has played a
    // little: the clip is 2 s long, a fixed wait could land after its end (ended = paused).
    const playing = () =>
      vp.evaluate(() => {
        const m = document.querySelector('[data-testid=lightbox] video[data-testid=lb-media]');
        if (m && (m.ended || (m.paused && !m.currentTime))) void m.play().catch(() => {});
      });
    await playing();
    const pv = await poll(vp, () => {
      const m = document.querySelector('[data-testid=lightbox] video[data-testid=lb-media]');
      return m && m.currentTime > 0.2 && { t: m.currentTime, played: !m.paused || m.ended, controls: m.controls, inline: m.playsInline, w: m.getBoundingClientRect().width };
    }, null, 10000);
    check(!!pv && pv.played && pv.controls && pv.inline && pv.w > 300, `video plays in the viewer with its controls (${pv ? pv.t.toFixed(1) : '-'} s)`);
    await shot(vp, 'media-video-playing');
    // Swiped away while it plays, from its start (the 2 s clip must not reach its end on its own: ended = paused).
    await vp.evaluate(() => {
      const m = document.querySelector('[data-testid=lightbox] video[data-testid=lb-media]');
      if (!m) return;
      window.__swiped = m;
      m.currentTime = 0;
      void m.play().catch(() => {});
    });
    await poll(vp, () => !window.__swiped?.paused, null, 5000);
    const vi = await lbInfo(vp);
    const nav = vi.index > 0 ? '[data-testid=lb-prev]' : '[data-testid=lb-next]';
    if (await vp.isVisible(nav)) await vp.click(nav);
    const moved = await poll(vp, (i) => Number(document.querySelector('[data-testid=lightbox]')?.dataset.index) !== i, vi.index, 3000);
    // That video paused by the viewer (or gone with its slide), not ended; and no other one playing.
    const state = () =>
      vp.evaluate(() => {
        const v = window.__swiped;
        const others = [...document.querySelectorAll('[data-testid=lightbox] video')].filter((x) => x !== v && !x.paused && !x.loop).length;
        return { gone: !v?.isConnected, paused: !!v?.paused, ended: !!v?.ended, others };
      });
    let left = await state();
    for (const end = Date.now() + 1500; moved && !((left.gone || (left.paused && !left.ended)) && !left.others) && Date.now() < end; left = await state()) await vp.waitForTimeout(100);
    const after = (left.gone || (left.paused && !left.ended)) && !left.others;
    check(!moved || !!after, `swiping away pauses the video (${moved ? JSON.stringify(left) : 'only item'})`);
    await vp.keyboard.press('Escape');
    await vp.waitForSelector(LB, { state: 'detached', timeout: 3000 });
  } else console.log('     (no video found: video checks skipped)');

  // ---- Reply to a photo: thumbnail in the quote; the quote still jumps to the message ----
  if (chats.reply && chats.replyMsg) {
    await openChat(page, chats.reply);
    const sel = `[data-mid="${chats.replyMsg}"] [data-testid=quote]`;
    const qn = await bringIntoView(page, sel);
    const q = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const i = el?.querySelector('[data-testid=quote-thumb] img');
      return el && { thumb: !!el.querySelector('[data-testid=quote-thumb]'), src: i?.getAttribute('src') || '', loaded: !!i && i.complete && i.naturalWidth > 0, w: i?.getBoundingClientRect().width, text: el.querySelector('.quote-text')?.textContent };
    }, sel);
    check(qn > 0 && q?.thumb && /^\/api\/thumb\/w144\.webp\?/.test(q.src) && q.loaded && Math.round(q.w) === 36, `reply quote: 144 thumbnail of the photo (${q && q.src.slice(0, 24)}…, "${q && q.text?.slice(0, 20)}")`);
    await page.locator(sel).scrollIntoViewIfNeeded();
    await shot(page, 'media-reply-thumb');
    await page.click(sel);
    const flashed = await poll(page, () => !!document.querySelector('.msg.flash'), null, 8000);
    check(!!flashed, 'tapping the quote jumps to the photo (highlighted)');
  } else console.log('     (no reply to a photo found: quote checks skipped)');

  // ---- iPhone: long-press on a tile, tap → viewer, toolbar toggle, drag down ----
  if (!chats.album) return;
  const p = await strictContext(s, true);
  all.push(p);
  await openChat(p.page, chats.album);
  await bringIntoView(p.page, '[data-testid=album]');
  const alb = p.page.locator('[data-testid=album]').last();
  const nt = await alb.locator('[data-testid=album-tile]').count();
  const tl = alb.locator('[data-testid=album-tile]').nth(Math.min(1, nt - 1));
  const tmid = await tl.getAttribute('data-tile-mid');
  const [x, y] = await center(tl);
  const under = await p.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-tile-mid]')?.dataset.tileMid, [x, y]);
  await longPress(p.page, p.cdp, x, y);
  const pressed = Date.now();
  await p.page.waitForSelector('[data-testid=message-menu].sheet');
  const sm = await p.page.evaluate(() => document.querySelector('[data-testid=message-menu]').dataset.menuMid);
  check(sm === tmid && under === tmid, `phone: long-press on a tile opens that item's sheet (${sm} / ${tmid}, under the finger ${under})`);
  await shot(p.page, 'media-album-phone-sheet');
  await tap(p.page, p.cdp, 195, 40);
  await p.page.waitForSelector('[data-testid=message-menu]', { state: 'detached', timeout: 5000 }).catch(() => {});
  await still(p.page, `[data-tile-mid="${tmid}"]`);
  // A tap within 900 ms of a long-press is its own click, which never opens the viewer (MessageItem longPressAt).
  await p.page.waitForTimeout(Math.max(0, 1000 - (Date.now() - pressed)));
  await watchAnims(p.page);
  await tap(p.page, p.cdp, x, y);
  await p.page.waitForSelector(LB);
  await opened(p.page);
  const chromeIs = (want) =>
    poll(p.page, (want) => {
      const d = document.querySelector('[data-testid=lightbox]');
      const bar = d && Number(getComputedStyle(d.querySelector('.lb-bar')).opacity);
      return !!d && d.dataset.chrome === want && (want === 'on' ? bar > 0.9 : bar < 0.05);
    }, want, 3000);
  await chromeIs('on');
  let st = await lbInfo(p.page);
  check(st.chrome === 'on' && st.bar > 0.9 && /\S/.test(st.foot), `phone viewer: toolbar, sender and date shown (${st.counter})`);
  await shot(p.page, 'media-album-phone-viewer');
  // Single taps (further apart than a double tap, 350 ms), each once the toolbar has finished fading.
  const apart = async (since) => p.page.waitForTimeout(Math.max(0, 450 - (Date.now() - since)));
  let tapped = Date.now();
  await tap(p.page, p.cdp, 195, 430);
  await chromeIs('off');
  st = await lbInfo(p.page);
  check(st.chrome === 'off' && st.bar < 0.05, 'phone: a tap hides the toolbar and caption');
  await shot(p.page, 'media-album-phone-nochrome');
  await apart(tapped);
  tapped = Date.now();
  await tap(p.page, p.cdp, 195, 430);
  check(!!(await chromeIs('on')), 'phone: another tap shows them again');
  await apart(tapped);
  // Drag down: the picture follows the finger, shrinks, the backdrop clears; back up and release: stays.
  await swipeTouch(p.page, p.cdp, [195, 400], [225, 560], 400, 10, 200);
  st = await lbInfo(p.page);
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0px\) scale\(([\d.]+)\)/.exec(st.style);
  check(!!m && Number(m[1]) > 20 && Number(m[2]) > 140 && Number(m[3]) < 1 && st.bd < 0.9 && st.bd > 0.1 && /chrome-off/.test(st.cls), `drag down: follows the finger (${st.style}), backdrop ${st.bd.toFixed(2)}`);
  await shot(p.page, 'media-album-phone-drag');
  for (let i = 9; i >= 0; i--) {
    await touch(p.cdp, 'touchMove', [[195, 400 + i * 16]]);
    await p.page.waitForTimeout(40);
  }
  await p.page.waitForTimeout(250);
  await touch(p.cdp, 'touchEnd', []);
  await poll(p.page, () => {
    const d = document.querySelector('[data-testid=lightbox]');
    return !d || (!d.querySelector('[data-testid=lb-frame]').style.transform && Number(getComputedStyle(d.querySelector('[data-testid=lb-backdrop]')).opacity) > 0.99);
  }, null, 3000);
  st = await lbInfo(p.page);
  check(!!st && !st.style && st.bd > 0.99, 'drag back up and release: the viewer stays');
  // A short quick flick down closes: speed, not distance. 80 px is under the distance a drag needs (flip.ts
  // dismissDecision: min(110 px, 15 % of the stage)), so the same 80 px dragged slowly (and held before the release)
  // must leave the viewer open; then fast, it closes. The fast moves are sent back to back, not paced by the test:
  // the speed is measured in the page, and on a loaded machine a paced 60 ms flick reaches it as a slow drag.
  const stageH = await p.page.evaluate(() => document.querySelector('[data-testid=lb-stage]')?.getBoundingClientRect().height ?? 0);
  check(80 < Math.min(110, stageH * 0.15), `flick: 80 px is under the drag distance (${Math.round(Math.min(110, stageH * 0.15))} px)`);
  await swipeTouch(p.page, p.cdp, [195, 400], [195, 480], 800, 10, 300);
  await touch(p.cdp, 'touchEnd', []);
  await poll(p.page, () => {
    const d = document.querySelector('[data-testid=lightbox]');
    return !d || (!d.querySelector('[data-testid=lb-frame]').style.transform && Number(getComputedStyle(d.querySelector('[data-testid=lb-backdrop]')).opacity) > 0.99);
  }, null, 3000);
  st = await lbInfo(p.page);
  check(!!st && !st.style, 'slow 80 px drag down and release: the viewer stays');
  await watchAnims(p.page);
  await touch(p.cdp, 'touchStart', [[195, 400]]);
  await Promise.all([420, 440, 460, 480].map((y) => touch(p.cdp, 'touchMove', [[195, y]])));
  await touch(p.cdp, 'touchEnd', []);
  const gone = await p.page.waitForSelector(LB, { state: 'detached', timeout: 5000 }).then(() => true, () => false);
  const fl = (await anims(p.page)).map((x) => x.anim).filter(Boolean);
  check(gone && (fl.includes('close') || fl.includes('fade-out')), `flick down closes (${fl.join(', ')})`);
  // Closing pops the viewer's history entry (the traversal lands asynchronously).
  const popped = await poll(p.page, () => !history.state?.klatchlyLightbox, null, 3000);
  check(!!popped, 'phone: the history entry is gone');
}

(async () => {
  const s = await open({ locale: 'en-US' });
  let exitErr;
  const all = [];
  try {
    main: {
    await enroll(s.page);
    const chats = await discover(s.page);
    console.log(`     chats: media ${short(chats.media)} · heavy ${short(chats.heavy)} · file ${short(chats.file)} · other ${short(chats.other)} · album ${short(chats.album)} (${chats.albumN}) · video ${short(chats.video)} · reply ${short(chats.reply)}`);
    if (process.env.PERF_ONLY) {
      await perf(s, chats);
      break main;
    }
    if (process.env.ALBUMS_ONLY) {
      await albums(s, chats, all);
      break main;
    }

    // ---------- Loading cost (iPhone, DPR 3) ----------
    const pf = await perf(s, chats);
    if (pf.heavy) {
      check(pf.heavy.thumbs > 0, `heavy chat: bubbles load thumbnails (${pf.heavy.thumbs} thumbnails, ${pf.heavy.originals} originals)`);
      check(pf.heavy.cls < 0.1, `heavy chat: CLS ${pf.heavy.cls} < 0.1`);
      check(pf.heavyAgain.picCached > 0 && pf.heavyAgain.picKB <= pf.heavy.picKB / 4, `heavy chat opened again: pictures from the worker's cache (${pf.heavyAgain.picCached}, ${pf.heavyAgain.picKB} KB over the network)`);
      check(pf.cached > 0, `thumbnail cache filled (${pf.cached} entries)`);
      check(pf.afterSignOut === true, 'sign-out empties the thumbnail cache');
    }

    // ---------- Desktop ----------
    const d = await strictContext(s, false);
    all.push(d);
    const { page } = d;
    if (chats.media) {
      await openChat(page, chats.media);
      await page.waitForSelector('.att-img img', { timeout: 20000 });
      await settle(page, { quiet: 800 });
      const c = await cls(page);
      console.log(`     desktop CLS while opening the picture chat: ${c}`);
      if (c >= 0.1) await clsDetail(page, 'desktop');
      check(c < 0.1, 'desktop: opening a chat with pictures shifts the layout by < 0.1');
      check((await brokenImgs(page)) === 0, 'desktop: no broken-image icon');
      const th = await page.evaluate(() =>
        [...document.querySelectorAll('a.att-img:not(.sticker) > img')].map((i) => ({
          thumb: /^\/api\/thumb\/w\d+\.webp\?/.test(i.currentSrc ? new URL(i.currentSrc).pathname + new URL(i.currentSrc).search : i.getAttribute('src')),
          srcset: !!i.getAttribute('srcset'),
          href: i.parentElement.getAttribute('href'),
          state: i.className,
          // the tinted frame hugs the picture
          frame: Math.abs(i.parentElement.getBoundingClientRect().width - i.getBoundingClientRect().width) < 1.5,
          tint: getComputedStyle(i.parentElement).backgroundColor !== 'rgba(0, 0, 0, 0)',
          loaded: i.complete && i.naturalWidth > 0,
        })),
      );
      console.log(`     desktop bubbles: ${th.length} pictures, ${th.filter((x) => x.thumb).length} shown from a thumbnail`);
      check(th.some((x) => x.thumb) && th.every((x) => x.thumb || !x.srcset), 'desktop: bubbles show thumbnails (srcset)');
      check(th.every((x) => /^\/api\/(media|[a-z]+\/media)\//.test(x.href)), 'desktop: bubble links keep the original');
      check(th.every((x) => x.frame && x.tint), 'desktop: tinted frame the size of the picture (placeholder)');
      check(th.filter((x) => x.loaded).every((x) => /\b(fade|now)\b/.test(x.state)), 'desktop: loaded pictures shown (faded in, or at once from cache)');
      const hdr = await page.evaluate(async () => {
        const i = [...document.querySelectorAll('a.att-img:not(.sticker) > img')].find((x) => /\/api\/thumb\//.test(x.currentSrc));
        if (!i) return null;
        const r = await fetch(i.currentSrc);
        const b = await r.arrayBuffer();
        return { status: r.status, type: r.headers.get('content-type'), cc: r.headers.get('cache-control'), etag: r.headers.get('etag'), csp: r.headers.get('content-security-policy'), len: b.byteLength, w: /w(\d+)\.webp/.exec(i.currentSrc)[1] };
      });
      check(!!hdr && hdr.status === 200 && hdr.type === 'image/webp' && /immutable/.test(hdr.cc) && /^"t/.test(hdr.etag || '') && /sandbox/.test(hdr.csp || ''), `thumbnail: WebP, immutable, ETag, sandboxed (${hdr && `w${hdr.w} ${Math.round(hdr.len / 1024)} KB`})`);
      const ssrf = await page.evaluate(async () => {
        const urls = ['file:///etc/passwd', 'http://169.254.169.254/', 'https://example.com/a.jpg', 'mxc://local.beeper.com/../../account.db'];
        const st = await Promise.all(urls.map((u) => fetch(`/api/thumb/w320.webp?url=${encodeURIComponent(u)}`, { redirect: 'manual' }).then((r) => r.status)));
        st.push(await fetch('/api/thumb/w500.webp?url=mxc%3A%2F%2Flocal.beeper.com%2Fx').then((r) => r.status));
        st.push(await fetch('/api/thumb/w320.webp?c=nobody%3Au%3A1&m=1').then((r) => r.status));
        return st;
      });
      check(ssrf.every((x) => x === 400), `thumbnail: other sources and sizes refused (${ssrf.join(' ')})`);
      const av = await page.evaluate(async () => {
        const imgs = [...document.querySelectorAll('.avatar > img')].map((i) => i.getAttribute('src')).filter((u) => /\/api\/thumb\/w144\./.test(u)).slice(0, 6);
        const size = (u) => fetch(u).then((r) => r.arrayBuffer()).then((b) => b.byteLength, () => 0);
        const orig = (u) => `/api/media/m.jpg?${new URL(u, location.href).search.slice(1)}`;
        let t = 0;
        let o = 0;
        for (const u of imgs) [t, o] = [t + (await size(u)), o + (await size(orig(u)))];
        return { n: imgs.length, t, o };
      });
      console.log(`     avatars: ${av.n} as thumbnails, ${Math.round(av.t / 1024)} KB (originals ${Math.round(av.o / 1024)} KB)`);
      check(av.n === 0 || av.t < av.o, 'avatars: thumbnails smaller than the originals');
      await shot(page, 'media-desktop-chat');

      // Right-click on a picture without caption (else the last picture).
      const pic = page.locator('[data-testid=msg]:not(:has([data-testid=msg-text])) a.att-img:not(.att-gif):not(.att-vid)[data-media-key]').last();
      const target = (await pic.count()) ? pic : page.locator('a.att-img:not(.att-gif):not(.att-vid)[data-media-key]').last();
      const hasText = !(await pic.count());
      await target.scrollIntoViewIfNeeded();
      await target.click({ button: 'right' });
      await page.waitForSelector('[data-testid=message-menu]');
      const ids = await page.$$eval('[data-testid=message-menu] .menu-list button', (b) => b.map((x) => x.dataset.testid));
      console.log(`     desktop menu on a picture: ${ids.join(', ')}`);
      check(ids[0] === 'menu-open' && ids[1] === 'menu-save', 'desktop menu: Open, then Download first');
      check(ids.includes('menu-copy-image'), 'desktop menu: Copy image (Chromium clipboard takes PNG)');
      check(hasText || !ids.some((x) => /menu-(copy|select|translate-(?!image))/.test(x) && x !== 'menu-copy-image'), 'desktop menu: no text actions on a picture without caption');
      check(ids.some((x) => x.startsWith('menu-translate-image-')), 'desktop menu: « Traduire l’image » on a picture (0.18.9)');
      check((await page.textContent('[data-testid=menu-save]')).trim() === 'Download', 'desktop label: Download');
      await shot(page, 'media-desktop-menu');
      await page.click('[data-testid=menu-save]');
      const dl = await poll(page, () => window.__dl[0]);
      check(!!dl && /^\/api\/(media|[a-z]+\/media)\//.test(dl.href) && !!dl.download, `desktop save: download link with a file name (${dl && dl.download})`);
      await target.click({ button: 'right' });
      await page.click('[data-testid=menu-copy-image]');
      const clip = await poll(page, () => window.__clip[0], null, 20000);
      check(!!clip && clip.types.join() === 'image/png' && clip.type === 'image/png' && clip.size > 100, `copy image: one PNG item (${clip && clip.size} B)`);
      check(await poll(page, () => !!document.querySelector('[data-testid=save-note]'), null, 3000), 'copy: "Image copied" note');
      await target.click({ button: 'right' });
      await page.click('[data-testid=menu-open]');
      await page.waitForSelector('[data-testid=lightbox]');
      const lb = await page.evaluate(() => {
        const a = document.querySelector('[data-testid=lb-download]');
        return { tag: a.tagName, href: a.getAttribute('href'), download: a.getAttribute('download'), copy: !!document.querySelector('[data-testid=lb-copy]'), orig: !!document.querySelector('[data-testid=lb-original]') };
      });
      check(lb.tag === 'A' && !!lb.download && lb.copy && lb.orig, `lightbox (desktop): download link (${lb.download}), copy and original buttons`);
      const lbSrc = await page.evaluate(() => document.querySelector('[data-testid=lightbox] [data-testid=lb-media]')?.getAttribute('src') || '');
      check(/^\/api\/(media|[a-z]+\/media)\//.test(lbSrc) && /^\/api\/(media|[a-z]+\/media)\//.test(lb.href), 'lightbox: the original, not the thumbnail');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-testid=lightbox]', { state: 'detached' });
    } else console.log('     (no chat with pictures found: desktop picture checks skipped)');

    if (chats.file) {
      await openChat(page, chats.file);
      await scrollTo(page, '[data-testid=att-file-card][data-kind=pdf]');
      const card = page.locator('[data-testid=att-file-card][data-kind=pdf]').last();
      await card.waitFor({ timeout: 20000 }).catch(async (e) => {
        const dbg = await page.evaluate(() => ({
          cards: [...document.querySelectorAll('[data-testid=att-file-card]')].map((c) => c.dataset.kind),
          msgs: document.querySelectorAll('[data-testid=msg]').length,
          scroller: !!document.querySelector('.conversation [data-virtuoso-scroller]'),
          top: document.querySelector('.conversation [data-virtuoso-scroller]')?.scrollTop,
        }));
        console.log(`     file chat: ${JSON.stringify(dbg)}`);
        await shot(page, 'media-desktop-file-missing');
        throw e;
      });
      await card.scrollIntoViewIfNeeded();
      const info = await card.evaluate((el) => ({
        name: el.querySelector('[data-testid=att-file-name]').dataset.name,
        size: el.querySelector('.att-file-size')?.textContent ?? '',
        icon: el.querySelector('svg.file-icon')?.dataset.kind,
        nfc: el.textContent === el.textContent.normalize('NFC'),
      }));
      check(info.icon === 'pdf' && /\.pdf$/i.test(info.name) && /PDF/.test(info.size) && info.nfc, `file card: PDF icon, name with extension, size line "${info.size}"`);
      await shot(page, 'media-desktop-file');
      const before = await page.evaluate(() => ({ path: location.pathname, len: history.length }));
      const resp = page.waitForResponse((r) => /\/api\/(media|[a-z]+\/media)\//.test(r.url()) && r.request().method() === 'GET' && r.status() === 200, { timeout: 30000 }).catch(() => null);
      await card.locator('[data-testid=att-file]').click();
      await page.waitForSelector('[data-testid=file-viewer]');
      const r = await resp;
      if (r) {
        const h = r.headers();
        check(h['content-type'] === 'application/pdf', `PDF served as application/pdf (${h['content-type']})`);
        check(/^inline; filename="[^"]*"; filename\*=UTF-8''\S+$/.test(h['content-disposition'] || ''), `Content-Disposition inline with the file name`);
        check(/sandbox/.test(h['content-security-policy'] || '') && h['x-content-type-options'] === 'nosniff', 'media security headers kept');
      } else check(false, 'PDF fetched for the viewer');
      const drawn = await poll(page, () => document.querySelector('[data-testid=pdf-page][data-drawn]') && document.querySelector('[data-testid=pdf-pages]').dataset.pages, null, 40000);
      check(Number(drawn) >= 1, `PDF drawn in the app (${drawn} page(s))`);
      await page.waitForTimeout(500);
      await shot(page, 'media-desktop-pdf');
      await page.click('[data-testid=fv-back]');
      await page.waitForSelector('[data-testid=file-viewer]', { state: 'detached' });
      const after = await page.evaluate(() => ({ path: location.pathname, len: history.length, st: !!(history.state && history.state.klatchlyLightbox) }));
      check(after.path === before.path && !after.st, 'Back closes the viewer, still in the chat');
      // Browser Back too
      await card.locator('[data-testid=att-file]').click();
      await page.waitForSelector('[data-testid=file-viewer]');
      await page.goBack();
      await page.waitForSelector('[data-testid=file-viewer]', { state: 'detached', timeout: 5000 }).catch(() => {});
      check(!(await page.isVisible('[data-testid=file-viewer]')) && (await page.evaluate(() => location.pathname)) === before.path, 'browser Back closes the viewer');
    } else console.log('     (no chat with a PDF found: file checks skipped)');

    if (chats.other) {
      await openChat(page, chats.other);
      const z = await page.evaluate(() => ({
        boxes: document.querySelectorAll('.att-img.nodims').length,
        imgs: document.querySelectorAll('.att-img img').length,
        tiles: document.querySelectorAll('[data-testid=media-error]').length,
      }));
      console.log(`     other connector: ${z.imgs} pictures, ${z.boxes} without size (fixed box), ${z.tiles} unavailable tile(s); CLS ${await cls(page)}`);
      check((await brokenImgs(page)) === 0, 'other connector: no broken-image icon');
      if ((await cls(page)) >= 0.1) await clsDetail(page, 'other');
      check((await cls(page)) < 0.1, 'other connector: opening the chat shifts the layout by < 0.1');
      await shot(page, 'media-desktop-other');
      // Its own media paths (not the Desktop API's /api/media): the bubbles show thumbnails all the same.
      const src = await page.evaluate(() => document.querySelector('a.att-img:not([href^="/api/media"])')?.getAttribute('href'));
      const zt = await page.evaluate(() => [...document.querySelectorAll('a.att-img:not([href^="/api/media"]) > img')].filter((i) => /\/api\/thumb\//.test(i.currentSrc)).length);
      check(!src || zt > 0, `other connector: bubbles show thumbnails (${zt})`);
    }

    // Unavailable picture: a tidy tile with Retry (any network), here by failing pictures on purpose (no worker).
    if (chats.media) {
      const e = await strictContext(s, false, undefined, true);
      all.push(e);
      // Pictures of bubbles: thumbnails (not the avatars' w144) and originals.
      const failPic = (r) => {
        const u = r.request().url();
        return r.request().resourceType() === 'image' && ((/\/api\/thumb\//.test(u) && !/\/w144\./.test(u)) || /\/api\/media\/.*[?&]type=image/.test(u)) ? r.fulfill({ status: 404, body: '' }) : r.continue();
      };
      await e.page.route('**/api/media/**', failPic);
      await e.page.route('**/api/thumb/**', failPic);
      await openChat(e.page, chats.media);
      await e.page.waitForSelector('[data-testid=media-error]', { timeout: 15000 }).catch(() => {});
      const tiles = await e.page.locator('[data-testid=media-error]').count();
      const attBroken = await e.page.evaluate(() => [...document.querySelectorAll('.att-img img')].filter((i) => i.complete && i.naturalWidth === 0).length);
      check(tiles > 0 && attBroken === 0, `failed pictures become "unavailable · Retry" tiles (${tiles}, ${attBroken} broken icon)`);
      await shot(e.page, 'media-desktop-error');
      await e.page.unroute('**/api/media/**');
      await e.page.unroute('**/api/thumb/**');
      await e.page.locator('[data-testid=media-retry]').first().click();
      const fewer = await poll(e.page, (n) => document.querySelectorAll('[data-testid=media-error]').length < n, tiles, 10000);
      check(!!fewer, 'Retry loads the picture again');
    }

    // ---------- iPhone (Home Screen app) ----------
    const p = await strictContext(s, true);
    all.push(p);
    if (chats.media) {
      await openChat(p.page, chats.media);
      await p.page.waitForSelector('.att-img img', { timeout: 20000 });
      console.log(`     phone CLS while opening the picture chat: ${await cls(p.page)}`);
      const pic = p.page.locator('a.att-img:not(.att-gif):not(.att-vid)[data-media-key]').last();
      const [x, y] = await center(pic);
      await longPress(p.page, p.cdp, x, y);
      await p.page.waitForSelector('[data-testid=message-menu].sheet');
      const ids = await p.page.$$eval('[data-testid=message-menu] .menu-list button', (b) => b.map((x) => x.dataset.testid));
      console.log(`     phone sheet on a picture: ${ids.join(', ')}`);
      check(ids[0] === 'menu-open' && ids[1] === 'menu-save', 'phone sheet: Ouvrir, Enregistrer / Partager first');
      check((await p.page.textContent('[data-testid=menu-save]')).trim() === 'Enregistrer / Partager', 'phone label: Enregistrer / Partager');
      await shot(p.page, 'media-phone-sheet');
      // The picture was fetched while the sheet was open: the tap shares at once, files only.
      await p.page.waitForTimeout(1500);
      await p.page.click('[data-testid=menu-save]');
      let sh = await poll(p.page, () => window.__share[0], null, 4000);
      if (!sh) {
        // Not ready at the tap: progress, then "Toucher pour enregistrer" (second tap).
        await p.page.waitForSelector('[data-testid=save-dock-go]', { timeout: 20000 });
        await shot(p.page, 'media-phone-dock');
        await p.page.click('[data-testid=save-dock-go]');
        sh = await poll(p.page, () => window.__share[0], null, 4000);
      }
      check(!!sh && sh.keys.join() === 'files' && sh.files.length === 1 && sh.files[0].size > 100 && /^image\//.test(sh.files[0].type), `share sheet: files only (${sh && JSON.stringify(sh.files[0])})`);
      // Lightbox on the phone: Enregistrer / Partager, no "open original" (it would leave the app)
      await tap(p.page, p.cdp, x, y);
      await p.page.waitForSelector('[data-testid=lightbox]');
      await opened(p.page);
      check(!(await p.page.isVisible('[data-testid=lb-original]')), 'phone lightbox: no new-tab button');
      check((await p.page.getAttribute('[data-testid=lb-download]', 'aria-label')) === 'Enregistrer / Partager', 'phone lightbox: Enregistrer / Partager');
      await p.page.evaluate(() => (window.__share.length = 0));
      await p.page.click('[data-testid=lb-download]');
      let sh2 = await poll(p.page, () => window.__share[0], null, 4000);
      if (!sh2 && (await p.page.isVisible('[data-testid=save-dock-go]'))) {
        await p.page.click('[data-testid=save-dock-go]');
        sh2 = await poll(p.page, () => window.__share[0], null, 4000);
      }
      check(!!sh2 && sh2.keys.join() === 'files', 'phone lightbox save: share sheet with files only');
      check((await p.page.evaluate(() => location.pathname)) === `/chat/${enc(chats.media)}`, 'phone: still in the app page');
      await shot(p.page, 'media-phone-lightbox');
      await p.page.click('[data-testid=lb-close]');
      await p.page.waitForSelector('[data-testid=lightbox]', { state: 'detached' });
    }
    if (chats.file) {
      await openChat(p.page, chats.file);
      await scrollTo(p.page, '[data-testid=att-file-card][data-kind=pdf]');
      const card = p.page.locator('[data-testid=att-file-card][data-kind=pdf]').last();
      await card.waitFor({ timeout: 20000 });
      const before = await p.page.evaluate(() => location.pathname);
      await card.evaluate((el) => {
        el.closest('[data-virtuoso-scroller]')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
        el.scrollIntoView({ block: 'center' });
      });
      const [x, y] = await center(card.locator('[data-testid=att-file]'));
      await longPress(p.page, p.cdp, x, y);
      await p.page.waitForSelector('[data-testid=message-menu].sheet');
      const ids = await p.page.$$eval('[data-testid=message-menu] .menu-list button', (b) => b.map((x) => x.dataset.testid));
      console.log(`     phone sheet on a PDF: ${ids.join(', ')}`);
      check(ids[0] === 'menu-open' && ids[1] === 'menu-save' && !ids.includes('menu-copy-image'), 'phone sheet on a file: Ouvrir, Enregistrer / Partager, no Copy image');
      await p.page.click('[data-testid=menu-open]');
      await p.page.waitForSelector('[data-testid=file-viewer]');
      const drawn = await poll(p.page, () => document.querySelector('[data-testid=pdf-page][data-drawn]') && document.querySelector('[data-testid=pdf-pages]').dataset.pages, null, 40000);
      check(Number(drawn) >= 1, `phone: PDF drawn inside the app (${drawn} page(s))`);
      await p.page.waitForTimeout(500);
      await shot(p.page, 'media-phone-pdf');
      await p.page.evaluate(() => (window.__share.length = 0));
      await p.page.click('[data-testid=fv-save]');
      const sh = await poll(p.page, () => window.__share[0], null, 4000);
      check(!!sh && sh.keys.join() === 'files' && sh.files[0].type === 'application/pdf' && /\.pdf$/i.test(sh.files[0].name), `viewer save: PDF shared under its name (${sh && sh.files[0].name.length} chars)`);
      await p.page.click('[data-testid=fv-back]');
      await p.page.waitForSelector('[data-testid=file-viewer]', { state: 'detached' });
      check((await p.page.evaluate(() => location.pathname)) === before, 'phone: Back from the viewer returns to the chat');
      // Bubble's own save button
      await p.page.evaluate(() => (window.__share.length = 0));
      await card.locator('[data-testid=att-file-save]').click();
      const sh3 = await poll(p.page, () => window.__share[0], null, 4000);
      check(!!sh3 && sh3.keys.join() === 'files', 'file bubble save button: share sheet (file already in memory)');
      await shot(p.page, 'media-phone-file');
    }
    if (chats.other) {
      await openChat(p.page, chats.other);
      check((await brokenImgs(p.page)) === 0, 'phone other connector: no broken-image icon');
      console.log(`     phone other connector CLS: ${await cls(p.page)}`);
      await shot(p.page, 'media-phone-other');
    }

    await albums(s, chats, all);

    for (const c of all) {
      console.log(`     writes aborted in this context: ${c.blocked.length} (${[...new Set(c.blocked)].slice(0, 4).join(', ')})`);
      if (c.csp.length) console.log('CSP:', c.csp.join('\n'));
      check(!c.csp.length, 'no CSP violation');
    }
    }
  } catch (e) {
    exitErr = e;
    console.error(e);
    check(false, `exception: ${e.message}`);
  } finally {
    for (const c of all) await c.ctx.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    for (const c of all) await c.ctx.close().catch(() => {});
    await logout(s.page);
    await s.browser.close();
  }
  done(s.csp);
})();
