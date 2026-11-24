// Translating a picture (0.18.9): right-click a photo of the test chat → « Traduire l'image en … »: the server
// reads the picture itself and sends it to the image use's model (offline: llm.mjs answers with the picture's type
// and size, its caption first); the translation shows under that photo, and is hidden at the end. A GIF-like
// "no text" answer is checked through the API. Only the test chat. sh web/test/e2e/run-offline.sh ../../ext/writing/test/imagetranslate.e2e.cjs
const { BASE, TEST_CHAT, check, step, open, enroll, logout, shot, done } = require('../../../test/e2e/lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page, blocked } = s;
  await enroll(page);
  const langs = await page.evaluate(async () => (await fetch('/api/assist/langs')).json());
  const lang = langs.readLangs[0];
  const native = { fr: 'Français', en: 'English', vi: 'Tiếng Việt' }[lang] ?? lang;
  const mids = [];
  page.on('request', (r) => r.url().endsWith('/api/translate/image') && mids.push(JSON.parse(r.postData()).messageID));
  try {
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    const album = page.locator('[data-testid=msg][data-album="3"]');
    await album.waitFor({ timeout: 20000 });
    await album.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    const tile = album.locator('[data-att]').first();
    await tile.click({ button: 'right' });
    await page.waitForSelector('[data-testid=message-menu]');
    const items = await page.$$eval('[data-testid=message-menu] [data-testid^=menu-]', (els) => els.map((e) => e.getAttribute('data-testid')));
    console.log(`     menu: ${items.join(', ')}`);
    check(langs.readLangs.every((l) => items.includes(`menu-translate-image-${l}`)), `a photo's menu offers « Traduire l'image » (${langs.readLangs.join(', ')})`);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/translate/image') && r.request().method() === 'POST', { timeout: 20000 }),
      page.click(`[data-testid=menu-translate-image-${lang}]`),
    ]);
    const sent = JSON.parse(res.request().postData());
    check(res.status() === 200 && Object.keys(sent).sort().join() === 'chatID,index,messageID,target', `the browser names the picture, never sends it (${res.status()}, ${Object.keys(sent).join(',')})`);
    const tr = album.locator('[data-testid=msg-translation-text]');
    await tr.waitFor({ timeout: 10000 });
    const text = await tr.textContent();
    check(new RegExp(`^${native}: Holiday photos · picture text \\(image/png, \\d+ bytes\\)$`).test(text), `the picture's translation shows under the photo, its caption first ("${text}")`);
    await shot(page, 'imagetranslate');
    // Kept: back after a reload.
    await page.reload();
    await album.waitFor({ timeout: 20000 });
    await album.scrollIntoViewIfNeeded();
    await tr.waitFor({ timeout: 10000 });
    step('kept after a reload');
    // A second photo of the album (no caption): its own translation, under the album too.
    await album.locator('[data-att]').nth(1).click({ button: 'right' });
    await page.click(`[data-testid=menu-translate-image-${lang}]`);
    // Polled with page.evaluate (waitForFunction evaluates a string: refused by the app's CSP).
    for (let i = 0; i < 40 && (await album.locator('[data-testid=msg-translation-text]').count()) < 2; i++) await page.waitForTimeout(250);
    const both = await album.locator('[data-testid=msg-translation-text]').allTextContents();
    check(both.length === 2 && /^[^·]*picture text \(image\/jpeg/.test(both[1]), `a photo without caption gets its own (${JSON.stringify(both)})`);
    while (await album.locator('[data-testid=translation-close]').count()) {
      await album.locator('[data-testid=translation-close]').first().click();
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(400);
    check(!(await album.locator('[data-testid=msg-translation]').count()), 'hidden with ✕');
  } finally {
    for (const m of new Set(mids))
      await page.evaluate(([c, id]) => fetch('/api/translations/hide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatID: c, messageID: id }) }), [TEST_CHAT, m]).catch(() => {});
  }
  // A file that is not a picture (the test chat's notes.txt / report.pdf): no picture to read.
  const bad = await page.evaluate(async (c) => {
    const items = (await (await fetch(`/api/chats/${encodeURIComponent(c)}/messages`)).json()).items;
    const pdf = items.find((m) => m.attachments?.[0]?.mimeType === 'application/pdf');
    const r = await fetch('/api/translate/image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatID: c, messageID: pdf.id, index: 0, target: 'fr' }) });
    return r.status;
  }, TEST_CHAT);
  check(bad === 422, `a PDF is not read as a picture (${bad})`);
  check(!blocked.length, `no write to another chat (${blocked.join(', ') || 'none'})`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
