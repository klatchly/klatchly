// e2e-instance: alone
// Settings → Manage extensions (0.15.5; /settings/extensions since 0.15.7, a grid of cards since 0.15.8), OFFLINE
// ONLY: this script turns packages off and on, which applies to the whole
// server and every signed-in device. It refuses to run against anything but a local instance.
// Offline (every backend faked: offline/server.mjs): sh web/test/e2e/run-offline.sh extensions.e2e.js
// Checks: the section lists every package of the build with its version, modules, data scope, requirements and
// state; writing off and on, applied live in another open tab (✨ goes and comes back without a reload) and in the
// menu (its page Langues de traduction leaves it and comes back; a tab showing that page falls back to the menu); llm
// off asks first and takes writing along (and llm's pages, Fournisseurs and Modèles par défaut, leave the menu); writing on again offers to turn llm on too; llm on alone says writing stayed off
// and offers it; accounts (0.15.6) says what it reads, and off and on again its count is asked again at once; the
// default connector cannot be turned off; each space of the build's packages (configured offline: its fake service)
// off and on again takes its sidebar button away and back in the other tab. Each card's badges are its modules' types.
// Whatever the list: the packages named here (llm, writing, accounts) are public ones; a package's own card (its
// scope said plainly…) is checked by its scripts (ext/<id>/test/).
const { BASE, SHOTS, TEST_CHAT, check, open, enroll, done, spaces } = require('./lib');

// The page itself.
const shot = (page, name) => page.locator('[data-testid=settings-extensions]').screenshot({ path: `${SHOTS}/${name}.png` });

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`refusing to toggle packages on ${BASE}: offline instances only`);
  process.exit(2);
}

