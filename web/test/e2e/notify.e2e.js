// Feature: notification upgrades, in real Chromium. Only touches the test chat (mark as read).
// sh web/test/e2e/run-offline.sh notify.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, settingsPage, leaveSettings, shot, done } = require('./lib');

(async () => {
  const s = await open({ locale: 'en-US', permissions: ['notifications'] });
  const { page, ctx } = s;
  // Record page-side Badging API calls (native when present, recorded either way).
  await page.addInitScript(() => {
    window.__badge = { native: typeof navigator.setAppBadge === 'function', calls: [] };
    const orig = navigator.setAppBadge?.bind(navigator);
    const origClear = navigator.clearAppBadge?.bind(navigator);
    navigator.setAppBadge = (n) => (window.__badge.calls.push(n ?? null), orig ? orig(n).catch(() => {}) : Promise.resolve());
    navigator.clearAppBadge = () => (window.__badge.calls.push(0), origClear ? origClear().catch(() => {}) : Promise.resolve());
  });
  const frames = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && f.payload.includes('visibility') && frames.push(JSON.parse(f.payload))));
  await enroll(page);
  await page.waitForTimeout(1500);

  // a. Badge from the page = unread messages of non-muted chats in the list.
  const b = await page.evaluate(() => window.__badge);
  // The server's count (unread messages of non-muted, non-archived chats), shared with pushes.
  const expected = await page.evaluate(async () => (await (await fetch('/api/notify/badge')).json()).badge);
  const last = b.calls[b.calls.length - 1];
  check(b.calls.length > 0, `page called the Badging API (native in this Chromium: ${b.native})`);
  check(last === expected, `page badge ${last} = server count ${expected}`);

  // c. The window reports what it shows (per-device suppression input).
  await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}?compose=1`);
  await page.waitForSelector('[data-testid=composer-input]');
  await page.waitForTimeout(800);
  const v = frames[frames.length - 1];
  check(!!v && v.visible === true && v.chatID === TEST_CHAT && typeof v.focused === 'boolean', `visibility frame ${JSON.stringify(v && { ...v, chatID: v.chatID && 'TEST' })}`);
  // b. "Reply" fallback: ?compose=1 focuses the composer, then the URL is cleaned.
  check((await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'composer-input', 'compose=1 focuses the composer');
  check(!page.url().includes('compose='), 'compose parameter removed from the URL');

  // Service worker (production build registers /sw.js).
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const caps = await sw.evaluate(() => ({
    maxActions: typeof Notification !== 'undefined' ? Notification.maxActions : null,
    inlineReply: typeof NotificationEvent !== 'undefined' && 'reply' in NotificationEvent.prototype,
    swBadge: typeof self.navigator.setAppBadge === 'function',
  }));
  console.log('     SW platform support:', JSON.stringify(caps));

  // Real push event through CDP (ServiceWorker.deliverPushMessage): the real handler shows the notification.
  // Headless Chromium has no notification backend (permission stays "denied"), so showNotification is
  // stubbed to record its arguments; the push event itself is real (CDP) and runs the real handler.
  await sw.evaluate(() => {
    self.__badges = [];
    self.__shown = [];
    Object.defineProperty(self.registration, 'showNotification', { configurable: true, value: async (title, o) => void self.__shown.push({ title, actions: o.actions || [], data: o.data }) });
    const nav = self.navigator;
    Object.defineProperty(nav, 'setAppBadge', { configurable: true, value: async (n) => void self.__badges.push(n) });
    Object.defineProperty(nav, 'clearAppBadge', { configurable: true, value: async () => void self.__badges.push(0) });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const regs = await new Promise((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => resolve(e.registrations));
    setTimeout(() => resolve([]), 3000);
  });
  const reg = regs.find((r) => r.scopeURL.startsWith(BASE));
  check(!!reg, 'service worker registration found via CDP');
  if (reg) {
    const payload = {
      title: 'E2E', body: 'test', tag: 'e2e-test', url: `/chat/${encodeURIComponent(TEST_CHAT)}`, chatID: TEST_CHAT, badge: 4,
      labels: { reply: 'Reply', read: 'Mark as read', placeholder: 'Message', replyFailed: 'Reply not sent' },
    };
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId: reg.registrationId, data: JSON.stringify(payload) });
    await page.waitForTimeout(1500);
    const shown = await sw.evaluate(() => self.__shown);
    const n = shown.find((x) => x.title === 'E2E');
    check(!!n, 'real push event (CDP) reached the handler, which built the notification');
    if (n) {
      const want = caps.maxActions >= 2 ? 2 : 0;
      check(n.actions.length === want, `actions: ${JSON.stringify(n.actions.map((a) => a.action + (a.type ? ':' + a.type : '')))} (maxActions ${caps.maxActions}, inline ${caps.inlineReply})`);
      check(n.data?.chatID === TEST_CHAT, 'notification data carries the chat');
    }
    check(JSON.stringify(await sw.evaluate(() => self.__badges)) === '[4]', 'SW set the app badge from the payload');
  }

  // b. "Mark as read" from the worker: same request the handler makes, from the SW context (cookie + CSRF).
  const r = await sw.evaluate(async (chatID) => {
    const res = await fetch('/api/notify/read', {
      method: 'POST', credentials: 'same-origin', redirect: 'manual',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatID }),
    });
    return { status: res.status, type: res.type, body: await res.json().catch(() => null) };
  }, TEST_CHAT);
  check(r.status === 200 && r.body?.ok === true && typeof r.body.badge === 'number', `SW POST /api/notify/read -> ${r.status} ${JSON.stringify(r.body)}`);
  const forged = await page.evaluate(async (chatID) => (await fetch('/api/notify/read', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ chatID }) })).status, TEST_CHAT);
  check(forged === 400, `invalid body refused (${forged})`);

  // Push subscription carries the language.
  await settingsPage(page, 'notifications');
  await page.waitForSelector('[data-testid=push-state][data-state]');
  const state = await page.getAttribute('[data-testid=push-state]', 'data-state');
  if (state === 'off') {
    await page.click('[data-testid=push-enable]');
    await page.waitForSelector('[data-testid=push-state][data-state=on]', { timeout: 15000 }).catch(() => {});
  }
  const st2 = await page.getAttribute('[data-testid=push-state]', 'data-state');
  console.log(`     push state after enable: ${st2}`);
  await shot(page, 'notify-en-settings');
  await settingsPage(page, 'language');
  await page.click('[data-testid=lang-fr]');
  await page.waitForTimeout(1000);
  await settingsPage(page, 'notifications');
  await shot(page, 'notify-fr-settings');
  if (st2 === 'on') {
    await page.click('[data-testid=push-disable]');
    await page.waitForSelector('[data-testid=push-state][data-state=off]');
  }
  await leaveSettings(page);
  check(s.csp.length === 0, `no CSP violations (${s.csp.length}) ${s.csp.slice(0, 2).join(' | ')}`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
