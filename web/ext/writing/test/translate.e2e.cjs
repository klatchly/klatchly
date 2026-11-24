// Right-click message menu + translation (0.5.1). Only messages of the test chat are translated (sent to the
// model); real chats are only right-clicked to look at the menu. Nothing is sent to any chat.
// sh web/test/e2e/run-offline.sh ../../ext/writing/test/translate.e2e.cjs
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('../../../test/e2e/lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  await enroll(page);

  const api = await page.evaluate(async () => {
    const post = async (body) => (await fetch('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
    return {
      status: await (await fetch('/api/translate')).json(),
      langs: await (await fetch('/api/assist/langs')).json(),
      badTarget: await post({ chatID: 'x', messageID: 'y', target: 'xx' }),
      extraKey: await post({ chatID: 'x', messageID: 'y', target: 'fr', text: 'free text' }),
      missing: await post({ chatID: 'other:u:1', messageID: '1', target: 'fr' }),
    };
  });
  console.log(`     api: ${JSON.stringify(api)}`);
  check(api.status.enabled === true, 'translation enabled');
  check(api.badTarget === 400 && api.extraKey === 400, 'unknown language or free text refused (400)');
  check([404, 422].includes(api.missing), 'unknown chat or message: nothing translated (404 / 422)');

  await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
  await page.waitForSelector('[data-testid=msg-text]');
  await page.waitForTimeout(1500);
  const bubble = page.locator('[data-testid=msg]:has([data-testid=msg-text]) [data-testid=bubble]').last();

  // Shift+right-click keeps the browser menu (ours does not open).
  await page.keyboard.down('Shift');
  await bubble.click({ button: 'right', position: { x: 12, y: 12 } });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  check(!(await page.$('[data-testid=message-menu]')), 'Shift+right-click: no app menu');

  await page.evaluate(() => document.addEventListener('contextmenu', (e) => (window.__ctx = { x: e.clientX, y: e.clientY }), { capture: true, once: true }));
  await bubble.click({ button: 'right', position: { x: 12, y: 12 } });
  await page.waitForSelector('[data-testid=message-menu]');
  await page.waitForTimeout(100);
  const pointer = await page.evaluate(() => window.__ctx);
  const menu = await page.$eval('[data-testid=message-menu]', (el) => ({
    items: [...el.querySelectorAll('[data-testid^=menu-]')].map((b) => b.getAttribute('data-testid')),
    rect: el.getBoundingClientRect().toJSON(),
  }));
  console.log(`     menu: ${menu.items.join(', ')}`);
  // One entry per language for received messages (Settings → Langues de traduction, 0.15.9).
  const read = api.langs.readLangs;
  check(['menu-copy', ...read.map((l) => `menu-translate-${l}`)].every((i) => menu.items.includes(i)), `right-click opens the message menu with copy and translate (${read.join(', ')})`);
  const { x: px, y: py } = pointer;
  const r = menu.rect;
  const atCorner = (Math.abs(r.left - px) < 4 || Math.abs(r.right - px) < 4) && (Math.abs(r.top - py) < 6 || Math.abs(r.bottom - py) < 6);
  // A menu taller than the room above and below the pointer is kept in the viewport instead.
  const vh = await page.evaluate(() => innerHeight);
  const fits = r.height <= py - 8 || r.height <= vh - py - 8;
  check(atCorner || (!fits && r.top >= 0 && r.bottom <= vh), `menu corner at the pointer (${JSON.stringify({ px, py, left: r.left, top: r.top, bottom: r.bottom })})`);
  await shot(page, 'translate-menu');

  const t0 = Date.now();
  await page.click(`[data-testid=menu-translate-${read.at(-1)}]`);
  await page.waitForSelector('[data-testid=msg-translation]');
  await page.waitForSelector('[data-testid=msg-translation-text]', { timeout: 30000 }).catch(() => {});
  const out = await page.$eval('[data-testid=msg-translation]', (el) => el.textContent);
  const ms = Date.now() - t0;
  console.log(`     translated in ${ms} ms: ${out.slice(0, 120)}`);
  check(!!(await page.$('[data-testid=msg-translation-text]')), 'translation shown under the message');
  // The language it was asked for, named in the UI language (the text itself is the model's).
  check(out.includes(new Intl.DisplayNames(['fr'], { type: 'language' }).of(read.at(-1))), `its language named (${read.at(-1)})`);
  await shot(page, 'translate-result');
  // Kept on the server: still there after a reload.
  await page.reload();
  await page.waitForSelector('[data-testid=msg-text]');
  const kept = await page.waitForSelector('[data-testid=msg-translation-text]', { timeout: 8000 }).then(() => true, () => false);
  check(kept, 'translation still shown after a reload');
  const hidden = page.waitForResponse((r) => r.url().includes('/api/translations/hide'));
  await page.click('[data-testid=translation-close]');
  check(!(await page.$('[data-testid=msg-translation]')), 'translation can be hidden');
  await hidden;
  // After the reload, once the chat's kept translations have come (not a fixed wait).
  const listed = page.waitForResponse((r) => r.url().includes('/api/translations?'));
  await page.reload();
  await page.waitForSelector('[data-testid=msg-text]');
  await listed;
  await page.waitForTimeout(300);
  check(!(await page.$('[data-testid=msg-translation]')), 'a hidden translation stays hidden after a reload');

  // A real chat: menu only, nothing translated.
  const real = await page.evaluate(async (test) => (await (await fetch('/api/chats?limit=20')).json()).items.find((c) => c.id !== test && c.preview?.text)?.id, TEST_CHAT);
  await page.goto(`${BASE}/chat/${encodeURIComponent(real)}`);
  await page.waitForSelector('[data-testid=msg-text]');
  await page.waitForTimeout(1000);
  await page.locator('[data-testid=msg]:has([data-testid=msg-text]) [data-testid=bubble]').last().click({ button: 'right', position: { x: 12, y: 12 } });
  await page.waitForSelector('[data-testid=message-menu]');
  const realItems = await page.$$eval('[data-testid=message-menu] [data-testid^=menu-]', (els) => els.map((e) => e.getAttribute('data-testid')));
  check(realItems.includes(`menu-translate-${read[0]}`), `real chat: translate offered (${realItems.join(', ')})`);
  await page.keyboard.press('Escape');

  console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
