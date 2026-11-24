// iOS home-screen app (0.9.2, 0.20.2): an install that draws under the status bar (black-translucent, safe-area top > 0)
// takes the screen height; one with the opaque bar (0.20.1+) keeps the window's. Chromium has no safe-area inset, so
// this checks the opaque case: the root is the window's height, as in Safari. Login page only.
// sh web/test/e2e/run-offline.sh iosgap.e2e.js
const { chromium } = require('playwright');
const BASE = process.env.BASE;
let ok = true;
(async () => {
  const browser = await chromium.launch();
  for (const [name, standalone, expect] of [['standalone (opaque status bar)', true, 793], ['safari', false, 793]]) {
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 793 },
      screen: { width: 393, height: 852 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
      isMobile: true, hasTouch: true,
    });
    if (standalone) await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForTimeout(1500);
    const h = await page.evaluate(() => document.getElementById('root').getBoundingClientRect().height);
    const pass = Math.round(h) === expect;
    ok = ok && pass;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}: root height ${h} (expected ${expect})`);
    await ctx.close();
  }
  await browser.close();
  console.log(ok ? 'all checks passed' : 'SOME CHECKS FAILED');
  process.exit(ok ? 0 : 1);
})();
