// Sign-out empties the browser's HTTP cache (Clear-Site-Data, 0.4.2), the worker's thumbnail cache (0.14.19) and its
// cache of the app's private chunks (0.24.0), and keeps the public shell (precache). Playwright routing turns the HTTP cache off, so this script runs without the lib.js guard: it
// never opens a chat and only reads (the list's avatars, thumbnails since 0.14.19).
// sh web/test/e2e/run-offline.sh clearcache.e2e.js
const { chromium } = require('playwright');
const { BASE, check, settingsPage, done } = require('./lib');

(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chromium' });
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const writes = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && /\/api\/(chats|notify)\//.test(r.url())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await page.goto(`${BASE}/enroll`);
  await page.fill('[data-testid=enroll-code]', process.env.CODE);
  await page.click('[data-testid=enroll-submit]');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
  // The service worker registers on load: wait for it so the check below means something.
  await page.reload();
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
  await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 15000))]));
  await page.waitForSelector('[data-testid=chat-row] img', { timeout: 15000 });
  await page.waitForTimeout(1000);

  const cachedOnly = (u) =>
    page.evaluate(async (u) => {
      try {
        return (await fetch(u, { cache: 'only-if-cached', mode: 'same-origin' })).status;
      } catch {
        return 0;
      }
    }, u);
  const srcs = await page.$$eval('[data-testid=chat-row] img', (els) =>
    els.map((e) => (e.complete && e.naturalWidth > 0 ? e.getAttribute('src') : null)).filter((u) => /^\/api\/[a-z]+(\/[a-z]+)?[/?]/.test(u || '')),
  );
  const cached = [];
  for (const u of srcs.slice(0, 10)) if ((await cachedOnly(u)) === 200) cached.push(u);
  console.log(`     avatars loaded: ${srcs.length}, in the HTTP cache: ${cached.length}`);
  check(cached.length > 0, 'avatars are cached before sign-out');

  const swState = () =>
    page.evaluate(async () => ({ reg: !!(await navigator.serviceWorker.getRegistration('/')), caches: (await caches.keys()).sort() }));
  const swBefore = await swState();
  console.log(`     before sign-out: ${JSON.stringify(swBefore)}`);

  const res = page.waitForResponse((r) => r.url().endsWith('/api/auth/logout'));
  await settingsPage(page, 'account');
  await page.click('[data-testid=logout]');
  await page.click('[data-testid=logout-confirm]');
  await page.waitForSelector('[data-testid=unlock]', { timeout: 10000 });
  check((await (await res).headerValue('clear-site-data')) === '"cache"', 'logout answers Clear-Site-Data: "cache"');
  const left = [];
  for (const u of cached) if ((await cachedOnly(u)) === 200) left.push(u);
  check(left.length === 0, `avatar caches emptied by sign-out (${left.length}/${cached.length} left)`);
  const swAfter = await swState();
  console.log(`     after sign-out: ${JSON.stringify(swAfter)}`);
  check(swBefore.caches.some((k) => k.startsWith('app-private-')), 'signed in: the private chunks are in their cache');
  const shell = swBefore.caches.filter((k) => k !== 'thumbs' && !k.startsWith('app-private-'));
  check(swBefore.reg && shell.length > 0 && swAfter.reg && swAfter.caches.join() === shell.join(), 'service worker and public shell cache untouched, thumbnails and private chunks dropped');

  check(writes.length === 0, `no write to any chat (${writes.join(', ') || 'none'})`);
  await browser.close();
  done([]);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
