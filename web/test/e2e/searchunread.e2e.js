// A chat opened from the search results is read there too (0.18.14): its unread badge goes in the results, not only
// in the inbox (the results keep their own copy of the chats). Read-only: the chat's mark-read is answered here,
// never sent for real. sh web/test/e2e/run-offline.sh searchunread.e2e.js
const { BASE, check, open, enroll, logout, shot, done } = require('./lib');

const CHAT = '!emma:beeper.local';

(async () => {
  const { browser, page, csp, blocked } = await open();
  await enroll(page);
  await page.route('**/api/chats/*/read', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  try {
    await page.goto(BASE + '/');
    await page.fill('[data-testid=search]', 'Emma');
    const row = page.locator(`[data-testid=search-results] [data-testid=chat-row][data-chat-id="${CHAT}"]`);
    await row.waitFor({ timeout: 20000 });
    check((await row.locator('.badge').count()) === 1, 'the search result shows its unread count');
    await row.click();
    await page.waitForURL(`**/chat/${encodeURIComponent(CHAT)}`, { timeout: 15000 });
    let badges = 1;
    for (let i = 0; i < 20 && badges; i++) {
      await page.waitForTimeout(250);
      badges = await row.locator('.badge').count();
    }
    check((await page.locator('[data-testid=search-results]').isVisible()) && badges === 0, 'opened from the results: its badge goes there too');
    await shot(page, 'searchunread');
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
