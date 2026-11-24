// HTML files open in the app's file viewer (0.18.8): drawn as written (its own styles), sandboxed: its script does
// not run, nothing remote loads, links open a new tab. Read-only: one chat opened (not the test chat), nothing
// written to any chat. sh web/test/e2e/run-offline.sh htmlview.e2e.js
const { BASE, check, open, enroll, logout, shot, done } = require('./lib');

const CHAT = '!chloe:beeper.local';

(async () => {
  const { browser, page, csp, blocked } = await open();
  await enroll(page);
  // Opening a chat marks it read: answered here, never sent for real (page.route comes before lib.js's guard).
  await page.route('**/api/chats/*/read', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  try {
    await page.goto(`${BASE}/chat/${encodeURIComponent(CHAT)}`);
    const card = page.locator('[data-testid=att-file-card]', { has: page.locator('[title="compte-rendu-neo-pyrgi.html"]') });
    await card.waitFor({ timeout: 20000 });
    await card.scrollIntoViewIfNeeded();
    await card.locator('[data-testid=att-file]').click();
    const frameEl = page.locator('[data-testid=fv-html]');
    await frameEl.waitFor({ timeout: 10000 });
    check((await frameEl.getAttribute('sandbox')) === 'allow-popups allow-popups-to-escape-sandbox', 'the frame is sandboxed (no scripts, no same origin)');
    const frame = await (await frameEl.elementHandle()).contentFrame();
    await frame.waitForSelector('#t', { timeout: 10000 });
    await page.waitForTimeout(500);
    const inside = await frame.evaluate(() => {
      const t = document.getElementById('t');
      const px = document.getElementById('px');
      let cookie = 'readable';
      try {
        cookie = document.cookie;
      } catch {
        cookie = 'blocked';
      }
      return { text: t.textContent, color: getComputedStyle(t).color, pxLoaded: px.complete && px.naturalWidth > 0, cookie, origin: self.origin, target: document.querySelector('base')?.target };
    });
    check(inside.text === 'Compte rendu de réunion', `its script did not run, accents read right ("${inside.text}")`);
    check(inside.color === 'rgb(200, 30, 90)', `its own styles apply (${inside.color})`);
    check(!inside.pxLoaded, 'a remote image is not loaded (no tracking pixel)');
    check(inside.cookie === 'blocked' && inside.origin === 'null', `opaque origin, no cookies (${inside.origin}, ${inside.cookie})`);
    check(inside.target === '_blank', 'links open in a new tab');
    const head = await page.evaluate(async (src) => {
      const r = await fetch(src);
      return { status: r.status, csp: r.headers.get('content-security-policy') };
    }, await frameEl.getAttribute('src'));
    check(head.status === 200 && /^sandbox /.test(head.csp) && !/allow-scripts|allow-same-origin/.test(head.csp), `served with a sandbox policy (${head.csp})`);
    check((await page.textContent('[data-testid=fv-name]')).includes('.html'), 'the bar names the file');
    await shot(page, 'htmlview');
    await page.click('[data-testid=fv-back]');
    await page.waitForTimeout(300);
    check(!(await page.locator('[data-testid=file-viewer]').count()), 'Back closes the viewer');
  } finally {
    check(!blocked.length, `no write to a chat (${blocked.join(', ') || 'none'})`);
  }
  await logout(page);
  await browser.close();
  done(csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
