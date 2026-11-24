// Pause and resume of a scheduled task from Automations (agents 3.2, hermes 2.2: capability jobsControl), on the hermes
// fake's tasks (ext/hermes/test/offline.mjs): "Veille du matin" (scheduled) and "Rapport hebdo" (paused) on default,
// "Récap mails" on assistant. Pause: a confirmation naming the task and its effect, the row paused at once, a toast,
// one POST /api/jobs/<id>/pause without a body upstream, still paused after a reload; cancelled: nothing sent;
// resume: back to scheduled; a failure upstream: the row put back and an error toast. Run, edit and removal stay
// refused. Without the capability (POST /__hermes-jobs-control "off"): no button, the server refuses (403). Phone
// width: the buttons fit. Screenshots light and dark.
// sh web/test/e2e/run-offline.sh ../../ext/agents/test/agentjobs.e2e.cjs
const { BASE, check, step, open, enroll, shot, done } = require('../../../test/e2e/lib');

const injectURL = process.env.INJECT_URL;
const hooks = injectURL && injectURL.replace(/inject$/, '');
const VEILLE = 'a1b2c3d4e5f6';
const HEBDO = 'b2c3d4e5f6a1';

(async () => {
  if (!hooks) {
    console.log('     offline only (no INJECT_URL): skipped');
    return done([]);
  }
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  const online = () => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true });
  await s.ctx.addInitScript(online);
  const api = (method, path, body) =>
    page.evaluate(
      async ([m, p, b]) => {
        const r = await fetch(`/api${p}`, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
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
  // Polled in the page (page.waitForFunction evaluates a string: refused by the app's CSP).
  const until = async (fn, arg, label, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await page.evaluate(fn, arg).catch(() => false)) return;
      await page.waitForTimeout(150);
    }
    throw new Error(`timeout: ${label}`);
  };
  const controls = async () => (await (await fetch(`${hooks}calls`)).json()).hermesJobControls ?? [];
  const hook = (name, body = '') => fetch(`${hooks}${name}`, { method: 'POST', body });
  const row = (id) => `[data-testid=agents-job][data-id="${id}"]`;
  const stateOf = (id) => page.getAttribute(row(id), 'data-state');
  const waitState = (id, st) => page.waitForSelector(`${row(id)}[data-state="${st}"]`, { timeout: 8000 });
  // The confirmation: its text kept, accepted or dismissed as asked.
  let answer = true;
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void (answer ? d.accept() : d.dismiss());
  });

  try {
    await enroll(page);
    if ((await page.evaluate(async () => (await fetch('/api/agents/agents')).status)) !== 200) {
      console.log('     skipped: no runtime keeps conversations in this build (no Agents space)');
      return done();
    }
    const listed = (await api('GET', '/agents/jobs')).json.jobs;
    check(listed.length === 3 && listed.every((j) => j.controllable === true), 'the API lists 3 tasks, each controllable');

    await page.goto(`${BASE}/agents/automations`);
    await page.waitForSelector(row(VEILLE));
    const toggles = await page.$$eval('[data-testid=agents-job]', (els) => els.map((e) => [e.dataset.id, e.querySelector('[data-testid=agents-job-toggle]')?.textContent ?? null]));
    check(toggles.length === 3 && toggles.every(([, t]) => t), 'one toggle per task');
    check((await page.textContent(`${row(VEILLE)} [data-testid=agents-job-toggle]`)) === 'Pause', 'scheduled task: « Pause »');
    check((await page.textContent(`${row(HEBDO)} [data-testid=agents-job-toggle]`)) === 'Reprendre', 'paused task: « Reprendre »');
    check((await page.textContent('.agents-auto-hint')).includes('mettre en pause'), 'the hint says they can be paused here');
    check((await page.$$('[data-testid=agents-automations] button')).length === 4, 'no other button than back and the toggles (no run, edit or delete)');
    await shot(page, 'agentjobs-list');

    // Cancelled: nothing sent, nothing changed.
    answer = false;
    await page.click(`${row(VEILLE)} [data-testid=agents-job-toggle]`);
    await page.waitForTimeout(300);
    check(dialogs.length === 1 && (await stateOf(VEILLE)) === 'scheduled' && (await controls()).length === 0, 'confirmation cancelled: nothing sent');
    answer = true;

    // Pause.
    await page.click(`${row(VEILLE)} [data-testid=agents-job-toggle]`);
    await waitState(VEILLE, 'paused');
    const pauseMsg = dialogs.at(-1);
    check(pauseMsg.includes('Veille du matin') && pauseMsg.includes('pause') && pauseMsg.includes('alertes'), `the confirmation names the task and the effect (${pauseMsg})`);
    await page.waitForSelector('[data-testid=toast]');
    check((await page.textContent('[data-testid=toast]')).includes('Veille du matin'), 'toast: paused');
    await until((sel) => document.querySelector(sel)?.textContent === 'Reprendre', `${row(VEILLE)} [data-testid=agents-job-toggle]`, 'Reprendre');
    let c = await controls();
    check(c.length === 1 && c[0].profile === 'default' && c[0].id === VEILLE && c[0].action === 'pause' && c[0].body === false, `one pause upstream, no body (${JSON.stringify(c)})`);
    await shot(page, 'agentjobs-paused');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'agentjobs-paused-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await waitState(VEILLE, 'paused');
    step('still paused after a reload');

    // Resume.
    await page.click(`${row(VEILLE)} [data-testid=agents-job-toggle]`);
    await waitState(VEILLE, 'scheduled');
    check(dialogs.at(-1).includes('Reprendre « Veille du matin »'), 'resume confirmation names the task');
    c = await controls();
    check(c.length === 2 && c[1].action === 'resume' && c[1].id === VEILLE, 'one resume upstream');

    // The other agent's task, resumed then paused again.
    await page.click(`${row(HEBDO)} [data-testid=agents-job-toggle]`);
    await waitState(HEBDO, 'scheduled');
    await page.click(`${row(HEBDO)} [data-testid=agents-job-toggle]`);
    await waitState(HEBDO, 'paused');
    step('a paused task resumed and paused again');

    // A failure upstream: shown at once, then put back, with an error toast.
    await hook('hermes-jobs-fail');
    await page.click(`${row(VEILLE)} [data-testid=agents-job-toggle]`);
    await until((sel) => !!document.querySelector(sel)?.textContent?.includes('pas pu'), '[data-testid=toast]', 'error toast');
    await waitState(VEILLE, 'scheduled');
    step('upstream failure: rolled back, error toast');

    // Never run, edited or removed; nobody else's ids.
    const before = (await controls()).length;
    for (const [m, p, b, want] of [
      ['POST', `/agents/jobs/${VEILLE}/run`, { agent: 'default' }, 404],
      ['PATCH', `/agents/jobs/${VEILLE}`, { agent: 'default', name: 'x' }, 404],
      ['DELETE', `/agents/jobs/${VEILLE}`, undefined, 404],
      ['POST', `/agents/jobs/${VEILLE}/pause`, { agent: 'assistant' }, 404],
      ['POST', `/agents/jobs/${VEILLE}/pause`, { agent: 'default', prompt: 'x' }, 400],
    ]) {
      const r = await api(m, p, b);
      check(r.status === want, `${m} ${p} ${JSON.stringify(b)}: ${r.status}`);
    }
    check((await controls()).length === before, 'none of them reached Hermes');

    // Phone width: the buttons fit.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const fit = await page.$$eval('[data-testid=agents-job-toggle]', (els) => els.every((e) => e.getBoundingClientRect().right <= window.innerWidth && e.getBoundingClientRect().height >= 32));
    check(fit && (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)), 'phone: toggles fit, no horizontal overflow');
    await shot(page, 'agentjobs-phone');
    await page.setViewportSize({ width: 1280, height: 800 });

    // Without the capability: read-only again, and refused by the server.
    await hook('hermes-jobs-control', 'off');
    await page.reload();
    await page.waitForSelector(row(VEILLE));
    check(!(await page.$('[data-testid=agents-job-toggle]')), 'capability off: no toggle');
    check(!(await page.textContent('.agents-auto-hint')).includes('mettre en pause'), 'capability off: the read-only hint');
    const n = (await controls()).length;
    const refused = await api('POST', `/agents/jobs/${VEILLE}/pause`, { agent: 'default' });
    check(refused.status === 403 && refused.json?.error === 'not_supported', `capability off: 403 not_supported (${refused.status})`);
    check((await controls()).length === n, 'capability off: nothing sent');
    await hook('hermes-jobs-control', 'on');
    check(s.blocked.length === 0, `no write to a real chat (${s.blocked.join(', ') || 'none'})`);
  } catch (e) {
    console.log('FAIL exception', e);
    check(false, 'exception');
    await shot(page, 'agentjobs-error').catch(() => {});
  } finally {
    await s.browser.close();
  }
  done(s.csp);
})();
