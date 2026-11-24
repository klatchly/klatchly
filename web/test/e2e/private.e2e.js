// Code served signed out (0.24.0, docs/auth-security.md): a signed-out visitor gets the boot entry and the sign-in
// screens only; the app's own code (shell, registry, every package's UI) goes to a session, and the service worker keeps
// it in a cache of its own, so the PWA still opens at once and offline. Checks, on an instance of its own enrolment:
// - anonymous (no browser): index.html, the boot's scripts and the sign-in chunk 200; the private entry and
//   GET /api/assets 302 to /; the worker precaches no private file; /sw-app.js public;
// - signed out in a browser, /share?text=…: the sign-in screen, and no private file asked for;
// - signed in: a private chunk 200 with Cache-Control private; the worker's private cache filled with every file of
//   GET /api/assets (the warm-up); offline, a reload opens the app (the stored copy);
// - offline right after an update (the private cache gone): "connect once" instead of a blank screen, and the app
//   back as soon as the network is;
// - sign-out: the private cache and the hint dropped, the public shell kept; a signed-out reload asks for no private
//   file. Never writes to a chat (no route guard: like clearcache.e2e.js, the worker must see the real requests).
// sh web/test/e2e/run-offline.sh private.e2e.js
const { chromium, request } = require('playwright');
const { BASE, check, settingsPage, shot, done } = require('./lib');

/**
 * Offline for the page and for the service worker: context.setOffline leaves the worker's own requests on the network
 * (Playwright 1.48 with this Chromium), so the worker's target fails every request it sends while offline (CDP Fetch
 * domain through the browser session).
 */
let swCdp;
async function offline(browser, ctx, on) {
  await ctx.setOffline(on);
  if (!swCdp) {
    const cdp = await browser.newBrowserCDPSession();
    const sessions = [];
    let id = 0;
    const send = (sessionId, method, params = {}) => cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: ++id, method, params }) });
    cdp.on('Target.receivedMessageFromTarget', (e) => {
      const m = JSON.parse(e.message);
      if (m.method === 'Fetch.requestPaused') {
        if (swCdp.on) void send(e.sessionId, 'Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'InternetDisconnected' });
        else void send(e.sessionId, 'Fetch.continueRequest', { requestId: m.params.requestId });
      }
    });
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos.filter((x) => x.type === 'service_worker')) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: false });
      sessions.push(sessionId);
      await send(sessionId, 'Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    }
    swCdp = { cdp, sessions, on };
  }
  swCdp.on = on;
}

