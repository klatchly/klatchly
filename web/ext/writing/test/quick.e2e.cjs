// Quick writing-help button (0.13.3): chosen per chat in the ✨ settings, sits between ✨ and the mic/send
// button, runs that fix in one tap. Spelling only unless set otherwise. TEST chat only, nothing is sent; the setting is cleared at the end.
// sh web/test/e2e/run-offline.sh ../../ext/writing/test/quick.e2e.cjs
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('../../../test/e2e/lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  try {
    await enroll(page);
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=composer-input]');
    // Default: spelling only, shown without any setting.
    await page.waitForSelector('[data-testid=assist-quick-btn]');
    check((await page.getAttribute('[data-testid=assist-quick-btn]', 'title')) === 'Orthographe seulement', 'quick button shown by default: spelling only');
    // "None" hides it, then back to the default.
    await page.click('[data-testid=assist-btn]');
    await page.click('[data-testid=assist-open-settings]');
    check((await page.inputValue('[data-testid=assist-quick]')) === 'spelling', 'settings show spelling as the choice');
    await page.selectOption('[data-testid=assist-quick]', 'none');
    await page.click('[data-testid=assist-save]');
    await page.waitForSelector('[data-testid=assist-quick-btn]', { state: 'hidden', timeout: 5000 }).catch(() => {});
    check(!(await page.isVisible('[data-testid=assist-quick-btn]')), '"None" hides the button');
    await page.evaluate(async (id) => fetch('/api/assist/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatID: id, quick: '' }) }), TEST_CHAT);
    await page.reload();
    await page.waitForSelector('[data-testid=assist-quick-btn]');
    check(await page.isDisabled('[data-testid=assist-quick-btn]'), 'quick button greyed out while the field is empty');
    const input = page.locator('[data-testid=composer-input]');
    const draft = 'je pense que on pourrais se voir demain';
    await input.fill(draft);
    const order = await page.$$eval('.composer [data-testid=assist-btn], .composer [data-testid=assist-quick-btn], .composer [data-testid=send], .composer [data-testid=mic]', (els) => els.map((e) => e.dataset.testid));
    check(order[0] === 'assist-btn' && order[1] === 'assist-quick-btn', `between ✨ and send (${order.join(' > ')})`);
    await shot(page, 'quick-btn');
    await page.click('[data-testid=assist-quick-btn]');
    await page.waitForSelector('[data-testid=assist-bar]', { timeout: 30000 });
    const fixed = await input.inputValue();
    console.log(`     spelling by quick button: ${fixed}`);
    check(fixed !== draft, 'one tap fixes the draft');
    await input.fill('');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    const r = await page
      .evaluate(async (id) => (await fetch('/api/assist/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatID: id, quick: '' }) })).json(), TEST_CHAT)
      .catch((e) => ({ error: String(e) }));
    check(!r.quick && !r.error, `setting cleared (${JSON.stringify(r)})`);
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
