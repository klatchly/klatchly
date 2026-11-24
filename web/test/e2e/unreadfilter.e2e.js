// "Unread only" beside the search field (0.18.14): the inbox keeps the chats with unread messages, the open chat
// stays (read as it opens), the choice survives a reload, and turning it off shows every chat again. Read-only: a
// mark-read is answered here, never sent. sh web/test/e2e/run-offline.sh unreadfilter.e2e.js
const { BASE, check, step, open, enroll, logout, shot, done } = require('./lib');

(async () => {
  const { browser, page, csp, blocked } = await open({ locale: 'fr-FR' });
  await enroll(page);
  await page.route('**/api/chats/*/read', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  const rows = () =>
    page.$$eval('[data-testid=chat-row]', (els) => els.map((e) => ({ id: e.getAttribute('data-chat-id'), unread: !!e.querySelector('.badge') })));
  try {
    await page.goto(BASE + '/');
    await page.waitForSelector('[data-testid=chat-row]', { timeout: 20000 });
    await page.waitForTimeout(800);
    const all = await rows();
    const unreadIDs = all.filter((r) => r.unread).map((r) => r.id);
    check(unreadIDs.length >= 2 && all.length > unreadIDs.length, `the inbox has read and unread chats (${unreadIDs.length}/${all.length})`);
    check((await page.getAttribute('[data-testid=unread-filter]', 'aria-pressed')) === 'false', 'the button is off at first');
    await page.click('[data-testid=unread-filter]');
    await page.waitForTimeout(500);
    let only = await rows();
    check(only.length === unreadIDs.length && only.every((r) => r.unread), `on: only the unread chats (${only.map((r) => r.id).join(', ')})`);
    check((await page.getAttribute('[data-testid=unread-filter]', 'aria-pressed')) === 'true' && (await page.textContent('[data-testid=unread-filter]')).includes('Non lus'), 'the button says it is on');
    await shot(page, 'unreadfilter');
    // The open chat stays though it is read as it opens.
    const opened = only[0].id;
    await page.click(`[data-testid=chat-row][data-chat-id="${opened}"]`);
    await page.waitForURL(`**/chat/${encodeURIComponent(opened)}`, { timeout: 15000 });
    await page.waitForTimeout(1200);
    only = await rows();
    check(only.some((r) => r.id === opened && !r.unread), 'the open chat stays in the list, read');
    // Kept after a reload (per device).
    await page.reload();
    await page.waitForSelector('[data-testid=unread-filter][aria-pressed=true]', { timeout: 20000 });
    step('still on after a reload');
    await page.click('[data-testid=unread-filter]');
    await page.waitForTimeout(500);
    check((await rows()).length >= all.length - 1, 'off: every chat again');
  } finally {
    check(!blocked.length, `no write to a chat (${blocked.join(', ') || 'none'})`);
  }
  await logout(page);
  await browser.close();
  done(csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
