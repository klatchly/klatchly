// Settings (0.14.17 a page, 0.15.7 a menu, 0.15.8 three pages of rows, 0.18.4 a fourth: Lecture discrète): the gear
// puts the Settings menu in the list column (Général, Lecture discrète, Application, Extensions; then a package's pages under its name) and a page in the pane
// (/settings/<id>, /settings/ext/<package>/<id>), its settings as rows (label and help left, control right, thin
// lines between, in cards centred in a readable width; stacked on a phone). 0.15.7's page URLs open the page that holds
// them now, scrolled to that block. Wide screen: /settings shows the first page beside the menu, entries switch the
// page without growing the history. Phone: the menu replaces the list, a page slides over it like a chat, Back and
// the edge swipe return to the menu. The menu's Close, the gear's toggle and Escape leave Settings for where it was
// opened, without growing the history. Deep links and reloads land on the same page. Read-only.
// sh web/test/e2e/run-offline.sh settings.e2e.js
const { BASE, TEST_CHAT, check, step, open, enroll, logout, shot, done, spaces } = require('./lib');

const CORE = ['general', 'reading', 'quiet', 'app', 'extensions'];
// 0.15.7's pages: now blocks of these pages.
const MOVED = { language: 'general', notifications: 'general', account: 'general', storage: 'app', about: 'app' };
const nav = (page) => page.evaluate(() => ({ path: location.pathname, len: history.length, state: history.state }));
const title = (page) => page.textContent('.pane-chat .settings-title');
const current = (page) => page.$$eval('[data-testid=settings-menu] [aria-current=page]', (a) => a.map((x) => x.dataset.testid));
const item = (id) => `[data-testid=settings-item-${id}]`;
// Polled from here (the CSP refuses Playwright's string predicates).
async function waitPath(page, want, ms = 30000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await page.waitForTimeout(100)) if ((await page.evaluate(() => location.pathname)) === want) return true;
  return false;
}

/** The rows of the page shown: their blocks, and whether each has its control right of its text (or under it). */
const rows = (page) =>
  page.$$eval('.pane-chat .set-row', (rs) =>
    rs.map((r) => {
      const t = r.querySelector('.set-text').getBoundingClientRect();
      const c = r.querySelector('.set-control').getBoundingClientRect();
      const line = getComputedStyle(r).borderBottomWidth;
      return { block: r.dataset.block, beside: c.left >= t.right - 1, under: c.top >= t.bottom - 1, line, lineOk: line === (r.nextElementSibling ? '1px' : '0px'), card: !!r.closest('.set-group') };
    }),
  );
const content = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('.pane-chat .settings-content').getBoundingClientRect();
    const p = document.querySelector('.pane-chat').getBoundingClientRect();
    return { left: Math.round(c.left - p.left), width: Math.round(c.width), pane: Math.round(p.width) };
  });

async function phoneContext(s) {
  const ctx = await s.browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'fr-FR',
    storageState: await s.ctx.storageState(),
  });
  // Nothing written from the phone: GETs only.
  await ctx.route('**/api/**', (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
  await ctx.addInitScript(() => localStorage.setItem('lang', 'fr'));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp };
}
const touch = (cdp, type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
async function edgeSwipe(page, cdp, toX, { y = 420, steps = 10, ms = 200 } = {}) {
  await touch(cdp, 'touchStart', [[6, y]]);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', [[6 + ((toX - 6) * i) / steps, y + i]]);
    await page.waitForTimeout(ms / steps);
  }
  await touch(cdp, 'touchEnd', []);
}

