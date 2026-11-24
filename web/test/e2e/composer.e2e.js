// Composer layout (0.14.10), WhatsApp style on phones: [📎][field ✨][🎤] when empty, [›][field ✨][quick][➤]
// while typing, the chevron brings 📎 and 📷 back. Desktop keeps every button. TEST chat only, nothing is sent:
// the phone contexts let only GET requests through (POST /api/assist mocked), the field is cleared at the end.
// sh web/test/e2e/run-offline.sh composer.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const chatURL = `${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`;
const DRAFT = 'je pense que on pourrais se voir demain';

async function phone(s, width, colorScheme) {
  const ctx = await s.browser.newContext({
    viewport: { width, height: 760 },
    screen: { width, height: 760 },
    userAgent: UA,
    isMobile: true,
    hasTouch: true,
    locale: 'fr-FR',
    colorScheme,
    storageState: await s.ctx.storageState(),
  });
  const blocked = [];
  const assist = [];
  await ctx.route('**/api/**', (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET') return r.continue();
    if (req.method() === 'POST' && path === '/api/assist') {
      assist.push(JSON.parse(req.postData() || '{}'));
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'Je pense qu’on pourrait se voir demain' }) });
    }
    blocked.push(`${req.method()} ${path.slice(0, 40)}`);
    return r.abort();
  });
  await ctx.addInitScript(() => localStorage.setItem('lang', 'fr'));
  const page = await ctx.newPage();
  return { ctx, page, blocked, assist };
}

const box = (page, id) => page.locator(`.composer [data-testid=${id}]`).boundingBox();
const visible = (page, id) => page.locator(`.composer [data-testid=${id}]`).isVisible();
/** The row's visible controls, left to right. */
const rowOrder = (page) =>
  page.$$eval('.composer-row [data-testid]', (els) =>
    els.filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && e.tagName !== 'INPUT').sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((e) => e.dataset.testid),
  );
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.composer').scrollWidth <= document.querySelector('.composer').clientWidth);

