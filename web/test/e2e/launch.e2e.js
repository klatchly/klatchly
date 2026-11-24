// Launch without a white screen and code splitting (0.14.13, 0.14.14). Read-only (GET only in the phone context).
// - index.html as served: inline page colour + static splash, CSP allowing that <style> by hash, iOS launch
//   images linked and served (200 image/png, cached a week); the service worker precaches the public shell only (the
//   boot entry and the sign-in screens: 0.24.0, code served signed out, private.e2e.js), the app's chunks are
//   private (fetched ahead into their own cache once signed in: GET /api/assets);
// - splash before JS on an emulated iPhone (dark, light) while the scripts are held back (the stylesheet is
//   render-blocking and not held: this is not the very first frame, which iOS covers with the launch image);
// - the launch loads only the scripts index.html names and the private entry with its imports (then the
//   conversation, preloaded); Settings and each space
//   of the build's packages load when opened and still work; a chat opens without waiting for its chunk;
// - a chunk gone after a deploy reloads the page once, never in a loop, and Retry works once it is back.
// sh web/test/e2e/run-offline.sh launch.e2e.js
const { existsSync, readFileSync, readdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const { BASE, SHOTS, TEST_CHAT, check, open, enroll, logout, shot, done, spaces } = require('./lib');

// Playwright's screenshot waits for the fonts, i.e. for the held-back scripts: capture through CDP instead.
async function rawShot(page, name) {
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, 'base64'));
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
// A chunk "gone after a deploy", retry URLs (?retry=…) included.
const SETTINGS_JS = /\/assets\/Settings-[^/]+\.js(\?.*)?$/;
// Preloaded right after the list is up ("save": saving / sharing media, shared by the conversation and its viewers;
// 0.14.21: "forward", "gallery", "files", "FileIcon", small modules the conversation shares with its media page and
// the forward picker; 0.15.1/0.15.2: the augmentations' slot chunks, fetched with the conversation's once the server
// has said which packages are on: chunks named after a module of a listed package's client/, e.g. writing's
// "Writing", the agents' "AgentInChat" and "strings"; "dismiss", the core's, with them).
const WEB = join(__dirname, '../..');
const BUILT = [...readFileSync(join(WEB, 'build-test/ext/packages.server.js'), 'utf8').matchAll(/from '\.\/([a-z][a-z0-9-]*)\/server\/index\.js'/g)].map((m) => m[1]);
const PKG_CHUNKS = BUILT.flatMap((id) => {
  const dir = join(WEB, 'ext', id, 'client');
  return existsSync(dir) ? readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => f.replace(/\.tsx?$/, '')) : [];
});
const AFTER_LIST = new RegExp(`^(${['Conversation', 'Composer', 'save', 'forward', 'gallery', 'files', 'FileIcon', 'dismiss', ...PKG_CHUNKS].join('|')})-`);
// Core chunks the packages' slot chunks import (sdk withStepUp), preloaded with them after the list.
const SLOT_DEPS = /^(StepUp|Auth)-/;
// The core's lazy screens (a package's space: checked on opening it).
const LAZY = /^(Settings|Auth|NewChat|MessageMenu|Lightbox|FileViewer|PdfView|pdfjs|ChatMedia|Forward)-/;

