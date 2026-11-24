// Fix: the conversation stays at the bottom after sending (optimistic bubble, echo, incoming message, list
// refetch), and the composer shows no scrollbar for a single line. Writes go to the TEST chat only.
// sh web/test/e2e/run-offline.sh sendscroll.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');
const http = require('http');

const injectURL = process.env.INJECT_URL;
const inject = (text) =>
  new Promise((resolve) => {
    if (!injectURL) return resolve(false);
    const req = http.request(injectURL, { method: 'POST' }, (res) => (res.resume(), resolve(res.statusCode === 200)));
    req.on('error', () => resolve(false));
    req.end(text);
  });

/** Distance to the bottom of the list and whether a message with this text is fully on screen. */
const view = (page, text) =>
  page.evaluate((text) => {
    const sc = document.querySelector('[data-testid=messages] [data-virtuoso-scroller]');
    const r = sc.getBoundingClientRect();
    const all = [...document.querySelectorAll('[data-testid=msg], [data-testid=msg-outgoing]')];
    const el = text ? all.reverse().find((e) => e.textContent.includes(text)) : null;
    const b = el?.getBoundingClientRect();
    return { gap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight), visible: !!b && b.top >= r.top - 2 && b.bottom <= r.bottom + 2 };
  }, text);

const tag = Date.now().toString(36);

async function sendTwo(page, label) {
  const a = `${label} A ${tag}`;
  const b = `${label} B ${tag}`;
  // Headless Chromium reports no fine pointer, where Enter inserts a newline: use the send button.
  await page.fill('[data-testid=composer-input]', a);
  await page.click('[data-testid=send]');
  await page.fill('[data-testid=composer-input]', b);
  await page.click('[data-testid=send]');
  return b;
}

async function wheelUp(page, n) {
  const box = await page.locator('[data-testid=messages]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(40);
  }
}

(async () => {
  const s = await open({ locale: 'en-US' });
  const { page } = s;
  await enroll(page);
  await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
  await page.waitForSelector('[data-testid=msg]');
  await page.waitForTimeout(1500);

  // Composer: one line (empty or short) has no scrollbar; long text grows, then scrolls.
  const ta = '[data-testid=composer-input]';
  const metrics = () =>
    page.$eval(ta, (el) => ({ sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY, h: el.offsetHeight }));
  const empty = await metrics();
  check(empty.oy === 'hidden' && empty.sh <= empty.ch, `empty composer: no scrollbar (${JSON.stringify(empty)})`);
  await page.fill(ta, 'one line');
  const one = await metrics();
  check(one.oy === 'hidden' && one.sh <= one.ch && one.h === empty.h, `one line: no scrollbar, same height (${JSON.stringify(one)})`);
  await page.fill(ta, 'a\nb\nc');
  const three = await metrics();
  check(three.oy === 'hidden' && three.h > one.h && three.sh <= three.ch, `three lines: grows without scrollbar (${JSON.stringify(three)})`);
  await page.fill(ta, Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
  const many = await metrics();
  check(many.oy === 'auto' && many.h <= 162, `20 lines: capped height, scrollable (${JSON.stringify(many)})`);
  await page.fill(ta, '');
  const back = await metrics();
  check(back.h === empty.h && back.oy === 'hidden', `cleared: back to one line (${JSON.stringify(back)})`);

  // 1. At the bottom, two quick sends with Enter.
  let last = await sendTwo(page, 'pin');
  await page.waitForTimeout(400);
  let v = await view(page, last);
  check(v.visible && v.gap < 10, `optimistic bubbles at the bottom (${JSON.stringify(v)})`);
  await page.waitForTimeout(4000);
  v = await view(page, last);
  check(v.visible && v.gap < 10, `after the echo replaced them: still at the bottom (${JSON.stringify(v)})`);

  // 2. An incoming message (sent through the API from "another device"), then a full list refetch.
  const inc = `incoming ${tag}`;
  if (await inject(inc)) {
    await page.waitForTimeout(3000);
    v = await view(page, inc);
    check(v.visible && v.gap < 10, `incoming message shown at the bottom (${JSON.stringify(v)})`);
  } else console.log('     (no INJECT_URL: incoming-message step skipped)');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(3000);
  v = await view(page, injectURL ? inc : last);
  check(v.visible && v.gap < 10, `after a refetch of every loaded page: still at the bottom (${JSON.stringify(v)})`);

  // 3. With older pages loaded (history pages shift on refetch), send again.
  await wheelUp(page, 25);
  await page.waitForTimeout(2000);
  await page.click('[data-testid=new-messages]');
  await page.waitForTimeout(1200);
  last = await sendTwo(page, 'paged');
  await page.waitForTimeout(4500);
  if (await inject(`incoming2 ${tag}`)) await page.waitForTimeout(2500);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(3000);
  v = await view(page, injectURL ? `incoming2 ${tag}` : last);
  check(v.visible && v.gap < 10, `older pages loaded + send + incoming + refetch: at the bottom (${JSON.stringify(v)})`);

  // 4. Scrolled up, then send: jumps to the bottom.
  await wheelUp(page, 8);
  await page.waitForTimeout(1200);
  const up = await view(page, last);
  check(up.gap > 200, `scrolled up before sending (gap ${up.gap})`);
  last = await sendTwo(page, 'jump');
  await page.waitForTimeout(4500);
  v = await view(page, last);
  check(v.visible && v.gap < 10, `sending while scrolled up jumps to the bottom (${JSON.stringify(v)})`);
  await shot(page, 'fix-send-bottom');

  console.log(`     writes to real chats blocked by the test guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
