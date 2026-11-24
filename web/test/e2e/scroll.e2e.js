// Hotfix: conversation scrolling. READ-ONLY on a long real chat (writes are blocked by lib.js), plus the
// test chat, where a message is injected through the API while scrolled up (Q_SEND hook below).
// sh web/test/e2e/run-offline.sh scroll.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');
const http = require('http');

// Optional local helper on the host that sends one message to the test chat (see run notes in README).
const injectURL = process.env.INJECT_URL;
const inject = (text) =>
  new Promise((resolve) => {
    if (!injectURL) return resolve(false);
    const req = http.request(injectURL, { method: 'POST' }, (res) => (res.resume(), resolve(res.statusCode === 200)));
    req.on('error', () => resolve(false));
    req.end(text);
  });

async function measureScroll(page, steps) {
  await page.evaluate(() => {
    window.__perf = { long: [], frames: [] };
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__perf.long.push(e.duration))).observe({ type: 'longtask', buffered: false });
    let last = performance.now();
    const tick = (t) => {
      window.__perf.frames.push(t - last);
      last = t;
      if (!window.__perf.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const box = await page.locator('[data-testid=messages]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    window.__perf.stop = true;
    const f = window.__perf.frames.slice(1);
    const sorted = [...f].sort((a, b) => a - b);
    return {
      longTasks: window.__perf.long.length,
      longTaskMs: Math.round(window.__perf.long.reduce((a, b) => a + b, 0)),
      frames: f.length,
      jank50: f.filter((x) => x > 50).length,
      p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0),
      max: Math.round(sorted[sorted.length - 1] || 0),
    };
  });
}

const topVisible = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid=messages] [data-virtuoso-scroller]');
    const r = sc.getBoundingClientRect();
    const el = [...document.querySelectorAll('[data-testid=msg]')].find((e) => e.getBoundingClientRect().bottom > r.top + 4);
    return el ? { id: el.dataset.mid, y: Math.round(el.getBoundingClientRect().top - r.top) } : null;
  });

(async () => {
  const s = await open({ locale: 'en-US' });
  const { page } = s;
  await enroll(page);

  // 1. Long real chat, read-only: wheel up through history and measure.
  let long = process.env.LONG_CHAT;
  if (!long) {
    long = await page.$$eval('[data-testid=chat-row]', (els) => els.filter((e) => !e.querySelector('.badge')).map((e) => e.dataset.chatId)[1]);
  }
  await page.goto(`${BASE}/chat/${encodeURIComponent(long)}`);
  await page.waitForSelector('[data-testid=msg]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const perf = await measureScroll(page, 80);
  console.log('     scroll perf (80 wheel steps):', JSON.stringify(perf));
  check(perf.jank50 <= 6, `few janky frames while scrolling (>50 ms: ${perf.jank50}, p95 ${perf.p95} ms)`);
  const before = await topVisible(page);
  await page.waitForTimeout(3000);
  const after = await topVisible(page);
  check(before && after && before.id === after.id && Math.abs(before.y - after.y) < 4, `reading position stable while idle (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);

  // 2. Test chat: scrolled up + a new message arrives -> position kept, "new messages" button shown.
  await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
  await page.waitForSelector('[data-testid=msg]');
  await page.waitForTimeout(1500);
  const box = await page.locator('[data-testid=messages]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(1200);
  const p1 = await topVisible(page);
  const sent = await inject(`scroll probe ${Date.now().toString(36)}`);
  if (sent) {
    await page.waitForTimeout(3000);
    const p2 = await topVisible(page);
    check(p1 && p2 && p1.id === p2.id && Math.abs(p1.y - p2.y) < 4, `incoming message keeps the position (${JSON.stringify(p1)} -> ${JSON.stringify(p2)})`);
    const unseen = Number(await page.getAttribute('[data-testid=new-messages]', 'data-unseen').catch(() => 0));
    check(unseen >= 1, `"new messages" button shows the count (${unseen})`);
    await shot(page, 'hotfix-scroll-newmsg');
    await page.click('[data-testid=new-messages]');
    await page.waitForTimeout(800);
    check(!(await page.isVisible('[data-testid=new-messages]')), 'button scrolls to bottom and hides');
  } else console.log('     (no INJECT_URL: incoming-message check skipped)');
  // 3. Phone emulation: touch fling gestures (CDP) through the long chat, read-only.
  const phone = await s.browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, locale: 'en-US', storageState: await s.ctx.storageState() });
  await phone.route('**/api/**', (route) => (route.request().method() === 'GET' ? route.continue() : route.abort()));
  const mp = await phone.newPage();
  await mp.goto(`${BASE}/chat/${encodeURIComponent(long)}`);
  await mp.waitForSelector('[data-testid=msg]', { timeout: 20000 });
  await mp.waitForTimeout(1500);
  const mcdp = await phone.newCDPSession(mp);
  await mp.evaluate(() => {
    window.__f = [];
    let last = performance.now();
    const tick = (t) => (window.__f.push(t - last), (last = t), window.__stop || requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < 6; i++) {
    await mcdp.send('Input.synthesizeScrollGesture', { x: 195, y: 300, yDistance: 600, speed: 1500, gestureSourceType: 'touch' });
  }
  await mp.waitForTimeout(1000);
  const mf = await mp.evaluate(() => ((window.__stop = true), window.__f.slice(1)));
  const ms = [...mf].sort((a, b) => a - b);
  console.log('     phone touch scroll:', JSON.stringify({ frames: mf.length, jank50: mf.filter((x) => x > 50).length, p95: Math.round(ms[Math.floor(ms.length * 0.95)] || 0) }));
  await mp.waitForTimeout(2500); // let fling momentum and the history page load finish
  const m1 = await topVisible(mp);
  await mp.waitForTimeout(3000);
  const m2 = await topVisible(mp);
  check(m1 && m2 && m1.id === m2.id && Math.abs(m1.y - m2.y) < 4, `phone: position stable after flings (${JSON.stringify(m1)} -> ${JSON.stringify(m2)})`);
  await shot(mp, 'hotfix-scroll-phone');
  await phone.close();

  // Opening a chat normally marks it read: lib.js aborts that for real chats, so nothing reached them.
  console.log(`     writes to real chats blocked by the test guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
