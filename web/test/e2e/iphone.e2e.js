// iPhone home-screen app (0.10.x): emulated iPhone (touch, iOS UA, navigator.standalone). Read-only: the phone
// context lets only GET requests through (mark-read on open included), and only the TEST chat is opened.
// sh web/test/e2e/run-offline.sh iphone.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, settingsPage, leaveSettings, shot, done } = require('./lib');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const chatURL = (id) => `${BASE}/chat/${encodeURIComponent(id)}`;

async function phoneContext(s, { width = 390, height = 844 } = {}) {
  const ctx = await s.browser.newContext({
    viewport: { width, height },
    screen: { width, height },
    userAgent: UA,
    isMobile: true,
    hasTouch: true,
    locale: 'fr-FR',
    storageState: await s.ctx.storageState(),
  });
  const blocked = [];
  await ctx.route('**/api/**', (r) => {
    if (r.request().method() === 'GET') return r.continue();
    blocked.push(`${r.request().method()} ${new URL(r.request().url()).pathname.slice(0, 40)}`);
    return r.abort();
  });
  await ctx.addInitScript(() => {
    // Emulated touch in desktop Chromium navigates back on a horizontal overscroll (swipe from the edge), which a
    // home-screen app on an iPhone never does: off, so the swipe checks see the app's own gestures only.
    document.addEventListener('DOMContentLoaded', () => (document.documentElement.style.overscrollBehaviorX = 'none'));
    Object.defineProperty(navigator, 'standalone', { value: true });
    localStorage.setItem('lang', 'fr');
    // Count WebSocket connections (reconnect after a long background).
    const WS = window.WebSocket;
    window.__ws = 0;
    window.WebSocket = class extends WS {
      constructor(...a) {
        super(...a);
        window.__ws++;
      }
    };
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp, blocked };
}

const touch = (cdp, type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
async function longPress(page, cdp, x, y, ms = 700) {
  await touch(cdp, 'touchStart', [[x, y]]);
  await page.waitForTimeout(ms);
  await touch(cdp, 'touchEnd', []);
}

/** Every :hover selector of the app's stylesheets that is not inside @media (hover: hover). */
const looseHover = (page) =>
  page.evaluate(() => {
    const out = [];
    const walk = (rules, inHover) => {
      for (const r of rules) {
        if (r instanceof CSSMediaRule) walk(r.cssRules, inHover || /hover:\s*hover/.test(r.conditionText || r.media.mediaText));
        else if (r.cssRules && r.cssRules.length) walk(r.cssRules, inHover);
        else if (r.selectorText && r.selectorText.includes(':hover') && !inHover) out.push(r.selectorText);
      }
    };
    for (const sh of document.styleSheets) {
      try {
        walk(sh.cssRules, false);
      } catch {}
    }
    return out;
  });

const listScroller = (page) => page.evaluate(() => {
  const el = document.querySelector('.pane-list [data-virtuoso-scroller]');
  return el ? Math.round(el.scrollTop) : -1;
});
const nav = (page) => page.evaluate(() => ({ path: location.pathname, len: history.length, state: history.state }));
async function edgeSwipe(page, cdp, toX, { y = 420, steps = 12, ms = 240, probe } = {}) {
  await touch(cdp, 'touchStart', [[6, y]]);
  let mid;
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', [[6 + ((toX - 6) * i) / steps, y + i]]);
    await page.waitForTimeout(ms / steps);
    if (i === Math.floor(steps / 2) && probe) mid = await probe();
  }
  await touch(cdp, 'touchEnd', []);
  return mid;
}

async function lotB({ page: mp, cdp }) {
  await mp.goto(`${BASE}/`);
  await mp.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
  await mp.waitForTimeout(1000);
  await mp.evaluate(() => {
    const el = document.querySelector('.pane-list [data-virtuoso-scroller]');
    if (el) el.scrollTop = 900;
  });
  await mp.waitForTimeout(600);
  const s0 = await listScroller(mp);
  const n0 = await nav(mp);
  // A row in the middle of the screen (opening a real chat: the phone context lets no write through).
  const id = await mp.evaluate(() => document.elementFromPoint(195, 420)?.closest('[data-testid=chat-row]')?.dataset.chatId);
  const row = mp.locator(`[data-testid=chat-row][data-chat-id="${id}"]`);
  await row.tap();
  const entering = await mp.waitForSelector('.shell.entering', { timeout: 1500 }).then(() => true, () => false);
  await mp.waitForSelector('[data-testid=conversation]', { timeout: 15000 });
  let n1 = await nav(mp);
  check(n1.path === `/chat/${encodeURIComponent(id)}` && n1.state?.fromList === true && n1.len === n0.len + 1, `tap from the list: chat entry marked fromList (${JSON.stringify(n1)})`);
  check(entering, 'chat slides in over the list');
  await mp.waitForTimeout(500);
  const hidden = await mp.$eval('.pane-list', (el) => getComputedStyle(el).visibility);
  check(hidden === 'hidden', `list hidden (not removed) under the chat (${hidden})`);
  await mp.waitForTimeout(500);
  await mp.tap('[data-testid=conv-back]');
  await mp.waitForTimeout(700);
  let n2 = await nav(mp);
  const s1 = await listScroller(mp);
  check(n2.path === '/' && n2.len === n1.len, `Back pops the entry: no new list entry (${n0.len} -> ${n1.len} -> ${n2.len})`);
  check(s0 > 0 && Math.abs(s1 - s0) < 4, `list scroll position kept (${s0} -> ${s1})`);
  await shot(mp, 'iphone-back-list');

  // Edge swipe: the pane follows the finger with the list visible under it, and goes back past 35 %.
  await mp.locator(`[data-testid=chat-row][data-chat-id="${id}"]`).tap();
  await mp.waitForSelector('[data-testid=conversation]', { timeout: 15000 });
  await mp.waitForTimeout(800);
  const len1 = (await nav(mp)).len;
  const mid = await edgeSwipe(mp, cdp, 120, {
    steps: 12,
    ms: 600,
    probe: () =>
      mp.evaluate(() => ({
        tf: document.querySelector('.pane-chat').style.transform,
        list: getComputedStyle(document.querySelector('.pane-list')).visibility,
      })),
  });
  await mp.waitForTimeout(500);
  check(/translateX\((\d+)/.test(mid?.tf || '') && mid.list === 'visible', `mid-swipe: pane dragged, list visible (${JSON.stringify(mid)})`);
  check((await nav(mp)).path !== '/', 'short slow swipe (120 px of 390) snaps back: still in the chat');
  check((await mp.$eval('.pane-chat', (el) => el.style.transform)) === '', 'pane back in place after the snap');
  await shot(mp, 'iphone-swipe-snap');
  await edgeSwipe(mp, cdp, 260, { steps: 10, ms: 200 });
  await mp.waitForTimeout(800);
  const n3 = await nav(mp);
  check(n3.path === '/' && n3.len === len1, `long swipe goes back, history not grown (${len1} -> ${n3.len})`);
  check(Math.abs((await listScroller(mp)) - s0) < 4, 'list scroll position kept after the swipe');
  // A quick flick goes back too.
  await mp.locator(`[data-testid=chat-row][data-chat-id="${id}"]`).tap();
  await mp.waitForSelector('[data-testid=conversation]', { timeout: 15000 });
  await mp.waitForTimeout(800);
  await edgeSwipe(mp, cdp, 110, { steps: 3, ms: 30 });
  await mp.waitForTimeout(800);
  check((await nav(mp)).path === '/', 'quick flick (104 px) goes back');

  // A swipe starting away from the edge does not go back (bubbles keep swipe-to-reply).
  await mp.goto(chatURL(TEST_CHAT));
  await mp.waitForSelector('[data-testid=conversation]', { timeout: 15000 });
  await mp.waitForTimeout(1000);
  const n4 = await nav(mp);
  await touch(cdp, 'touchStart', [[80, 420]]);
  for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', [[80 + i * 30, 420]]);
  await touch(cdp, 'touchEnd', []);
  await mp.waitForTimeout(600);
  check((await nav(mp)).path === n4.path, 'swipe from x=80 does not leave the chat');
  if (await mp.isVisible('[data-testid=reply-bar]')) await mp.tap('[data-testid=cancel-reply]');

  // Lightbox history still works, then Back from a chat not opened from the list replaces it with the list.
  const media = mp.locator('[data-media-key]').last();
  if (await media.count()) {
    await media.scrollIntoViewIfNeeded();
    const h0 = (await nav(mp)).len;
    await media.tap();
    await mp.waitForSelector('[data-testid=lightbox]', { timeout: 5000 });
    const lbState = await nav(mp);
    await mp.tap('[data-testid=lb-close]');
    await mp.waitForTimeout(600);
    const after = await nav(mp);
    check(lbState.len === h0 + 1 && lbState.state?.klatchlyLightbox && !after.state?.klatchlyLightbox && after.path === n4.path, `lightbox: own history entry, closed by ✕ (${h0} -> ${lbState.len})`);
  }
  await mp.tap('[data-testid=conv-back]');
  await mp.waitForTimeout(700);
  const n5 = await nav(mp);
  check(n5.path === '/' && n5.len <= n4.len + 1, `Back from a direct link: list replaces the chat (${JSON.stringify({ before: n4.len, after: n5.len })})`);
  await mp.goBack().catch(() => {});
  await mp.waitForTimeout(500);
  check((await nav(mp)).path !== chatURL(TEST_CHAT).replace(BASE, ''), 'history Back does not return to the replaced chat');
}

/** The test chat seen with `unread` unread messages, all of them from someone else (routes only, read-only). */
async function fakeUnread(ctx, unread) {
  const base = `/api/chats/${encodeURIComponent(TEST_CHAT)}`;
  // Errors once the context is closed (a request still in flight) are not test failures.
  const safe = (fn) => async (r) => {
    try {
      if (r.request().method() !== 'GET') return await r.abort();
      await fn(r);
    } catch {}
  };
  await ctx.route((u) => u.pathname === base, safe(async (r) => {
    const res = await r.fetch();
    const j = await res.json();
    await r.fulfill({ status: res.status(), json: { ...j, unreadCount: unread } });
  }));
  await ctx.route((u) => u.pathname === `${base}/messages`, safe(async (r) => {
    const res = await r.fetch();
    const j = await res.json();
    j.items = (j.items || []).map((m) => ({ ...m, isSender: false, senderName: m.senderName || 'Test' }));
    await r.fulfill({ status: res.status(), json: j });
  }));
}
const atBottomOf = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.messages [data-virtuoso-scroller]');
    return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1;
  });

