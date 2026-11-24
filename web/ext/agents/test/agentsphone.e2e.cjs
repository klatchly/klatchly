// The Agents space on an emulated iPhone (touch, iOS UA, navigator.standalone), READ-ONLY (the phone context lets
// only GET requests through): the Hermes composer grows with its text, its session picker is a 16 px native select
// (no zoom on focus). Moved from test/e2e/iphone.e2e.js (the core's scripts name no package).
// sh web/test/e2e/run-offline.sh ../../ext/agents/test/agentsphone.e2e.cjs
const { BASE, check, open, enroll, shot, done } = require('../../../test/e2e/lib');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

(async () => {
  const s = await open({ locale: 'fr-FR' });
  await enroll(s.page);
  // Needs a runtime that keeps conversations (the Agents space: Hermes, as the offline fake of the hermes package);
  // a build without one has no space and these agents (ext/agents/test/llmagent.e2e.cjs covers that case).
  if ((await s.page.evaluate(async () => (await fetch('/api/agents/agents')).status)) !== 200) {
    console.log('     skipped: no runtime keeps conversations in this build (no Agents space)');
    return done();
  }
  const ctx = await s.browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
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
    Object.defineProperty(navigator, 'standalone', { value: true });
    localStorage.setItem('lang', 'fr');
  });
  const mp = await ctx.newPage();
  try {
    // The composer of a new conversation grows with its text (nothing is sent, nothing is created).
    await mp.goto(`${BASE}/agents/new`);
    const hermes = await mp.waitForSelector('[data-testid=agents-input]', { timeout: 15000 }).then(() => true, () => false);
    check(hermes, 'the Hermes composer is there');
    if (hermes) {
      const h0 = await mp.$eval('[data-testid=agents-input]', (el) => el.getBoundingClientRect().height);
      await mp.fill('[data-testid=agents-input]', 'une\ndeux\ntrois\nquatre');
      await mp.waitForTimeout(100);
      const h1 = await mp.$eval('[data-testid=agents-input]', (el) => el.getBoundingClientRect().height);
      check(h1 > h0 + 30, `Hermes composer grows (${Math.round(h0)} -> ${Math.round(h1)} px)`);
      const sel = await mp.$('[data-testid=agents-picker]');
      if (sel) check((await sel.evaluate((el) => getComputedStyle(el).fontSize)) === '16px', 'Hermes session picker: 16px native select');
      await shot(mp, 'agentsphone-composer');
      await mp.fill('[data-testid=agents-input]', '');
    }
    console.log(`     phone writes blocked: ${blocked.length ? blocked.join(', ') : 'none'}`);
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    await ctx.close();
  }
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