const assetsOf = (text, re = /\/?assets\/[\w.-]+\.(?:js|css|mjs)/g) => [...new Set([...text.matchAll(re)].map((m) => '/' + m[0].replace(/^\//, '')))];

(async () => {
  // ── Anonymous, no browser ──
  const ctxAnon = await request.newContext({ baseURL: BASE });
  // Redirects not followed (per request: Playwright 1.48).
  const anon = { get: (p) => ctxAnon.get(p, { maxRedirects: 0 }), head: (p) => ctxAnon.head(p, { maxRedirects: 0 }) };
  const home = await anon.get('/');
  const html = await home.text();
  check(home.status() === 200, 'GET / signed out: 200');
  const entry = /<script type="module"[^>]*src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const shellFiles = assetsOf(html);
  check(!!entry && shellFiles.length >= 2, `index.html names the boot entry and its files (${shellFiles.join(', ')})`);
  for (const f of shellFiles) {
    const r = await anon.get(f);
    check(r.status() === 200 && r.headers()['cache-control'] === 'public, max-age=31536000, immutable', `${f}: 200, public`);
  }
  const bootRefs = assetsOf(await (await anon.get(entry)).text());
  const auth = bootRefs.find((f) => /\/Auth-[\w-]+\.js$/.test(f));
  const appmain = bootRefs.find((f) => /\/appmain-[\w-]+\.js$/.test(f));
  check(!!auth && (await anon.get(auth)).status() === 200, `the sign-in screens' chunk is public (${auth})`);
  const priv = await anon.get(appmain);
  check(priv.status() === 302 && priv.headers().location === '/', `the private entry signed out: 302 to / (${appmain}: ${priv.status()})`);
  const privHead = await anon.head(appmain);
  check(privHead.status() === 302, 'HEAD too');
  const appFiles = bootRefs.filter((f) => f !== auth && !shellFiles.includes(f));
  let leaked = 0;
  for (const f of appFiles) if ((await anon.get(f)).status() !== 302) leaked++;
  check(appFiles.length > 2 && leaked === 0, `none of the private entry's ${appFiles.length} files is served signed out`);
  const list = await anon.get('/api/assets');
  check(list.status() === 302, 'GET /api/assets signed out: 302');
  const sw = await (await anon.get('/sw.js')).text();
  const precached = assetsOf(sw, /assets\/[\w.-]+\.(?:js|css|mjs)/g);
  check(precached.includes(auth) && precached.every((f) => shellFiles.includes(f) || f === auth), `the worker precaches the public files only (${precached.length})`);
  check(/importScripts\([^)]*"\/sw-app\.js"/.test(sw), 'the worker imports /sw-app.js');
  const swApp = await anon.get('/sw-app.js');
  const version = /const VERSION = '(\d+\.\d+\.\d+)'/.exec(await swApp.text())?.[1];
  check(swApp.status() === 200 && !!version, `/sw-app.js public, version ${version}`);
  await ctxAnon.dispose();

  // ── A browser, signed out, on the share page ──
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chromium' });
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const csp = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && csp.push(m.text()));
  const writes = [];
  let asked = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/assets/')) asked.push(u.pathname);
    if (r.method() !== 'GET' && /\/api\/(chats|notify)\//.test(u.pathname)) writes.push(`${r.method()} ${u.pathname}`);
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  const isPrivate = (f) => !shellFiles.includes(f) && f !== auth;
  try {
    await page.goto(`${BASE}/share?text=hello`);
    await page.waitForSelector('[data-testid=unlock]', { timeout: 30000 });
    await page.waitForTimeout(500);
    check(!asked.some(isPrivate), `signed out on /share: the sign-in screen, no private file asked for (${asked.join(', ')})`);
    await shot(page, 'private-signed-out-share');

    // ── Enrolment, then the app ──
    asked = [];
    await page.goto(`${BASE}/enroll`);
    await page.fill('[data-testid=enroll-code]', process.env.CODE);
    await page.click('[data-testid=enroll-submit]');
    await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
    check(asked.includes(appmain), 'signed in: the private entry loads');
    check((await page.evaluate(() => location.pathname)) === '/', 'enrolment ends at home');
    const signed = await page.evaluate(async (u) => {
      const r = await fetch(u, { cache: 'no-store' });
      return { status: r.status, cc: r.headers.get('cache-control') };
    }, appmain);
    check(signed.status === 200 && signed.cc === 'private, max-age=31536000, immutable', `a private chunk signed in: 200, ${signed.cc}`);

    // ── The worker: installed, controlling, its private cache warmed ──
    await page.reload();
    await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
    await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 15000))]));
    const files = (await page.evaluate(async () => (await fetch('/api/assets')).json())).files;
    check(files.length > 10 && files.includes(appmain) && !files.some((f) => /pdfjs-|pdf\.worker/.test(f)), `GET /api/assets signed in: ${files.length} private files, pdf.js left out`);
    let cached = [];
    for (let i = 0; i < 40; i++) {
      cached = await page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname), `app-private-${version}`);
      if (files.every((f) => cached.includes(f))) break;
      await page.waitForTimeout(500);
    }
    check(files.every((f) => cached.includes(f)), `the private cache holds every private file (${cached.length}/${files.length})`);
    const precache = await page.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys()) if (/precache/.test(k)) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
      return out;
    });
    check(precache.length > 0 && !precache.some((p) => files.includes(p)), `the precache holds no private file (${precache.length} entries)`);
    check((await page.evaluate(() => localStorage.getItem('klatchly.signedin'))) === '1', 'the "was signed in" hint is set');

    // ── Offline: the app opens from the caches, with the stored copy ──
    await page.waitForTimeout(4000); // the stored copy is written within 3 s of a change (persist.ts)
    await offline(browser, ctx, true);
    await page.reload().catch(() => {});
    const offlineOpen = await page.waitForSelector('[data-testid=chat-row]', { timeout: 15000 }).then(() => true, () => false);
    check(offlineOpen, 'offline: a reload opens the app (code from the worker, the stored copy)');
    await shot(page, 'private-offline');

    // ── Offline right after an update: the private cache gone, as a new version's activation leaves it, and the new
    // version's files never fetched (not in the HTTP cache either) ──
    await page.evaluate((name) => caches.delete(name), `app-private-${version}`);
    await cdp.send('Network.clearBrowserCache');
    await page.reload().catch(() => {});
    const pending = await page.waitForSelector('[data-testid=update-pending]', { timeout: 15000 }).then(() => true, () => false);
    check(pending, 'offline after an update: "connect once to finish updating", not a blank screen');
    await shot(page, 'private-update-pending');
    const back = page.waitForEvent('load', { timeout: 15000 }).then(() => true, () => false);
    await offline(browser, ctx, false);
    check(await back, 'back online: the page reloads by itself');
    check(await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 }).then(() => true, () => false), 'and the app opens');

    // ── Sign-out ──
    const before = await page.evaluate(async () => (await caches.keys()).sort());
    await settingsPage(page, 'account');
    await page.click('[data-testid=logout]');
    await page.click('[data-testid=logout-confirm]');
    await page.waitForSelector('[data-testid=unlock]', { timeout: 10000 });
    await page.waitForTimeout(500);
    const after = await page.evaluate(async () => (await caches.keys()).sort());
    check(!after.some((k) => k.startsWith('app-private-')) && after.some((k) => /precache/.test(k)), `sign-out: private cache dropped, public shell kept (${before.join(',')} → ${after.join(',')})`);
    check((await page.evaluate(() => localStorage.getItem('klatchly.signedin'))) === null, 'sign-out: the hint is dropped');
    asked = [];
    await page.reload();
    await page.waitForSelector('[data-testid=unlock]', { timeout: 30000 });
    await page.waitForTimeout(500);
    check(!asked.some(isPrivate), `signed out, a reload asks for no private file (${asked.join(', ') || 'none'})`);
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    check(csp.length === 0, `no CSP violations (${csp.length})`);
    check(writes.length === 0, `no write to any chat (${writes.join(', ') || 'none'})`);
    await browser.close();
    done(csp);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