async function lotC(s, phones) {
  // Few unread: divider above the 3rd message from the end, list still opens at the bottom.
  let p = await phoneContext(s);
  phones.push(p);
  await fakeUnread(p.ctx, 3);
  await p.page.goto(chatURL(TEST_CHAT));
  await p.page.waitForSelector('[data-testid=msg]', { timeout: 30000 });
  await p.page.waitForTimeout(1500);
  let d = await p.page.evaluate(() => {
    const div = document.querySelector('[data-testid=unread-divider]');
    const msgs = [...document.querySelectorAll('[data-testid=msg]')];
    const own = div?.closest('.msg-wrap')?.querySelector('[data-testid=msg]');
    return { text: div?.textContent, fromEnd: own ? msgs.length - msgs.indexOf(own) : -1 };
  });
  check(d.text === '3 nouveaux messages' && d.fromEnd === 3, `3 unread: divider « 3 nouveaux messages » above the 3rd last message (${JSON.stringify(d)})`);
  let gap = await atBottomOf(p.page);
  check(gap >= 0 && gap < 4, `3 unread: opens at the bottom (${gap} px from it)`);
  await shot(p.page, 'iphone-unread-3');

  // Shorter scroller (keyboard up, say): a list at the bottom stays there.
  await p.page.setViewportSize({ width: 390, height: 520 });
  await p.page.waitForTimeout(600);
  gap = await atBottomOf(p.page);
  check(gap >= 0 && gap < 4, `scroller shrinks: still pinned to the bottom (${gap} px)`);
  await p.page.setViewportSize({ width: 390, height: 844 });

  // Offline: the band under the header, gone once back online and reconnected.
  await p.ctx.setOffline(true);
  const off = await p.page.waitForSelector('[data-testid=conn-bar][data-state=offline]', { timeout: 4000 }).then(() => true, () => false);
  check(off && (await p.page.textContent('[data-testid=conn-bar]')) === 'Hors ligne', 'offline: « Hors ligne » band under the header');
  await shot(p.page, 'iphone-offline');
  await p.ctx.setOffline(false);
  const back = await p.page.waitForSelector('[data-testid=conn-bar]', { state: 'detached', timeout: 20000 }).then(() => true, () => false);
  check(back, 'back online: band gone once the socket is open again');
  await p.ctx.unrouteAll({ behavior: 'ignoreErrors' });
  await p.ctx.close();

  // Many unread: opens at the divider (top of the screen), not at the bottom.
  p = await phoneContext(s);
  phones.push(p);
  await fakeUnread(p.ctx, 30);
  await p.page.goto(chatURL(TEST_CHAT));
  await p.page.waitForSelector('[data-testid=unread-divider]', { timeout: 30000 });
  await p.page.waitForTimeout(1500);
  d = await p.page.evaluate(() => {
    const div = document.querySelector('[data-testid=unread-divider]');
    const sc = document.querySelector('.messages [data-virtuoso-scroller]');
    return { text: div?.textContent, top: Math.round(div.getBoundingClientRect().top - sc.getBoundingClientRect().top) };
  });
  gap = await atBottomOf(p.page);
  check(/nouveaux messages/.test(d.text || '') && d.top >= -4 && d.top < 120, `many unread: divider at the top of the list (${JSON.stringify(d)})`);
  check(gap > 100 && (await p.page.isVisible('[data-testid=new-messages]')), `many unread: not stuck to the bottom (${gap} px above it)`);
  await shot(p.page, 'iphone-unread-many');
}

