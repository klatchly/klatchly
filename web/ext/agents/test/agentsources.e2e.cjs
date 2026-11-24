// Conversations started elsewhere, the Filter sheet and Automations (agents 3.1, hermes 2.1), on the hermes fake's
// sessions of several sources (ext/hermes/test/offline.mjs): Telegram, WhatsApp, a terminal session (hidden until the
// filter shows it), an extra source, scheduled runs (never listed) and three scheduled tasks. Desktop: the one control
// row, cleaned titles, source badges, the Filter sheet (sources, unread only), a read-only conversation (no composer,
// the server refuses a send, the read mark goes back to Hermes), « Continuer dans Klatchly » (a Klatchly conversation that
// starts with its context), Automations (never a prompt; pause / resume: agentjobs.e2e.cjs). Phone (390 px, touch): one control row, no
// horizontal overflow, the Filter bottom sheet, the read-only view, /agents/overview. Screenshots light and dark.
// sh web/test/e2e/run-offline.sh ../../ext/agents/test/agentsources.e2e.cjs
const { BASE, check, step, open, enroll, shot, done } = require('../../../test/e2e/lib');

const injectURL = process.env.INJECT_URL;
const hooks = injectURL && injectURL.replace(/inject$/, '');
const TG = 'ext_20261111_084000_7e1a2b';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

