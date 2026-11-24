// Group members' bubbles get one colour each (0.4.5), read-only, light and dark.
// sh web/test/e2e/run-offline.sh groupcolors.e2e.js
const { BASE, check, open, enroll, logout, shot, done } = require('./lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  await enroll(page);
  // GROUP_CHAT (the offline instance's), else the first group of the list.
  const group =
    process.env.GROUP_CHAT ||
    (await page.evaluate(async () => (await (await fetch('/api/chats?limit=50')).json()).items.find((c) => c.type === 'group')?.id));
  check(!!group, 'group chat found');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${BASE}/chat/${encodeURIComponent(group)}`);
    await page.waitForSelector('.msg.other .sender');
    const rows = await page.$$eval('.msg.other', (els) =>
      els.map((e) => ({ hue: e.style.getPropertyValue('--sh'), bg: getComputedStyle(e.querySelector('.bubble')).backgroundColor, name: e.querySelector('.sender')?.textContent })),
    );
    const bySender = new Map();
    for (const r of rows) if (r.name) bySender.set(r.name, r.hue);
    console.log(`     ${scheme}: ${JSON.stringify([...bySender])}`);
    check(rows.length > 0 && rows.every((r) => r.hue !== ''), `${scheme}: every incoming bubble is tinted`);
    check(new Set(bySender.values()).size === bySender.size, `${scheme}: one distinct colour per member`);
    await shot(page, `group-colors-${scheme}`);
  }
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