async function desktop(page) {
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
  const n0 = await nav(page);
  await page.click('[data-testid=open-settings]');
  await page.waitForSelector('[data-testid=settings-menu]', { timeout: 10000 });
  await page.waitForSelector('.pane-chat [data-testid=settings-general] [data-testid=settings-language]', { timeout: 10000 });
  const n1 = await nav(page);
  check(n1.path === '/settings' && n1.state?.fromList === true && n1.state?.from === '/' && n1.len === n0.len + 1, `desktop: the gear opens /settings, one entry (${JSON.stringify(n1)})`);
  check(await page.isVisible('.pane-list [data-testid=settings-menu]'), 'desktop: the menu is in the list column');
  check(!(await page.isVisible('.pane-list [data-testid=chat-row]')), 'desktop: in place of the chat list');
  check((await title(page)) === 'Général', 'desktop: /settings shows its first page (Général) beside the menu');
  check(JSON.stringify(await current(page)) === '["settings-item-general"]', 'desktop: its entry is the current one (aria-current)');
  check(!(await page.isVisible('[data-testid=settings-back]')) && (await page.isVisible('[data-testid=settings-close]')), "desktop: the menu's Close, none in the page header");
  const core = await page.$$eval('[data-testid=settings-core] a', (a) => a.map((x) => x.textContent));
  check(core.join('|') === 'Général|Lecture discrète|Heures calmes|Application|Extensions', `the core's five entries (${core.join('|')})`);
  const items = await page.$$eval('[data-testid=settings-menu] a', (a) => a.map((x) => x.dataset.testid.replace('settings-item-', '')));
  check(JSON.stringify(items.slice(0, CORE.length)) === JSON.stringify(CORE), `core entries first, in order (${items.join(',')})`);
  check(items.slice(CORE.length).every((id) => /^[a-z0-9]+-[a-z0-9-]+$/.test(id)), "then the packages' pages");
  const labels = await page.$$eval('[data-testid=settings-menu] a', (a) => a.map((x) => x.textContent));
  check(labels.slice(0, CORE.length).join('|') === 'Général|Lecture discrète|Heures calmes|Application|Extensions', `labels in French (${labels.join('|')})`);
  const writing = await page.isVisible(item('writing-langs'));
  if (writing) {
    check((await page.textContent('[data-testid=settings-pkg-writing] .space-group')) === 'Aide à l’écriture', "a package's pages under its name (Aide à l’écriture → Langues de traduction)");
    check((await page.textContent('[data-testid=settings-pkg-llm] .space-group')) === 'Modèles de langage', 'llm: its two pages under its name');
  } else console.log('     (writing off: no package page listed)');
  // Général: Langue, Notifications, Session, then Connexion (its own chunk, last) as rows, control beside the text, a
  // line between rows. Lecture discrète has its own page since 0.18.4: nothing of it here.
  await page.waitForSelector('.pane-chat [data-testid=settings-signin]', { timeout: 15000 });
  const g = await rows(page);
  check(g.map((r) => r.block).join() === 'language,notifications,account,signin', `Général: its rows (${g.map((r) => r.block)})`);
  check(g.every((r) => r.beside), 'desktop: each control right of its label');
  check(g.every((r) => r.card && r.lineOk), 'desktop: rows in cards, a thin line between the rows of a card');
  check((await page.$$eval('.pane-chat .set-group-title', (h) => h.length)) === 2, 'desktop: Général in two groups (this device, security)');
  check(!(await page.$('.pane-chat [data-testid=reading-accounts]')), 'desktop: no discreet reading on Général');
  const box = await content(page);
  check(box.width <= 920 && Math.abs(box.left - (box.pane - box.left - box.width)) <= 2, `desktop: the page centred in the pane, at most 920 px wide (${JSON.stringify(box)})`);
  // Sign-in, closed: its method and Change…; locked (the confirmation window over, faked in the page), Change… asks
  // to confirm first, the form hidden until then (0.17.4).
  check(!(await page.$('.pane-chat [data-testid=signin-passkeys]')) && (await page.isVisible('.pane-chat [data-testid=signin-change]')), 'Connexion closed: the method and Change…, no form');
  await page.route('**/api/auth/settings', async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...(await res.json()), stepUp: { leftMs: 0, methods: ['passkey'] } } });
  });
  await page.reload();
  await page.click('.pane-chat [data-testid=signin-change]', { timeout: 15000 });
  await page.waitForSelector('.pane-chat [data-testid=signin-stepup]', { timeout: 5000 });
  check(!(await page.$('.pane-chat [data-testid=signin-passkeys]')) && (await page.isVisible('[data-testid=signin-stepup-passkey]')), 'Connexion locked: Change… asks to confirm, no greyed-out form');
  await shot(page, 'settings-desktop-signin-locked');
  await page.click('.pane-chat [data-testid=signin-change]');
  check(!(await page.$('.pane-chat [data-testid=signin-stepup]')), 'Connexion: Done closes it');
  await page.unroute('**/api/auth/settings');
  await page.reload();
  await page.waitForSelector('.pane-chat [data-testid=settings-signin]', { timeout: 15000 });
  await shot(page, 'settings-desktop');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'settings-desktop-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Lecture discrète: its page from the menu, the entry current; its lead, the accounts (switch beside each), the
  // conversations' card with "Add a conversation"; centred like the others.
  await page.click(item('reading'));
  await page.waitForSelector('.pane-chat [data-testid=settings-reading] [data-testid=reading-chats]', { timeout: 15000 });
  check((await nav(page)).path === '/settings/reading' && (await title(page)) === 'Lecture discrète', 'desktop: the Lecture discrète page');
  check(JSON.stringify(await current(page)) === '["settings-item-reading"]', 'desktop: its entry current');
  check(await page.isVisible('.pane-chat [data-testid=reading-lead]'), 'Lecture discrète: its lead');
  await page.waitForSelector('.pane-chat .reading-account', { timeout: 15000 });
  const rd = await rows(page);
  check(rd.length > 0 && rd.every((r) => r.beside && r.card), `Lecture discrète: one row per account, the switch beside (${rd.length})`);
  check(await page.isVisible('.pane-chat [data-testid=reading-add]'), 'Lecture discrète: « Ajouter une discussion »');
  const rbox = await content(page);
  check(rbox.width <= 920 && Math.abs(rbox.left - (rbox.pane - rbox.left - rbox.width)) <= 2, `desktop: Lecture discrète centred (${JSON.stringify(rbox)})`);
  await shot(page, 'settings-desktop-reading');
  // The menu was opened from the list: back to Général for what follows (page to page, the same entry).
  await page.click(item('general'));
  await page.waitForSelector('.pane-chat [data-testid=settings-general]', { timeout: 10000 });

  // From the menu: a page (one entry, Back would return to the menu); page to page: the same entry.
  await page.click(item('app'));
  await page.waitForSelector('.pane-chat [data-testid=settings-app]');
  const n2 = await nav(page);
  check(n2.path === '/settings/app' && n2.len === n1.len + 1 && n2.state?.from === '/', `desktop: an entry opens /settings/app (${JSON.stringify(n2)})`);
  check((await title(page)) === 'Application', 'desktop: the Application page');
  const a = await rows(page);
  check(a.map((r) => r.block).join() === 'storage,about' && a.every((r) => r.beside), `Application: Données et cache, À propos, as rows (${a.map((r) => r.block)})`);
  check(/^Version \d+\.\d+\.\d+$/.test(await page.textContent('[data-testid=app-version]')), 'À propos: the version');
  check(!!(await page.textContent('[data-testid=settings-about] .settings-diag'))?.trim(), 'À propos: the display diagnostics');
  check(JSON.stringify(await current(page)) === '["settings-item-app"]', 'desktop: aria-current follows');
  check(!(await page.$('[data-testid=settings-models]')) && !(await page.$('[data-testid=extensions]')), "no package's section on a core page");
  await shot(page, 'settings-desktop-app');
  for (const [id, testid, name] of [
    ['general', 'signout-row', 'Général'],
    ['extensions', 'extensions', 'Gérer les extensions'],
    ...(writing ? [['llm-providers', 'settings-providers', 'Fournisseurs'], ['llm-models', 'settings-models', 'Modèles par défaut'], ['writing-langs', 'settings-langs', 'Langues de traduction']] : []),
  ]) {
    await page.click(item(id));
    await page.waitForSelector(`.pane-chat [data-testid=${testid}]`, { timeout: 15000 });
    const n = await nav(page);
    check(n.len === n2.len && (await title(page)) === name, `desktop: ${id} → ${n.path}, "${name}", same entry`);
    if (id === 'extensions') {
      await page.waitForSelector('[data-testid=extensions] article', { timeout: 15000 });
      const cards = await page.$$eval('[data-testid=extensions] article', (a) =>
        a.map((x) => ({ left: Math.round(x.getBoundingClientRect().left), top: Math.round(x.getBoundingClientRect().top), sw: Math.round(x.querySelector('.ext-head').getBoundingClientRect().top), facts: Math.round(x.querySelector('.ext-facts').getBoundingClientRect().bottom) })),
      );
      check(new Set(cards.map((c) => c.left)).size === 2, `desktop: Extensions, cards in two columns (${cards.length} cards)`);
      const byRow = [...new Set(cards.map((c) => c.top))].map((top) => cards.filter((c) => c.top === top));
      check(byRow.every((r) => new Set(r.map((c) => c.sw)).size === 1 && new Set(r.map((c) => c.facts)).size === 1), 'desktop: the cards of a row line up their heads and their facts');
      await shot(page, 'settings-desktop-extensions');
    }
    if (id === 'llm-models') {
      await page.waitForSelector('[data-testid=llm-routes] select, .pane-chat .settings-note', { timeout: 15000 });
      const ai = await rows(page);
      // Two rows (model, fallback) per use the packages on declare (writing: 3, ask: 1 since 0.21.0).
      const uses = await page.$$eval('[data-testid=llm-routes] fieldset.llm-group', (f) => f.length);
      if (ai.length) check(uses > 0 && ai.length === 2 * uses && ai.every((r) => r.beside), `Modèles par défaut: model and fallback per use as rows (${ai.length}, ${uses} uses)`);
      await shot(page, 'settings-desktop-ai');
    }
    if (id === 'writing-langs') {
      // 0.15.9: the translation languages, two rows (drafts, received messages).
      await page.waitForSelector('[data-testid=langs-settings], .pane-chat .settings-note', { timeout: 15000 });
      const l = await rows(page);
      if (l.length) check(l.length === 2 && l.every((r) => r.beside), `Langues de traduction: two rows (${l.length})`);
      await shot(page, 'settings-desktop-langs');
    }
  }
  if (writing) check((await nav(page)).path === '/settings/ext/writing/langs', "a package's page in its namespace: /settings/ext/writing/langs");
  await page.click(item('app'));
  await page.waitForSelector('.pane-chat [data-testid=app-version]');

  await page.reload();
  await page.waitForSelector('.pane-chat [data-testid=settings-about]', { timeout: 30000 });
  check((await nav(page)).path === '/settings/app' && JSON.stringify(await current(page)) === '["settings-item-app"]', 'desktop: reload stays on the page, its entry current');

  // A narrow window (820 px: the pane beside the list is about 440 px): the rows stack, labels stay readable.
  await page.setViewportSize({ width: 820, height: 800 });
  for (const path of ['/settings/general', ...(writing ? ['/settings/ext/llm/models', '/settings/ext/writing/langs'] : [])]) {
    await page.goto(BASE + path);
    await page.waitForSelector('.pane-chat .set-row', { timeout: 15000 });
    await page.waitForTimeout(400);
    const r = await page.$$eval('.pane-chat .set-row', (rs) =>
      rs.map((x) => {
        const label = x.querySelector('.set-label');
        const em = parseFloat(getComputedStyle(label).fontSize);
        const row = x.getBoundingClientRect();
        const ctl = x.querySelector('.set-control').getBoundingClientRect();
        return { label: Math.round(label.getBoundingClientRect().width / em), fits: ctl.right <= row.right + 1 && ctl.left >= row.left - 1 };
      }),
    );
    check(r.length > 0 && r.every((x) => x.label >= 7 && x.fits), `820 px, ${path}: labels at least 7em wide, controls inside their rows (${r.map((x) => x.label).join(',')} em)`);
    check(await page.evaluate(() => document.querySelector('.pane-chat .settings-body').scrollWidth <= document.querySelector('.pane-chat .settings-body').clientWidth + 1), `820 px, ${path}: no horizontal scroll`);
    if (path.includes('writing')) await shot(page, `settings-820-${path.split('/').pop()}`);
  }

  // 0.15.7's page URLs: still served; replaced by their page's, the block as anchor, scrolled into view.
  await page.setViewportSize({ width: 1200, height: 420 });
  for (const [old, to] of Object.entries(MOVED)) {
    const status = await page.evaluate(async (u) => (await fetch(u, { headers: { Accept: 'text/html' } })).status, `/settings/${old}`);
    await page.goto(`${BASE}/settings/${old}`);
    check(await waitPath(page, `/settings/${to}`), `desktop: /settings/${old} (served: ${status}) → /settings/${to}`);
    await page.waitForSelector(`.pane-chat [data-testid=settings-${old}]`, { timeout: 15000 });
    await page.waitForTimeout(300);
    const at = await page.evaluate((b) => {
      const r = document.querySelector(`.pane-chat [data-block=${b}]`).getBoundingClientRect();
      const body = document.querySelector('.pane-chat .settings-body').getBoundingClientRect();
      return { hash: location.hash, top: Math.round(r.top - body.top), h: Math.round(body.height) };
    }, old);
    check(status === 200 && at.hash === `#${old}` && at.top >= 0 && at.top < at.h, `desktop: …#${old}, its block in view (${JSON.stringify(at)})`);
    check(JSON.stringify(await current(page)) === `["settings-item-${to}"]`, `desktop: /settings/${old}: the ${to} entry current`);
  }
  await page.setViewportSize({ width: 1200, height: 800 });

  // Escape: out of Settings, past the page and the menu, the history not grown.
  const nE = await nav(page);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 10000 });
  let n = await nav(page);
  check(n.path === '/' && n.len === nE.len, `desktop: Escape leaves Settings for the list (${JSON.stringify(n)})`);

  // The chat list under the menu keeps its scroll position, and its search.
  const roundTrip = async () => {
    await page.click('[data-testid=open-settings]');
    await page.waitForSelector('[data-testid=settings-menu]');
    check(!(await page.isVisible('[data-testid=search]')), 'desktop: the chat list hidden under the menu');
    await page.click('[data-testid=settings-close]');
    await page.waitForSelector('[data-testid=settings-menu]', { state: 'detached', timeout: 5000 });
  };
  const scrolled = await page.$eval('.chat-list', (el) => ((el.scrollTop = 120), el.scrollTop));
  await roundTrip();
  const kept = await page.$eval('.chat-list', (el) => el.scrollTop);
  check(kept === scrolled, `desktop: leaving Settings keeps the list's scroll (${kept}/${scrolled})`);
  await page.fill('[data-testid=search]', 'e2e');
  await roundTrip();
  check((await page.inputValue('[data-testid=search]')) === 'e2e', 'desktop: and its search');
  await page.fill('[data-testid=search]', '');

  // The menu's Close: out, no new entry.
  await page.click('[data-testid=open-settings]');
  await page.waitForSelector('[data-testid=settings-menu]');
  const nB = await nav(page);
  await page.click('[data-testid=settings-close]');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 5000 });
  n = await nav(page);
  check(n.path === '/' && n.len === nB.len, `desktop: the menu's Close returns to the list, no new entry (${JSON.stringify(n)})`);

  // From a chat: Back and Escape (from the menu or a page) return to that chat.
  const chatPath = `/chat/${encodeURIComponent(TEST_CHAT)}`;
  await page.goto(BASE + chatPath);
  await page.waitForSelector('[data-testid=conversation]', { timeout: 30000 });
  await page.click('[data-testid=open-settings]');
  await page.waitForSelector('[data-testid=settings-menu]');
  check(!(await page.isVisible('[data-testid=conversation]')), 'desktop: Settings replaces the open chat in the pane');
  await page.click('[data-testid=settings-close]');
  await page.waitForSelector('[data-testid=conversation]', { timeout: 10000 });
  check((await nav(page)).path === chatPath, "desktop: the menu's Close returns to the chat it was opened from");
  await page.click('[data-testid=open-settings]');
  await page.waitForSelector('[data-testid=settings-menu]');
  await page.click(item('general'));
  await page.waitForSelector('[data-testid=signout-row]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=conversation]', { timeout: 10000 });
  check((await nav(page)).path === chatPath, 'desktop: Escape from a page returns to the chat too');

  // Deep links (no history state): the page; Back leads to the chat list, replacing the entry.
  await page.goto(BASE + '/settings/app');
  await page.waitForSelector('.pane-chat [data-testid=settings-app]', { timeout: 30000 });
  check(JSON.stringify(await current(page)) === '["settings-item-app"]', 'desktop: deep link /settings/app');
  const d0 = await nav(page);
  await page.click('[data-testid=settings-close]');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 10000 });
  n = await nav(page);
  check(n.path === '/' && n.len === d0.len, `desktop: deep link, Back replaces it with the list (${JSON.stringify(n)})`);
  const unknown = await page.evaluate(async () => (await fetch('/settings/nope', { headers: { Accept: 'text/html' } })).status);
  check(unknown === 404, `desktop: the server has no page /settings/nope (${unknown})`);
  // Opened anyway (the service worker answers any navigation with the app): the menu takes its place.
  await page.goto(BASE + '/settings/nope');
  check(await waitPath(page, '/settings'), 'desktop: an unknown Settings URL is replaced by /settings');
  // A package page this build does not have (or of a package that is off): the menu takes its place.
  await page.goto(BASE + '/settings/ext/nope/x');
  check(await waitPath(page, '/settings'), 'desktop: an unknown package page gives way to the menu');
  await page.waitForSelector('.pane-chat [data-testid=settings-general]', { timeout: 30000 });
  step('desktop: an unknown package page gives way to the menu and the first page');
  // The page already shown beside the menu, chosen in it: the same entry, no extra step back.
  const nL = await nav(page);
  await page.click(item('general'));
  await waitPath(page, '/settings/general', 5000);
  check((await nav(page)).len === nL.len, 'desktop: choosing the page already shown replaces the entry');
  if (writing) {
    await page.goto(BASE + '/settings/ext/llm/models');
    await page.waitForSelector('.pane-chat [data-testid=settings-models]', { timeout: 30000 });
    check(JSON.stringify(await current(page)) === '["settings-item-llm-models"]', 'desktop: deep link to a package page');
  }

  // The spaces: their gear opens the same menu in place of their list; Back returns to the space.
  // Each space of the build's packages (its list: `.pane-list .space-scroll`, not the menu's).
  const pane = '.pane-list .space-scroll:not(.settings-menu-scroll)';
  for (const { id, path } of await spaces(page)) {
    const tab = `open-${id}`;
    await page.goto(BASE + '/');
    await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
    if (!(await page.isVisible(`[data-testid=${tab}]`))) {
      check(false, `${path}: its sidebar button`);
      continue;
    }
    await page.click(`[data-testid=${tab}]`);
    await page.waitForSelector(pane, { timeout: 15000 });
    await page.click(`.pane-list [data-testid=open-settings]`);
    await page.waitForSelector('[data-testid=settings-menu]', { timeout: 10000 });
    check((await nav(page)).path === '/settings' && !(await page.isVisible(pane)), `desktop ${path}: the menu takes the space's list column`);
    await page.reload();
    await page.waitForSelector('[data-testid=settings-menu]', { timeout: 30000 });
    await page.click('[data-testid=settings-close]');
    await page.waitForSelector(pane, { timeout: 10000 });
    check((await nav(page)).path === path, `desktop ${path}: Back returns to the space (after a reload too)`);
  }
}

