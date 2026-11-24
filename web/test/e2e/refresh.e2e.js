// "Refresh the app" in Settings (0.9.1): shows the version, reloads, and the session survives. Read-only.
// sh web/test/e2e/run-offline.sh refresh.e2e.js
const { check, step, open, enroll, logout, settingsPage, leaveSettings, shot, done } = require('./lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  try {
    await enroll(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await settingsPage(page, 'about');
    check(/^Version 0\.25\.3$/.test(await page.textContent('[data-testid=app-version]')), 'settings show the version (0.25.3)');
    await page.click('[data-testid=settings-back]');
    await settingsPage(page, 'storage');
    await shot(page, 'refresh-settings');
    await page.evaluate(() => sessionStorage.setItem('beforeRefresh', '1'));
    await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.click('[data-testid=app-refresh]')]);
    step('the app reloaded');
    // Settings is a page (0.14.17), Données et cache a block of Application (0.15.8): the reload stays on it, signed in.
    await page.waitForSelector('[data-testid=app-refresh]', { timeout: 20000 });
    check((await page.evaluate(() => location.pathname)) === '/settings/app' && !(await page.isVisible('[data-testid=unlock]')), 'still signed in after the refresh, back on Settings → Application');
    await leaveSettings(page);
    await page.waitForSelector('[data-testid=net-open]', { timeout: 20000 });
    step('Back leads to the chat list');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
