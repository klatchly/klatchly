// Agents space (0.12.0): the Hermes button swaps the left column for the agents list (agents = Hermes profiles),
// "Discussions" goes back; new conversation from an agent card (agents home, 0.14.7); a harmless turn (« Réponds juste : pong »);
// rename in place (tap the title) and from the row menu (right click); pin; per-profile routing seen through the
// API; the same on a phone width (list -> conversation -> back). Every agent that is up gets one test
// conversation; all of them are deleted at the end. Never touches a real chat (lib.js guard).
// Group conversation (0.12.1): Hermes leads with the helper Assistant (« Ajouter des agents »), a harmless
// delegation (Assistant answers « pong », shown as Assistant's own message when the background subagent is
// done), the delegate_task chip names Assistant, then the helper is removed.
// Every agent that is up must answer « Réponds juste : pong » with pong (offline: ext/hermes/test/offline.mjs).
// sh web/test/e2e/run-offline.sh ../../ext/agents/test/agents.e2e.cjs
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
  const until = async (fn, arg, timeout, label) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await page.evaluate(fn, arg).catch(() => false)) return true;
      await page.waitForTimeout(250);
    }
    throw new Error(`timeout: ${label}`);
  };
  const origin = () => new URL(page.url()).origin;
  const created = new Set();
  const sessions = async () => (await api('GET', '/agents/sessions')).json?.sessions ?? [];

  /** New conversation with `agent` from its card, one pong turn; returns the session id. */
  const pong = async (agent) => {
    const ask = 'Réponds juste : pong';
    const expect = 'pong';
    // The start buttons live on the agents home (0.14.7): the right pane at /agents, reached from the list's top row.
    await page.click('[data-testid=agents-home-row]');
    await page.click(`[data-testid=agent-start][data-agent=${agent}]`);
    await until((a) => location.pathname === '/agents/new' && new URLSearchParams(location.search).get('agent') === a, agent, 10000, 'new conversation route');
    await page.fill('[data-testid=agents-input]', ask);
    await page.click('[data-testid=agents-send]');
    await until(() => /^\/agents\/klatchly_/.test(location.pathname), null, 15000, 'session created');
    const sid = /\/agents\/(klatchly_[0-9a-f_]+)$/.exec(new URL(page.url()).pathname)[1];
    created.add(sid);
    await until((re) => [...document.querySelectorAll('[data-testid=agents-assistant]')].some((e) => new RegExp(re, 'i').test(e.textContent)), expect, 120000, `${agent} reply`);
    const row = (await sessions()).find((x) => x.id === sid);
    check(row?.agent === agent, `${agent}: the conversation lives on that profile (${row?.agent})`);
    check(row?.unread === 0, `${agent}: read while open (unread ${row?.unread})`);
    return sid;
  };

  try {
    await enroll(page);
    // Needs a runtime that keeps conversations (the Agents space: Hermes, as the offline fake of the hermes package);
    // a build without one has no space and these agents (ext/agents/test/llmagent.e2e.cjs covers that case).
    if ((await page.evaluate(async () => (await fetch('/api/agents/agents')).status)) !== 200) {
      console.log('     skipped: no runtime keeps conversations in this build (no Agents space)');
      return done();
    }
    const agents = (await api('GET', '/agents/agents')).json?.agents ?? [];
    console.log(`     agents: ${agents.map((a) => `${a.name}=${a.available ? 'up' : 'down'}`).join(', ')}`);
    check(agents[0]?.name === 'default' && agents[0]?.label === 'Hermes', 'the default profile is "Hermes", first');

    // Space switch.
    await page.click('[data-testid=open-agents]');
    await page.waitForSelector('[data-testid=agents-pane]');
    // The home's cards come with the agents list (loaded beside the pane).
    if (agents.length) await page.waitForSelector('[data-testid=agent-card]');
    check(!(await page.$('[data-testid=search]')), 'the chat list (and its search) is replaced');
    const cards = await page.$$eval('[data-testid=agent-card]', (els) => els.map((e) => [e.dataset.agent, e.dataset.available !== '1', e.textContent]));
    check(cards.length === agents.length, `one card per agent (${cards.map((c) => c[0]).join(', ')})`);
    for (const a of agents) {
      const c = cards.find((x) => x[0] === a.name);
      check(!!c && c[1] === !a.available && c[2].includes(a.label), `${a.name}: card ${a.available ? 'enabled' : 'disabled'}${a.description ? ', with its description' : ''}`);
    }
    await shot(page, 'agents-list');
    await page.click('[data-testid=tab-chats]');
    await page.waitForSelector('[data-testid=search]');
    check(new URL(page.url()).pathname === '/', '« Discussions » goes back to the chats');
    await page.click('[data-testid=open-agents]');
    await page.waitForSelector('[data-testid=agents-pane]');

    // Strict relay: unknown agents and fields refused.
    for (const agent of ['nope', '../default', 'Assistant']) check((await api('POST', '/agents/sessions', { agent })).status === 400, `create on « ${agent} » refused`);
    for (const a of agents.filter((x) => !x.available)) check((await api('POST', '/agents/sessions', { agent: a.name })).status === 400, `create on ${a.name} (down) refused`);
    // Scheduled tasks: listed read-only by the space (agents 3.1), never their prompt; nothing else reaches them.
    const jobs = await api('GET', '/agents/jobs');
    check((await api('GET', '/jobs')).status === 404 && jobs.status === 200 && !JSON.stringify(jobs.json).includes('prompt'), 'no jobs route but the space\'s read-only list');
    check((await api('POST', '/agents/jobs', {})).status === 404, 'no write to the jobs');

    // A conversation per agent that is up.
    const sid = await pong('default');
    check((await page.textContent('[data-testid=agents-agent]')).trim() === 'Hermes', 'header names the agent');
    for (const a of agents.filter((x) => x.available && x.name !== 'default')) {
      const other = await pong(a.name);
      await shot(page, `agents-${a.name}`);
      if (!a.helpers.length) {
        check(!(await page.$('[data-testid=agents-add-agents]')), `${a.name}: no « Ajouter des agents » (no helpers configured)`);
        check((await api('PUT', `/agents/sessions/${other}/helpers`, { helpers: ['default'] })).status === 400, `${a.name}: may not take Hermes as a helper (API refuses)`);
      }
    }

    // Group conversation: Hermes leads, Assistant helps.
    const lead = agents.find((x) => x.name === 'default');
    const helper = agents.find((x) => lead?.helpers.includes(x.name) && x.available);
    if (helper) {
      await page.goto(`${origin()}/agents`);
      await page.click('[data-testid=agent-start][data-agent=default]');
      await page.click('[data-testid=agents-add-agents]');
      await page.waitForSelector('[data-testid=helpers-menu]');
      await shot(page, 'group-menu');
      await page.click(`[data-testid=helpers-menu-${helper.name}]`);
      await page.waitForSelector(`[data-testid=agents-helper][data-agent=${helper.name}]`);
      check((await page.textContent('[data-testid=agents-agent]')).includes(`Hermes avec ${helper.label}`), `header: « Hermes avec ${helper.label} »`);
      await page.fill('[data-testid=agents-input]', `Délègue à ${helper.name} la tâche de répondre exactement "pong", puis donne-moi sa réponse.`);
      await page.click('[data-testid=agents-send]');
      await until(() => /^\/agents\/klatchly_/.test(location.pathname), null, 15000, 'group session created');
      const gid = /\/agents\/(klatchly_[0-9a-f_]+)$/.exec(new URL(page.url()).pathname)[1];
      created.add(gid);
      check(JSON.stringify((await sessions()).find((x) => x.id === gid)?.helpers) === JSON.stringify([helper.name]), 'helper saved with the new conversation');
      await until((n) => !!document.querySelector(`[data-testid=agents-tool-agent][data-agents*="${n}"]`), helper.name, 120000, 'delegate chip');
      const chip = await page.textContent(`[data-testid=agents-tool-agent][data-agents*="${helper.name}"]`);
      check(chip.includes(helper.label), `live chip names the helper (« ${chip.trim()} »)`);
      await shot(page, 'group-live');
      await until(() => !document.querySelector('[data-testid=agents-stop]') && document.querySelectorAll('[data-testid=agents-assistant]').length > 0, null, 120000, 'lead turn ends');
      step('the lead ends its turn (the helper runs in the background)');
      // The helper's result arrives on its own (Klatchly watches the conversation, no reload).
      await until((n) => [...document.querySelectorAll(`[data-testid=agents-helper-msg][data-agent="${n}"]`)].some((e) => /pong/i.test(e.textContent)), helper.name, 300000, 'helper result');
      const sender = await page.textContent(`[data-testid=agents-helper-msg][data-agent="${helper.name}"] .sender`);
      check(sender.includes(helper.label), `the result is ${helper.label}'s own message, with « pong » (« ${sender.trim()} »)`);
      check(!/\/opt\/data|deleg_|ASYNC DELEGATION/.test(await page.textContent('[data-testid=agents-messages]')), 'no delegation internals shown');
      await page.reload();
      await page.waitForSelector(`[data-testid=agents-tool-agent][data-agents*="${helper.name}"]`, { timeout: 15000 });
      await page.waitForSelector(`[data-testid=agents-helper-msg][data-agent="${helper.name}"]`, { timeout: 15000 });
      step('history keeps the delegate chip and the helper message');
      const grow = (await sessions()).find((x) => x.id === gid);
      check(/pong/i.test(grow?.preview ?? '') && grow?.preview.startsWith(helper.label), `list preview: « ${grow?.preview} »`);
      await shot(page, 'group-done');
      // Phone width: the group strip fits.
      await page.setViewportSize({ width: 390, height: 844 });
      check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'phone: group strip, no horizontal scroll');
      await shot(page, 'group-phone');
      await page.setViewportSize({ width: 1200, height: 800 });
      // Remove the helper.
      await page.click(`[data-testid=agents-helper][data-agent=${helper.name}] [data-testid=agents-helper-remove]`);
      await page.waitForSelector('[data-testid=agents-group]', { state: 'detached', timeout: 10000 });
      check(JSON.stringify((await sessions()).find((x) => x.id === gid)?.helpers) === '[]', 'helper removed');
      check((await page.textContent('[data-testid=agents-agent]')).trim() === 'Hermes', 'header back to « Hermes »');
    } else console.log('     group: no helper up for Hermes, skipped');

    // Rename in place: tap the title.
    await page.goto(`${origin()}/agents/${sid}`);
    await page.click('[data-testid=agents-title]');
    await page.fill('[data-testid=agents-title-input]', 'Test e2e renommé');
    await page.press('[data-testid=agents-title-input]', 'Enter');
    await until((id) => document.querySelector(`[data-testid=agent-conv-row][data-session-id="${id}"] .chat-title`)?.textContent === 'Test e2e renommé', sid, 10000, 'row title');
    check((await sessions()).find((x) => x.id === sid)?.title === 'Test e2e renommé', 'renamed in place (title saved in Hermes)');
    check((await page.textContent('[data-testid=agents-title]')).includes('Test e2e renommé'), 'header shows the new title');

    // Rename from the row menu (right click), then pin.
    await page.click(`[data-testid=agent-conv-row][data-session-id="${sid}"]`, { button: 'right' });
    await page.click('[data-testid=agents-menu-rename]');
    await page.fill('[data-testid=agents-rename-input]', 'Test e2e menu');
    await shot(page, 'agents-rename');
    await page.click('[data-testid=agents-rename-save]');
    await until((id) => document.querySelector(`[data-testid=agent-conv-row][data-session-id="${id}"] .chat-title`)?.textContent === 'Test e2e menu', sid, 10000, 'menu rename');
    step('renamed from the menu');
    await page.click(`[data-testid=agent-conv-row][data-session-id="${sid}"]`, { button: 'right' });
    await page.click('[data-testid=agents-menu-pin]');
    await until((id) => document.querySelector('[data-testid=agent-conv-row]')?.dataset.sessionId === id, sid, 10000, 'pinned on top');
    check((await sessions()).find((x) => x.id === sid)?.pinned === true, 'pinned (first in the list)');

    // Phone: list -> conversation -> back to the list -> back to the chats.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin()}/agents`);
    await page.waitForSelector('[data-testid=agents-pane]');
    await page.click(`[data-testid=agent-conv-row][data-session-id="${sid}"]`);
    await page.waitForSelector('[data-testid=agents-view]');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!overflow && (await page.isVisible('[data-testid=agents-input]')), 'phone: conversation on top, composer visible, no horizontal scroll');
    await shot(page, 'agents-phone-conv');
    await page.click('[data-testid=agents-back]');
    await until(() => location.pathname === '/agents', null, 5000, 'back');
    await page.waitForSelector('[data-testid=agents-pane]', { state: 'visible' });
    step('phone: back to the agents list');
    await shot(page, 'agents-phone-list');
    await page.click('[data-testid=tab-chats]');
    await until(() => location.pathname === '/', null, 5000, 'chats');
    step('phone: back to the chats');
    await page.setViewportSize({ width: 1200, height: 800 });

    // Delete from the row menu.
    await page.goto(`${origin()}/agents`);
    await page.click(`[data-testid=agent-conv-row][data-session-id="${sid}"]`, { button: 'right' });
    await page.click('[data-testid=agents-menu-delete]');
    await page.click('[data-testid=agents-confirm-delete-yes]');
    await page.waitForSelector(`[data-testid=agent-conv-row][data-session-id="${sid}"]`, { state: 'detached', timeout: 15000 });
    check(!(await sessions()).some((x) => x.id === sid), 'deleted from the menu');
    created.delete(sid);
    check(s.blocked.length === 0, `no write to a real chat (${s.blocked.join(', ') || 'none'})`);
  } catch (e) {
    console.log('FAIL exception', e);
    check(false, 'exception');
    await shot(page, 'agents-error').catch(() => {});
  } finally {
    for (const id of created) {
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
