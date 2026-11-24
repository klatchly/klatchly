// Design review shots (not part of the suite): every Settings page at four window sizes (1920×1080, 1280×800,
// 768×1024, an iPhone's 390×844), light and dark, the whole page height, into $SHOTS/design/. Also Général with the
// sign-in settings locked (a step-up asked: the state the server sends after the confirmation window, faked here in
// the page) and opened. Read-only: every context sends GETs only.
// sh web/test/e2e/run-offline.sh design.e2e.js
const { mkdirSync } = require('fs');
const { BASE, SHOTS, check, open, enroll, done } = require('./lib');

const OUT = `${SHOTS}/design`;
const SIZES = [
  { name: '1920', width: 1920, height: 1080 },
  { name: '1280', width: 1280, height: 800 },
  { name: '768', width: 768, height: 1024, touch: true },
  { name: '390', width: 390, height: 844, touch: true, phone: true },
];
const PAGES = [
  { name: 'general', path: '/settings/general', wait: '[data-testid=settings-signin] [data-testid=signin-state]' },
  { name: 'general-locked', path: '/settings/general', wait: '[data-testid=settings-signin] [data-testid=signin-state]', locked: true },
  { name: 'general-locked-open', path: '/settings/general', wait: '[data-testid=settings-signin] [data-testid=signin-state]', locked: true, click: '[data-testid=signin-change]' },
  { name: 'general-open', path: '/settings/general', wait: '[data-testid=settings-signin] [data-testid=signin-state]', click: '[data-testid=signin-change]' },
  { name: 'reading', path: '/settings/reading', wait: '[data-testid=reading-chats] [data-testid=reading-chats-none], [data-testid=reading-chats] [data-testid=reading-chat]' },
  { name: 'app', path: '/settings/app', wait: '[data-testid=app-version]' },
  { name: 'extensions', path: '/settings/extensions', wait: '[data-testid=extensions] article' },
  { name: 'providers', path: '/settings/ext/llm/providers', wait: '[data-testid=llm-providers]' },
  { name: 'providers-locked', path: '/settings/ext/llm/providers', wait: '[data-testid=llm-providers]', locked: true },
  { name: 'models', path: '/settings/ext/llm/models', wait: '[data-testid=llm-routes]' },
  { name: 'langs', path: '/settings/ext/writing/langs', wait: '[data-testid=langs-settings]' },
  { name: 'chat', path: '/', wait: '[data-testid=chat-row]', chat: true },
];

(async () => {
  mkdirSync(OUT, { recursive: true });
  const s = await open();
  await enroll(s.page);
  const storageState = await s.ctx.storageState();
  for (const size of SIZES) {
    const ctx = await s.browser.newContext({
      viewport: { width: size.width, height: size.height },
      screen: { width: size.width, height: size.height },
      deviceScaleFactor: size.phone ? 2 : 1,
      isMobile: !!size.phone,
      hasTouch: !!size.touch,
      locale: 'en-US',
      storageState,
    });
    await ctx.route('**/api/**', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
    await ctx.addInitScript(() => localStorage.setItem('lang', 'en'));
    for (const p of PAGES) {
      const page = await ctx.newPage();
      if (p.locked) {
        // The confirmation window over: what the server says then (a passkey to confirm with).
        const lock = (st) => ({ leftMs: 0, methods: ['passkey'] });
        await page.route('**/api/auth/settings', async (r) => {
          const res = await r.fetch();
          const body = await res.json();
          await r.fulfill({ response: res, json: { ...body, stepUp: lock(body.stepUp) } });
        });
        await page.route('**/api/auth/stepup', async (r) => (r.request().method() === 'GET' ? r.fulfill({ json: lock() }) : r.continue()));
      }
      await page.goto(BASE + p.path);
      let ok = true;
      await page.waitForSelector(p.wait, { timeout: 20000 }).catch(() => (ok = false));
      if (ok && p.click) await page.click(p.click, { timeout: 3000 }).catch(() => (ok = false));
      if (ok && p.chat && !size.phone) {
        await page.click('[data-testid=chat-row]');
        await page.waitForSelector('[data-testid=composer] textarea, .composer textarea', { timeout: 15000 }).catch(() => {});
      }
      await page.waitForTimeout(700);
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.waitForTimeout(150);
        // The whole page: the window as tall as the scrolled body (it scrolls inside the pane, not the document).
        const extra = await page.evaluate(() => {
          const b = document.querySelector('.pane-chat .settings-body');
          return b ? Math.max(0, b.scrollHeight - b.clientHeight) : 0;
        });
        if (extra) await page.setViewportSize({ width: size.width, height: Math.min(size.height + extra, 5000) });
        await page.waitForTimeout(150);
        const hscroll = await page.evaluate(() => {
          const b = document.querySelector('.pane-chat .settings-body');
          return b ? b.scrollWidth > b.clientWidth + 1 : document.documentElement.scrollWidth > innerWidth + 1;
        });
        if (p.name !== 'chat') check(!hscroll, `${size.name} ${p.name} ${scheme}: no horizontal scroll`);
        await page.screenshot({ path: `${OUT}/${p.name}-${size.name}-${scheme}.png` });
        if (extra) await page.setViewportSize({ width: size.width, height: size.height });
      }
      if (!ok) console.log(`     (${size.name} ${p.name}: not all there)`);
      await page.close();
    }
    await ctx.close();
  }
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
