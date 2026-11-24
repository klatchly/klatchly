// The example package end to end (offline instance, test/e2e/offline/server.mjs): its space (button, list, main
// pane, its route through Refresh), its Settings page (a preference saved on the server) and its ✨ entry (the
// draft's words counted in the browser, shown in the conversation's toast; nothing is sent, the field is cleared).
// It needs a build with the package listed; on a build without it (the owner's list) it says so and passes.
//   cd web && KLATCHLY_PACKAGES=beeper,accounts,llm,writing,example npm test && \
//     KLATCHLY_PACKAGES=beeper,accounts,llm,writing,example npm run build
//   sh web/test/e2e/run-offline.sh ../../ext/example/test/example.e2e.cjs
const { BASE, TEST_CHAT, check, step, open, enroll, logout, settingsPage, leaveSettings, shot, done } = require('../../../test/e2e/lib');

/** The ✨ entry on this draft: the toast's text. The field is emptied afterwards (never sent). */
async function countDraft(page, text) {
  const input = page.locator('[data-testid=composer-input]');
  await input.fill(text);
  await page.click('[data-testid=assist-btn]');
  await page.waitForSelector('[data-testid=assist-menu] [data-testid=example-count]');
  await page.click('[data-testid=example-count]');
  await page.waitForSelector('[data-testid=toast]', { timeout: 5000 });
  const toast = (await page.textContent('[data-testid=toast]')).trim();
  check((await input.inputValue()) === text, 'the draft is left as it was');
  await input.fill('');
  return toast;
}

/** The Settings page's checkbox set to `on` (saved on the server), then out of Settings. */
async function setCharacters(page, on) {
  await settingsPage(page, 'example-prefs');
  check(new URL(page.url()).pathname === '/settings/ext/example/prefs', "its page in the package's namespace");
  const box = page.locator('[data-testid=example-characters]');
  await page.waitForSelector('[data-testid=example-characters]:not([disabled])');
  if ((await box.isChecked()) !== on) {
    await box.click();
    await page.waitForSelector('[data-testid=example-note]');
    check((await page.textContent('[data-testid=example-note]')) === 'Saved.', `preference saved (${on})`);
  }
  check((await box.isChecked()) === on, `checkbox ${on ? 'on' : 'off'}`);
  await leaveSettings(page);
}

(async () => {
  const s = await open({ locale: 'en-US' });
  const { page } = s;
  try {
    await enroll(page);
    const listed = await page.evaluate(async () => (await (await fetch('/api/extensions')).json()).packages.find((p) => p.id === 'example'));
    if (!listed) {
      console.log('  skipped: the example package is not in this build (build with KLATCHLY_PACKAGES=…,example)');
      return;
    }
    check(listed.active, 'the example package is on');

    // The space, wide screen: list and main pane, the route's answer in both.
    await page.click('[data-testid=open-example]');
    await page.waitForSelector('[data-testid=example-main] [data-testid=example-greeting]');
    check(new URL(page.url()).pathname === '/example', 'the button opens /example');
    check((await page.textContent('[data-testid=example-main] [data-testid=example-greeting]')) === 'Hello from the example package.', 'default greeting (no KLATCHLY_EXAMPLE_GREETING)');
    check(!!(await page.waitForSelector('[data-testid=example-list] [data-testid=example-card]', { timeout: 5000 }).catch(() => null)), 'the card in the list column too');
    const calls = async () => Number(/^(\d+)/.exec((await page.textContent('[data-testid=example-main] [data-testid=example-calls]')) ?? '')?.[1]);
    const before = await calls();
    await page.click('[data-testid=example-main] [data-testid=example-refresh]');
    // Polled from here: the app's CSP refuses waitForFunction's evaluation.
    for (const t0 = Date.now(); (await calls()) <= before && Date.now() - t0 < 5000; ) await page.waitForTimeout(100);
    check((await calls()) > before, `Refresh calls the route again (${before} -> ${await calls()})`);
    await shot(page, 'example-space');

    // The ✨ entry, words only, then with characters once the preference is on; the preference back off.
    step('the ✨ entry in the test chat');
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=composer-input]');
    check((await countDraft(page, 'Hello, brave new world!')) === '4 words', 'words counted in the browser');
    await setCharacters(page, true);
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=composer-input]');
    check((await countDraft(page, 'Hello, brave new world!')) === '4 words, 23 characters', 'with characters once the preference is on');
    await setCharacters(page, false);

    // Phone: the list column is the page; the card is there.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/example`);
    await page.waitForSelector('[data-testid=example-list] [data-testid=example-greeting]');
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    check(noHScroll, 'phone: no horizontal scroll');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'example-phone-dark');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    check(s.blocked.length === 0, `no write outside the test chat (${s.blocked.join(', ')})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
