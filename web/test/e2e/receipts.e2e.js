// Read receipts (0.13.2): our messages carry ✓ (sent) or ✓✓ (read). Read only, TEST chat only.
// sh web/test/e2e/run-offline.sh receipts.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  try {
    await enroll(page);
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=msg]');
    await page.waitForTimeout(1500);
    const own = await page.locator('.msg.own [data-testid=bubble]').count();
    const ticks = await page.locator('.msg.own [data-testid=msg-ticks]').count();
    const other = await page.locator('.msg.other [data-testid=msg-ticks]').count();
    const states = await page.$$eval('[data-testid=msg-ticks]', (els) => els.map((e) => `${e.dataset.read}:${e.getAttribute('aria-label')}`));
    console.log(`     own bubbles ${own}, ticks ${ticks}, states ${[...new Set(states)].join(' | ')}`);
    check(own > 0 && ticks > 0, 'our messages show ticks');
    check(other === 0, 'no ticks on incoming messages');
    await shot(page, 'receipts');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