async function drag(page, cdp, [x, y0], y1, { steps = 8, ms = 400 } = {}) {
  await touch(cdp, 'touchStart', [[x, y0]]);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', [[x, y0 + ((y1 - y0) * i) / steps]]);
    await page.waitForTimeout(ms / steps);
  }
  await touch(cdp, 'touchEnd', []);
}

async function lotD(s, phones) {
  const p = await phoneContext(s, { width: 360, height: 780 });
  phones.push(p);
  const mp = p.page;
  const cdp = p.cdp;
  // Slow first page: skeleton bubbles, not a bare "…".
  const base = `/api/chats/${encodeURIComponent(TEST_CHAT)}/messages`;
  await p.ctx.route((u) => u.pathname === base, async (r) => {
    try {
      if (r.request().method() !== 'GET') return await r.abort();
      await new Promise((res) => setTimeout(res, 1500));
      await r.continue();
    } catch {}
  });
  await mp.goto(chatURL(TEST_CHAT));
  const sk = await mp.waitForSelector('.messages [data-testid=skeleton]', { timeout: 5000 }).then(() => true, () => false);
  check(sk, 'messages loading: skeleton bubbles');
  await shot(mp, 'iphone-skeleton');
  await mp.waitForSelector('[data-testid=msg]', { timeout: 30000 });
  await mp.waitForTimeout(1200);

  // Playwright cannot emulate (pointer: coarse): apply that block's rules to this page by hand.
  const coarse = await mp.evaluate(() => {
    for (const sh of document.styleSheets)
      for (const r of sh.cssRules)
        if (r instanceof CSSMediaRule && /pointer:\s*coarse/.test(r.conditionText) && /\.icon-btn \{[^}]*width: 44px/.test(r.cssText)) {
          // CSSOM, not a <style> element: the page's CSP blocks inline styles.
          for (const x of [...r.cssRules]) sh.insertRule(x.cssText, sh.cssRules.length);
          return true;
        }
    return false;
  });
  check(coarse, 'touch rules: 44 px icon buttons under (pointer: coarse)');
  // 360 px wide: headers fit, buttons are 44 px.
  const fit = await mp.evaluate(() => {
    const h = document.querySelector('.conv-header');
    const b = document.querySelector('.conv-header .icon-btn');
    return { over: h.scrollWidth - h.clientWidth, btn: Math.round(b.getBoundingClientRect().height) };
  });
  check(fit.over <= 0 && fit.btn === 44, `360 px: conversation header fits, 44 px buttons (${JSON.stringify(fit)})`);
  const track = await mp.$('[data-testid=voice-track]');
  if (track) {
    const tb = await track.evaluate((el) => ({ hit: Math.round(el.getBoundingClientRect().height), bar: Math.round(el.firstElementChild.getBoundingClientRect().height) }));
    check(tb.hit === 24 && tb.bar === 6, `voice track: 24 px hit box, 6 px bar (${JSON.stringify(tb)})`);
  }

  // Long-press cue, then the sheet: grab handle, one-line preview, drag down to close.
  const bubbles = mp.locator('[data-testid=msg] [data-testid=bubble]');
  const bb = await bubbles.nth((await bubbles.count()) - 1).boundingBox();
  const bx = bb.x + Math.min(30, bb.width / 2);
  const by = bb.y + bb.height / 2;
  await touch(cdp, 'touchStart', [[bx, by]]);
  await mp.waitForTimeout(330);
  const cue = await mp.evaluate(() => !!document.querySelector('.bubble.pressing'));
  await mp.waitForTimeout(400);
  await touch(cdp, 'touchEnd', []);
  check(cue, 'long-press under way: bubble scaled down (pressing)');
  await mp.waitForSelector('[data-testid=message-menu]');
  await mp.waitForTimeout(400);
  const sheet = await mp.evaluate(() => ({
    grab: !!document.querySelector('[data-testid=message-menu] .sheet-grab'),
    preview: document.querySelector('[data-testid=sheet-preview]')?.textContent || '',
    pressing: !!document.querySelector('.bubble.pressing'),
  }));
  check(sheet.grab && sheet.preview.length > 0 && !sheet.pressing, `sheet: grab handle and message preview (${JSON.stringify(sheet.preview.slice(0, 40))})`);
  await shot(mp, 'iphone-sheet-d');
  const grab = await mp.locator('[data-testid=message-menu] .sheet-grab').boundingBox();
  await drag(mp, cdp, [grab.x + grab.width / 2, grab.y + 2], grab.y + 32);
  await mp.waitForTimeout(400);
  check(await mp.isVisible('[data-testid=message-menu]'), 'short slow drag: the sheet springs back');
  await drag(mp, cdp, [grab.x + grab.width / 2, grab.y + 2], grab.y + 220, { steps: 8, ms: 300 });
  await mp.waitForTimeout(500);
  check(!(await mp.isVisible('[data-testid=message-menu]')), 'drag down: the sheet closes');

  // Chat list menu (long-press a row; nothing is chosen in it).
  await mp.goto(`${BASE}/`);
  await mp.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
  await mp.waitForTimeout(800);
  await longPress(mp, cdp, 180, 300, 800);
  const cm = await mp.waitForSelector('[data-testid=chat-menu]', { timeout: 3000 }).then(() => true, () => false);
  check(cm && !!(await mp.$('[data-testid=chat-menu] .sheet-grab')), 'chat menu: bottom sheet with a grab handle');
  if (cm) {
    const g2 = await mp.locator('[data-testid=chat-menu] .sheet-grab').boundingBox();
    await drag(mp, cdp, [g2.x + g2.width / 2, g2.y + 2], g2.y + 200, { steps: 6, ms: 200 });
    await mp.waitForTimeout(500);
    check(!(await mp.isVisible('[data-testid=chat-menu]')), 'chat menu: drag down closes it');
  }
  await mp.evaluate(() => {
    for (const sh of document.styleSheets)
      for (const r of sh.cssRules)
        if (r instanceof CSSMediaRule && /pointer:\s*coarse/.test(r.conditionText) && /\.icon-btn \{[^}]*width: 44px/.test(r.cssText)) {
          for (const x of [...r.cssRules]) sh.insertRule(x.cssText, sh.cssRules.length);
          return;
        }
  });
  const lh = await mp.evaluate(() => {
    const h = document.querySelector('.list-header');
    return { over: h.scrollWidth - h.clientWidth, btns: [...h.querySelectorAll('.icon-btn')].map((b) => Math.round(b.getBoundingClientRect().width)) };
  });
  check(lh.over <= 0 && lh.btns.every((w) => w === 44), `360 px: list header fits, 44 px buttons (${JSON.stringify(lh)})`);
  await shot(mp, 'iphone-list-360');

  // Colours, focus ring, reduced motion.
  const man = await mp.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  const meta = await mp.$$eval('meta[name=theme-color]', (els) => els.map((e) => e.content));
  check(man.theme_color === '#1b2127' && man.background_color === '#14191e' && meta.join() === '#ffffff,#1b2127', `manifest and theme-color follow the panes (${man.theme_color} ${man.background_color} ${meta.join()})`);
  const fv = await mp.evaluate(() => [...document.styleSheets].some((sh) => [...sh.cssRules].some((r) => r.selectorText === ':focus-visible')));
  check(fv, 'shared :focus-visible outline');
  await mp.emulateMedia({ reducedMotion: 'reduce' });
  const rm = await mp.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'msg-menu sheet';
    document.body.append(probe);
    const row = document.createElement('div');
    row.className = 'bubble-row';
    document.body.append(row);
    const out = { sheet: getComputedStyle(probe).animationName, row: getComputedStyle(row).transitionDuration };
    probe.remove();
    row.remove();
    return out;
  });
  check(rm.sheet === 'none' && rm.row === '0s', `reduced motion: no sheet animation, no bubble-row transition (${JSON.stringify(rm)})`);
  await p.ctx.unrouteAll({ behavior: 'ignoreErrors' });
}

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  const phones = [];
  try {
    await enroll(page);

    // ---------- Lot A: quick fixes ----------
    const loose = await looseHover(page);
    check(loose.length === 0, `no :hover rule outside @media (hover: hover) (${loose.join(' | ') || 'none'})`);
    const tap = await page.evaluate(() => getComputedStyle(document.documentElement).touchAction);
    check(tap === 'manipulation', `html touch-action: manipulation (${tap})`);
    check(!(await page.$('.list-header [data-testid=logout]')), 'no sign-out button in the list header');
    check(!!(await page.$('[data-testid=open-settings] svg circle')), 'settings button shows a gear');
    await settingsPage(page, 'account');
    await page.click('[data-testid=logout]');
    check(await page.isVisible('[data-testid=logout-confirm]'), 'sign-out asks for a confirmation');
    await shot(page, 'iphone-signout-confirm');
    await page.click('[data-testid=logout-cancel]');
    check(await page.isVisible('[data-testid=logout]') && !(await page.isVisible('[data-testid=logout-confirm]')), 'cancel keeps the session');
    await leaveSettings(page);

    const p = await phoneContext(s);
    phones.push(p);
    const mp = p.page;
    await mp.goto(chatURL(TEST_CHAT));
    await mp.waitForSelector('[data-testid=composer-input]', { timeout: 30000 });
    await mp.waitForSelector('[data-testid=msg]', { timeout: 30000 }).catch(() => {});
    await mp.waitForTimeout(1200);

    // Keyboard: html.kb-open while the composer has the focus; no safe-area padding then.
    await mp.focus('[data-testid=composer-input]');
    const kb = await mp.evaluate(() => ({ cls: document.documentElement.classList.contains('kb-open'), pad: getComputedStyle(document.querySelector('.composer')).paddingBottom }));
    check(kb.cls && kb.pad === '8px', `focus: html.kb-open, composer padding-bottom 8px (${JSON.stringify(kb)})`);
    await mp.evaluate(() => document.activeElement.blur());
    await mp.waitForTimeout(100);
    check(!(await mp.evaluate(() => document.documentElement.classList.contains('kb-open'))), 'blur: kb-open removed');

    // Long-press a bubble: the sheet opens and stays open after the finger lifts (no synthetic click).
    const bubbles = mp.locator('[data-testid=msg] [data-testid=bubble]');
    const nb = await bubbles.count();
    if (nb) {
      const bb = await bubbles.nth(nb - 1).boundingBox();
      await longPress(mp, p.cdp, bb.x + Math.min(30, bb.width / 2), bb.y + bb.height / 2);
      await mp.waitForTimeout(500);
      check(await mp.isVisible('[data-testid=message-menu]'), 'long-press: sheet open and still open after touchend');
      await shot(mp, 'iphone-sheet');
      if (await mp.$('[data-testid=menu-select]')) {
        await mp.tap('[data-testid=menu-select]');
        await mp.waitForSelector('[data-testid=select-text]');
        const us = await mp.$eval('[data-testid=select-text]', (el) => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect);
        check(us === 'text', `"Sélectionner le texte": selectable text sheet (${us})`);
        await shot(mp, 'iphone-select-text');
        await mp.mouse.click(195, 60);
        await mp.waitForTimeout(300);
      } else check(false, 'menu offers "Sélectionner le texte"');
      // Emoji search field: 16px (no zoom on focus).
      await longPress(mp, p.cdp, bb.x + Math.min(30, bb.width / 2), bb.y + bb.height / 2);
      await mp.waitForSelector('[data-testid=more-reactions]', { timeout: 3000 }).catch(() => {});
      if (await mp.$('[data-testid=more-reactions]')) {
        await mp.tap('[data-testid=more-reactions]');
        const fs = await mp.$eval('[data-testid=picker-search]', (el) => getComputedStyle(el).fontSize);
        check(fs === '16px', `emoji search font-size 16px (${fs})`);
      }
      await mp.keyboard.press('Escape');
      await mp.waitForTimeout(300);
    } else check(false, 'test chat has messages to long-press');

    // Long-press on a link: "Copy link" in the sheet.
    const link = mp.locator('[data-testid=msg-text] a[href^="http"]').last();
    if (await link.count()) {
      await link.scrollIntoViewIfNeeded();
      const lb = await link.boundingBox();
      await longPress(mp, p.cdp, lb.x + 4, lb.y + lb.height / 2);
      await mp.waitForSelector('[data-testid=message-menu]', { timeout: 3000 }).catch(() => {});
      check(!!(await mp.$('[data-testid=menu-copy-link]')), 'long-press on a link: "Copier le lien" offered');
      await mp.mouse.click(195, 60);
      await mp.waitForTimeout(300);
    } else console.log('     (no link in the test chat: copy-link check skipped)');

    // Back from the background after more than 10 s: a new socket at once.
    const ws0 = await mp.evaluate(() => window.__ws);
    await mp.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await mp.waitForTimeout(10_500);
    await mp.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await mp.waitForTimeout(1500);
    const ws1 = await mp.evaluate(() => window.__ws);
    check(ws1 === ws0 + 1, `resume after 10 s hidden: reconnected (${ws0} -> ${ws1} sockets)`);

    // (A package space's composer on the phone is tested by that package's own end-to-end scripts.)

    // ---------- Lot B: navigation ----------
    await lotB(p);

    console.log(`     phone writes blocked: ${p.blocked.length ? p.blocked.join(', ') : 'none'}`);

    // ---------- Lot C: reading ----------
    await lotC(s, phones);

    // ---------- Lot D: polish ----------
    await lotD(s, phones);
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    for (const p of phones) {
      await p.ctx.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await p.ctx.close().catch(() => {});
    }
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    check(await page.isVisible('[data-testid=unlock]'), 'signed out through Settings');
    await s.browser.close();
    done(s.csp);
  }
})();
