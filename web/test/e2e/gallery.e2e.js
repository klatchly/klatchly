// The chat's "Media, links and files" page (0.14.21): opening from the header (/chat/<id>/media), month grid of
// thumbnails, viewer over the whole chat's media (paging older items, "Show in chat"), Files (file viewer, save),
// Links (new browsing context), Back / Esc / reload / phone edge swipe, multi-select (downloads on desktop, one
// share sheet on iPhone), and the low-priority "Mark all as read" (stubbed: never run for real).
// READ-ONLY: every context aborts every non-GET /api request, except the stubbed read-all. Share, downloads and the
// clipboard are stubbed in the page and only checked.
// Chats: the test chat (pictures, files) plus real chats found among the first of the list (GET only).
// sh web/test/e2e/run-offline.sh gallery.e2e.js
const { BASE, TEST_CHAT, check, step, open, enroll, logout, shot, done } = require('./lib');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const enc = encodeURIComponent;
const chatURL = (id, sub) => `${BASE}/chat/${enc(id)}${sub ? `/${sub}` : ''}`;
const short = (id) => (id ? `${id.slice(0, 8)}…` : '-');
const LB = '[data-testid=lightbox]';
const CELL = '[data-testid=media-cell]';

function stubs() {
  window.__share = [];
  window.__dl = [];
  Object.defineProperty(navigator, 'canShare', { value: (d) => !!d && Array.isArray(d.files) && d.files.length > 0, configurable: true });
  Object.defineProperty(navigator, 'share', {
    value: (d) => {
      window.__share.push({ keys: Object.keys(d), files: (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })) });
      return Promise.resolve();
    },
    configurable: true,
  });
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download')) return void window.__dl.push({ href: this.getAttribute('href'), download: this.download });
    return click.call(this);
  };
}

/**
 * A context that lets no write leave the page. Opening a chat (here: the test chat, or a real chat's media page,
 * which mounts its conversation underneath) marks it read when it has unread messages: that write is aborted
 * too, but expected, for the chats in `opened` only. Any other is a stray write (a chat marked read that the
 * user did not open).
 */
async function strictContext(s, phone, opened = new Set([TEST_CHAT])) {
  const ctx = await s.browser.newContext({
    ...(phone ? { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, userAgent: UA, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1200, height: 800 } }),
    locale: phone ? 'fr-FR' : 'en-US',
    storageState: await s.ctx.storageState(),
  });
  const blocked = [];
  const readAll = [];
  await ctx.route('**/api/**', (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET') return r.continue();
    // "Mark all as read": answered here, never sent (it would mark the real low-priority chats).
    if (path === '/api/inbox/low-priority/read-all') {
      readAll.push({ method: req.method(), body: req.postData(), type: req.headers()['content-type'] });
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 2, marked: 2, failed: 0, complete: true }) });
    }
    const read = /^\/api\/chats\/([^/]+)\/read$/.exec(path);
    if (!read || !opened.has(decodeURIComponent(read[1]))) blocked.push(`${req.method()} ${path.replace(/\/chats\/([^/]{0,6})[^/]*/, '/chats/$1…').slice(0, 60)}`);
    return r.abort();
  });
  await ctx.addInitScript(stubs);
  // The Home Screen app (the edge swipe is the app's own there; Safari has its own).
  if (phone) await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  const page = await ctx.newPage();
  const csp = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && csp.push(m.text()));
  return { ctx, page, blocked, csp, readAll };
}

const mediaPage = (page, id, tab) =>
  page.evaluate(async ([id, tab]) => {
    const r = await fetch(`/api/chats/${encodeURIComponent(id)}/media?tab=${tab}`);
    return r.ok ? r.json() : { status: r.status };
  }, [id, tab]);

/** Synthetic touches on an element (Chromium with hasTouch): a long press, or a drag from the left edge. */
async function touch(page, sel, path, holdMs = 0) {
  await page.evaluate(
    async ([sel, path, holdMs]) => {
      const el = document.querySelector(sel);
      const mk = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      const fire = (type, x, y) =>
        el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(x, y)], changedTouches: [mk(x, y)] }));
      fire('touchstart', path[0][0], path[0][1]);
      for (const [x, y] of path.slice(1)) {
        await new Promise((r) => setTimeout(r, 16));
        fire('touchmove', x, y);
      }
      if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
      const [lx, ly] = path[path.length - 1];
      fire('touchend', lx, ly);
    },
    [sel, path, holdMs],
  );
}

