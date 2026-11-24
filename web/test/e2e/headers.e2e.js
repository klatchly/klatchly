// Header line (0.15.8): on a wide screen the list column's header and the pane's header end on the same line, on
// every screen (the chat list and a conversation, the low-priority and archive lists, Settings, each space and one
// of its places). Both use the shared --header-h (styles.css); this measures their bottom borders and wants them
// within half a pixel. On a phone (one screen at a time), every header ends on the same line too. Read-only: it
// opens screens, it never sends.
// sh web/test/e2e/run-offline.sh headers.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done, spaces } = require('./lib');

/** The bottom edge of the visible header of the list column and of the pane (null when one has none). */
const edges = (page) =>
  page.evaluate(() => {
    const bottom = (sel) => {
      const el = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden');
      return el ? el.getBoundingClientRect().bottom : null;
    };
    return { left: bottom('.pane-list .list-header'), right: bottom('.pane-chat .conv-header') };
  });

async function measure(page, label, name) {
  await page.waitForTimeout(400);
  const e = await edges(page);
  if (e.right === null) {
    console.log(`     ${label}: no header in the pane (${JSON.stringify(e)})`);
    return;
  }
  check(e.left !== null && Math.abs(e.left - e.right) <= 0.5, `${label}: headers end on the same line (list ${e.left}, pane ${e.right})`);
  if (name) await shot(page, name);
}

/** A space's tab, its list and, when it lists one, its first place (a conversation, a project, an account). */
async function space(page, tab, path, place) {
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
  if (!(await page.isVisible(`[data-testid=${tab}]`))) return console.log(`     (${path} not enabled: skipped)`);
  await page.click(`[data-testid=${tab}]`);
  await page.waitForFunction((p) => location.pathname === p, path, { timeout: 15000 }).catch(() => {});
  await measure(page, path);
  const row = await page.$(`.pane-list ${place}`);
  if (!row) return console.log(`     (${path}: no place listed)`);
  await row.click();
  await page.waitForTimeout(600);
  await measure(page, `${path}: a place (${await page.evaluate(() => location.pathname)})`, `headers${path.replace('/', '-')}`);
}

/** Phone (390×844, touch): the header on top of each screen (the list's, or the pane's over it) ends on one line. */
async function phone(s) {
  const ctx = await s.browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'fr-FR',
    storageState: await s.ctx.storageState(),
  });
  // Nothing written from the phone: GETs only.
  await ctx.route('**/api/**', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
  await ctx.addInitScript(() => localStorage.setItem('lang', 'fr'));
  const page = await ctx.newPage();
  const seen = [];
  const at = async (path, sel, label) => {
    await page.goto(BASE + path);
    await page.waitForSelector(sel, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    const e = await edges(page);
    // The pane when it is over the list, else the list.
    const y = (await page.isVisible('.pane-chat .conv-header')) ? e.right : e.left;
    console.log(`     phone ${label}: ${y}`);
    if (y !== null) seen.push([label, y]);
  };
  try {
    await at('/', '[data-testid=chat-row]', 'chats');
    await at(`/chat/${encodeURIComponent(TEST_CHAT)}`, '[data-testid=conversation] .conv-header', 'conversation');
    await at('/settings', '[data-testid=settings-menu]', 'Settings menu');
    await at('/settings/general', '[data-testid=settings-general]', 'Settings page');
    // Each space of the build's packages (its list).
    for (const sp of await spaces(page)) await at(sp.path, '.pane-list .list-header', `space ${sp.id}`);
    await at('/settings/ext/accounts/networks', '[data-testid=acc-dashboard]', 'Networks');
    await at('/settings/ext/accounts/networks/whatsapp', '[data-testid=acc-detail]', 'an account');
    await page.goto(BASE + '/settings/general');
    await page.waitForTimeout(500);
    await shot(page, 'headers-phone-settings');
    const y0 = seen[0]?.[1];
    check(seen.length >= 5 && seen.every(([, y]) => Math.abs(y - y0) <= 0.5), `phone: every header ends on the same line (${seen.map(([l, y]) => `${l} ${y}`).join(', ')})`);
  } finally {
    await ctx.close();
  }
}

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  try {
    await enroll(page);
    await phone(s);
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=conversation] .conv-header', { timeout: 30000 });
    await measure(page, 'chats + conversation', 'headers-chat');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'headers-chat-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    for (const [tab, label] of [['open-lowpri', 'low priority'], ['open-archives', 'archives']]) {
      await page.click(`[data-testid=${tab}]`);
      await measure(page, `${label} + conversation`);
    }
    await page.click('[data-testid=tab-chats]');
    await page.click('[data-testid=open-settings]');
    await page.waitForSelector('.pane-chat [data-testid=settings-page] .conv-header', { timeout: 15000 });
    await page.waitForSelector('[data-testid=settings-menu]', { timeout: 15000 });
    await measure(page, 'Settings', 'headers-settings');
    await page.goto(`${BASE}/settings/extensions`);
    await page.waitForSelector('.pane-chat [data-testid=extensions]', { timeout: 15000 });
    await measure(page, 'Settings → Extensions');
    // Each space of the build's packages, and its first place when it lists one.
    for (const sp of await spaces(page)) await space(page, `open-${sp.id}`, sp.path, '.chat-row');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await page.goto(BASE + '/').catch(() => {});
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