async function phone(s, { colorScheme = 'dark' } = {}) {
  const ctx = await s.browser.newContext({
    viewport: { width: 402, height: 874 },
    screen: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    userAgent: UA,
    isMobile: true,
    hasTouch: true,
    colorScheme,
    locale: 'fr-FR',
    // The worker would fetch every chunk (precache) and hide what the page itself asks for.
    serviceWorkers: 'block',
    storageState: await s.ctx.storageState(),
  });
  await ctx.route('**/api/**', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  const page = await ctx.newPage();
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && s.csp.push(m.text()));
  const scripts = [];
  page.on('request', (r) => {
    const m = /\/assets\/([^/?]+\.js)$/.exec(r.url());
    if (m) scripts.push(m[1]);
  });
  return { ctx, page, scripts };
}

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  let p;
  try {
    // ── index.html as served ──
    const res = await page.request.get(`${BASE}/`);
    const html = await res.text();
    check(/<style>[^<]*html,\s*body\s*\{\s*background:\s*#f4f5f7[^<]*prefers-color-scheme:\s*dark\)\s*\{\s*html,\s*body\s*\{\s*background:\s*#14191e/.test(html), 'index.html: inline light and dark page colour');
    check(html.includes('<div id="root"><div class="splash"><div class="gate-mark" aria-hidden="true"></div></div></div>'), 'index.html: static splash inside #root');
    check(/style-src 'self' 'sha256-[A-Za-z0-9+/=]+'/.test(res.headers()['content-security-policy'] || ''), 'CSP allows the inline <style> by hash only');
    const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)">/g)];
    check(links.length >= 40, `${links.length} launch image links`);
    const iphone = links.filter(([, media]) => media.includes('device-width: 402px') && media.includes('device-height: 874px'));
    check(iphone.length === 4, 'iPhone 17 / 16 Pro: light and dark, portrait and landscape');
    for (const [, , href] of [...iphone, links[0], links[links.length - 1]]) {
      const r = await page.request.get(BASE + href);
      check(r.status() === 200 && r.headers()['content-type'] === 'image/png' && r.headers()['cache-control'] === 'public, max-age=604800', `${href}: 200 image/png, a week`);
    }
    // The launch set: the entry script and its modulepreloads.
    const assets = [...new Set([...html.matchAll(/\/assets\/[^"]+\.js/g)].map((m) => m[0]))];
    const sw = await (await page.request.get(`${BASE}/sw.js`)).text();
    const precached = [...new Set([...sw.matchAll(/assets\/([A-Za-z]+-[\w-]+\.js)/g)].map((m) => m[1]))];
    check(precached.some((f) => f.startsWith('Auth-')), 'service worker precaches the sign-in screens');
    check(!['Settings', 'MessageMenu', 'Lightbox', 'NewChat', 'Conversation', 'appmain'].some((n) => precached.some((f) => f.startsWith(n + '-'))), "service worker precaches none of the app's private chunks");
    check(assets.every((a) => sw.includes(a.slice(1))), 'service worker precaches the launch chunks');
    check(!/splash\//.test(sw), 'launch images are not precached');
    // What the boot entry may import: the sign-in screens and the private entry with its imports (its preload list).
    const entry = /<script type="module"[^>]*src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    const bootText = entry ? await (await page.request.get(BASE + entry)).text() : '';
    const bootRefs = [...new Set([...bootText.matchAll(/assets\/([\w.-]+\.js)/g)].map((m) => m[1]))];
    check(bootRefs.some((f) => f.startsWith('appmain-')), `the boot entry imports the private entry (${bootRefs.length} files named)`);

    await enroll(page);
    // The app's private chunks, for the checks of the spaces below.
    const warm = await page.evaluate(async () => (await (await fetch('/api/assets')).json()).files.map((f) => f.slice('/assets/'.length)));

    // ── First paint on an iPhone (dark), scripts held back ──
    p = await phone(s);
    let release;
    const held = new Promise((r) => (release = r));
    await p.ctx.route('**/assets/*.js', async (r) => {
      await held;
      return r.continue();
    });
    // Module scripts run before DOMContentLoaded: wait for the parsed splash instead.
    await p.page.goto(BASE + '/', { waitUntil: 'commit' });
    await p.page.waitForSelector('#root > .splash > .gate-mark', { state: 'attached' });
    await p.page.waitForTimeout(300);
    const first = await p.page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      mark: !!document.querySelector('#root > .splash > .gate-mark'),
      markBg: getComputedStyle(document.querySelector('.gate-mark')).backgroundColor,
    }));
    await rawShot(p.page, 'launch-first-paint-dark');
    check(first.bg === 'rgb(20, 25, 30)', `splash before JS, dark: page colour ${first.bg}`);
    check(first.mark && first.markBg === 'rgb(122, 155, 184)', 'splash before JS: the mark');
    release();
    await p.ctx.unroute('**/assets/*.js');

    // ── What the launch loads ──
    await p.page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
    // Up to the list: the launch (what is preloaded after it, with its own imports such as StepUp and Auth, is not).
    const untilList = [...p.scripts];
    await p.page.waitForTimeout(1500);
    const launchSet = assets.map((a) => a.slice('/assets/'.length));
    // (A package module named like a launch chunk, its index or i18n, is not one of the preloads. StepUp, and the sign-in
    // screens' Auth it takes the passkey prompt from, come as imports of the packages' slot chunks, preloaded as soon as
    // the server has said which packages are on: not the launch either.)
    const atLaunch = untilList.filter((f) => (!AFTER_LIST.test(f) && !SLOT_DEPS.test(f)) || launchSet.includes(f));
    const appSet = bootRefs.filter((f) => !f.startsWith('Auth-'));
    check(
      launchSet.every((f) => atLaunch.includes(f)) && atLaunch.some((f) => f.startsWith('appmain-')) && atLaunch.every((f) => launchSet.includes(f) || appSet.includes(f)),
      `launch: the scripts of index.html and the private entry's (${atLaunch.join(', ')})`,
    );
    check(!(await p.page.isVisible('[data-testid=unlock]')), 'launch signed in: no sign-in screen');
    check(p.scripts.some((f) => f.startsWith('Conversation-')), 'conversation chunk preloaded after the list');
    check(!atLaunch.some((f) => LAZY.test(f)), 'launch: no lazy screen requested');
    await shot(p.page, 'launch-list-dark');

    // ── Settings, lazily ──
    await p.page.click('[data-testid=open-settings]');
    await p.page.waitForSelector('[data-testid=settings-menu]', { timeout: 10000 });
    check(p.scripts.some((f) => f.startsWith('Settings-')), 'Settings chunk loaded on opening Settings');
    check((await p.page.evaluate(() => location.pathname)) === '/settings', 'Settings is a page: /settings');
    check(!p.scripts.some((f) => f.startsWith('Extensions-')), 'Manage extensions: its chunk not loaded with the menu');
    await p.page.click('[data-testid=settings-item-app]');
    await p.page.waitForSelector('[data-testid=app-version]', { timeout: 10000 });
    check(/^Version \d+\.\d+\.\d+$/.test(await p.page.textContent('[data-testid=app-version]')), 'Settings works (Application → À propos shows the version)');
    await shot(p.page, 'launch-settings');
    // Escape: on a phone, from a page back to the menu (as its Back), then out of Settings.
    await p.page.keyboard.press('Escape');
    await p.page.waitForSelector('[data-testid=settings-page]', { state: 'hidden', timeout: 5000 });
    check((await p.page.evaluate(() => location.pathname)) === '/settings', 'Escape on a page: back to the menu');
    await p.page.keyboard.press('Escape');
    await p.page.waitForSelector('[data-testid=settings-menu]', { state: 'detached', timeout: 5000 });

    // ── A chat opens at once (chunk already in; client-side navigation, the test chat only) ──
    const before = p.scripts.length;
    await p.page.evaluate((id) => {
      history.pushState(null, '', `/chat/${encodeURIComponent(id)}`);
      dispatchEvent(new PopStateEvent('popstate'));
    }, TEST_CHAT);
    await p.page.waitForSelector('.pane-chat .conv-header, .pane-chat [data-testid=messages]', { timeout: 5000 });
    check(!p.scripts.slice(before).some((f) => AFTER_LIST.test(f)), 'opening a chat fetches no conversation chunk');
    check(!(await p.page.isVisible('.pane-chat > .conversation > .messages:only-child')), 'no placeholder shown');
    await p.page.goBack();
    await p.page.waitForSelector('[data-testid=chat-row]', { timeout: 15000 });

    // ── The spaces of the build's packages: each loads when opened (its own chunk, unless an augmentation of the
    // same package already brought it), its list shows ──
    const spaceChunks = new Map();
    for (const sp of await spaces(p.page)) {
      const before = p.scripts.length;
      await p.page.click(`[data-testid=open-${sp.id}]`);
      const shown = await p.page.waitForSelector('.pane-list .space-scroll:not(.settings-menu-scroll)', { timeout: 15000 }).then(() => true, () => false);
      const loaded = p.scripts.slice(before);
      check(shown && !loaded.some((f) => launchSet.includes(f)), `${sp.id}: its list shows, from no launch script (${loaded.join(', ') || 'chunk already there'})`);
      check(loaded.every((f) => warm.includes(f)), `${sp.id}: its chunks are private, fetched ahead once signed in`);
      if (loaded.length) spaceChunks.set(sp.id, loaded);
      await p.page.goBack();
      await p.page.waitForSelector('[data-testid=chat-row]', { timeout: 15000 });
    }
    await p.ctx.close();

    // ── Light theme: first paint ──
    p = await phone(s, { colorScheme: 'light' });
    await p.ctx.route('**/assets/*.js', () => {});
    await p.page.goto(BASE + '/', { waitUntil: 'commit' });
    await p.page.waitForSelector('#root > .splash > .gate-mark', { state: 'attached' });
    await p.page.waitForTimeout(300);
    check((await p.page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(244, 245, 247)', 'splash before JS, light: page colour');
    await rawShot(p.page, 'launch-first-paint-light');
    await p.ctx.close();

    // ── A chunk gone after a deploy ──
    p = await phone(s);
    await p.ctx.route(SETTINGS_JS, (r) => r.fulfill({ status: 404, body: '' }));
    await p.page.goto(BASE + '/');
    await p.page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
    const reloaded = p.page.waitForEvent('load', { timeout: 10000 }).then(() => true, () => false);
    await p.page.click('[data-testid=open-settings]');
    check(await reloaded, 'missing chunk: the page reloads once');
    // The reload lands on /settings: its chunk still missing, the menu column shows its header and Retry, no reload loop.
    const again = p.page.waitForEvent('load', { timeout: 6000 }).then(() => true, () => false);
    check(await p.page.waitForSelector('.pane-list [data-testid=load-error]', { timeout: 30000 }).then(() => true, () => false), 'still missing after the reload: "could not load" with Retry');
    check(!(await again), 'no reload loop');
    check(await p.page.isVisible('[data-testid=settings-close]'), 'the menu keeps its header with Close');
    await shot(p.page, 'launch-settings-load-error');
    await p.ctx.unroute(SETTINGS_JS);
    await p.page.click('.pane-list [data-testid=load-retry]');
    check(await p.page.waitForSelector('[data-testid=settings-menu]', { timeout: 15000 }).then(() => true, () => false), 'chunk back: Retry shows the menu');
    await p.page.click('[data-testid=settings-close]');
    await p.page.waitForSelector('[data-testid=chat-row]', { timeout: 15000 });
    // A pane: Retry row, then Retry works (the first space with a chunk of its own).
    const [paneId, paneChunks] = [...spaceChunks][0] ?? [];
    if (paneId) {
      const missing = new RegExp(`/assets/(${paneChunks.map((f) => f.replace(/[-.]/g, '\\$&')).join('|')})(\\?.*)?$`);
      await p.ctx.route(missing, (r) => r.fulfill({ status: 404, body: '' }));
      await p.page.click(`[data-testid=open-${paneId}]`);
      check(await p.page.waitForSelector('[data-testid=load-error]', { timeout: 10000 }).then(() => true, () => false), `${paneId} chunk missing: "could not load" row with Retry`);
      await shot(p.page, 'launch-load-error');
      await p.ctx.unroute(missing);
      await p.page.click('[data-testid=load-retry]');
      check(await p.page.waitForSelector('.pane-list .space-scroll:not(.settings-menu-scroll)', { timeout: 15000 }).then(() => true, () => false), `Retry: ${paneId} loads`);
    } else console.log('     (no space with a chunk of its own: the pane Retry is not checked)');
    await p.ctx.close();
    p = undefined;
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    if (p) await p.ctx.close().catch(() => {});
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