(async () => {
  const s = await open();
  await enroll(s.page);

  // Real chats with media, files or links, found among the first of the list (GET only).
  const ids = await s.page.evaluate(async () => (await (await fetch('/api/chats?limit=50')).json()).items.filter((c) => c.id.startsWith('!')).map((c) => c.id)); // the Desktop API's (Matrix room ids)
  let mediaChat;
  let linkChat;
  for (const id of ids.slice(0, 40)) {
    if (!mediaChat) {
      const p = await mediaPage(s.page, id, 'media');
      if (p.items && p.items.length >= 12 && p.hasMore) mediaChat = id;
    }
    if (!linkChat) {
      const p = await mediaPage(s.page, id, 'links');
      if (p.items && p.items.some((m) => (m.urls || []).length)) linkChat = id;
    }
    if (mediaChat && linkChat) break;
  }
  console.log(`     chats: media ${short(mediaChat)} links ${short(linkChat)}`);

  // ---------- Desktop ----------
  {
    // The real chats whose media and links pages it opens (their conversation mounts under the page).
    const { ctx, page, blocked, csp, readAll } = await strictContext(s, false, new Set([TEST_CHAT, mediaChat, linkChat].filter(Boolean)));
    await page.goto(chatURL(TEST_CHAT));
    await page.waitForSelector('[data-testid=conv-info]', { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.click('[data-testid=conv-info]');
    await page.waitForSelector(CELL, { timeout: 20000 });
    check(page.url() === chatURL(TEST_CHAT, 'media'), 'header opens /chat/<id>/media');
    check(await page.isVisible('[data-testid=conversation]'), 'the conversation stays mounted under the page');
    const cells = await page.locator(CELL).count();
    check(cells >= 3, `media grid shows the test chat's pictures (${cells})`);
    check((await page.locator('.media-month').count()) >= 1, 'month header');
    const src = await page.locator(`${CELL} img`).first().getAttribute('src');
    check(/^\/api\/thumb\/w\d+\.webp\?url=/.test(src || ''), 'grid cells load thumbnails, not originals');
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.media-row')).gridTemplateColumns.split(' ').length);
    check(cols >= 4, `desktop grid has ${cols} columns`);
    await shot(page, 'gallery-desktop');

    // Viewer over the chat's media, "Show in chat".
    const first = page.locator(CELL).first();
    const key = await first.getAttribute('data-media-key');
    await first.click();
    await page.waitForSelector(LB);
    await page.waitForTimeout(500);
    const counter = await page.textContent('[data-testid=lb-counter]');
    check(new RegExp(`/ ${cells}$`).test(counter.trim()), `viewer holds the whole list (${counter.trim()})`);
    check(await page.isVisible('[data-testid=lb-show-in-chat]'), 'Show in chat in the viewer');
    check(await page.isVisible('[data-testid=lb-forward]'), 'Forward in the viewer');
    await page.click('[data-testid=lb-show-in-chat]');
    await page.waitForSelector('[data-testid=chat-media]', { state: 'detached', timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.messages .msg.flash', { timeout: 5000 }).catch(() => {});
    const mid = key.slice(0, key.lastIndexOf(':'));
    check(page.url() === chatURL(TEST_CHAT), 'Show in chat returns to the conversation URL');
    check(await page.evaluate((mid) => { const el = document.querySelector('.messages .msg.flash'); return !!el && !document.querySelector('[data-testid=lightbox]') && (el.dataset.mid === mid || !!el.querySelector(`[data-tile-mid="${CSS.escape(mid)}"]`) || +el.dataset.album > 0); }, mid), 'jumped to the message (highlighted), viewer closed');
    check(!(await page.evaluate(() => history.state && (history.state.klatchlyLightbox || history.state.fromChat))), 'no viewer or media entry left in history');

    // Esc and Back leave the page; a reload keeps it.
    await page.click('[data-testid=conv-info]');
    await page.waitForSelector(CELL);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    check(page.url() === chatURL(TEST_CHAT) && !(await page.isVisible('[data-testid=chat-media]')), 'Esc closes the page');
    await page.click('[data-testid=conv-info]');
    await page.waitForSelector(CELL);
    await page.goBack();
    await page.waitForTimeout(500);
    check(page.url() === chatURL(TEST_CHAT) && !(await page.isVisible('[data-testid=chat-media]')), 'browser Back closes the page');
    await page.goto(chatURL(TEST_CHAT, 'files'));
    await page.waitForSelector('[data-testid=media-file]', { timeout: 20000 });
    step('direct link / reload on /files shows the page');
    check((await page.getAttribute('[data-testid=media-tab-files]', 'aria-selected')) === 'true', 'Files tab selected');
    const fileName = await page.textContent('[data-testid=media-file] .media-file-name');
    check(/\S/.test(fileName), `file row with its name (${fileName.trim()})`);
    check((await page.locator('[data-testid=media-file] svg.file-icon').count()) > 0, 'file icon');
    await page.click('[data-testid=media-file] .media-file-main');
    await page.waitForSelector('[data-testid=file-viewer]');
    step('tap on a file opens the file viewer');
    await page.click('[data-testid=fv-back]');
    await page.waitForTimeout(400);
    check((await page.locator('[data-testid=file-viewer]').count()) === 0 && page.url() === chatURL(TEST_CHAT, 'files'), 'viewer Back returns to the Files tab');
    await page.click('[data-testid=media-file-save]');
    await page.waitForTimeout(300);
    const dl1 = await page.evaluate(() => window.__dl.slice());
    check(dl1.length === 1 && /^\/api\/media\//.test(dl1[0].href) && dl1[0].download === fileName.trim(), `save = download under its name (${JSON.stringify(dl1[0] || {})})`);
    await page.click('[data-testid=media-back]');
    await page.waitForTimeout(400);
    check(page.url() === chatURL(TEST_CHAT), 'Back from a direct link goes to the conversation');

    // Multi-select: downloads one after another under their names.
    await page.goto(chatURL(TEST_CHAT, 'media'));
    await page.waitForSelector(CELL);
    await page.evaluate(() => (window.__dl.length = 0));
    await page.click('[data-testid=media-select]');
    for (let i = 0; i < 3; i++) await page.locator(CELL).nth(i).click();
    check((await page.textContent('[data-testid=media-selcount]')).includes('3'), 'three selected');
    check((await page.locator(LB).count()) === 0, 'tapping while selecting does not open the viewer');
    await page.click('[data-testid=media-share]');
    await page.waitForTimeout(1500);
    const dls = await page.evaluate(() => window.__dl.slice());
    check(dls.length === 3 && dls.every((d) => d.download && /^\/api\/media\//.test(d.href)), `3 downloads with real names (${dls.map((d) => d.download).join(', ')})`);
    await shot(page, 'gallery-select-desktop');
    await page.click('[data-testid=media-select]');
    check((await page.locator('[data-testid=media-selbar]').count()) === 0, 'Done leaves the selection');

    // A real chat: paging older items, from the grid and from the viewer (GET only).
    if (mediaChat) {
      const pages = [];
      page.on('request', (r) => r.url().includes('/media?tab=media') && pages.push(r.url()));
      await page.goto(chatURL(mediaChat, 'media'));
      await page.waitForSelector(CELL, { timeout: 20000 });
      await page.waitForTimeout(800);
      const n0 = await page.locator(CELL).count();
      const lastCell = page.locator(CELL).last();
      await lastCell.scrollIntoViewIfNeeded();
      await lastCell.click();
      await page.waitForSelector(LB);
      await page.waitForTimeout(2500);
      const c = (await page.textContent('[data-testid=lb-counter]')).trim();
      const [i, total] = c.split('/').map((x) => Number(x.trim()));
      check(pages.some((u) => u.includes('cursor=')) && total > n0 - 0, `the viewer near the oldest item loads older ones (${c}, grid had ${n0})`);
      check(i > 1, `still on the same picture after the older ones arrived (${c})`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await shot(page, 'gallery-real');
    }

    // Links: new browsing context, never this page.
    if (linkChat) {
      await page.goto(chatURL(linkChat, 'links'));
      await page.waitForSelector('[data-testid=media-link]', { timeout: 20000 });
      const links = await page.$$eval('[data-testid=media-link]', (as) => as.slice(0, 5).map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, title: a.querySelector('.media-link-title').textContent })));
      check(links.every((l) => /^https?:\/\//.test(l.href) && l.target === '_blank' && /noopener/.test(l.rel) && /noreferrer/.test(l.rel)), `links open in a new browsing context (${links.length})`);
      check(links.every((l) => l.title.trim()), 'each link has a title or its URL');
      await shot(page, 'gallery-links');
    }

    // Low priority: "Mark all as read" (stubbed), with a confirmation.
    await page.goto(BASE + '/');
    await page.waitForSelector('[data-testid=chat-row]');
    await page.click('[data-testid=open-lowpri]');
    const hasLow = await page.waitForSelector('[data-testid=lowpri-read-all]', { timeout: 10000 }).then(() => true, () => false);
    if (hasLow) {
      await page.click('[data-testid=lowpri-read-all]');
      await page.waitForSelector('[data-testid=confirm-read-all]');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      check(readAll.length === 0, 'cancel sends nothing');
      await page.click('[data-testid=lowpri-read-all]');
      await page.click('[data-testid=confirm-read-all-ok]');
      await page.waitForSelector('[data-testid=toast]', { timeout: 5000 });
      const toast = await page.textContent('[data-testid=toast]');
      check(readAll.length === 1 && readAll[0].method === 'POST' && readAll[0].body === '{}' && /json/.test(readAll[0].type), `one POST to read-all (${JSON.stringify(readAll[0] || {})})`);
      check(/2 chats marked as read/.test(toast), `result toast (${toast})`);
      await shot(page, 'lowpri-read-all');
    } else check(false, 'low-priority list with chats (Mark all as read)');

    check(!blocked.length, `no write left the page (${blocked.join(', ') || 'none'})`);
    check(!csp.length, `no CSP violation (${csp.length})`);
    await ctx.close();
  }

  // ---------- iPhone ----------
  {
    const { ctx, page, blocked, csp } = await strictContext(s, true);
    await page.goto(chatURL(TEST_CHAT));
    await page.waitForSelector('[data-testid=conv-info]', { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.tap('[data-testid=conv-info]');
    await page.waitForSelector(CELL, { timeout: 20000 });
    await page.waitForTimeout(500);
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.media-row')).gridTemplateColumns.split(' ').length);
    check(cols === 3, `phone grid has 3 columns (${cols})`);
    const box = await page.locator('[data-testid=chat-media]').boundingBox();
    check(box && Math.round(box.width) === 390 && box.x === 0, 'page covers the screen');
    check((await page.textContent('[data-testid=media-tab-media]')).trim() === 'Médias', 'French tabs');
    await shot(page, 'gallery-iphone');

    // Long press starts selecting; one share sheet with every file.
    await touch(page, `${CELL}:nth-child(1)`, [[60, 300]], 650);
    await page.waitForTimeout(300);
    check(await page.isVisible('[data-testid=media-selbar]'), 'long press starts the selection');
    check((await page.locator(LB).count()) === 0, 'long press does not open the viewer');
    await page.locator(CELL).nth(1).tap();
    await page.locator(CELL).nth(2).tap();
    check((await page.textContent('[data-testid=media-selcount]')).includes('3'), 'three selected (French)');
    await page.waitForTimeout(2500); // prefetched while selecting
    await page.tap('[data-testid=media-share]');
    await page.waitForTimeout(600);
    if (await page.isVisible('[data-testid=save-dock-go]')) await page.tap('[data-testid=save-dock-go]');
    await page.waitForTimeout(400);
    const sh = await page.evaluate(() => window.__share.slice());
    check(sh.length === 1 && sh[0].keys.join() === 'files' && sh[0].files.length === 3 && sh[0].files.every((f) => f.name && f.size > 0 && /^image\//.test(f.type)), `one share sheet with 3 files (${JSON.stringify(sh[0]?.files.map((f) => f.name))})`);
    await shot(page, 'gallery-iphone-select');
    await page.tap('[data-testid=media-select]');

    // Swipe from the left edge: back to the conversation, not to the list.
    await touch(page, '[data-testid=chat-media]', [[6, 400], [40, 402], [120, 404], [220, 405], [300, 406]]);
    await page.waitForTimeout(800);
    check(page.url() === chatURL(TEST_CHAT) && (await page.isVisible('[data-testid=conversation]')), 'edge swipe returns to the conversation');

    check(!blocked.length, `no write left the page (${blocked.join(', ') || 'none'})`);
    check(!csp.length, `no CSP violation (${csp.length})`);
    await ctx.close();
  }

  await logout(s.page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
