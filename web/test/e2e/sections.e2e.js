// Section tab bar (0.14.1): every sidebar header shows the same tabs; the active one is larger and coloured,
// the others grey; switching sections never moves the bar. Read only.
// sh web/test/e2e/run-offline.sh sections.e2e.js
const { BASE, check, open, enroll, logout, shot, done, spaces } = require('./lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  const state = () =>
    page.$$eval('.section-tab', (els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        const ic = e.querySelector('.section-icon').getBoundingClientRect();
        return { id: e.dataset.testid, active: e.getAttribute('aria-current') === 'page', x: Math.round(r.left), w: Math.round(ic.width), color: getComputedStyle(e).color };
      }),
    );
  // Polls with page.evaluate (Playwright's own polling evaluates strings: refused by the app's CSP).
  const until = async (fn, arg, label, timeout = 5000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await page.evaluate(fn, arg).catch(() => false)) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`timeout: ${label}`);
  };
  // The tab icons have stopped moving (the active one grows with a short transition).
  const still = () => until(() => ![...document.querySelectorAll('.section-icon')].some((e) => e.getAnimations().some((a) => a.playState === 'running')), null, 'icons still');
  /** A tab's count, read at once (null: none). */
  const count = (tab) => page.evaluate((t) => document.querySelector(`[data-testid=${t}] .icon-count`)?.textContent ?? null, tab);
  const at = async (tab, label) => {
    await page.click(`[data-testid=${tab}]`);
    await until((t) => document.querySelector(`[data-testid=${t}]`)?.getAttribute('aria-current') === 'page', tab, `${label} active`).catch(() => {});
    await still();
    const st = await state();
    const act = st.filter((x) => x.active);
    check(act.length === 1 && act[0].id === tab, `${label}: only "${tab}" active (${act.map((x) => x.id)})`);
    const other = st.find((x) => !x.active);
    check(act[0].w > other.w && act[0].color !== other.color, `${label}: active icon larger (${act[0].w} > ${other.w}) and coloured`);
    return st;
  };
  try {
    await enroll(page);
    await page.waitForSelector('.section-tabs');
    // The counts come with the first data: read them once everything has loaded.
    await page.waitForLoadState('networkidle');
    const base = await state();
    console.log(`     tabs: ${base.map((x) => x.id).join(' ')}`);
    check(base[0].id === 'tab-chats' && base[0].active, 'chats tab first and active');
    check(!(await page.isVisible('.list-title')), 'no text title any more');
    await shot(page, 'sections-chats');
    const xs = JSON.stringify(base.map((x) => x.x));
    // The core's sections, then each space of the build's packages.
    const spaceTabs = (await spaces(page)).map((sp) => [`open-${sp.id}`, sp.id]);
    for (const [tab, label] of [['open-lowpri', 'low priority'], ['open-archives', 'archives'], ...spaceTabs, ['tab-chats', 'back to chats']]) {
      if (!base.some((x) => x.id === tab)) continue;
      const before = await count(tab);
      const st = await at(tab, label);
      // 0.15.7: a tab's count stays while its section is the active one.
      if (before) {
        const after = await count(tab);
        check(after !== null, `${label}: its count (${before}) still shown on the active tab (${after})`);
        await shot(page, `sections-count-active-${label.replace(/\s+/g, '-')}`);
      }
      check(JSON.stringify(st.map((x) => x.x)) === xs, `${label}: tabs did not move`);
      if (spaceTabs.some(([t]) => t === tab)) await shot(page, `sections-${label}`);
    }
    check(new URL(page.url()).pathname === '/', 'back on the chat list');
    await page.setViewportSize({ width: 390, height: 844 });
    await still();
    const over = await page.evaluate(() => document.querySelector('.list-header').scrollWidth > document.querySelector('.list-header').clientWidth);
    check(!over, 'phone width: header fits');
    await shot(page, 'sections-phone');
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
