// Quick action on messages (0.13.5): a one-tap button in the hover row of received messages, chosen per chat
// in the ✨ settings; unset = translate into French (same translation as the message menu). TEST chat only,
// nothing is sent. The test chat may hold only our own messages, so the newest one is shown as received by
// rewriting the page's copy of the history (the server and the chat are untouched); its translation is
// hidden again and the setting cleared at the end.
// sh web/test/e2e/run-offline.sh ../../ext/writing/test/msgquick.e2e.cjs
const { BASE, TEST_CHAT, check, step, open, enroll, logout, shot, done } = require('../../../test/e2e/lib');

const put = (page, body) =>
  page.evaluate(
    async (b) => {
      const r = await fetch('/api/assist/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    body,
  );

const langFr = (code) => new Intl.DisplayNames(['fr'], { type: 'language' }).of(code);

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  let fakeID;
  let langs;
  try {
    await enroll(page);
    // The user's translation languages, put back at the end.
    langs = await page.evaluate(async () => (await fetch('/api/assist/langs')).json());
    // Server validation: only the supported languages, 'none' or '' (back to the default).
    const bad = await put(page, { chatID: TEST_CHAT, msgQuick: 'translate:xx' });
    check(bad.status === 400, `unknown action refused (${bad.status})`);
    const off = await put(page, { chatID: TEST_CHAT, msgQuick: 'none' });
    check(off.status === 200 && off.body.msgQuick === 'none', `'none' stored (${JSON.stringify(off.body)})`);
    const reset = await put(page, { chatID: TEST_CHAT, msgQuick: '' });
    check(reset.status === 200 && !reset.body.msgQuick, `'' back to the default (${JSON.stringify(reset.body)})`);

    // The newest text message of the test chat, shown as received (this page only).
    await page.route(`**/api/chats/${encodeURIComponent(TEST_CHAT)}/messages*`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      let j;
      try {
        j = await res.json();
      } catch {
        return route.fulfill({ response: res });
      }
      const m = (j.items || []).find((x) => x.text && x.text.trim() && !x.isDeleted && x.type !== 'NOTICE');
      if (m && (!fakeID || fakeID === m.id)) {
        fakeID = m.id;
        m.isSender = false;
        m.senderName = 'Test';
      }
      return route.fulfill({ response: res, json: j });
    });
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=msg-text]');
    if (fakeID) await page.waitForSelector(`[data-mid="${fakeID}"] [data-testid=msg-text]`, { timeout: 10000 });
    check(!!fakeID, 'a test message shown as received');
    const received = page.locator(`[data-mid="${fakeID}"]`);
    const ownMsg = page.locator('.msg.own:has([data-testid=msg-text])').last();
    if (await ownMsg.count()) {
      await ownMsg.locator('[data-testid=bubble]').hover();
      check((await ownMsg.locator('[data-testid=msg-quick]').count()) === 0, 'no quick action on our own messages');
    }
    await received.locator('[data-testid=bubble]').hover();
    const btn = received.locator('[data-testid=msg-quick]');
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    check((await btn.getAttribute('title')) === `Traduire en ${langFr(langs.readLangs[0])}`, `default: the first language for received messages (${await btn.getAttribute('title')})`);
    check((await btn.textContent()).trim() === langs.readLangs[0].toUpperCase(), `short label (${(await btn.textContent()).trim()})`);
    const order = await received.locator('.msg-actions button').evaluateAll((els) => els.map((e) => e.dataset.testid));
    check(order[0] === 'msg-quick' && order.includes('msg-more'), `in the action row, next to react / more (${order.join(' > ')})`);
    // Headless Chromium reports (hover: none): the row stays transparent, so show it for the picture and
    // the button is clicked by event below.
    await received.locator('.msg-actions').evaluate((el) => (el.style.opacity = '1'));
    await page.waitForTimeout(300);
    await shot(page, 'msgquick-row');

    // Settings: the ✨ menu shows French as the choice; "None" hides the button.
    await page.click('[data-testid=assist-head-btn]');
    await page.waitForSelector('[data-testid=assist-msg-quick]');
    check((await page.inputValue('[data-testid=assist-msg-quick]')) === '', 'settings show "Default" as the choice');
    const choices = await page.$$eval('[data-testid=assist-msg-quick] option', (o) => o.map((x) => x.value));
    check(JSON.stringify(choices) === JSON.stringify(['', 'none', ...langs.readLangs.map((l) => `translate:${l}`)]), `choices: Default, None, the languages for received messages (${choices.join(', ')})`);
    await shot(page, 'msgquick-settings');
    await page.selectOption('[data-testid=assist-msg-quick]', 'none');
    await page.click('[data-testid=assist-save]');
    await btn.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await received.locator('[data-testid=bubble]').hover();
    check((await btn.count()) === 0, '"None" hides the button');
    await put(page, { chatID: TEST_CHAT, msgQuick: '' });
    await page.reload();
    await page.waitForSelector(`[data-mid="${fakeID}"]`);
    await page.waitForTimeout(1000);

    // One tap: the same translation as the menu, under the bubble; the button goes away while it shows.
    await received.locator('[data-testid=bubble]').hover();
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    await btn.dispatchEvent('click');
    await received.locator('[data-testid=msg-translation-text]').waitFor({ timeout: 30000 });
    const head = await received.locator('[data-testid=msg-translation] .translation-head span').textContent();
    check(head === `Traduction · ${langFr(langs.readLangs[0])}`, `translation shown under the bubble (${head})`);
    await received.locator('[data-testid=bubble]').hover();
    check((await btn.count()) === 0, 'no button while that translation shows');
    await shot(page, 'msgquick-translated');
    await received.locator('[data-testid=translation-close]').click();
    await received.locator('[data-testid=bubble]').hover();
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    step('button back once the translation is hidden');

    // 0.15.9: the languages for received messages (Settings) make the default and the menu entries.
    const set = await page.evaluate(async () => (await fetch('/api/assist/langs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readLangs: ['ja', 'en'] }) })).status);
    check(set === 200, `languages for received messages set to ja, en (${set})`);
    await page.reload();
    await page.waitForSelector(`[data-mid="${fakeID}"]`);
    await page.waitForTimeout(1000);
    await received.locator('[data-testid=bubble]').hover();
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    check((await btn.getAttribute('title')) === 'Traduire en japonais' && (await btn.textContent()).trim() === 'JA', `default follows the first language (${await btn.getAttribute('title')})`);
    await received.locator('[data-testid=bubble]').click({ button: 'right', position: { x: 12, y: 12 } });
    await page.waitForSelector('[data-testid=message-menu]');
    const items = await page.$$eval('[data-testid=message-menu] [data-testid^=menu-translate-]', (els) => els.map((e) => `${e.dataset.testid}=${e.textContent}`));
    check(JSON.stringify(items) === JSON.stringify(['menu-translate-ja=Traduire en japonais', 'menu-translate-en=Traduire en anglais']), `menu: one entry per language (${items.join(', ')})`);
    await page.keyboard.press('Escape');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    if (langs) {
      const back = await page
        .evaluate(async (l) => (await fetch('/api/assist/langs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(l) })).json(), langs)
        .catch((e) => ({ error: String(e) }));
      check(JSON.stringify(back) === JSON.stringify(langs), `translation languages put back (${JSON.stringify(back)})`);
    }
    const r = await put(page, { chatID: TEST_CHAT, msgQuick: '', quick: '' }).catch((e) => ({ body: { error: String(e) } }));
    check(r.body && !r.body.msgQuick && !r.body.quick && !r.body.error, `settings cleared (${JSON.stringify(r.body)})`);
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