async function phone({ page, cdp }) {
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
  await page.waitForTimeout(800);
  const n0 = await nav(page);
  await page.tap('[data-testid=open-settings]');
  await page.waitForSelector('[data-testid=settings-menu]', { timeout: 10000 });
  const n1 = await nav(page);
  check(n1.path === '/settings' && n1.state?.fromList === true && n1.len === n0.len + 1, `phone: the gear opens /settings (${JSON.stringify(n1)})`);
  check(!(await page.isVisible('[data-testid=settings-page]')), 'phone: the menu alone, no page over it');
  check(JSON.stringify(await current(page)) === '[]', 'phone: no entry current on the menu');
  const box = await page.locator('[data-testid=settings-menu]').boundingBox();
  check(box && box.x === 0 && Math.round(box.width) === 390, `phone: the menu on the full width (${JSON.stringify(box)})`);
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  check(noScroll, 'phone: no horizontal scroll');
  const entries = await page.$$eval('[data-testid=settings-menu] a', (a) => a.map((x) => Math.round(x.getBoundingClientRect().height)));
  check(entries.every((h) => h >= 48), `phone: entries at least 48 px high (${entries.join(',')})`);
  await shot(page, 'settings-phone-menu');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'settings-phone-menu-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // A page slides over the menu, like a chat over the list.
  await page.tap(item('general'));
  const entering = await page.waitForSelector('.shell.entering', { timeout: 1500 }).then(() => true, () => false);
  await page.waitForSelector('[data-testid=settings-notifications]', { timeout: 10000 });
  const n2 = await nav(page);
  check(n2.path === '/settings/general' && n2.state?.fromList === true && n2.len === n1.len + 1, `phone: an entry opens its page (${JSON.stringify(n2)})`);
  check(entering, 'phone: the page slides in');
  await page.waitForTimeout(500);
  const pb = await page.locator('[data-testid=settings-page]').boundingBox();
  check(pb && pb.x === 0 && Math.round(pb.width) === 390, `phone: the page full screen (${JSON.stringify(pb)})`);
  check((await page.$eval('.pane-list', (el) => getComputedStyle(el).visibility)) === 'hidden', 'phone: the menu is under it (hidden, kept)');
  check(await page.isVisible('[data-testid=settings-back]'), 'phone: Back in its header');
  await page.waitForSelector('.pane-chat [data-testid=settings-signin]', { timeout: 15000 });
  const pr = await rows(page);
  check(pr.length === 4 && pr.every((r) => r.under && !r.beside), `phone: the rows stacked, control under its label (${pr.length})`);
  check(await page.evaluate(() => document.querySelector('.pane-chat .settings-body').scrollWidth <= innerWidth + 1), 'phone: no horizontal scroll on the page');
  await shot(page, 'settings-phone-page');
  await page.tap('[data-testid=settings-back]');
  await page.waitForSelector('[data-testid=settings-page]', { state: 'hidden', timeout: 10000 });
  await page.waitForTimeout(500);
  let n = await nav(page);
  check(n.path === '/settings' && n.len === n2.len && (await page.isVisible('[data-testid=settings-menu]')), `phone: Back returns to the menu (${JSON.stringify(n)})`);

  // Lecture discrète on a phone: no horizontal scroll; an account's switch stays beside its name (a short control).
  await page.tap(item('reading'));
  await page.waitForSelector('.pane-chat .reading-account', { timeout: 15000 });
  await page.waitForTimeout(500);
  check(await page.evaluate(() => document.querySelector('.pane-chat .settings-body').scrollWidth <= innerWidth + 1), 'phone: Lecture discrète, no horizontal scroll');
  const rp = await rows(page);
  check(rp.length > 0 && rp.every((r) => r.beside), `phone: Lecture discrète, each switch beside its account (${rp.length})`);
  const addBox = await page.locator('[data-testid=reading-add]').boundingBox();
  check(!!addBox && addBox.height >= 44, `phone: « Ajouter une discussion » a finger's reach (${addBox && Math.round(addBox.height)} px)`);
  await shot(page, 'settings-phone-reading');
  await page.tap('[data-testid=settings-back]');
  await page.waitForSelector('[data-testid=settings-page]', { state: 'hidden', timeout: 10000 });
  await page.waitForTimeout(500);

  // The edge swipe, too.
  await page.tap(item('app'));
  await page.waitForSelector('[data-testid=settings-about]');
  await page.waitForTimeout(600);
  await shot(page, 'settings-phone-app');
  await edgeSwipe(page, cdp, 260);
  await page.waitForTimeout(900);
  n = await nav(page);
  check(n.path === '/settings', `phone: edge swipe returns to the menu (${JSON.stringify(n)})`);

  // A package's page, on the full width.
  if (await page.isVisible(item('llm-models'))) {
    await page.tap(item('llm-models'));
    await page.waitForSelector('[data-testid=settings-models]', { timeout: 15000 });
    // Its body (the llm chunk, then its settings) and the end of the slide.
    await page.waitForSelector('[data-testid=llm-routes] select, .pane-chat .settings-note', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    if (await page.isVisible('[data-testid=llm-writing-translate-model]').catch(() => false)) {
      const sel = await page.locator('[data-testid=llm-writing-translate-model]').boundingBox();
      check(sel && sel.width >= 300, `phone: model select on the full width (${Math.round(sel?.width ?? 0)} px)`);
    }
    await shot(page, 'settings-phone-ai');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'settings-phone-ai-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.tap('[data-testid=settings-back]');
    await page.waitForSelector('[data-testid=settings-page]', { state: 'hidden', timeout: 10000 });
  }
  await page.waitForTimeout(400);
  await page.tap(item('extensions'));
  await page.waitForSelector('[data-testid=extensions] article', { timeout: 15000 });
  const cols = await page.$$eval('[data-testid=extensions] article', (a) => new Set(a.map((x) => Math.round(x.getBoundingClientRect().left))).size);
  check(cols === 1, `phone: Extensions, one column of cards (${cols})`);
  await shot(page, 'settings-phone-extensions');
  await page.tap('[data-testid=settings-back]');
  await page.waitForSelector('[data-testid=settings-page]', { state: 'hidden', timeout: 10000 });

  // Deep link (0.15.7's Session page, now in Général): the page; Back then shows the menu (replacing the entry).
  await page.goto(BASE + '/settings/account');
  await page.waitForSelector('[data-testid=signout-row]', { timeout: 30000 });
  const d0 = await nav(page);
  await page.tap('[data-testid=settings-back]');
  await page.waitForSelector('[data-testid=settings-page]', { state: 'hidden', timeout: 10000 });
  n = await nav(page);
  check(n.path === '/settings' && n.len === d0.len, `phone: deep link, Back shows the menu (${JSON.stringify(n)})`);
  await page.tap('[data-testid=settings-close]');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 10000 });
  check((await nav(page)).path === '/', "phone: the menu's Close returns to the chat list");
}

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  let p;
  try {
    await enroll(page);
    await desktop(page);
    p = await phoneContext(s);
    await phone(p);
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    await p?.ctx.close().catch(() => {});
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await page.goto(BASE + '/').catch(() => {});
    await logout(page);
    check(await page.isVisible('[data-testid=unlock]'), 'signed out through Settings');
    await s.browser.close();
    done(s.csp);
  }
})();
