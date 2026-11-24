// The agents package's card in Settings → Manage extensions, READ-ONLY (moved from test/e2e/extensions.e2e.js,
// which checks every card without naming a package): a space and an augmentation, and its data scope said plainly
// ('events': it reads every message of the chats).
// sh web/test/e2e/run-offline.sh ../../ext/agents/test/agentscard.e2e.cjs
const { BASE, SHOTS, check, open, enroll, done } = require('../../../test/e2e/lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  await page.addInitScript(() => localStorage.setItem('lang', 'fr'));
  try {
    await enroll(page);
    await page.goto(`${BASE}/settings/extensions`);
    await page.waitForSelector('[data-testid=settings-extensions] [data-testid=ext-agents]', { timeout: 15000 });
    const badges = await page.$$eval('[data-testid=ext-agents] [data-testid=ext-badge]', (b) => b.map((x) => x.textContent).join(','));
    check(badges === 'espace,augmentation', `agents: a space and an augmentation (${badges})`);
    check((await page.textContent('[data-testid=ext-scope-agents]')).includes('lit tous les messages des discussions'), "agents: 'events' said plainly");
    check((await page.getAttribute('[data-testid=ext-scope-agents]', 'data-scope')) === 'events', 'agents: events scope');
    await page.locator('[data-testid=ext-agents]').screenshot({ path: `${SHOTS}/agentscard.png` });
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  }
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
