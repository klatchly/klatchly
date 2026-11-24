// Image lightbox: opening from a bubble, zoom/pan, previous/next, close (✕, Esc, backdrop, Back, swipe down),
// focus, history, download/original links, error state and Retry, phone gestures, no CSP violation. 0.14.20: the test
// chat's pictures (sent within a minute) form an album; its caption still shows in the viewer.
// Writes: only to the TEST chat (a few generated images when it has fewer than 3), re-archived at the end.
// A real WhatsApp chat with pictures is checked READ-ONLY (lib.js guard: mark-read and every write blocked).
// sh web/test/e2e/run-offline.sh lightbox.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, shot, done } = require('./lib');

const enc = encodeURIComponent;
const LB = '[data-testid=lightbox]';
// Pictures (videos open in the viewer too since 0.14.20; these checks are about pictures).
const PIC = '[data-media-key]:not(.att-vid)';

// --- Small generated pictures ------------------------------------------------------------------------------
/** GIF encoder without compression: a clear code before every pixel keeps the code width at 3 bits. */
function gif(w, h, frames) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const u16 = (n) => push(n & 255, n >> 8);
  push(...Buffer.from('GIF89a'));
  u16(w), u16(h), push(0xf1, 0, 0); // global table, 4 colours
  push(0x2f, 0x5d, 0x8a, 0xf2, 0xb1, 0x3c, 0xe8, 0xe8, 0xe8, 0x1e, 0x24, 0x2b);
  push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0); // loop forever
  for (const px of frames) {
    push(0x21, 0xf9, 4, 0, 50, 0, 0, 0); // 0.5 s per frame
    push(0x2c), u16(0), u16(0), u16(w), u16(h), push(0);
    push(2); // min code size
    const out = [];
    let acc = 0;
    let n = 0;
    const emit = (code) => {
      acc |= code << n;
      n += 3;
      while (n >= 8) out.push(acc & 255), (acc >>= 8), (n -= 8);
    };
    for (let i = 0; i < w * h; i++) emit(4), emit(px(i % w, Math.floor(i / w)));
    emit(5);
    if (n) out.push(acc & 255);
    for (let i = 0; i < out.length; i += 255) push(Math.min(255, out.length - i), ...out.slice(i, i + 255));
    push(0);
  }
  push(0x3b);
  return Buffer.from(bytes);
}

/** PNG / JPEG drawn on a canvas in the page. */
async function canvasImage(page, w, h, type, label, hue) {
  const b64 = await page.evaluate(
    async ([w, h, type, label, hue]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${hue} 60% 45%)`);
      grad.addColorStop(1, `hsl(${(hue + 80) % 360} 60% 30%)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgb(255 255 255 / 0.35)';
      for (let x = 0; x < w; x += 50) g.strokeRect(x, 0, 50, h);
      for (let y = 0; y < h; y += 50) g.strokeRect(0, y, w, 50);
      g.fillStyle = '#fff';
      g.font = `bold ${Math.round(h / 8)}px sans-serif`;
      g.textAlign = 'center';
      g.fillText(label, w / 2, h / 2);
      const blob = await new Promise((r) => c.toBlob(r, type, 0.85));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    },
    [w, h, type, label, hue],
  );
  return Buffer.from(b64, 'base64');
}

// --- Helpers -----------------------------------------------------------------------------------------------
/** page.waitForFunction evaluates strings (blocked by the app's CSP): poll with page.evaluate instead. */
async function poll(page, fn, arg, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    if (Date.now() > end) throw new Error(`poll timeout: ${String(fn).slice(0, 80)}`);
    await page.waitForTimeout(100);
  }
}
// ---------------------------------------------------------------------------------------------
const lbState = (page) =>
  page.evaluate(() => {
    const d = document.querySelector('[data-testid=lightbox]');
    if (!d) return null;
    const m = d.querySelector('[data-testid=lb-media]');
    return {
      open: d.open,
      role: d.getAttribute('role') || d.tagName.toLowerCase(),
      modal: d.getAttribute('aria-modal'),
      label: d.getAttribute('aria-label'),
      index: Number(d.dataset.index),
      scale: Number(d.dataset.scale),
      counter: d.querySelector('[data-testid=lb-counter]')?.textContent,
      transform: m?.style.transform || '',
      loaded: m ? (m.tagName === 'IMG' ? m.complete && m.naturalWidth > 0 : m.readyState >= 2) : false,
      src: m?.getAttribute('src'),
      spinner: !!d.querySelector('[data-testid=lb-loading]'),
      error: !!d.querySelector('[data-testid=lb-error]'),
      focusInside: d.contains(document.activeElement),
      htmlLocked: document.documentElement.classList.contains('lb-open'),
      hist: history.state && history.state.klatchlyLightbox === true,
    };
  });
