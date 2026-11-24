// Network filter (0.17.5: in the search bar, a panel of every network; no row of its own). Read-only.
// sh web/test/e2e/run-offline.sh netfilter.e2e.js
const { check, open, enroll, logout, done, SHOTS } = require('./lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  await enroll(page);
  // What the panel should count: inbox chats with unread messages per account (muted, archived, low priority left out).
  const { accounts, unread, owner } = await page.evaluate(async () => {
    const accounts = (await (await fetch('/api/accounts')).json()).map((a) => a.accountID);
    const chats = (await (await fetch('/api/chats?limit=50')).json()).items;
    const unread = {};
    for (const c of chats) if (c.unreadCount > 0 && !c.isMuted && !c.isArchived && !c.isLowPriority) unread[c.accountID] = (unread[c.accountID] ?? 0) + 1;
    return { accounts, unread, owner: Object.fromEntries(chats.map((c) => [c.id, c.accountID])) };
  });
  const withUnread = Object.keys(unread);
  check(accounts.length >= 3 && withUnread.length > 0, `fixture: ${accounts.length} accounts, unread on ${withUnread.join(', ')}`);
  // Picked: one network without unread chats, so the others' unread show as the dot.
  const pick = accounts.find((a) => !unread[a] && a !== 'hungryserv') ?? accounts[0];

  for (const [name, w, h] of [['desktop', 1200, 800], ['phone', 390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForSelector('[data-testid=net-open]');
    const layout = await page.evaluate(() => {
      const bar = document.querySelector('.search-bar');
      const b = document.querySelector('[data-testid=net-open]').getBoundingClientRect();
      const box = bar.getBoundingClientRect();
      return { inBar: b.left >= box.left && b.right <= box.right && b.top >= box.top && b.bottom <= box.bottom, first: bar.parentElement.firstElementChild === bar };
    });
    check(layout.inBar && layout.first, `${name}: the filter sits in the search bar, no row above it`);

    await page.click('[data-testid=net-open]');
    await page.waitForSelector('[data-testid=net-picker]');
    const items = await page.$$eval('[data-testid=net-item]', (els) => els.map((e) => ({ id: e.dataset.account, badge: e.querySelector('.badge')?.textContent ?? '', focused: e === document.activeElement })));
    check(items.length === accounts.length && accounts.every((a) => items.some((i) => i.id === a)), `${name}: the panel lists every network (${items.length})`);
    check(items.every((i) => i.badge === (unread[i.id] ? String(unread[i.id]) : '')), `${name}: unread chats per network in the panel`);
    check(items[0].focused, `${name}: the panel takes the focus`);
    await page.click(`[data-testid=net-item][data-account="${pick}"]`);
    check(await page.isVisible('[data-testid=net-picker]'), `${name}: picking keeps the panel open (several can be picked)`);
    await page.screenshot({ path: `${SHOTS}/netfilter-${name}-panel.png`, clip: { x: 0, y: 0, width: Math.min(w, 400), height: 480 } });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=net-picker]', { state: 'detached' });
    check(await page.evaluate(() => document.activeElement?.dataset.testid === 'net-open'), `${name}: Escape closes it, focus back on the button`);

    await page.waitForFunction(() => document.querySelectorAll('[data-testid=chat-row]').length > 0 || !!document.querySelector('[data-testid=no-filtered]'));
    const rows = await page.$$eval('[data-testid=chat-row]', (els) => els.map((e) => e.getAttribute('data-chat-id')));
    check(rows.every((id) => !owner[id] || owner[id] === pick), `${name}: the list shows only ${pick} (${rows.length} rows)`);
    const st = await page.evaluate(() => ({
      label: document.querySelector('[data-testid=net-open]').getAttribute('aria-label'),
      clear: !!document.querySelector('[data-testid=net-clear]'),
      dot: !!document.querySelector('[data-testid=net-elsewhere]'),
    }));
    check(st.clear && st.label.startsWith('Filtré : '), `${name}: the button names the filter and offers to clear it (${st.label})`);
    check(st.dot, `${name}: a dot for unread chats on the hidden networks`);
    await page.screenshot({ path: `${SHOTS}/netfilter-${name}.png`, clip: { x: 0, y: 0, width: Math.min(w, 400), height: 130 } });
    await page.click('[data-testid=net-clear]');
    await page.waitForSelector('[data-testid=net-clear]', { state: 'detached' });
    check(!(await page.$('[data-testid=net-elsewhere]')), `${name}: one click clears the filter`);
  }
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await page.setViewportSize({ width: 1200, height: 800 });
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
