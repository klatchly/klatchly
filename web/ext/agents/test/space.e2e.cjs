// Hermes chat (0.9.0, agents space since 0.12.0): header button, Hermes view, a harmless turn streamed over SSE through Caddy (« Réponds
// juste : pong »), an approval card answered « Refuser » (a chmod on a file that does not exist, denied: nothing
// runs), the message Hermes sent with `hermes send -t klatchly` shown once (not twice with its mirrored copy), phone
// width, no CSP violation. Never touches a real chat (lib.js guard). Deletes the Hermes conversations it
// created. Offline (ext/hermes/test/offline.mjs) the inbound message is posted before every script; on a real
// Hermes, send one first (`hermes send -t klatchly "Test klatchly 0.9.0 …"`) or that part is skipped.
// sh web/test/e2e/run-offline.sh ../../ext/agents/test/space.e2e.cjs
const { check, step, open, enroll, logout, shot, done } = require('../../../test/e2e/lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page, ctx } = s;
  const api = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const r = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json().catch(() => null) };
      },
      { method, path, body },
    );
  const sse = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/agents/runs/') && r.url().endsWith('/events')) sse.push({ status: r.status(), type: r.headers()['content-type'] || '' });
  });
  const created = new Set();
  const sessionInUrl = () => /\/agents\/(klatchly_[0-9a-f_]+)$/.exec(new URL(page.url()).pathname)?.[1];
  // Polls with page.evaluate (Playwright's own polling evaluates strings: refused by the app's CSP).
  const until = async (fn, arg, timeout, label) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await page.evaluate(fn, arg).catch(() => false)) return true;
      await page.waitForTimeout(250);
    }
    throw new Error(`timeout: ${label}`);
  };
  const lastAssistant = () => page.$$eval('[data-testid=agents-assistant]', (els) => (els.at(-1)?.textContent ?? '').trim());

  try {
    await enroll(page);
    // Needs a runtime that keeps conversations (the Agents space: Hermes, as the offline fake of the hermes package);
    // a build without one has no space and these agents (ext/agents/test/llmagent.e2e.cjs covers that case).
    if ((await page.evaluate(async () => (await fetch('/api/agents/agents')).status)) !== 200) {
      console.log('     skipped: no runtime keeps conversations in this build (no Agents space)');
      return done();
    }
    const status = (await api('GET', '/agents/status')).json;
    check(status?.enabled === true, 'the space is enabled on the server');
    const before = new Set(((await api('GET', '/agents/sessions')).json?.sessions ?? []).map((x) => x.id));

    // Header: the Agents button next to the low-priority / archive ones.
    const order = await page.$$eval('.list-header [data-testid]', (els) => els.map((e) => e.dataset.testid));
    check(order.includes('open-agents') && order.indexOf('open-agents') < order.indexOf('open-archives'), `Agents button in the header (${order.join(',')})`);
    await page.click('[data-testid=open-agents]');
    await page.waitForSelector('[data-testid=agents-pane]');
    check(new URL(page.url()).pathname === '/agents', 'opens the agents space (/agents)');
    // Renamed in agents 3.0: the old paths are no longer served (no page, no API, no redirect).
    const old = await page.evaluate(async () => Promise.all(['/hermes', '/hermes/new', '/api/hermes/status', '/api/hermes/sessions'].map(async (u) => (await fetch(u, { redirect: 'manual' })).status)));
    check(old.every((st) => st === 404), `/hermes and /api/hermes/* not served (${old.join(',')})`);
    await shot(page, 'agents-open');

    // Not exposed: other sessions, cron jobs, the raw api_server.
    check((await api('GET', '/agents/sessions/20260608_001827_4d6da4/messages')).status === 404, 'a raw Hermes session id is not readable (only "ext_…" of a listed one)');
    check((await api('GET', '/agents/sessions/ext_api_1793275455_772c09d4/messages')).status === 404, 'another api_server client\'s session is not readable');
    check((await api('POST', '/agents/jobs/a1b2c3d4e5f6/run', {})).status === 404, 'scheduled tasks are only listed (no run, pause or resume)');
    check((await api('GET', '/jobs')).status === 404, '/api/jobs does not exist');

    // A new conversation, one harmless turn.
    await page.click('[data-testid=agents-new]');
    // Several agents up: the picker asks which one (Hermes = the default profile).
    if (await page.waitForSelector('[data-testid=agent-picker]', { timeout: 1500 }).catch(() => null)) await page.click('[data-testid=agent-picker-default]');
    await page.waitForSelector('[data-testid=agents-view]');
    await page.fill('[data-testid=agents-input]', 'Réponds juste : pong');
    const t0 = Date.now();
    await page.click('[data-testid=agents-send]');
    await page.waitForSelector('[data-testid=agents-pending], [data-testid=agents-user]', { timeout: 15000 });
    await until(() => /\/agents\/klatchly_/.test(location.pathname), null, 15000, 'wait');
    const sid = sessionInUrl();
    if (sid) created.add(sid);
    check(!!sid && !before.has(sid), `new conversation ${sid}`);
    await page.waitForSelector('[data-testid=agents-live]', { timeout: 20000 });
    const liveSeen = Date.now() - t0;
    await until(() => [...document.querySelectorAll('[data-testid=agents-assistant]')].some((e) => /pong/i.test(e.textContent)), null, 120000, 'wait');
    console.log(`     live bubble after ${liveSeen} ms, reply after ${Date.now() - t0} ms`);
    check(/pong/i.test(await lastAssistant()), `Hermes answered « ${await lastAssistant()} »`);
    check(sse.length > 0 && sse.every((x) => x.status === 200 && x.type.startsWith('text/event-stream')), `SSE through Caddy: ${JSON.stringify(sse)}`);
    check((await page.$$('[data-testid=agents-user]')).length === 1 && !(await page.$('[data-testid=agents-pending]')), 'the sent message shows once');
    const listed = (await api('GET', '/agents/sessions')).json;
    check(listed?.main === sid, 'the conversation is the current one ("main")');
    await shot(page, 'agents-pong');

    // Approval: a flagged command that cannot do anything (the file does not exist), refused.
    await page.fill(
      '[data-testid=agents-input]',
      "Test de l'interface d'autorisation. Lance exactement cette commande avec l'outil terminal : chmod 777 /tmp/klatchly-approval-test-inexistant . " +
        "Si elle est refusée, n'essaie rien d'autre et réponds juste : refusé.",
    );
    const answers = (await page.$$('[data-testid=agents-assistant]')).length;
    await page.click('[data-testid=agents-send]');
    const card = await page.waitForSelector('[data-testid=agents-approval]', { timeout: 90000 }).catch(() => null);
    if (card) {
      const txt = (await card.textContent()) || '';
      check(/Autoriser/.test(txt) && /Refuser/.test(txt) && /expire dans/.test(txt), 'approval card with Autoriser / Refuser and the countdown');
      check(/chmod/.test(txt), 'the card shows the command');
      await shot(page, 'agents-approval');
      await page.click('[data-testid=agents-deny]');
      await page.waitForSelector('[data-testid=agents-approval]', { state: 'detached', timeout: 15000 });
      step('card gone after Refuser');
      await page.waitForSelector('[data-testid=agents-send]', { timeout: 120000 });
      await until((n) => document.querySelectorAll('[data-testid=agents-assistant]').length > n, answers, 15000, 'answer after the deny');
      console.log(`     after deny: « ${(await lastAssistant()).slice(0, 120)} »`);
    } else {
      console.log('SKIP no approval request (the model did not run the command)');
      await page.waitForSelector('[data-testid=agents-send]', { timeout: 120000 }).catch(() => {});
    }

    // The message Hermes sent with `hermes send -t klatchly`: shown once, as a message from Hermes.
    const all = (await api('GET', '/agents/sessions')).json?.sessions ?? [];
    const inbound = all.find((x) => (x.preview || '').startsWith('Test klatchly 0.9.0'));
    if (inbound) {
      await page.goto(`${new URL(page.url()).origin}/agents/${inbound.id}`);
      await page.waitForSelector('[data-testid=agents-inbound]', { timeout: 15000 });
      const n = await page.$$eval('[data-testid=agents-inbound]', (els) => els.filter((e) => e.textContent.includes('Test klatchly 0.9.0')).length);
      const users = await page.$$eval('[data-testid=agents-user]', (els) => els.filter((e) => /\[(?:Klatchly|beep) delivery\]/.test(e.textContent)).length); // [beep delivery]: copies stored before 0.26.0
      check(n === 1 && users === 0, `message from Hermes shown once (inbound ${n}, mirrored copies shown ${users})`);
      await shot(page, 'agents-inbound');
    } else console.log('SKIP no inbound test message found');

    // Phone width: the Hermes view takes the screen, composer reachable, no horizontal scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${new URL(page.url()).origin}/agents/${sid}`);
    await page.waitForSelector('[data-testid=agents-view]');
    const box = await page.$eval('[data-testid=agents-view]', (e) => e.getBoundingClientRect().width);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const composer = await page.isVisible('[data-testid=agents-input]');
    check(box >= 385 && !overflow && composer, `phone: full width (${Math.round(box)} px), no horizontal scroll, composer visible`);
    await shot(page, 'agents-phone');
    await page.click('[data-testid=agents-back]');
    // The agents list stays underneath on a phone: wait for the route, not for the element.
    check(await until(() => location.pathname === '/agents', null, 5000, 'back').catch(() => false), 'back to the agents list');
    await page.click('[data-testid=tab-chats]');
    await page.waitForSelector('[data-testid=chat-row]');
    check(new URL(page.url()).pathname === '/', 'then back to the chat list');
    await page.setViewportSize({ width: 1200, height: 800 });

    // Delete from the UI (the test conversation).
    await page.goto(`${new URL(page.url()).origin}/agents/${sid}`);
    await page.waitForSelector('[data-testid=agents-more]');
    await page.click('[data-testid=agents-more]');
    await page.click('[data-testid=agents-menu-delete]');
    await page.click('[data-testid=agents-confirm-delete-yes]');
    await until(() => location.pathname === '/agents', null, 15000, 'wait');
    const after = ((await api('GET', '/agents/sessions')).json?.sessions ?? []).map((x) => x.id);
    check(!after.includes(sid), 'conversation deleted from the UI');
    created.delete(sid);
    check(s.blocked.length === 0, `no write to a real chat (${s.blocked.join(', ') || 'none'})`);
  } catch (e) {
    console.log('FAIL exception', e);
    check(false, 'exception');
    await shot(page, 'agents-error').catch(() => {});
  } finally {
    for (const id of created) {
      // A turn still running refuses the delete (409): stop it, then retry for up to 2 minutes.
      let r = { status: 0 };
      for (let i = 0; i < 60; i++) {
        r = await api('DELETE', `/agents/sessions/${id}`).catch(() => ({ status: 0 }));
        if (r.status !== 409) break;
        if (i === 0) {
          const m = (await api('GET', `/agents/sessions/${id}/messages`)).json;
          if (m?.run) await api('POST', `/agents/runs/${m.run}/stop`, {});
        }
        await page.waitForTimeout(2000);
      }
      console.log(`     cleanup ${id}: ${r.status}`);
    }
    await logout(page);
    await ctx.browser().close();
  }
  done(s.csp);
})();