const waitLoaded = (page) =>
  poll(page, () => {
    const m = document.querySelector('[data-testid=lightbox] [data-testid=lb-media]');
    return !!m && (m.tagName === 'IMG' ? m.complete && m.naturalWidth > 0 : m.readyState >= 2);
  }, null, 15000).then(() => true, () => false);
const closed = (page) => page.waitForSelector(LB, { state: 'detached', timeout: 3000 }).then(() => true, () => false);
const gap = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid=messages] [data-virtuoso-scroller]');
    return sc ? Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) : -1;
  });
const mediaBox = (page) => page.locator(`${LB} [data-testid=lb-media]`).boundingBox();

/** Same write guard as lib.js, for extra contexts. */
async function guard(ctx, blocked) {
  await ctx.route('**/api/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const touchesChat = url.pathname.startsWith('/api/chats/') || url.pathname.startsWith('/api/notify/');
    const isTest = url.pathname.includes(enc(TEST_CHAT)) || (req.postData() || '').includes(TEST_CHAT);
    if (req.method() !== 'GET' && touchesChat && !isTest) {
      blocked.push(`${req.method()} ${url.pathname.replace(/\/chats\/([^/]{0,6})[^/]*/, '/chats/$1…')}`);
      return route.abort();
    }
    return route.continue();
  });
}

async function testChatImages(page) {
  return page.evaluate(async (id) => {
    const r = await (await fetch(`/api/chats/${encodeURIComponent(id)}/messages`)).json();
    return r.items.filter((m) => !m.isDeleted && (m.attachments || []).some((a) => a.type === 'img' && !a.isSticker)).length;
  }, TEST_CHAT);
}

async function sendImages(page) {
  const tag = Date.now().toString(36);
  const png = await canvasImage(page, 1600, 1000, 'image/png', `PNG ${tag}`, 210);
  const jpg = await canvasImage(page, 900, 1300, 'image/jpeg', `JPEG ${tag}`, 20);
  const anim = gif(160, 120, [(x, y) => ((x >> 4) + (y >> 4)) % 2 ? 0 : 1, (x, y) => ((x >> 4) + (y >> 4)) % 2 ? 1 : 3]);
  const sendFiles = async (files, text) => {
    await page.setInputFiles('[data-testid=file-input]', files);
    await poll(page, (n) => {
      const items = [...document.querySelectorAll('[data-testid=tray-item]')];
      return items.length === n && items.every((i) => i.dataset.status === 'done');
    }, files.length, 30000);
    if (text) await page.fill('[data-testid=composer-input]', text);
    await page.click('[data-testid=send]');
    await page.waitForTimeout(2500);
  };
  await sendFiles([{ name: `lightbox-${tag}.png`, mimeType: 'image/png', buffer: png }], `lightbox caption ${tag}`);
  await sendFiles(
    [
      { name: `lightbox-${tag}.jpg`, mimeType: 'image/jpeg', buffer: jpg },
      { name: `lightbox-${tag}.gif`, mimeType: 'image/gif', buffer: anim },
    ],
    '',
  );
  // Wait for the echoes (real message IDs) to replace the optimistic bubbles.
  await poll(page, () => !document.querySelector('[data-testid=msg-outgoing]'), null, 30000).catch(() => {});
}