(async () => {
  if (!hooks) {
    console.log('     offline only (no INJECT_URL): skipped');
    return done([]);
  }
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  // The instance runs without a network interface: the page would say "offline" in every screenshot.
  const online = () => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true });
  await s.ctx.addInitScript(online);
  const api = (method, path, body) =>
    page.evaluate(
      async ([m, p, b]) => {
        const r = await fetch(`/api${p}`, { method: m, headers: b ? { 'content-type': 'application/json', 'x-requested-with': 'klatchly' } : { 'x-requested-with': 'klatchly' }, body: b ? JSON.stringify(b) : undefined });
        let json = null;
        try {
          json = await r.json();
        } catch {
          /* empty */
        }
        return { status: r.status, json };
      },
      [method, path, body],
    );
  const until = async (fn, arg, timeout, label) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await page.evaluate(fn, arg).catch(() => false)) return true;
      await page.waitForTimeout(200);
    }
    throw new Error(`timeout: ${label}`);
  };
  const rows = () => page.$$eval('[data-testid=agent-conv-row]', (els) => els.map((e) => ({ id: e.dataset.sessionId, source: e.dataset.source, title: e.querySelector('[data-testid=agent-conv-title]')?.textContent ?? '', preview: e.querySelector('[data-testid=agent-conv-preview]')?.textContent ?? '', unread: !!e.querySelector('[data-testid=agent-conv-unread]') })));
  const noHScroll = (p = page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const readMarks = async () => (await (await fetch(`${hooks}calls`)).json()).hermesReadMarks ?? [];

  try {
    await enroll(page);
    if ((await page.evaluate(async () => (await fetch('/api/agents/agents')).status)) !== 200) {
      console.log('     skipped: no runtime keeps conversations in this build (no Agents space)');
      return done();
    }
    const all = (await api('GET', '/agents/sessions')).json.sessions;
    check(all.some((x) => x.id === TG && x.source === 'telegram' && x.readOnly), 'the API lists the Telegram conversation, read-only');
    check(!all.some((x) => /^ext_local-/.test(x.id) || x.source === 'cron'), 'scheduled runs are never conversations');
    check(!all.some((x) => x.id === 'ext_20261112_070000_0e0e0e'), 'an empty session is not listed');

    // ── Desktop: one control row, cleaned titles, source badges ──
    await page.goto(`${BASE}/agents`);
    await page.waitForSelector('[data-testid=agent-conv-row]');
    check(await page.isVisible('[data-testid=agents-controls] [data-testid=agents-search]'), 'one control row: the search field…');
    check(await page.isVisible('[data-testid=agents-controls] [data-testid=agents-filter-btn]'), '…and the Filter button');
    check(!(await page.$('[data-testid=agents-pane] .agent-fchip')), 'no row of agent chips');
    let r = await rows();
    check(r.some((x) => x.id === TG && x.source === 'telegram'), 'Telegram conversation in the list');
    check(!r.some((x) => x.source === 'cli'), 'terminal sessions hidden by default');
    check(r.some((x) => x.source === 'atelier'), 'a source added by KLATCHLY_HERMES_EXTRA_SOURCES is listed');
    const badge = await page.textContent(`[data-testid=agent-conv-row][data-session-id="${TG}"] [data-testid=agent-conv-source]`);
    check(badge === 'Telegram', `source badge « ${badge} »`);
    check(!(await page.$(`[data-testid=agent-conv-row][data-source=klatchly] [data-testid=agent-conv-source]`)), 'no badge on Klatchly conversations');
    const dinner = r.find((x) => x.source === 'whatsapp');
    check(!!dinner && dinner.title.startsWith('Dîner de samedi') && !dinner.title.includes('🍝'), `title without its leading emoji (« ${dinner && dinner.title} »)`);
    const suffix = await page.$eval('[data-testid=agent-conv-row][data-source=whatsapp] .agent-title-suffix', (e) => [e.textContent, getComputedStyle(e).color]).catch(() => null);
    check(!!suffix && suffix[0] === '#2', `Hermes' « #2 » kept apart (${suffix && suffix.join(', ')})`);
    const untitled = r.find((x) => x.id === 'ext_20261110_190500_c0ffee');
    check(!!untitled && /^Conversation du /.test(untitled.title) && untitled.title !== untitled.preview, `no title: « ${untitled && untitled.title} », not the preview again`);
    check(r.every((x) => !x.title || x.title !== x.preview), 'no row repeats its preview as its title');
    await shot(page, 'agentsources-desktop');

    // ── The Filter sheet: sources (the terminal through it), unread only ──
    await page.click('[data-testid=agents-filter-btn]');
    await page.waitForSelector('[data-testid=agents-filter-sheet]');
    const sources = await page.$$eval('[data-testid=source-filter]', (els) => els.map((e) => [e.dataset.source, e.getAttribute('aria-checked')]));
    check(JSON.stringify(sources.map((x) => x[0])) === JSON.stringify(['klatchly', 'atelier', 'cli', 'telegram', 'whatsapp']), `sources present only (${sources.map((x) => x.join(':')).join(', ')})`);
    check(sources.find((x) => x[0] === 'cli')?.[1] === 'false', 'the terminal unchecked by default');
    await shot(page, 'agentsources-filter');
    await page.click('[data-testid=source-filter][data-source=cli]');
    await page.waitForSelector('[data-testid=agent-conv-row][data-source=cli]');
    check((await page.textContent('[data-testid=agents-filter-btn]')).includes('Filtrer · 1'), 'the button counts it');
    await page.click('[data-testid=source-filter][data-source=telegram]');
    await page.waitForSelector(`[data-testid=agent-conv-row][data-session-id="${TG}"]`, { state: 'detached' });
    step('a source unchecked: its conversations leave the list');
    await page.click('[data-testid=agents-filter-reset]');
    await page.waitForSelector('[data-testid=agent-conv-row][data-source=cli]', { state: 'detached' });
    await page.click('[data-testid=agents-filter-done]');
    check((await page.textContent('[data-testid=agents-filter-btn]')).trim() === 'Filtrer', 'reset: back to « Filtrer »');

    // Search: local, in titles and previews.
    await page.fill('[data-testid=agents-search]', 'colis');
    await until(() => document.querySelectorAll('[data-testid=agent-conv-row]').length === 1, null, 5000, 'search');
    check((await rows())[0].id === TG, 'search « colis »: the Telegram conversation');
    await page.fill('[data-testid=agents-search]', 'zzzz');
    await page.waitForSelector('[data-testid=agents-no-match]');
    await page.fill('[data-testid=agents-search]', '');

    // Unread only: a new Telegram message arrives (Hermes side), the list shows it unread.
    await fetch(`${hooks}inject/hermes-telegram`, { method: 'POST', body: 'Le livreur a appelé.' });
    // The runtime keeps its listing a while (2 s on the offline instance): wait for the refresh it starts after.
    let tgUnread = false;
    for (let i = 0; i < 30 && !tgUnread; i++) {
      tgUnread = (await api('GET', '/agents/sessions')).json.sessions.some((x) => x.id === TG && x.unread > 0);
      if (!tgUnread) await page.waitForTimeout(1000);
    }
    check(tgUnread, 'a new message in a Telegram conversation: unread in Klatchly');
    await page.reload();
    await page.waitForSelector(`[data-testid=agent-conv-row][data-session-id="${TG}"] [data-testid=agent-conv-unread]`);
    await page.click('[data-testid=agents-filter-btn]');
    await page.click('[data-testid=unread-only]');
    await page.click('[data-testid=agents-filter-done]');
    r = await rows();
    check(r.length > 0 && r.every((x) => x.unread), `unread only: ${r.length} row(s), every one unread`);
    await shot(page, 'agentsources-unread');

    // ── A conversation started elsewhere: read-only ──
    await page.click(`[data-testid=agent-conv-row][data-session-id="${TG}"]`);
    await page.waitForSelector('[data-testid=agents-readonly]');
    check(await page.isVisible(`[data-testid=agent-conv-row][data-session-id="${TG}"]`), 'unread only: the open conversation stays in the list');
    check(!(await page.$('[data-testid=agents-input]')), 'no composer');
    check(!(await page.$('[data-testid=agents-more]')), 'no menu (no rename, pin or delete)');
    const banner = await page.textContent('[data-testid=agents-readonly]');
    check(banner.includes('Conversation Telegram · lecture seule') && banner.includes('Continuer dans Klatchly'), `banner « ${banner.slice(0, 60)}… »`);
    await page.waitForSelector('[data-testid=agents-user]');
    check((await page.textContent('[data-testid=agents-messages]')).includes('Le livreur passe demain matin'), 'its history is shown');
    const refused = await api('POST', `/agents/sessions/${TG}/messages`, { text: 'Réponds juste : pong' });
    check(refused.status === 403 && refused.json?.error === 'read_only', `the server refuses a send into it (${refused.status} ${refused.json?.error})`);
    const renamed = await api('PATCH', `/agents/sessions/${TG}`, { title: 'x' });
    check(renamed.status === 403, 'and a rename');
    const marks = await readMarks();
    check(marks.some((m) => m.id === TG.slice(4) && m.unread === false), `opening it tells Hermes it is read (${JSON.stringify(marks)})`);
    await shot(page, 'agentsources-readonly');
    await page.click('[data-testid=agents-filter-btn]');
    await page.click('[data-testid=agents-filter-reset]');
    await page.click('[data-testid=agents-filter-done]');

    // « Continuer dans Klatchly »: a Klatchly conversation that starts with the context, sent by the user.
    await page.click('[data-testid=agents-continue]');
    await until(() => location.pathname === '/agents/new' && new URLSearchParams(location.search).get('from')?.startsWith('ext_'), null, 8000, 'continue route');
    await until(() => (document.querySelector('[data-testid=agents-input]')?.value ?? '').length > 20, null, 8000, 'seeded composer');
    const seed = await page.inputValue('[data-testid=agents-input]');
    check(seed.startsWith('Suite de notre conversation Telegram « Livraison colis » :') && seed.includes('> Moi : ') && seed.includes('Le livreur'), `composer starts with the context (« ${seed.split('\n')[0]} »)`);
    check(!(await page.$(`[data-testid=agent-conv-row][data-session-id="${TG}"] [data-testid=agent-conv-unread]`)), 'the Telegram conversation is read in the list once opened');
    await shot(page, 'agentsources-continue');
    await page.click('[data-testid=agents-send]');
    await until(() => /^\/agents\/klatchly_/.test(location.pathname), null, 15000, 'Klatchly conversation made');
    const made = new URL(page.url()).pathname.slice('/agents/'.length);
    await page.waitForSelector(`[data-testid=agent-conv-row][data-session-id="${made}"]`);
    check(!(await page.$(`[data-testid=agent-conv-row][data-session-id="${made}"] [data-testid=agent-conv-source]`)), 'the new conversation is Klatchly\'s (no source badge)');
    check(await page.isVisible('[data-testid=agents-input]'), 'and it can be written to');
    await page.waitForSelector('[data-testid=agents-assistant]', { timeout: 20000 });
    step('the agent answered in the new conversation');

    // ── Automations ──
    const jobs = await api('GET', '/agents/jobs');
    check(jobs.json.jobs.length === 3 && !JSON.stringify(jobs.json).includes('SECRET') && !JSON.stringify(jobs.json).includes('prompt'), `the API lists 3 tasks, never their prompt`);
    await page.click('[data-testid=agents-automations-row]');
    await page.waitForSelector('[data-testid=agents-job]');
    check(new URL(page.url()).pathname === '/agents/automations', 'Automations: /agents/automations');
    const jobRows = await page.$$eval('[data-testid=agents-job]', (els) => els.map((e) => [e.dataset.state, e.textContent]));
    check(jobRows.length === 3, `${jobRows.length} tasks shown`);
    check(jobRows.some(([st, t]) => st === 'paused' && t.includes('En pause') && t.includes('échec')), 'the paused one says so, and its last run failed');
    check(!(await page.textContent('[data-testid=agents-automations]')).includes('SECRET'), 'no prompt on the page');
    const labels = await page.$$eval('[data-testid=agents-automations] .agents-jobs button', (els) => els.map((e) => e.textContent));
    check(labels.length === 3 && labels.every((t) => t === 'Pause' || t === 'Reprendre'), `only pause / resume, no run, edit or delete (${labels.join(', ')}; agentjobs.e2e.cjs)`);
    await shot(page, 'agentsources-automations');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'agentsources-automations-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // ── Phone ──
    const ctx = await s.browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, userAgent: UA, isMobile: true, hasTouch: true, locale: 'fr-FR', storageState: await s.ctx.storageState() });
    await ctx.addInitScript(() => localStorage.setItem('lang', 'fr'));
    await ctx.addInitScript(online);
    const mp = await ctx.newPage();
    try {
      await mp.goto(`${BASE}/agents`);
      await mp.waitForSelector('[data-testid=agent-conv-row]');
      const [sb, fb] = await Promise.all([mp.$eval('[data-testid=agents-search]', (e) => e.getBoundingClientRect().toJSON()), mp.$eval('[data-testid=agents-filter-btn]', (e) => e.getBoundingClientRect().toJSON())]);
      check(Math.abs(sb.top + sb.height / 2 - (fb.top + fb.height / 2)) < 4 && fb.right <= 390, 'phone: search and Filter on one row, inside the screen');
      check(!(await mp.$('[data-testid=agents-pane] .agent-fchip')), 'phone: no second row of chips');
      check(await noHScroll(mp), 'phone list: no horizontal overflow');
      const over = await mp.$$eval('[data-testid=agent-conv-row]', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
      check(over === 0, `phone: no row wider than the column (${over})`);
      await shot(mp, 'agentsources-phone-list');
      await mp.emulateMedia({ colorScheme: 'dark' });
      await shot(mp, 'agentsources-phone-list-dark');
      await mp.emulateMedia({ colorScheme: 'light' });
      await mp.tap('[data-testid=agents-filter-btn]');
      await mp.waitForSelector('[data-testid=agents-filter-sheet].sheet');
      await mp.waitForTimeout(350);
      check(await noHScroll(mp), 'phone: the Filter sheet fits');
      await shot(mp, 'agentsources-phone-sheet');
      await mp.emulateMedia({ colorScheme: 'dark' });
      await shot(mp, 'agentsources-phone-sheet-dark');
      await mp.emulateMedia({ colorScheme: 'light' });
      await mp.tap('[data-testid=agents-filter-done]');
      await mp.tap('[data-testid=agents-home-row]');
      await mp.waitForSelector('[data-testid=agents-home]', { state: 'visible' });
      check(new URL(mp.url()).pathname === '/agents/overview', 'phone: the agents home is /agents/overview');
      await mp.goto(`${BASE}/agents/${TG}`);
      await mp.waitForSelector('[data-testid=agents-readonly]');
      await mp.waitForTimeout(400);
      check(await noHScroll(mp), 'phone read-only view: no horizontal overflow');
      const btn = await mp.$eval('[data-testid=agents-continue]', (e) => e.getBoundingClientRect().toJSON());
      check(btn.right <= 390 && btn.height >= 36, 'phone: « Continuer dans Klatchly » fits and is easy to tap');
      await shot(mp, 'agentsources-phone-readonly');
      await mp.emulateMedia({ colorScheme: 'dark' });
      await shot(mp, 'agentsources-phone-readonly-dark');
    } finally {
      await ctx.close();
    }
    check(s.blocked.length === 0, `no write to a real chat (${s.blocked.join(', ') || 'none'})`);
  } catch (e) {
    console.log('FAIL exception', e);
    check(false, 'exception');
    await shot(page, 'agentsources-error').catch(() => {});
  } finally {
    await s.browser.close();
  }
  done(s.csp);
})();
