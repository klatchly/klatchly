// ✨ in a message being edited (0.18.15): the writing help's fixes run on the editor's text (offline llm.mjs fixes
// "je pense que on pourrais" → "Je pense qu'on pourrait."), the original shows under it, Undo puts it back; the
// chat agent's section is not there. Nothing is saved: the edit is cancelled. Only the test chat.
// sh web/test/e2e/run-offline.sh ../../ext/writing/test/editassist.e2e.cjs
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('../../../test/e2e/lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page, blocked } = s;
  await enroll(page);
  const puts = [];
  page.on('request', (r) => r.method() === 'PUT' && r.url().includes('/messages/') && puts.push(r.url()));
  try {
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    const input = page.locator('[data-testid=composer-input]');
    await input.waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    await input.focus();
    await page.keyboard.press('ArrowUp');
    const editor = page.locator('[data-testid=inline-edit-input]');
    await editor.waitFor({ timeout: 5000 });
    await editor.fill('je pense que on pourrais');
    await page.click('[data-testid=inline-edit-assist]');
    await page.waitForSelector('[data-testid=assist-menu] [data-testid=assist-grammar]', { timeout: 10000 });
    const items = await page.$$eval('[data-testid=assist-menu] [role=menuitem]', (els) => els.map((e) => e.getAttribute('data-testid')));
    console.log(`     menu: ${items.join(', ')}`);
    check(items.includes('assist-spelling') && items.includes('assist-grammar'), 'the editor has the ✨ fixes');
    check(!items.some((i) => /agent/.test(i ?? '')), 'not the chat agent');
    await page.click('[data-testid=assist-menu] [data-testid=assist-grammar]');
    let v = '';
    for (let i = 0; i < 40 && v !== "Je pense qu'on pourrait."; i++) {
      await page.waitForTimeout(250);
      v = await editor.inputValue();
    }
    check(v === "Je pense qu'on pourrait.", `the text is fixed in the editor ("${v}")`);
    const bar = page.locator('[data-testid=inline-edit-assist-bar]');
    await bar.waitFor({ timeout: 5000 });
    check((await bar.textContent()).includes('je pense que on pourrais'), 'the original shows under it');
    await shot(page, 'editassist');
    await page.click('[data-testid=inline-edit-assist-undo]');
    check((await editor.inputValue()) === 'je pense que on pourrais', 'Undo puts it back');
    await page.click('[data-testid=inline-edit-cancel]');
    await page.waitForTimeout(300);
    check(!(await editor.count()) && !puts.length, 'cancelled: nothing saved');
  } finally {
    check(!blocked.length, `no write to another chat (${blocked.join(', ') || 'none'})`);
  }
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