// --- Touch (CDP) -------------------------------------------------------------------------------------------
const touchEv = (cdp, type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
async function swipe(page, cdp, [x0, y0], [x1, y1], ms = 220, steps = 10) {
  await touchEv(cdp, 'touchStart', [[x0, y0]]);
  for (let i = 1; i <= steps; i++) {
    await touchEv(cdp, 'touchMove', [[x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]]);
    await page.waitForTimeout(ms / steps);
  }
  await touchEv(cdp, 'touchEnd', []);
}
async function doubleTap(page, cdp, x, y) {
  for (let i = 0; i < 2; i++) {
    await touchEv(cdp, 'touchStart', [[x, y]]);
    await touchEv(cdp, 'touchEnd', []);
    await page.waitForTimeout(90);
  }
}
async function pinch(page, cdp, cx, cy, from, to, steps = 10) {
  await touchEv(cdp, 'touchStart', [[cx - from, cy], [cx + from, cy]]);
  for (let i = 1; i <= steps; i++) {
    const d = from + ((to - from) * i) / steps;
    await touchEv(cdp, 'touchMove', [[cx - d, cy], [cx + d, cy]]);
    await page.waitForTimeout(20);
  }
  await touchEv(cdp, 'touchEnd', []);
}

(async () => {
  const s = await open({ locale: 'en-US' });
  const { page, ctx } = s;
  let exitErr;
  try {
    await enroll(page);
    const cdp = await ctx.newCDPSession(page);

    // ---------- 1. Test chat, desktop ----------
    await page.goto(`${BASE}/chat/${enc(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=msg]', { timeout: 30000 });
    if ((await testChatImages(page)) < 3) {
      console.log('     sending 3 generated images to the test chat');
      await sendImages(page);
    }
    await page.goto(`${BASE}/chat/${enc(TEST_CHAT)}`);
    await page.waitForSelector(PIC, { timeout: 30000 });
    await page.waitForTimeout(2000);
    const thumbs = page.locator(PIC);
    const n = await thumbs.count();
    check(n >= 3, `test chat shows ${n} openable pictures`);
    // The generated pictures went out within a minute: one album, the PNG's caption under its mosaic.
    const alb = await page.evaluate(() => {
      const a = [...document.querySelectorAll('[data-testid=album]')].pop();
      const m = a?.closest('[data-mid]');
      return a && { n: Number(a.dataset.count), tiles: a.querySelectorAll('[data-testid=album-tile]').length, caption: m.querySelector('[data-testid=msg-text]')?.textContent || '', below: !!m.querySelector('[data-testid=album] ~ [data-testid=msg-text]') };
    });
    check(!!alb && alb.n >= 2 && alb.tiles === Math.min(4, alb.n), `test chat pictures drawn as an album (${alb && `${alb.n} items`})`);
    check(!alb || !alb.caption || alb.below, `album caption under the mosaic ("${alb && alb.caption.slice(0, 24)}")`);
    const gap0 = await gap(page);
    const last = thumbs.last();
    const lastKey = await last.getAttribute('data-media-key');
    const box0 = await last.boundingBox();
    const hist0 = await page.evaluate(() => history.length);
    const url0 = page.url();
    const pages0 = ctx.pages().length;

    // Not mounted until opened.
    check((await page.locator(LB).count()) === 0, 'lightbox not in the DOM before opening');
    await last.click();
    await page.waitForSelector(LB);
    const ok = await waitLoaded(page);
    let st = await lbState(page);
    check(st.open && st.role === 'dialog' && st.modal === 'true' && st.label === 'Image viewer', `dialog, aria-modal, labelled (${JSON.stringify([st.role, st.modal, st.label])})`);
    check(ok && st.loaded && !st.spinner && !st.error, 'picture loaded, no spinner/error');
    check(ctx.pages().length === pages0, 'plain click opens no new tab');
    check(st.counter && /^\d+ \/ \d+$/.test(st.counter) && st.index === Number(st.counter.split(' / ')[1]) - 1, `counter on the last picture (${st.counter})`);
    check(st.src && /^\/api\/media\/[a-z0-9]+\.[a-z0-9]+\?/.test(st.src) && st.src === (await last.getAttribute('href')), 'same /api/media URL as the bubble');
    check(st.focusInside, 'focus moved into the dialog');
    check(st.htmlLocked, 'page scroll locked');
    check(st.hist && (await page.evaluate(() => history.length)) === hist0 + 1 && page.url() === url0, 'history entry pushed, URL unchanged');
    // Neighbour preloaded (rendered in the strip).
    const neighbour = await page.evaluate(() => document.querySelectorAll('[data-testid=lightbox] .lb-slide').length);
    check(neighbour >= 2, `neighbour picture preloaded (${neighbour} slides)`);
    await shot(page, 'lightbox-desktop');

    // Previous / next: keys and arrows.
    const total = Number(st.counter.split(' / ')[1]);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(400);
    st = await lbState(page);
    check(st.index === total - 2 && st.counter === `${total - 1} / ${total}`, `← goes to the previous picture (${st.counter})`);
    await page.click('[data-testid=lb-prev]');
    await page.waitForTimeout(400);
    check((await lbState(page)).index === total - 3, 'previous arrow');
    await page.click('[data-testid=lb-next]');
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    st = await lbState(page);
    check(st.index === total - 1 && !(await page.isVisible('[data-testid=lb-next]')), 'next arrow + →, no next arrow on the last picture');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    check((await lbState(page)).index === total - 1, '→ on the last picture stays');

    // Caption of the PNG message (sent with text) shows when on it.
    const capIdx = await page.evaluate(() => {
      const keys = [...document.querySelectorAll('[data-media-key]:not(.att-vid)')].map((a) => a.closest('[data-mid]'));
      return keys.findIndex((m) => m && m.querySelector('[data-testid=msg-text]'));
    });
    if (capIdx >= 0) {
      for (let i = total - 1; i > capIdx + (total - n); i--) await page.keyboard.press('ArrowLeft'), await page.waitForTimeout(300);
      const cs = await lbState(page);
      check(await page.isVisible('[data-testid=lb-caption]'), `caption shown for a picture with text (dom ${capIdx}, at ${cs.counter})`);
    }
    // Zoom tests on a big picture (a small one fits the screen even at 2.5×: nothing to pan).
    for (let i = 0; i < total; i++) {
      const big = await page.evaluate(() => (document.querySelector('[data-testid=lightbox] [data-testid=lb-media]')?.naturalWidth || 0) >= 800);
      if (big || (await lbState(page)).index === 0) break;
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(300);
    }

    // Zoom: wheel, double-click, pan, keys.
    await waitLoaded(page);
    let mb = await mediaBox(page);
    await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(250);
    st = await lbState(page);
    check(st.scale > 1.3, `wheel zooms in (${st.scale})`);
    const sc0 = await page.evaluate(() => document.querySelector('[data-testid=messages] [data-virtuoso-scroller]').scrollTop);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(250);
    st = await lbState(page);
    check(st.scale === 1, `wheel zooms back out to fit (${st.scale})`);
    const sc1 = await page.evaluate(() => document.querySelector('[data-testid=messages] [data-virtuoso-scroller]').scrollTop);
    check(sc0 === sc1, 'wheel over the lightbox does not scroll the list');
    mb = await mediaBox(page);
    await page.mouse.dblclick(mb.x + mb.width * 0.3, mb.y + mb.height * 0.3);
    await page.waitForTimeout(400);
    st = await lbState(page);
    check(Math.abs(st.scale - 2.5) < 0.01, `double-click zooms to 2.5× (${st.scale})`);
    const before = st.transform;
    await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.mouse.down();
    await page.mouse.move(mb.x + mb.width / 2 - 120, mb.y + mb.height / 2 - 60, { steps: 6 });
    await page.mouse.up();
    st = await lbState(page);
    check(st.transform !== before && st.scale > 2, `drag pans when zoomed (${before} -> ${st.transform})`);
    await shot(page, 'lightbox-desktop-zoomed');
    await page.mouse.dblclick(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.waitForTimeout(400);
    check((await lbState(page)).scale === 1, 'double-click again: back to 1×');
    await page.keyboard.press('+');
    await page.waitForTimeout(300);
    check((await lbState(page)).scale > 1.4, '+ zooms in');
    await page.keyboard.press('0');
    await page.waitForTimeout(300);
    check((await lbState(page)).scale === 1, '0 resets');
    await page.click('[data-testid=lb-zoom]');
    await page.waitForTimeout(300);
    check((await lbState(page)).scale === 2.5, 'zoom button');
    await page.click('[data-testid=lb-zoom]');
    await page.waitForTimeout(300);

    // Toolbar links.
    const dl = await page.evaluate(() => {
      const a = document.querySelector('[data-testid=lb-download]');
      const o = document.querySelector('[data-testid=lb-original]');
      return { href: a.getAttribute('href'), download: a.getAttribute('download'), oHref: o.getAttribute('href'), target: o.getAttribute('target'), rel: o.getAttribute('rel') };
    });
    check(/^\/api\/media\/[a-z0-9]+\.[a-z0-9]+\?/.test(dl.href) && !!dl.download, `download link (${dl.download})`);
    check(dl.oHref === dl.href && dl.target === '_blank' && /noopener/.test(dl.rel), 'open-original link in a new tab');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('[data-testid=lb-download]')]);
    const dlPath = download && (await download.path().catch(() => null));
    const dlSize = dlPath ? require('fs').statSync(dlPath).size : 0;
    check(!!download && dlSize > 100, `download works (${download && download.suggestedFilename()}, ${dlSize} B)`);

    // Focus trap.
    for (let i = 0; i < 9; i++) await page.keyboard.press('Tab');
    check((await lbState(page)).focusInside, 'Tab keeps the focus inside');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Tab');
    check((await lbState(page)).focusInside, 'Shift+Tab keeps the focus inside');

    // Esc closes, focus back on the picture, history entry popped, list still at the bottom.
    const shownKey = await page.evaluate(() => document.querySelector('[data-testid=lightbox] [data-testid=lb-media]')?.getAttribute('src'));
    await page.keyboard.press('Escape');
    check(await closed(page), 'Esc closes');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      focus: document.activeElement?.getAttribute('data-media-key'),
      hist: history.state && history.state.klatchlyLightbox,
      len: history.length,
      locked: document.documentElement.classList.contains('lb-open'),
    }));
    check(after.focus === lastKey, `focus restored to the clicked picture (${after.focus === lastKey})`);
    check(!after.hist && !after.locked && page.url() === url0, 'history entry popped, scroll lock released');
    const box1 = await last.boundingBox();
    check(box0 && box1 && Math.abs(box0.y - box1.y) < 2 && Math.abs(box0.height - box1.height) < 1, `no layout shift in the list (${box0?.y}/${box1?.y})`);
    const gap1 = await gap(page);
    check(gap0 <= 2 && gap1 <= 2, `list still at the bottom (${gap0} -> ${gap1})`);
    void shownKey;

    // ✕ button.
    await last.click();
    await page.waitForSelector(LB);
    await page.click('[data-testid=lb-close]');
    check(await closed(page), '✕ closes');
    await page.waitForTimeout(300);

    // Backdrop click.
    await last.click();
    await page.waitForSelector(LB);
    await waitLoaded(page);
    const stage = await page.locator('[data-testid=lb-stage]').boundingBox();
    mb = await mediaBox(page);
    // Bottom-left corner of the stage: always outside the picture (slide padding).
    void mb;
    await page.mouse.click(stage.x + 4, stage.y + stage.height - 3);
    check(await closed(page), 'click on the backdrop closes');
    await page.waitForTimeout(300);

    // Back button closes; then in-app navigation still works.
    await last.click();
    await page.waitForSelector(LB);
    await page.goBack();
    check(await closed(page), 'browser Back closes the lightbox');
    await page.waitForTimeout(500);
    check(page.url() === url0 && (await page.isVisible('[data-testid=conversation]')), 'still in the conversation after Back');
    await last.click();
    await page.waitForSelector(LB);
    await page.keyboard.press('Escape');
    await closed(page);
    await page.waitForTimeout(400);
    check(!(await page.evaluate(() => history.state && history.state.klatchlyLightbox)), 'no lightbox entry left in history');
    await page.goto(`${BASE}/chat/${enc(TEST_CHAT)}`);
    await page.waitForSelector(PIC, { timeout: 20000 });
    await page.waitForTimeout(1200);

    // Ctrl/middle click keep the link behaviour (new tab).
    const tl = page.locator(PIC).last();
    const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null), tl.click({ modifiers: ['Control'] })]);
    check(!!popup && (await page.locator(LB).count()) === 0, 'ctrl-click opens a new tab, no lightbox');
    await popup?.close();
    const [popup2] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null), tl.click({ button: 'middle' })]);
    check(!!popup2 && (await page.locator(LB).count()) === 0, 'middle-click opens a new tab, no lightbox');
    await popup2?.close();

    // Reduced motion: no slide animation.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await tl.click();
    await page.waitForSelector(LB);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(30);
    const rm = await page.evaluate(() => {
      const d = document.querySelector('[data-testid=lightbox]');
      return { index: Number(d.dataset.index), transition: getComputedStyle(d.querySelector('.lb-track')).transitionDuration };
    });
    check(rm.index === total - 2 && /^0s/.test(rm.transition), `reduced motion: instant change (${JSON.stringify(rm)})`);
    await page.keyboard.press('Escape');
    await closed(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // Error state: the last picture fails (404). Its bubble shows its own "unavailable · Retry" tile since 0.14.18
    // (nothing to open there): the viewer is opened on the picture before it, then → to the failing one. In a fresh
    // context (the page's own memory cache would keep serving the picture), GET only.
    const failing = new URL(await page.locator(PIC).last().getAttribute('href'), BASE);
    const failKey = failing.searchParams.get('url');
    const ectx = await s.browser.newContext({ viewport: { width: 1200, height: 800 }, locale: 'en-US', serviceWorkers: 'block', storageState: await ctx.storageState() });
    await ectx.route('**/api/**', (r) => {
      if (r.request().method() !== 'GET') return r.abort();
      const u = new URL(r.request().url());
      if ((u.pathname.startsWith('/api/media') || u.pathname.startsWith('/api/thumb')) && u.searchParams.get('url') === failKey) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
      return r.continue();
    });
    const ep = await ectx.newPage();
    await ep.goto(`${BASE}/chat/${enc(TEST_CHAT)}`);
    await ep.waitForSelector('[data-testid=media-error]', { timeout: 20000 }).catch(() => {});
    await ep.waitForTimeout(800);
    check((await ep.locator('[data-testid=media-error]').count()) >= 1, 'failing picture: "unavailable · Retry" tile in its bubble');
    await ep.locator(PIC).last().click();
    await ep.waitForSelector(LB);
    await ep.keyboard.press('ArrowRight');
    const errShown = await ep.waitForSelector(`${LB} [data-testid=lb-error]`, { timeout: 8000 }).then(() => true, () => false);
    check(errShown && (await ep.textContent('[data-testid=lb-error]')).includes('could not be loaded'), 'error state shown (localized)');
    check(await ep.isVisible('[data-testid=lb-original]'), 'open-original still offered on error');
    check(await ep.isVisible('[data-testid=lb-retry]'), 'Retry offered on error');
    await shot(ep, 'lightbox-error');
    // Retry while it still fails: the error again; once the picture is back, Retry loads it (new URL).
    await ep.click('[data-testid=lb-retry]');
    check(await ep.waitForSelector(`${LB} [data-testid=lb-error]`, { timeout: 8000 }).then(() => true, () => false), 'Retry while still failing: error again');
    await ectx.unrouteAll({ behavior: 'ignoreErrors' });
    await ectx.route('**/api/**', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
    await ep.click('[data-testid=lb-retry]');
    const back = await waitLoaded(ep);
    const rsrc = await ep.evaluate(() => document.querySelector('[data-testid=lightbox] [data-testid=lb-media]')?.getAttribute('src') || '');
    check(back && /[?&]r=2$/.test(rsrc), `Retry loads the picture again (${rsrc.slice(-6)})`);
    await ectx.unrouteAll({ behavior: 'ignoreErrors' });
    await ectx.close();

    // ---------- 2. Phone (touch), French ----------
    const pblocked = [];
    const phone = await s.browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, locale: 'fr-FR', storageState: await ctx.storageState() });
    await guard(phone, pblocked);
    const mp = await phone.newPage();
    const pcsp = [];
    mp.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && pcsp.push(m.text()));
    await mp.addInitScript(() => {
      localStorage.setItem('lang', 'fr');
      document.addEventListener('securitypolicyviolation', (e) => console.log(`Refused to (CSP) ${e.violatedDirective} ${e.blockedURI}`));
    });
    await mp.goto(`${BASE}/chat/${enc(TEST_CHAT)}`);
    await mp.waitForSelector(PIC, { timeout: 30000 });
    await mp.waitForTimeout(1500);
    const mcdp = await phone.newCDPSession(mp);
    const ml = mp.locator(PIC).last();
    const mhist0 = await mp.evaluate(() => history.length);
    await ml.tap();
    await mp.waitForSelector(LB);
    await waitLoaded(mp);
    st = await lbState(mp);
    const frLabel = await mp.getAttribute('[data-testid=lb-close]', 'aria-label');
    console.log(`     phone: lang=${await mp.evaluate(() => document.documentElement.lang)} close label=${frLabel}`);
    check(st.open && st.loaded && st.hist && (await mp.evaluate(() => history.length)) === mhist0 + 1, 'phone: tap opens, history entry pushed');
    check(!(await mp.isVisible('[data-testid=lb-prev]')), 'phone: no side arrows on touch');
    await shot(mp, 'lightbox-phone');
    const vw = 390;
    const sb = await mp.locator('[data-testid=lb-stage]').boundingBox();
    const cy = sb.y + sb.height / 2;
    // Swipe right → previous; swipe left → next.
    const i0 = st.index;
    await swipe(mp, mcdp, [vw * 0.2, cy], [vw * 0.85, cy]);
    await mp.waitForTimeout(500);
    check((await lbState(mp)).index === i0 - 1, 'phone: swipe right shows the previous picture');
    await shot(mp, 'lightbox-phone-prev');
    await swipe(mp, mcdp, [vw * 0.85, cy], [vw * 0.15, cy]);
    await mp.waitForTimeout(500);
    check((await lbState(mp)).index === i0, 'phone: swipe left shows the next picture');
    // Short slow drag snaps back.
    await swipe(mp, mcdp, [vw * 0.5, cy], [vw * 0.42, cy], 600);
    await mp.waitForTimeout(400);
    st = await lbState(mp);
    check(st.index === i0, 'phone: short drag snaps back');
    // Double-tap zoom, pan, double-tap back.
    await waitLoaded(mp);
    mb = await mediaBox(mp);
    await doubleTap(mp, mcdp, mb.x + mb.width / 2, mb.y + mb.height / 2);
    await mp.waitForTimeout(400);
    st = await lbState(mp);
    check(Math.abs(st.scale - 2.5) < 0.01, `phone: double-tap zooms (${st.scale})`);
    const t0 = st.transform;
    await swipe(mp, mcdp, [vw * 0.5, cy], [vw * 0.25, cy], 300);
    await mp.waitForTimeout(400);
    st = await lbState(mp);
    check(st.index === i0 && st.transform !== t0, 'phone: drag pans when zoomed (no page change)');
    await shot(mp, 'lightbox-phone-zoomed');
    await doubleTap(mp, mcdp, vw / 2, cy);
    await mp.waitForTimeout(400);
    check((await lbState(mp)).scale === 1, 'phone: double-tap back to 1×');
    // Pinch.
    await pinch(mp, mcdp, vw / 2, cy, 40, 120);
    await mp.waitForTimeout(400);
    st = await lbState(mp);
    check(st.scale > 2, `phone: pinch zooms (${st.scale})`);
    await pinch(mp, mcdp, vw / 2, cy, 140, 30);
    await mp.waitForTimeout(400);
    check((await lbState(mp)).scale === 1, 'phone: pinch in returns to 1×');
    // Swipe down closes (and pops the history entry).
    await swipe(mp, mcdp, [vw / 2, cy - 100], [vw / 2, cy + 150], 250);
    check(await closed(mp), 'phone: swipe down closes');
    await mp.waitForTimeout(500);
    check(!(await mp.evaluate(() => history.state && history.state.klatchlyLightbox)) && (await mp.evaluate(() => history.length)) >= mhist0, 'phone: history entry popped');
    // Back closes, and the conversation stays.
    await ml.tap();
    await mp.waitForSelector(LB);
    await mp.goBack();
    check(await closed(mp), 'phone: Back closes the lightbox');
    await mp.waitForTimeout(500);
    check(new URL(mp.url()).pathname.startsWith('/chat/'), 'phone: still in the conversation');
    // In-app back button still works.
    await mp.tap('[data-testid=conv-back]');
    await mp.waitForTimeout(600);
    check(new URL(mp.url()).pathname === '/', 'phone: conversation back button still goes to the list');
    check(!pcsp.length, `phone: no CSP violation${pcsp.length ? ` (${pcsp.join(' | ')})` : ''}`);
    check(!pblocked.length, `phone: no write attempted outside the test chat (${pblocked.join(', ')})`);
    await phone.close();

    // ---------- 3. Real WhatsApp chat, read-only ----------
    if (process.env.WA !== '0') {
      const found = await page.evaluate(async () => {
        let cursor;
        const tried = [];
        for (let p = 0; p < 4; p++) {
          const q = new URLSearchParams({ limit: '50', ...(cursor ? { cursor, direction: 'before' } : {}) });
          const r = await (await fetch(`/api/chats?${q}`)).json();
          for (const c of r.items || []) {
            if (!/whatsapp/i.test(c.network || '') || tried.length >= 40) continue;
            tried.push(c.id);
            const m = await (await fetch(`/api/chats/${encodeURIComponent(c.id)}/messages`)).json();
            const n = (m.items || []).filter((x) => !x.isDeleted && (x.attachments || []).some((a) => a.type === 'img' && !a.isSticker && a.srcURL)).length;
            if (n >= 2) return { id: c.id, n, tried: tried.length };
          }
          if (!r.hasMore || !r.oldestCursor) break;
          cursor = r.oldestCursor;
        }
        return { tried: tried.length };
      });
      if (!found.id) console.log(`     no WhatsApp chat with pictures in the latest pages (${found.tried} checked): skipped`);
      else {
        console.log(`     WhatsApp chat ${found.id.slice(0, 6)}… (${found.n} pictures in its latest page), read-only`);
        // Guard is active: a (harmless, invalid) write to that chat is aborted before leaving the browser.
        const probe = await page.evaluate(async (id) => {
          try {
            await fetch(`/api/chats/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            return 'sent';
          } catch {
            return 'blocked';
          }
        }, found.id);
        check(probe === 'blocked', 'write guard active for the real chat');
        const blockedBefore = s.blocked.length;
        await page.goto(`${BASE}/chat/${enc(found.id)}`);
        await page.waitForSelector('[data-testid=msg]', { timeout: 30000 });
        await page.waitForTimeout(2000);
        // The pictures may sit above the screen: scroll up (read-only) until one is rendered.
        const mbox = await page.locator('[data-testid=messages]').boundingBox();
        await page.mouse.move(mbox.x + mbox.width / 2, mbox.y + mbox.height / 2);
        for (let i = 0; i < 30 && !(await page.locator(PIC).count()); i++) {
          await page.mouse.wheel(0, -500);
          await page.waitForTimeout(250);
        }
        const wthumbs = page.locator(PIC);
        await wthumbs.last().scrollIntoViewIfNeeded();
        await poll(page, () => [...document.querySelectorAll('[data-media-key]:not(.att-vid) img')].some((i) => i.complete && i.naturalWidth > 0), null, 15000).catch(() => {});
        const wn = await wthumbs.count();
        const rendered = await page.evaluate(() => [...document.querySelectorAll('[data-media-key]:not(.att-vid) img')].filter((i) => i.complete && i.naturalWidth > 0).length);
        check(wn >= 1 && rendered >= 1, `WhatsApp pictures render in the list (${rendered}/${wn})`);
        await wthumbs.last().click();
        await page.waitForSelector(LB);
        const wok = await waitLoaded(page);
        st = await lbState(page);
        check(wok && st.loaded && /^\d+ \/ \d+$/.test(st.counter), `WhatsApp picture opens in the lightbox (${st.counter})`);
        if (st.index > 0) {
          await page.keyboard.press('ArrowLeft');
          await page.waitForTimeout(400);
          const wl = await waitLoaded(page);
          const ws = await lbState(page);
          // Older pages may still be arriving (prepended pictures shift the index): compare the picture itself.
          check(ws.src !== st.src && wl, `WhatsApp: previous picture loads (${JSON.stringify({ i: ws.index, loaded: wl, spinner: ws.spinner, error: ws.error, kind: ws.src && ws.src.includes('type=video') ? 'video' : 'img' })})`);
        }
        await page.keyboard.press('Escape');
        check(await closed(page), 'WhatsApp: Esc closes');
        const writes = s.blocked.slice(blockedBefore);
        console.log(`     blocked while viewing: ${writes.join(', ') || 'none'}`);
        check(writes.every((w) => /^POST \/api\/chats\/[^/]+\/read$/.test(w)), 'only mark-read was attempted, and it was blocked');
        await page.goto(`${BASE}/`);
        await page.waitForTimeout(500);
      }
    }
    check(!s.csp.length, `no CSP violation${s.csp.length ? ` (${s.csp.length})` : ''}`);
  } catch (e) {
    exitErr = e;
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    // Test chat back to the archive (any send unarchives it).
    const arch = await page
      .evaluate(async (id) => {
        const r = await fetch(`/api/chats/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
        await new Promise((res) => setTimeout(res, 1500));
        const c = await (await fetch(`/api/chats/${encodeURIComponent(id)}`)).json();
        return { status: r.status, isArchived: c.isArchived };
      }, TEST_CHAT)
      .catch((e) => ({ error: String(e) }));
    console.log(`     test chat re-archived: ${JSON.stringify(arch)}`);
    check(arch.isArchived === true, 'test chat archived again');
    // Our own session cookie, to revoke it afterwards (prefix = sha256 of the cookie value).
    const cookies = await ctx.cookies();
    const sid = cookies.find((c) => c.name === '__Host-sid' || c.name === 'sid');
    if (sid) console.log(`     SESSION_PREFIX=${require('crypto').createHash('sha256').update(sid.value).digest('hex').slice(0, 12)}`);
    await s.browser.close();
    void exitErr;
    done(s.csp);
  }
})();
