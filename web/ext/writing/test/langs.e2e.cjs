// Settings → Langues de traduction (0.15.9; /settings/ext/writing/langs): the languages offered to translate a draft
// (up to 3) and received messages (up to 2), in order, the first the default; saved at once, app-wide. Then the
// composer's ✨ menu and the chat settings follow them. No AI call, nothing is sent; the user's lists are put back
// at the end (and the test chat's settings cleared).
// sh web/test/e2e/run-offline.sh ../../ext/writing/test/langs.e2e.cjs
const { BASE, TEST_CHAT, check, open, enroll, logout, settingsPage, shot, done } = require('../../../test/e2e/lib');

const get = (page) => page.evaluate(async () => (await fetch('/api/assist/langs')).json());
const putLangs = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch('/api/assist/langs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);
const chips = (page, row) => page.$$eval(`[data-testid=langs-${row}] .langs-chip`, (els) => els.map((e) => e.dataset.testid.split('-').pop()));

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  let before;
  try {
    await enroll(page);
    before = await get(page);
    console.log(`     lists before: ${JSON.stringify(before)}`);
    // Server validation: 1 to 3 / 1 to 2 distinct supported languages.
    for (const bad of [{ draftLangs: [] }, { draftLangs: ['vi', 'fr', 'en', 'ja'] }, { readLangs: ['fr', 'en', 'ja'] }, { readLangs: ['fr', 'fr'] }, { draftLangs: ['xx'] }, { other: 1 }]) {
      const r = await putLangs(page, bad);
      check(r.status === 400, `refused: ${JSON.stringify(bad)} (${r.status})`);
    }
    const set = await putLangs(page, { draftLangs: ['vi', 'fr', 'en'], readLangs: ['fr', 'en'] });
    check(set.status === 200, 'the defaults set for the test');

    // The page, at phone width: two rows, the chips in order, the first marked as default.
    await page.setViewportSize({ width: 390, height: 844 });
    await settingsPage(page, 'writing-langs');
    check(new URL(page.url()).pathname === '/settings/ext/writing/langs', "its page in writing's namespace");
    await page.waitForSelector('[data-testid=langs-settings]');
    check((await page.$$('[data-testid=langs-settings] .set-row')).length === 2, 'two Settings rows');
    const text = await page.textContent('[data-testid=langs-settings]');
    check(/Traduire mes messages en/.test(text) && /Traduire les messages reçus en/.test(text) && /par défaut/.test(text), 'labels in French, the default named');
    check(JSON.stringify(await chips(page, 'draft')) === '["vi","fr","en"]' && JSON.stringify(await chips(page, 'read')) === '["fr","en"]', 'the lists in order');
    check(!(await page.isVisible('[data-testid=langs-draft-add]')), 'three languages for drafts: nothing more to add');
    check(!(await page.isVisible('[data-testid=langs-read-add]')), 'two for received messages: nothing more to add');
    const noHScroll = await page.evaluate(() => {
      const d = document.querySelector('[data-testid=settings]');
      return d.scrollWidth <= d.clientWidth + 1;
    });
    check(noHScroll, 'no horizontal scroll at phone width');
    await shot(page, 'langs-settings-phone');

    // Remove, add, move up: each saved at once.
    await page.click('[data-testid=langs-draft-remove-fr]');
    await page.click('[data-testid=langs-draft-add]');
    await page.click('[data-testid=langs-draft-add-ja]');
    await page.waitForSelector('[data-testid=langs-draft-ja]');
    await page.click('[data-testid=langs-draft-up-ja]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=langs-draft] .langs-chip')[1]?.dataset.testid === 'langs-draft-ja', null, { timeout: 5000 }).catch(() => {});
    check(JSON.stringify(await chips(page, 'draft')) === '["vi","ja","en"]', `drafts: fr removed, ja added then moved up (${await chips(page, 'draft')})`);
    await page.click('[data-testid=langs-read-remove-fr]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=langs-read] .langs-chip').length === 1);
    check(await page.isDisabled('[data-testid=langs-read-remove-en]'), 'the last language cannot be removed');
    await page.click('[data-testid=langs-read-add]');
    await page.click('[data-testid=langs-read-add-de]');
    await page.waitForSelector('[data-testid=langs-read-de]');
    await page.click('[data-testid=langs-read-up-de]');
    const want = JSON.stringify({ draftLangs: ['vi', 'ja', 'en'], readLangs: ['de', 'en'] });
    let saved;
    for (let i = 0; i < 20 && JSON.stringify((saved = await get(page))) !== want; i++) await page.waitForTimeout(250);
    check(JSON.stringify(saved) === want, `saved on the server (${JSON.stringify(saved)})`);
    check((await page.textContent('[data-testid=langs-note]')) === 'Enregistré.', 'says it is saved');
    await shot(page, 'langs-settings-changed');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'langs-settings-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // The composer follows: the ✨ menu lists the drafts' languages (the chat's own first), the quick choices too.
    await page.setViewportSize({ width: 1200, height: 800 });
    await putLangs(page, { draftLangs: ['ja', 'en'] });
    await page.evaluate(async (id) => fetch('/api/assist/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatID: id, quick: '', msgQuick: '', lang: 'en' }) }), TEST_CHAT);
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=composer-input]');
    await page.click('[data-testid=assist-btn]');
    await page.waitForSelector('[data-testid=assist-menu]');
    const menu = async () => page.$$eval('[data-testid=assist-menu] [data-testid^=assist-translate-]', (els) => els.map((e) => e.dataset.testid.split('-').pop()));
    const langOfChat = (await page.evaluate(async (id) => (await (await fetch(`/api/assist/prefs?chatID=${encodeURIComponent(id)}`)).json()).lang, TEST_CHAT)) || null;
    const expected = langOfChat ? [langOfChat, ...['ja', 'en'].filter((l) => l !== langOfChat)] : ['ja', 'en'];
    check(JSON.stringify(await menu()) === JSON.stringify(expected), `✨ menu: the drafts' languages, the chat's first (${await menu()})`);
    check(((await page.textContent('[data-testid=assist-translate-ja]')) || '').includes('japonais'), 'named in French');
    await page.click('[data-testid=assist-open-settings]');
    const quick = await page.$$eval('[data-testid=assist-quick] option', (o) => o.map((x) => x.value));
    check(JSON.stringify(quick) === JSON.stringify(['none', 'spelling', 'grammar', 'rephrase', 'translate:ja', 'translate:en']), `quick button: fixes and the drafts' languages (${quick.join(', ')})`);
    const msgQ = await page.$$eval('[data-testid=assist-msg-quick] option', (o) => o.map((x) => x.value));
    check(JSON.stringify(msgQ) === JSON.stringify(['', 'none', 'translate:de', 'translate:en']), `quick action on messages: Default, None, the received languages (${msgQ.join(', ')})`);
    check((await page.inputValue('[data-testid=assist-msg-quick]')) === '', 'unset: "Default" selected');
    const defMsg = await page.$eval('[data-testid=assist-msg-quick] option[value=""]', (o) => o.textContent);
    check(defMsg === 'Par défaut (Traduire en allemand)', `"Default" names the first of them (${defMsg})`);
    const langOpts = await page.$$eval('[data-testid=assist-lang] option', (o) => o.map((x) => x.value));
    check(langOpts[0] === '' && ['ja', 'en'].every((l) => langOpts.includes(l)), `default language: "Default" first, then the drafts' languages (${langOpts.join(', ')})`);
    check((await page.$eval('[data-testid=assist-lang] option[value=""]', (o) => o.textContent)) === 'Par défaut (japonais)', '"Default" names the first language for drafts');
    await shot(page, 'langs-composer-settings');
    // The chat remembers the last language used ('en' here); "Default" clears it, the untouched select is not sent.
    check((await page.inputValue('[data-testid=assist-lang]')) === 'en', "the chat's own language selected");
    await page.selectOption('[data-testid=assist-lang]', '');
    const savedPrefs = page.waitForResponse((r) => r.url().includes('/api/assist/prefs') && r.request().method() === 'PUT');
    await page.click('[data-testid=assist-save]');
    await savedPrefs;
    const after = await page.evaluate(async (id) => (await fetch(`/api/assist/prefs?chatID=${encodeURIComponent(id)}`)).json(), TEST_CHAT);
    check(!('lang' in after) && !('msgQuick' in after), `"Default" saved as unset (${JSON.stringify(after)})`);
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    await page
      .evaluate(async (id) => fetch('/api/assist/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatID: id, quick: '', msgQuick: '', lang: '' }) }), TEST_CHAT)
      .catch(() => {});
    if (before) {
      const back = await putLangs(page, before).catch((e) => ({ body: { error: String(e) } }));
      check(JSON.stringify(back.body) === JSON.stringify(before), `lists put back (${JSON.stringify(back.body)})`);
    }
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