const state = (page, id) => page.getAttribute(`[data-testid=ext-${id}]`, 'data-state');
async function waitState(page, id, want, ms = 10000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await page.waitForTimeout(100)) if ((await state(page, id)) === want) return true;
  return false;
}
async function waitVisible(page, sel, visible, ms = 10000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await page.waitForTimeout(100)) if ((await page.isVisible(sel)) === visible) return true;
  return false;
}
const serverOn = (page) => page.evaluate(async () => (await (await fetch('/api/extensions')).json()).packages.filter((p) => p.active).map((p) => p.id).sort().join(','));

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  await page.addInitScript(() => localStorage.setItem('lang', 'fr'));
  await enroll(page);

  // Another tab of the same device, on the test chat: what it shows must follow the switches without a reload.
  const other = await s.ctx.newPage();
  await other.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
  await other.waitForSelector('[data-testid=composer-input]');
  check(await waitVisible(other, '[data-testid=assist-btn]', true), 'other tab: ✨ there (writing on)');
  // The spaces of the build's packages: their buttons there.
  const sps = await spaces(page);
  for (const sp of sps) check(await waitVisible(other, `[data-testid=open-${sp.id}]`, true), `other tab: the ${sp.id} button there`);
  // Accounts (Settings → Networks since accounts 1.2): no button; what the other tab asks of the package (the count
  // behind the Settings dot, none offline: no account in trouble).
  const asked = [];
  other.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/networks/overview') asked.push(r.method());
  });

  // A third tab on writing's page (Langues de traduction): it must give way to the menu when writing goes off.
  const third = await s.ctx.newPage();
  await third.goto(`${BASE}/settings/ext/writing/langs`);
  await third.waitForSelector('.pane-chat [data-testid=settings-langs]', { timeout: 15000 });

  await page.goto(`${BASE}/settings/extensions`);
  await page.waitForSelector('[data-testid=settings-extensions] [data-testid=extensions]', { timeout: 15000 });
  const menu = () => page.$$eval('[data-testid=settings-menu] a', (a) => a.map((x) => x.dataset.testid.replace('settings-item-', '')).join(','));
  const entries = (await menu()).split(',');
  check(
    entries.slice(0, 5).join(',') === 'general,reading,quiet,app,extensions' && ['accounts-networks', 'llm-providers', 'llm-models', 'writing-langs'].every((e) => entries.includes(e)) && entries.indexOf('llm-models') < entries.indexOf('writing-langs'),
    `menu: the core's five entries, then the packages' pages, accounts', llm's and writing's among them (${entries.join(',')})`,
  );
  check((await page.textContent('[data-testid=settings-pkg-writing] .space-group')) === 'Aide à l’écriture', "writing's page under the package's name");
  const ids = await page.$$eval('[data-testid=extensions] article', (a) => a.map((x) => x.dataset.testid.replace(/^ext-/, '')));
  const built = await page.evaluate(async () => (await (await fetch('/api/extensions')).json()).packages.map((p) => p.id));
  check(ids.join(',') === built.join(',') && ids.includes('beeper'), `every package of the build, in declared order (${ids.join(',')})`);
  check((await page.textContent('.pane-chat .settings-title')) === 'Gérer les extensions', 'titled "Gérer les extensions"');
  // Each card as the server describes its package: state, version, a description, its modules.
  const server = await page.evaluate(async () => (await (await fetch('/api/extensions/details')).json()));
  check(ids.join(',') === server.packages.map((p) => p.id).join(','), "the cards in the server's order");
  for (const p of server.packages) {
    const card = `[data-testid=ext-${p.id}]`;
    check(
      (await page.getAttribute(card, 'data-state')) === p.state &&
        (await page.textContent(`[data-testid=ext-version-${p.id}]`)) === p.version &&
        !!(await page.textContent(`${card} .ext-desc`))?.trim() &&
        (await page.$$(`${card} [data-testid=ext-badge]`)).length === p.modules.length,
      `${p.id}: state, version, description and modules as the server has them`,
    );
  }
  check(/API d’extension 1\.\d+\.\d+/.test(await page.textContent('[data-testid=ext-api]')), 'the extension API version');
  check((await page.textContent('[data-testid=ext-version-writing]')) === '1.2.0', 'a package version');
  check(/Modèles de langage \^1\.2 ✓/.test(await page.textContent('[data-testid=ext-requires-writing]')), 'writing: requires llm (by its name) ^1.2 ✓');
  check(/Aide à l’écriture/.test(await page.textContent('[data-testid=ext-requiredby-llm]')), 'llm: required by writing help');
  const badges = (id) => page.$$eval(`[data-testid=ext-${id}] [data-testid=ext-badge]`, (b) => b.map((x) => x.textContent).join(','));
  const TYPE = { connector: 'connecteur', space: 'espace', augmentation: 'augmentation', provider: 'fournisseur' };
  for (const p of server.packages) {
    const want = p.modules.map((m) => TYPE[m.type]).join(',');
    check((await badges(p.id)) === want, `${p.id}: its modules' badges (${want})`);
  }
  check((await badges('beeper')) === 'connecteur' && (await badges('llm')) === 'fournisseur', 'connector and provider badges');
  check((await page.textContent('[data-testid=ext-scope-writing]')).includes('seulement quand vous le demandez'), "writing: 'on-demand' said plainly");
  check((await page.textContent('[data-testid=ext-reads-accounts]')).includes('lit vos comptes'), 'accounts: what it reads, said plainly');

  // The default connector stays; each space's package, configured (its fake service), can be switched.
  check(await page.isDisabled('[data-testid=ext-toggle-beeper]'), 'beeper: switch disabled');
  check((await page.textContent('[data-testid=ext-why-beeper]')).includes('source de discussions par défaut'), 'beeper: why it stays');
  for (const sp of sps) check((await state(page, sp.pkg)) === 'on' && !(await page.isDisabled(`[data-testid=ext-toggle-${sp.pkg}]`)), `${sp.pkg}: on, its switch enabled`);
  const allOn = await serverOn(page);
  // ✨ is writing's, and that of any other package with an on-demand augmentation (its entries in the composer's
  // menu): with one of those on, the button stays when writing goes.
  const sparkleStays = server.packages.some((p) => !['writing', 'llm'].includes(p.id) && p.modules.some((m) => m.type === 'augmentation' && m.scope === 'on-demand'));
  await shot(page, 'extensions-desktop');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'extensions-desktop-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // writing off: no question (nothing requires it); live in the other tab.
  await page.click('[data-testid=ext-toggle-writing]');
  check(await waitState(page, 'writing', 'disabled'), 'writing: turned off');
  check((await page.getAttribute('[data-testid=ext-toggle-writing]', 'aria-checked')) === 'false', 'its switch shows off');
  check(await waitVisible(other, '[data-testid=assist-btn]', sparkleStays), `other tab: ✨ ${sparkleStays ? 'stays for the other packages' : 'gone'} without a reload`);
  check(await waitVisible(page, '[data-testid=settings-item-writing-langs]', false), 'menu: Langues de traduction gone with writing');
  check(await page.isVisible('[data-testid=settings-item-llm-models]'), "menu: llm's pages stay (llm still on)");
  let back = false;
  for (const t0 = Date.now(); !back && Date.now() - t0 < 10000; await third.waitForTimeout(100)) back = (await third.evaluate(() => location.pathname)) === '/settings';
  check(back, "third tab: writing's open page gives way to the menu");
  check(!(await third.$('[data-testid=settings-langs]')), 'third tab: its page is gone');
  check((await serverOn(page)) === allOn.split(',').filter((id) => id !== 'writing').join(','), 'server: writing off');
  await page.click('[data-testid=ext-toggle-writing]');
  check(await waitState(page, 'writing', 'on'), 'writing: on again');
  check(await waitVisible(other, '[data-testid=assist-btn]', true), 'other tab: ✨ back without a reload');
  check(await waitVisible(page, '[data-testid=settings-item-writing-langs]', true), 'menu: Langues de traduction back');
  check(await waitVisible(third, '[data-testid=settings-item-writing-langs]', true), 'third tab: in its menu too');

  // llm off: asks first, naming what goes with it; Cancel changes nothing.
  await page.click('[data-testid=ext-toggle-llm]');
  await page.waitForSelector('[data-testid=ext-confirm-llm]');
  const ask = await page.textContent('[data-testid=ext-confirm-llm] [data-testid=ext-confirm-text]');
  check(/Désactiver Modèles de langage désactive aussi : Aide à l’écriture/.test(ask), `cascade named (${ask})`);
  await shot(page, 'extensions-cascade');
  await page.click('[data-testid=ext-confirm-cancel]');
  check((await state(page, 'llm')) === 'on' && (await state(page, 'writing')) === 'on', 'Cancel: nothing changed');
  await page.click('[data-testid=ext-toggle-llm]');
  await page.click('[data-testid=ext-confirm-llm] [data-testid=ext-confirm-ok]');
  check(await waitState(page, 'llm', 'disabled'), 'llm: off');
  check(await waitState(page, 'writing', 'disabled'), 'writing: off with it');
  check(await waitVisible(other, '[data-testid=assist-btn]', sparkleStays), `other tab: ✨ ${sparkleStays ? 'stays for the other packages' : 'gone'}`);
  check(await waitVisible(page, '[data-testid=settings-item-llm-providers]', false), "menu: llm's pages gone with it");

  // writing on: offers to turn llm on too.
  await page.click('[data-testid=ext-toggle-writing]');
  await page.waitForSelector('[data-testid=ext-confirm-writing]');
  const offer = await page.textContent('[data-testid=ext-confirm-writing] [data-testid=ext-confirm-text]');
  check(/Pour activer Aide à l’écriture, il faut aussi activer : Modèles de langage/.test(offer) && (await page.textContent('[data-testid=ext-confirm-writing] [data-testid=ext-confirm-ok]')) === 'Activer les deux', `offers both (${offer})`);
  await page.click('[data-testid=ext-confirm-writing] [data-testid=ext-confirm-ok]');
  check((await waitState(page, 'llm', 'on')) && (await waitState(page, 'writing', 'on')), 'both on');
  check(await waitVisible(other, '[data-testid=assist-btn]', true), 'other tab: ✨ back');

  // llm off again, then on alone: writing stays off (the choice is kept) and the page says so, offering it.
  await page.click('[data-testid=ext-toggle-llm]');
  await page.click('[data-testid=ext-confirm-llm] [data-testid=ext-confirm-ok]');
  check(await waitState(page, 'writing', 'disabled'), 'llm off again, writing with it');
  await page.click('[data-testid=ext-toggle-llm]');
  check(await waitState(page, 'llm', 'on'), 'llm on alone');
  check((await state(page, 'writing')) === 'disabled', 'writing stays off');
  await page.waitForSelector('[data-testid=ext-offer-llm]');
  const still = await page.textContent('[data-testid=ext-offer-llm] [data-testid=ext-offer-text]');
  check(still === 'Toujours à l’arrêt : Aide à l’écriture. L’activer aussi ?', `offers what stayed off (${still})`);
  await shot(page, 'extensions-offer');
  await page.click('[data-testid=ext-offer-llm] [data-testid=ext-offer-ok]');
  check(await waitState(page, 'writing', 'on'), 'writing on from the offer');
  check(await waitVisible(other, '[data-testid=assist-btn]', true), 'other tab: ✨ back again');

  // accounts off: the polling of its count stops in the other tab; on again, the count is asked at once.
  await page.click('[data-testid=ext-toggle-accounts]');
  check(await waitState(page, 'accounts', 'disabled'), 'accounts: off');
  const before = asked.length;
  await page.click('[data-testid=ext-toggle-accounts]');
  check(await waitState(page, 'accounts', 'on'), 'accounts: on again');
  for (const t0 = Date.now(); asked.length === before && Date.now() - t0 < 10000; ) await other.waitForTimeout(100);
  check(asked.length > before && asked.every((m) => m === 'GET'), `other tab: its count asked again at once (${asked.length - before})`);
  // Each space's package off: its sidebar button leaves the other tab (and the buttons of what goes with it); on
  // again, with what it took along.
  for (const sp of sps) {
    check(await other.isVisible(`[data-testid=open-${sp.id}]`), `other tab: the ${sp.id} button there`);
    await page.click(`[data-testid=ext-toggle-${sp.pkg}]`);
    if (await page.waitForSelector(`[data-testid=ext-confirm-${sp.pkg}]`, { timeout: 1500 }).then(() => true, () => false)) await page.click(`[data-testid=ext-confirm-${sp.pkg}] [data-testid=ext-confirm-ok]`);
    check(await waitState(page, sp.pkg, 'disabled'), `${sp.pkg}: off`);
    check(await waitVisible(other, `[data-testid=open-${sp.id}]`, false), `other tab: the ${sp.id} button gone`);
    await page.click(`[data-testid=ext-toggle-${sp.pkg}]`);
    if (await page.waitForSelector(`[data-testid=ext-confirm-${sp.pkg}]`, { timeout: 1500 }).then(() => true, () => false)) await page.click(`[data-testid=ext-confirm-${sp.pkg}] [data-testid=ext-confirm-ok]`);
    check(await waitState(page, sp.pkg, 'on'), `${sp.pkg}: on again`);
    check(await waitVisible(other, `[data-testid=open-${sp.id}]`, true), `other tab: the ${sp.id} button back`);
  }
  check((await serverOn(page)) === allOn, 'server: everything back on');

  // Phone width: one column, the switch within reach (the page over the menu).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForSelector('[data-testid=ext-toggle-writing]', { timeout: 15000 });
  await page.waitForTimeout(300);
  const box = await page.locator('[data-testid=ext-toggle-writing]').boundingBox();
  check(!!box && box.x + box.width <= 390, 'phone: the switch fits');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'phone: no horizontal scroll');
  await shot(page, 'extensions-phone');

  check(s.blocked.length === 0, `nothing blocked by the guard (${s.blocked.join(', ')})`);
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
