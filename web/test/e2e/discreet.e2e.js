// Discreet reading (after 0.17.3): offline only (it needs the fakes' hooks: INJECT_URL). Turns it on for the test
// chat's account in Settings → Lecture discrète (its own page since 0.18.4), gets a message in the test chat, opens it: Klatchly shows it read, and the fake
// Desktop API got no read (each one would send a read receipt). Then "Mark as read" in the conversation header: one
// read. The setting is server-wide: put back at the end. Then per chat (0.18.1), the account off again: the test
// chat's menu (right click in the archives) makes it discreet: no read sent, the header's mark; Settings lists it,
// its × takes it out; made discreet then "not discreet" from the menu: the read goes again; Settings shows it as
// Normale; its segmented control turns it back to Discrète; "reset all", confirmed, empties the list. "Add a
// conversation" (0.18.4): the picker finds the test chat and makes it discreet; its name opens it. Past 8
// conversations a filter (made-up chat ids, unknown to the fake: no chat is touched). The page on a phone too.
// sh web/test/e2e/run-offline.sh discreet.e2e.js
const { BASE, TEST_CHAT, check, step, open, enroll, settingsPage, logout, shot, done } = require('./lib');

const injectURL = process.env.INJECT_URL;
const hooks = injectURL && injectURL.replace(/inject$/, '');
const reads = async () => (await (await fetch(`${hooks}calls`)).json()).beeperReads.filter((id) => id === TEST_CHAT).length;
const inject = (text) => fetch(injectURL, { method: 'POST', body: text });
const row = `[data-testid=chat-row][data-chat-id="${TEST_CHAT}"]`;
/** Polls `get` until `ok` holds, 10 s at most; the last value. */
async function until(get, ok) {
  let v;
  for (let i = 0; i < 50; i++) {
    v = await get();
    if (ok(v)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return v;
}

(async () => {
  if (!hooks) {
    console.log('     offline only (no INJECT_URL): skipped');
    return done([]);
  }
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  const enc = encodeURIComponent(TEST_CHAT);
  const unreadOf = () => page.evaluate(async (id) => (await (await fetch(`/api/chats/${id}`)).json()).unreadCount, enc);
  let account;
  try {
    await enroll(page);
    account = await page.evaluate(async (id) => (await (await fetch(`/api/chats/${id}`)).json()).accountID, enc);

    // Settings → Lecture discrète: one switch per account, off by default; on for the test chat's account. The line
    // under the account says what the switch does now, and follows it.
    await settingsPage(page, 'reading');
    await page.waitForSelector(`[data-testid=reading-toggle-${account}]`, { timeout: 15000 });
    const before = await page.getAttribute(`[data-testid=reading-toggle-${account}]`, 'aria-checked');
    check(before === 'false', `off by default for ${account}`);
    const stateOf = () => page.getAttribute(`[data-testid=reading-state-${account}]`, 'data-state');
    const offLine = await page.textContent(`[data-testid=reading-state-${account}]`);
    check((await stateOf()) === 'off' && /prévient l’expéditeur/.test(offLine), `off: the line says opening tells the sender (${offLine})`);
    await page.click(`[data-testid=reading-toggle-${account}]`);
    await page.waitForSelector(`[data-testid=reading-toggle-${account}][aria-checked=true]`, { timeout: 10000 });
    step('switched on');
    const onLine = await page.textContent(`[data-testid=reading-state-${account}]`);
    check((await stateOf()) === 'on' && /ne prévient personne/.test(onLine), `on: the line follows (${onLine})`);
    check(!!(await page.textContent('[data-testid=reading-note-beeper]'))?.trim(), "the source's note, once under its accounts");
    await shot(page, 'discreet-settings');

    // A message comes in; opening the chat reads it in Klatchly only.
    await inject('discreet reading check');
    await until(unreadOf, (n) => n > 0);
    await page.goto(`${BASE}/chat/${enc}`);
    await page.waitForSelector('[data-testid=msg]', { timeout: 15000 });
    check((await until(unreadOf, (n) => n === 0)) === 0, 'read in Klatchly (unread 0)');
    // A second message while the chat is open: read at once, still quietly. Waited for: the message shown, then the
    // chat read again in Klatchly (the read that would have sent a receipt has happened).
    await inject('second discreet check');
    await page.waitForSelector('text=second discreet check', { timeout: 10000 });
    check((await until(unreadOf, (n) => n === 0)) === 0, 'the new message read in Klatchly too');
    check((await reads()) === 0, `no read sent to the network (${await reads()})`);
    check(await page.isVisible('[data-testid=reply-hint]'), 'the composer says once that replying may tell');
    check(/marquera tous ses messages précédents comme lus/.test(await page.textContent('[data-testid=reply-hint] span')) && (await page.getAttribute('[data-testid=reply-hint]', 'data-sure')) === 'true', 'the reply hint, certain (replying reads the chat for real)');

    // "Mark as read": one read, the toast says the sender was told.
    await page.click('[data-testid=conv-mark-read]', { timeout: 5000 });
    await page.waitForSelector('[data-testid=toast]', { timeout: 5000 });
    for (let i = 0; i < 20 && (await reads()) === 0; i++) await page.waitForTimeout(150);
    check((await reads()) === 1, `"Mark as read" sends one read (${await reads()})`);
    await shot(page, 'discreet-markread');

    // A reply in the discreet chat (0.18.4): a message comes in (read quietly, the chat open), then our reply reads
    // the chat for real: exactly one read.
    await inject('before reply check');
    await page.waitForSelector('text=before reply check', { timeout: 10000 });
    check((await until(unreadOf, (n) => n === 0)) === 0 && (await reads()) === 1, 'a message while open: read quietly, no read sent');
    const replied = await page.evaluate((id) => fetch(`/api/chats/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"reply check"}' }).then((r) => r.status), enc);
    await until(reads, (x) => x > 1);
    await page.waitForTimeout(800);
    check(replied === 200 && (await reads()) === 2, `a reply reads the chat for real, once (${await reads()} reads)`);

    // Per chat: the account off again; the test chat's own choice from its menu (right click: in the inbox now that
    // the reply took it out of the archives, else in the archives).
    await page.evaluate((a) => fetch(`/api/reading/${encodeURIComponent(a)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"discreet":false}' }), account);
    const menu = async () => {
      await page.goto(BASE);
      await page.waitForSelector('[data-testid=chat-row]', { timeout: 15000 });
      if (!(await page.$(row))) await page.click('[data-testid=open-archives]', { timeout: 15000 });
      await page.click(row, { button: 'right', timeout: 15000 });
      await page.waitForSelector('[data-testid=chat-menu-discreet]', { timeout: 10000 });
      return page.getAttribute('[data-testid=chat-menu-discreet]', 'aria-checked');
    };
    check((await menu()) === 'false', 'menu: « Lecture discrète » unchecked (the account is off)');
    check(!(await page.$('[data-testid=chat-menu-discreet-reset]')), 'no « Revenir au réglage du compte » without a choice');
    await page.click('[data-testid=chat-menu-discreet]');
    await page.waitForFunction(async (id) => (await (await fetch('/api/reading')).json()).chats?.[id] === true, TEST_CHAT, { timeout: 10000 });
    let n = await reads();
    await inject('per chat discreet check');
    await until(unreadOf, (x) => x > 0);
    await page.goto(`${BASE}/chat/${enc}`);
    await page.waitForSelector('text=per chat discreet check', { timeout: 15000 });
    check((await until(unreadOf, (x) => x === 0)) === 0, 'per chat: read in Klatchly');
    check((await reads()) === n, `per chat: no read sent (${(await reads()) - n})`);
    check(await page.isVisible('[data-testid=conv-discreet]'), 'the header shows the discreet mark');
    await shot(page, 'discreet-chat-header');

    // Settings lists it (name, Discrète); its × puts it back on the account's.
    const item = `[data-testid=reading-chat][data-chat-id="${TEST_CHAT}"]`;
    const stateIn = () => page.getAttribute(`${item} [data-testid=reading-chat-state]`, 'data-value');
    await settingsPage(page, 'reading');
    await page.waitForSelector(item, { timeout: 15000 });
    check((await page.textContent(`${item} .set-label`)).trim().length > 0, 'Settings: the chat by its name');
    check((await stateIn()) === 'discreet' && (await page.getAttribute(`${item} [data-testid=reading-chat-discreet]`, 'aria-checked')) === 'true', 'Settings: Discrète');
    check((await page.textContent('[data-testid=reading-chats-count]')).trim() === '1', 'Settings: the count');
    await page.$eval(item, (el) => el.scrollIntoView({ block: 'center' }));
    await shot(page, 'discreet-chat-settings');
    await page.click(`${item} [data-testid=reading-chat-remove]`);
    await page.waitForSelector('[data-testid=reading-chats-none]', { timeout: 10000 });
    check(!(await page.$(item)), 'Settings: × takes it out');

    // Discreet again, then not: checked, then an explicit "not discreet", and the read goes.
    await menu();
    await page.click('[data-testid=chat-menu-discreet]');
    await page.waitForFunction(async (id) => (await (await fetch('/api/reading')).json()).chats?.[id] === true, TEST_CHAT, { timeout: 10000 });
    check((await menu()) === 'true', 'menu: checked once chosen');
    check(!!(await page.$('[data-testid=chat-menu-discreet-reset]')), 'menu: « Revenir au réglage du compte » offered');
    await shot(page, 'discreet-chat-menu');
    await page.click('[data-testid=chat-menu-discreet]');
    await page.waitForFunction(async (id) => (await (await fetch('/api/reading')).json()).chats?.[id] === false, TEST_CHAT, { timeout: 10000 });
    n = await reads();
    await inject('per chat normal check');
    await until(unreadOf, (x) => x > 0);
    await page.goto(`${BASE}/chat/${enc}`);
    await page.waitForSelector('text=per chat normal check', { timeout: 15000 });
    check((await until(reads, (x) => x > n)) > n, 'per chat, not discreet: the read is sent');
    check(!(await page.isVisible('[data-testid=conv-discreet]')), 'no discreet mark');

    await settingsPage(page, 'reading');
    await page.waitForSelector(item, { timeout: 15000 });
    check((await stateIn()) === 'normal' && (await page.getAttribute(`${item} [data-testid=reading-chat-normal]`, 'aria-checked')) === 'true', 'Settings: shown as Normale');
    // The segmented control: Discrète from here.
    await page.click(`${item} [data-testid=reading-chat-discreet]`);
    await page.waitForFunction(async (id) => (await (await fetch('/api/reading')).json()).chats?.[id] === true, TEST_CHAT, { timeout: 10000 });
    await page.waitForSelector(`${item} [data-testid=reading-chat-state][data-value=discreet]`, { timeout: 10000 });
    step('Settings: Discrète chosen from the page');

    // "Reset all" asks first; Cancel keeps the list, the confirmation empties it.
    await page.click('[data-testid=reading-chats-reset]');
    await page.waitForSelector('[data-testid=reading-chats-reset-confirm]', { timeout: 5000 });
    await page.click('[data-testid=reading-chats-reset-cancel]');
    check(!!(await page.$(item)), 'reset: Cancel keeps the list');
    await page.click('[data-testid=reading-chats-reset]');
    await page.click('[data-testid=reading-chats-reset-confirm]');
    await page.waitForSelector('[data-testid=reading-chats-none]', { timeout: 10000 });
    check(!(await page.$(item)), '« Tout remettre au réglage du compte », confirmed, empties the list');

    // "Add a conversation": the picker, a search, the test chat (its account normal) becomes discreet.
    await page.click('[data-testid=reading-add]');
    await page.waitForSelector('[data-testid=reading-picker]', { timeout: 10000 });
    await page.fill('[data-testid=reading-picker-search]', 'Test');
    const pick = `[data-testid=reading-pick][data-chat-id="${TEST_CHAT}"]`;
    await page.waitForSelector(pick, { timeout: 15000 });
    await shot(page, 'discreet-picker');
    await page.click(pick);
    await page.waitForSelector('[data-testid=reading-picker]', { state: 'detached', timeout: 10000 });
    await page.waitForFunction(async (id) => (await (await fetch('/api/reading')).json()).chats?.[id] === true, TEST_CHAT, { timeout: 10000 });
    await page.waitForSelector(`${item} [data-testid=reading-chat-state][data-value=discreet]`, { timeout: 10000 });
    step('picker: the test chat added, discreet');
    check(/discrète/.test((await page.textContent('[data-testid=settings-note]')) ?? ''), 'picker: the outcome said');
    // Already in the list: offered no more. Escape closes the picker, not Settings.
    await page.click('[data-testid=reading-add]');
    await page.fill('[data-testid=reading-picker-search]', 'Test');
    await page.waitForSelector(`${pick}:disabled`, { timeout: 15000 });
    step('picker: a chat already in the list is disabled');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=reading-picker]', { state: 'detached', timeout: 5000 });
    check(await page.isVisible('[data-testid=settings-reading]'), 'picker: Escape closes it, Settings stays');

    // Past 8 conversations, a filter (made-up chat ids: "Discussion introuvable", nothing real touched).
    const fake = Array.from({ length: 8 }, (_, i) => `!discreet-filler-${i}:beeper.local`);
    const setFake = (discreet) => page.evaluate(([ids, body]) => Promise.all(ids.map((c) => fetch(`/api/reading/chat/${encodeURIComponent(c)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }))), [fake, JSON.stringify({ discreet })]);
    await setFake(true);
    await page.goto(`${BASE}/settings/reading`);
    await page.waitForSelector('[data-testid=reading-chats-filter]', { timeout: 15000 });
    check((await page.$$('[data-testid=reading-chat]')).length === 9, 'filter: shown past 8, every row listed');
    await page.waitForSelector(`${item} [data-testid=reading-chat-open]`, { timeout: 15000 });
    await page.fill('[data-testid=reading-chats-filter]', 'test');
    const left = await page.$$eval('[data-testid=reading-chat]', (r) => r.map((x) => x.dataset.chatId));
    check(left.length === 1 && left[0] === TEST_CHAT, `filter: by name (${left.join()})`);
    await setFake(null);

    // Its name opens the chat.
    await page.goto(`${BASE}/settings/reading`);
    await page.click(`${item} [data-testid=reading-chat-open]`, { timeout: 15000 });
    await page.waitForFunction((p) => location.pathname === p, `/chat/${enc}`, { timeout: 10000 });
    step('the name opens the chat');

    // The page on a phone (with a chat row): no horizontal scroll, the rows inside their cards.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/settings/reading`);
    await page.waitForSelector(item, { timeout: 15000 });
    const overflow = await page.$eval('.pane-chat .settings-body', (el) => el.scrollWidth - el.clientWidth);
    check(overflow <= 1, `phone: no horizontal scroll (${overflow})`);
    const fits = await page.$$eval('.reading-account, [data-testid=reading-chat]', (rs) => rs.every((el) => el.getBoundingClientRect().right <= el.closest('.set-group').getBoundingClientRect().right + 1));
    check(fits, 'phone: every row fits its card');
    const beside = await page.$eval(`[data-testid=reading-toggle-${account}]`, (b) => b.getBoundingClientRect().top < b.closest('.set-row').querySelector('.set-text').getBoundingClientRect().bottom);
    check(beside, "phone: the account's switch beside its name");
    const seg = await page.$eval(`${item} [data-testid=reading-chat-state]`, (el) => Math.round(el.getBoundingClientRect().height));
    check(seg >= 40, `phone: the segmented control is a finger's reach (${seg} px)`);
    await page.$eval(item, (el) => el.scrollIntoView({ block: 'center' }));
    await shot(page, 'discreet-phone');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    // Server-wide: back as it was for the next scripts.
    await page.evaluate(() => fetch('/api/reading/chats', { method: 'DELETE' })).catch(() => {});
    if (account) await page.evaluate((a) => fetch(`/api/reading/${encodeURIComponent(a)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"discreet":false}' }), account).catch(() => {});
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