async function phoneRun(s, width, scheme) {
  const tag = `${width}-${scheme}`;
  const p = await phone(s, width, scheme);
  const { page } = p;
  try {
    await page.goto(chatURL);
    const input = page.locator('[data-testid=composer-input]');
    await input.waitFor();
    await page.waitForSelector('.composer [data-testid=assist-btn]');
    await input.fill('');
    await input.focus();
    await page.waitForTimeout(300);

    // Empty: [📎][field ✨][🎤].
    const empty = (await rowOrder(page)).join(' ');
    check(empty === 'attach composer-input assist-btn mic', `${tag} empty row: ${empty}`);
    check(!(await visible(page, 'camera')) && !(await visible(page, 'assist-quick-btn')) && !(await visible(page, 'composer-tools')), `${tag} empty: no 📷, no quick, no chevron`);
    const f0 = await box(page, 'composer-input');
    const a0 = await box(page, 'assist-btn');
    check(a0.x >= f0.x && a0.x + a0.width <= f0.x + f0.width + 0.5 && a0.y + a0.height <= f0.y + f0.height + 0.5, `${tag} ✨ sits inside the field`);
    console.log(`     ${tag} empty: field ${Math.round(f0.width)} px = ${Math.round((f0.width / width) * 100)} %`);
    check(f0.width / width >= (width < 360 ? 0.62 : 0.66), `${tag} empty field takes most of the width`);
    const att = await box(page, 'attach');
    check(att.width >= 44 && att.height >= 44, `${tag} 📎 is a 44 px target`);
    check(await noHScroll(page), `${tag} no horizontal scroll (empty)`);
    await shot(page, `composer-${tag}-empty`);

    // Typing: [›][field ✨][quick][➤].
    await input.pressSequentially('je pense', { delay: 10 });
    await input.fill(DRAFT);
    const typing = (await rowOrder(page)).join(' ');
    check(typing === 'composer-tools composer-input assist-btn assist-quick-btn send', `${tag} typing row: ${typing}`);
    const f1 = await box(page, 'composer-input');
    console.log(`     ${tag} typing: field ${Math.round(f1.width)} px = ${Math.round((f1.width / width) * 100)} %`);
    check(f1.width / width >= (width < 360 ? 0.5 : 0.58), `${tag} typing field keeps more than half the width`);
    const chev = page.locator('.composer [data-testid=composer-tools]');
    const hit = await chev.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const a = getComputedStyle(el, '::after');
      return { w: r.width - parseFloat(a.left) - parseFloat(a.right), h: r.height - parseFloat(a.top) - parseFloat(a.bottom) };
    });
    check(hit.w >= 44 && hit.h >= 44, `${tag} chevron hit area ${Math.round(hit.w)}×${Math.round(hit.h)} ≥ 44`);
    check((await chev.getAttribute('aria-expanded')) === 'false', `${tag} chevron aria-expanded=false`);
    const send = await box(page, 'send');
    check(Math.abs(send.x + send.width - (width - 10)) <= 2, `${tag} send at the mic's place (right end)`);
    check(await noHScroll(page), `${tag} no horizontal scroll (typing)`);
    await shot(page, `composer-${tag}-typing`);

    // Chevron: 📎 and 📷 back in place of quick, focus stays in the field.
    await chev.tap();
    await page.waitForTimeout(150);
    const tools = (await rowOrder(page)).join(' ');
    check(tools === 'attach camera composer-input assist-btn send', `${tag} chevron expanded: ${tools}`);
    check(await page.evaluate(() => document.activeElement?.dataset.testid === 'composer-input'), `${tag} focus stays in the field`);
    check(await noHScroll(page), `${tag} no horizontal scroll (expanded)`);
    check(await input.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), `${tag} narrower field grows to fit its text (nothing clipped)`);
    await shot(page, `composer-${tag}-tools`);
    await input.press('Space');
    await page.waitForTimeout(100);
    check((await rowOrder(page)).join(' ') === 'composer-tools composer-input assist-btn assist-quick-btn send', `${tag} typing folds them again`);

    // Multi-line: buttons stay at the bottom, the field stops growing (~6 lines) then scrolls.
    await input.fill(Array.from({ length: 12 }, (_, i) => `ligne ${i + 1}`).join('\n'));
    await page.waitForTimeout(100);
    const f2 = await box(page, 'composer-input');
    const s2 = await box(page, 'send');
    const a2 = await box(page, 'assist-btn');
    check(f2.height <= 150 && f2.height >= 120, `${tag} field capped at ~6 lines (${Math.round(f2.height)} px)`);
    check(Math.abs(s2.y + s2.height - (f2.y + f2.height)) <= 4 && Math.abs(a2.y + a2.height - (f2.y + f2.height)) <= 3, `${tag} buttons aligned to the field's bottom`);
    check(await input.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'), `${tag} long text scrolls`);
    await shot(page, `composer-${tag}-multiline`);

    // ✨ menu from inside the field, then the quick button (mocked).
    await input.fill(DRAFT);
    await page.locator('.composer [data-testid=assist-btn]').tap();
    await page.waitForSelector('[data-testid=assist-menu]');
    const m = await page.locator('[data-testid=assist-menu]').boundingBox();
    check(m.x >= 0 && m.x + m.width <= width, `${tag} ✨ menu fits on screen`);
    check(await page.evaluate(() => document.activeElement?.dataset.testid === 'composer-input'), `${tag} ✨ keeps the focus in the field`);
    await shot(page, `composer-${tag}-menu`);
    await input.press('Escape');
    check(!(await page.isVisible('[data-testid=assist-menu]')), `${tag} Escape closes the ✨ menu`);
    if (width === 390) {
      await page.locator('.composer [data-testid=assist-quick-btn]').tap();
      await page.waitForSelector('[data-testid=assist-bar]');
      check(p.assist.length === 1 && p.assist[0].chatID === TEST_CHAT, `${tag} quick button runs (mocked, TEST chat)`);
      await page.click('[data-testid=assist-undo]');
    }
    await input.fill('');
    check((await rowOrder(page)).join(' ') === 'attach composer-input assist-btn mic', `${tag} cleared: back to the empty row`);
    check(!p.blocked.some((x) => /messages|send/.test(x)), `${tag} nothing sent (blocked writes: ${p.blocked.join(', ') || 'none'})`);
  } finally {
    await page.locator('[data-testid=composer-input]').fill('').catch(() => {});
    await p.ctx.close();
  }
}

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  try {
    await enroll(page);
    for (const scheme of ['light', 'dark']) {
      await phoneRun(s, 390, scheme);
      await phoneRun(s, 320, scheme);
    }

    // Desktop: every button stays, ✨ inside the field, the quick button greyed out while empty.
    await page.route('**/api/assist', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'application/json', body: '{"text":"x"}' }) : r.continue()));
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(chatURL);
      const input = page.locator('[data-testid=composer-input]');
      await input.waitFor();
      await page.waitForSelector('.composer [data-testid=assist-btn]');
      await input.fill('');
      const empty = (await rowOrder(page)).join(' ');
      check(empty === 'attach composer-input assist-btn assist-quick-btn mic', `desktop-${scheme} empty row: ${empty}`);
      check(await page.isDisabled('[data-testid=assist-quick-btn]'), `desktop-${scheme} quick greyed out while empty`);
      await shot(page, `composer-desktop-${scheme}-empty`);
      await input.fill(DRAFT);
      const typing = (await rowOrder(page)).join(' ');
      check(typing === 'attach composer-input assist-btn assist-quick-btn send', `desktop-${scheme} typing row: ${typing}`);
      await shot(page, `composer-desktop-${scheme}-typing`);
      await input.fill('');
    }
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    await page.locator('[data-testid=composer-input]').fill('').catch(() => {});
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
