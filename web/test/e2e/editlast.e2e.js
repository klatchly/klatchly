// ↑ in the empty field edits our last message (0.18.5, any physical keyboard): the inline editor opens on the newest
// editable message of ours, Escape gives the focus back to the field; not with text in the field. Writes: one
// edit in the test chat, put back to its text at the end. sh web/test/e2e/run-offline.sh editlast.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

const messages = (page) =>
  page.evaluate(async (id) => (await (await fetch(`/api/chats/${encodeURIComponent(id)}/messages`)).json()).items, TEST_CHAT);

(async () => {
  const { browser, page, csp, blocked } = await open();
  await enroll(page);
  const input = page.locator('[data-testid=composer-input]');
  const editor = page.locator('[data-testid=inline-edit-input]');
  let last;
  try {
    last = (await messages(page)).find((m) => m.isSender && !m.isDeleted && !m.attachments?.length && m.text);
    console.log(`     our last text: "${last?.text}"`);
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await input.waitFor({ timeout: 20000 });
    await page.waitForTimeout(1000);

    // Text in the field: ↑ only moves the caret.
    await input.fill('draft');
    await input.focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);
    check(!(await editor.count()), 'with text in the field, ↑ opens no editor');
    await input.fill('');

    await page.keyboard.press('ArrowUp');
    await editor.waitFor({ timeout: 3000 });
    const ed = await page.evaluate(() => {
      const el = document.activeElement;
      return { focused: el?.dataset.testid, value: el?.value, mid: el?.closest('[data-mid]')?.dataset.mid };
    });
    await page.waitForTimeout(400);
    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=inline-edit-input]');
      const r = document.querySelector('[data-testid=inline-edit-save]').getBoundingClientRect();
      const list = document.querySelector('[data-testid=composer-input]').closest('form').getBoundingClientRect();
      const msg = el.closest('.msg').getBoundingClientRect();
      return { client: el.clientHeight, scroll: el.scrollHeight, width: Math.round(el.getBoundingClientRect().width), inside: msg.right <= document.documentElement.clientWidth, saveVisible: r.bottom <= list.top && r.height > 0 };
    });
    check(box.scroll <= box.client + 1 && box.width >= 400 && box.inside && box.saveVisible, `the editor shows the whole text, wide, in view with its buttons (${JSON.stringify(box)})`);
    check(ed.focused === 'inline-edit-input' && ed.value === last.text && ed.mid === last.id, `↑ in the empty field edits our last message (${JSON.stringify(ed)})`);
    await shot(page, 'editlast-open');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check(!(await editor.count()), 'Escape closes the editor');
    check((await page.evaluate(() => document.activeElement?.dataset.testid)) === 'composer-input', 'the focus is back in the field');

    // ↑ again, change it, save (Enter needs a fine pointer, which headless Chrome lacks): the focus is back in the field.
    await page.keyboard.press('ArrowUp');
    await editor.waitFor({ timeout: 3000 });
    // A long text: the editor grows with it (wrapped lines included), no inner scroll.
    await page.keyboard.insertText(' — un texte assez long pour passer sur plusieurs lignes, comme un vrai message.'.repeat(4));
    await page.waitForTimeout(300);
    const long = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=inline-edit-input]');
      const r = el.getBoundingClientRect();
      const save = document.querySelector('[data-testid=inline-edit-save]').getBoundingClientRect();
      const field = document.querySelector('[data-testid=composer-input]').closest('form').getBoundingClientRect();
      return { client: el.clientHeight, scroll: el.scrollHeight, top: Math.round(r.top), saveBottom: Math.round(save.bottom), fieldTop: Math.round(field.top) };
    });
    check(long.client > 60 && long.scroll <= long.client + 1 && long.top > 60 && long.saveBottom <= long.fieldTop, `a long text is shown whole, in view with its buttons (${JSON.stringify(long)})`);
    await shot(page, 'editlast-long');
    await page.keyboard.press('Control+A');
    await page.keyboard.type(`${last.text} (edited)`);
    const [res] = await Promise.all([page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/messages/')), page.click('[data-testid=inline-edit-save]')]);
    check(res.ok(), `edit saved (${res.status()})`);
    await page.waitForTimeout(300);
    check((await page.evaluate(() => document.activeElement?.dataset.testid)) === 'composer-input', 'after saving, the focus is back in the field');
    const after = (await messages(page)).find((m) => m.id === last.id);
    check(after?.text === `${last.text} (edited)`, `server has the new text ("${after?.text}")`);
  } finally {
    if (last) await page.evaluate(([c, m, text]) => fetch(`/api/chats/${encodeURIComponent(c)}/messages/${encodeURIComponent(m)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }), [TEST_CHAT, last.id, last.text]).catch(() => {});
  }
  check(!blocked.length, `no write to another chat (${blocked.join(', ') || 'none'})`);
  await logout(page);
  await browser.close();
  done(csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
