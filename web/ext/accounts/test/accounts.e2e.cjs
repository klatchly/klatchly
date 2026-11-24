// e2e-instance: alone R_ACCOUNTS=1
// Accounts and networks (0.15.6), in Settings since accounts 1.2 (Settings → Networks): no sidebar button; the
// Settings button carries a dot and the menu entry the count of accounts in trouble; the page is the dashboard (one
// card per account, in trouble first); one account's page (status, identity, figures, recent chats, capabilities),
// whose chats open in the chat view; the space's old URLs send on to it. READ-ONLY: the page
// only reads (GET /api/networks/*); every other call to it is aborted and counted, and no chat is written to (nor
// opened, on a real server). Offline, the sources are the canned Desktop API (4 accounts, Slack in trouble) and the
// other connectors of the offline build (their packages' fakes, ext/<id>/test/offline.mjs).
// (run.mjs gives it an instance of its own with R_ACCOUNTS=1: its first line)
// sh web/test/e2e/run-offline.sh ../../ext/accounts/test/accounts.e2e.cjs
const { BASE, check, step, open, enroll, shot, done } = require('../../../test/e2e/lib');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const OFFLINE = /localhost|127\.0\.0\.1/.test(BASE);

/** Aborts anything but a GET to the space's API; returns the list of what was attempted. */
async function guard(ctx) {
  const attempted = [];
  await ctx.route('**/api/networks/**', (r) => {
    if (r.request().method() === 'GET') return r.continue();
    attempted.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`);
    return r.abort();
  });
  return attempted;
}

const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

(async () => {
  const s = await open({ locale: 'en-US' });
  const desktopAttempts = await guard(s.ctx);
  const { page } = s;
  await enroll(page);
  await page.setViewportSize({ width: 1440, height: 960 });

  // ── Desktop: Settings → Networks ──
  check(!(await page.isVisible('[data-testid=open-networks]')), 'no Networks button in the sidebar header any more');
  if (OFFLINE) {
    await page.waitForSelector('[data-testid=open-settings] [data-testid=settings-attention]', { timeout: 20000 }).catch(() => {});
    check(await page.isVisible('[data-testid=open-settings] [data-testid=settings-attention]'), 'offline: a dot on the Settings button (an account in trouble)');
  }
  await page.click('[data-testid=open-settings]');
  await page.waitForSelector('[data-testid=settings-item-accounts-networks]', { timeout: 15000 });
  if (OFFLINE) {
    const n = await page.locator('[data-testid=settings-item-accounts-networks] [data-testid=settings-item-count]').textContent().catch(() => null);
    check(n === '1', `offline: the menu entry counts the accounts in trouble (${n})`);
  }
  await page.click('[data-testid=settings-item-accounts-networks]');
  check(new URL(page.url()).pathname === '/settings/ext/accounts/networks', 'route is /settings/ext/accounts/networks');
  await page.waitForSelector('[data-testid=acc-card]', { timeout: 20000 });
  const rows = await page.locator('[data-testid=acc-card]').evaluateAll((els) => els.map((e) => e.dataset.health));
  check(rows.length > 0, `accounts listed (${rows.length})`);
  const firstOther = rows.findIndex((h) => h !== 'trouble');
  check(firstOther === -1 || rows.slice(firstOther).every((h) => h !== 'trouble'), 'accounts in trouble listed first');
  await page.waitForSelector('[data-testid=acc-dashboard] [data-testid=acc-card]', { timeout: 15000 });
  const cards = await page.locator('[data-testid=acc-card]').count();
  check(cards === rows.length, `a card per account (${cards})`);
  await page.waitForSelector('[data-testid=acc-card] [data-testid=acc-figures]', { timeout: 20000 });
  check(await page.isVisible('[data-testid=acc-summary]'), 'summary chips on top of the dashboard');
  const trouble = page.locator('[data-testid=acc-card][data-health=trouble]');
  if ((await trouble.count()) > 0) {
    check(await trouble.first().locator('[data-testid=acc-hint]').isVisible(), 'a card in trouble says what to do (no reconnect from here)');
    check(/reconnect it (in|where)/.test((await trouble.first().textContent()) ?? ''), 'the hint says where to reconnect');
    if (OFFLINE) check(/reconnect it in Beeper/.test((await trouble.first().textContent()) ?? ''), "offline: its source's name (Beeper)");
  }
  if (OFFLINE) {
    // The canned Desktop API's 4, and those of the other sources of the offline build.
    const ov = await page.evaluate(async () => (await fetch('/api/networks/overview')).json());
    const others = ov.accounts.filter((a) => a.source !== 'beeper');
    check(rows[0] === 'trouble' && rows.length === 4 + others.length, `offline: Slack (reconnect needed) first of ${4 + others.length} (${rows.join(',')})`);
    if (ov.sources.length > 1) check(others.length > 0, `offline: accounts from the other connectors too (${ov.sources.map((x) => x.id).join(',')})`);
    check((await page.locator('[data-testid=acc-source-down]').count()) === 0, 'offline: every source answered');
    check(/The Slack session expired/.test((await page.textContent('[data-testid=acc-dashboard]')) ?? ''), 'offline: the status text of the account is shown');
  }
  const boxes = await page.locator('[data-testid=acc-card]').evaluateAll((els) => els.slice(0, 2).map((e) => e.getBoundingClientRect().top));
  if (boxes.length > 1) check(Math.abs(boxes[0] - boxes[1]) < 2, 'desktop: cards sit side by side (grid)');
  // The old URL sends on to the page.
  await page.goto(`${BASE}/networks`);
  await page.waitForSelector('[data-testid=acc-dashboard]', { timeout: 15000 });
  check(new URL(page.url()).pathname === '/settings/ext/accounts/networks', `/networks sends on to Settings (${new URL(page.url()).pathname})`);
  check((await overflowX(page)) <= 0, 'desktop: no horizontal overflow');
  await page.waitForTimeout(500);
  await shot(page, 'accounts-desktop');

  // One account: from its card (offline, the one with capabilities and chats).
  await (OFFLINE ? page.locator('[data-testid=acc-card-link]', { hasText: 'WhatsApp' }) : page.locator('[data-testid=acc-card-link]').first()).click();
  await page.waitForSelector('[data-testid=acc-detail][data-account]', { timeout: 15000 });
  const detailPath = new URL(page.url()).pathname;
  check(/^\/settings\/ext\/accounts\/networks\/[A-Za-z0-9_-]+$/.test(detailPath), `the card opens …/networks/<account> (${detailPath})`);
  check(await page.isVisible('[data-testid=settings-item-accounts-networks][aria-current=page]'), 'its menu entry stays current');
  const caps = await page.locator('[data-testid=acc-caps] li').count();
  if (OFFLINE) {
    check(caps >= 8, `offline: capabilities in plain words (${caps})`);
    check(/Replies to a message/.test((await page.textContent('[data-testid=acc-caps]')) ?? ''), 'offline: a capability reads as words');
    check(/\+15550100001/.test((await page.textContent('[data-testid=acc-detail]')) ?? ''), 'offline: the signed-in user sees the account phone');
  }
  const recent = await page.locator('[data-testid=acc-chat]').count();
  check(recent > 0 || (await page.isVisible('text=No chat on this account yet.')), `recent chats listed (${recent})`);
  check((await overflowX(page)) <= 0, 'desktop detail: no horizontal overflow');
  await page.waitForTimeout(300);
  await shot(page, 'accounts-desktop-detail');
  // A recent chat opens in the chat view (offline only: no real chat is opened by this script).
  if (OFFLINE && recent > 0) {
    const href = await page.locator('[data-testid=acc-chat]').first().getAttribute('href');
    await page.locator('[data-testid=acc-chat]').first().click();
    await page.waitForTimeout(800);
    check(new URL(page.url()).pathname === href, `a recent chat opens /chat/<id> (${href})`);
    await page.goBack();
    await page.waitForSelector('[data-testid=acc-detail][data-account]', { timeout: 15000 });
    check(new URL(page.url()).pathname === detailPath, 'Back returns to the account');
  }
  // A malformed or unknown account: the page says so.
  await page.goto(`${BASE}/networks/nobody-here`);
  await page.waitForSelector('[data-testid=acc-not-found]', { timeout: 15000 });
  check(new URL(page.url()).pathname === '/settings/ext/accounts/networks/nobody-here', 'an old account URL sends on to its Settings place');
  step('an unknown account: "not connected any more"');
  await page.click('[data-testid=acc-back]');
  await page.waitForSelector('[data-testid=acc-dashboard]', { timeout: 15000 });
  step('"All networks" goes back to the dashboard');
  // Settings → Manage extensions says what the package reads.
  await page.goto(`${BASE}/settings/extensions`);
  const reads = page.locator('[data-testid=ext-reads-accounts]');
  await reads.waitFor({ timeout: 15000 }).catch(() => {});
  check(await reads.isVisible().catch(() => false), 'Settings → Extensions: "reads your accounts…" under Accounts and networks');

  // ── Phone (French, dark) ──
  const ctx = await s.browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    userAgent: UA,
    isMobile: true,
    hasTouch: true,
    locale: 'fr-FR',
    colorScheme: 'dark',
    storageState: await s.ctx.storageState(),
  });
  const phoneAttempts = await guard(ctx);
  const phone = await ctx.newPage();
  await phone.goto(`${BASE}/settings/ext/accounts/networks`);
  await phone.waitForSelector('[data-testid=acc-card]', { timeout: 20000 });
  check(/Tous les comptes de messagerie/.test((await phone.textContent('[data-testid=acc-dashboard]')) ?? ''), 'phone: French labels');
  check((await overflowX(phone)) <= 0, 'phone: no horizontal overflow (list)');
  await phone.waitForTimeout(500);
  await shot(phone, 'accounts-phone');
  await phone.locator('[data-testid=acc-card-link]').first().click();
  await phone.waitForSelector('[data-testid=acc-detail][data-account]', { timeout: 15000 });
  check(await phone.isVisible('[data-testid=acc-back]'), 'phone: "Tous les réseaux" link');
  if (OFFLINE) check(await phone.isVisible('[data-testid=acc-hint]'), 'phone: the account in trouble says what to do');
  check((await overflowX(phone)) <= 0, 'phone: no horizontal overflow (account)');
  await phone.waitForTimeout(400);
  await shot(phone, 'accounts-phone-detail');
  await phone.click('[data-testid=acc-back]');
  await phone.waitForTimeout(600);
  check(new URL(phone.url()).pathname === '/settings/ext/accounts/networks', 'phone: back to the dashboard');

  check(desktopAttempts.length === 0 && phoneAttempts.length === 0, `read-only: no write to the space's API (${[...desktopAttempts, ...phoneAttempts].join(', ') || 'none'})`);
  check(s.blocked.length === 0, `no write to a chat attempted (${s.blocked.join(', ') || 'none'})`);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
