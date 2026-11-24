// Feature: interface language (en/fr). Read-only on real chats: opens the test chat, sends nothing.
// sh web/test/e2e/run-offline.sh i18n.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

(async () => {
  // French browser -> French UI by default.
  const fr = await open({ locale: 'fr-FR' });
  const { page } = fr;
  await enroll(page);
  check((await page.getAttribute('html', 'lang')) === 'fr', 'fr-FR browser: <html lang=fr>');
  check((await page.getAttribute('[data-testid=open-settings]', 'aria-label')) === 'Réglages', 'fr: settings aria-label');
  check((await page.getAttribute('[data-testid=search]', 'placeholder')) === 'Rechercher', 'fr: search placeholder');
  check((await page.title()).length <= 6 && !/klatchly|beeper/i.test(await page.title()), 'neutral title');
  await shot(page, 'i18n-fr-list');

  await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
  await page.waitForSelector('[data-testid=composer-input]');
  check((await page.getAttribute('[data-testid=composer-input]', 'placeholder')) === 'Message', 'fr: composer placeholder');
  check((await page.getAttribute('[data-testid=mic]', 'aria-label')) === 'Enregistrer un message vocal', 'fr: mic aria-label');
  await page.fill('[data-testid=composer-input]', 'x');
  check((await page.getAttribute('[data-testid=send]', 'aria-label')) === 'Envoyer', 'fr: send aria-label');
  await page.waitForTimeout(800);
  await shot(page, 'i18n-fr-conversation');

  // Switch to English in Settings: immediate, persisted, <html lang> follows.
  await page.click('[data-testid=open-settings]');
  await page.waitForSelector('[data-testid=settings-language]');
  check((await page.textContent('.pane-chat .settings-title')) === 'Général', 'fr: settings heading (the Général page, with Langue)');
  await shot(page, 'i18n-fr-settings');
  await page.click('[data-testid=lang-en]');
  check((await page.textContent('.pane-chat .settings-title')) === 'General' && (await page.textContent('[data-testid=settings-item-general] .settings-item-label')) === 'General', 'switch: settings re-rendered in English');
  check((await page.getAttribute('html', 'lang')) === 'en', 'switch: <html lang=en>');
  await shot(page, 'i18n-en-settings');
  await page.click('[data-testid=settings-close]');
  check((await page.getAttribute('[data-testid=send]', 'aria-label')) === 'Send', 'switch: composer re-rendered');
  await page.fill('[data-testid=composer-input]', '');
  await shot(page, 'i18n-en-conversation');
  await page.reload();
  await page.waitForSelector('[data-testid=composer-input]');
  check((await page.getAttribute('[data-testid=open-settings]', 'aria-label')) === 'Settings', 'choice persisted after reload');
  const day = await page.$$eval('.day-sep span', (els) => els.map((e) => e.textContent));
  check(day.every((d) => !/aujourd|hier/.test(d ?? '')), `day separators in English (${day.slice(-2).join(' | ')})`);
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=chat-row]');
  await shot(page, 'i18n-en-list');

  // Gate pages: icon + key only, labels follow the language.
  await logout(page);
  check((await page.getAttribute('[data-testid=unlock]', 'aria-label')) === 'Unlock', 'en: unlock aria-label');
  check((await page.locator('main.gate').innerText()).trim() === '', 'gate shows no text');
  await shot(page, 'i18n-en-gate');
  check(fr.csp.length === 0, `no CSP violations (${fr.csp.length})`);
  await fr.browser.close();

  // English browser with nothing stored -> English; a German browser falls back to English.
  const de = await open({ locale: 'de-DE' });
  // Nothing stored: the session file (lib.js SESSION_FILE) may carry the language another script chose.
  await de.ctx.addInitScript(() => localStorage.removeItem('lang'));
  await de.page.goto(BASE + '/');
  await de.page.waitForSelector('[data-testid=unlock]');
  check((await de.page.getAttribute('html', 'lang')) === 'en', 'de-DE browser falls back to en');
  const fr2 = await de.browser.newContext({ locale: 'fr-CA' });
  const p2 = await fr2.newPage();
  await p2.goto(BASE + '/');
  await p2.waitForSelector('[data-testid=unlock]');
  check((await p2.getAttribute('[data-testid=unlock]', 'aria-label')) === 'Déverrouiller', 'fr-CA browser -> fr gate label');
  await shot(p2, 'i18n-fr-gate');
  await de.browser.close();
  done(fr.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
