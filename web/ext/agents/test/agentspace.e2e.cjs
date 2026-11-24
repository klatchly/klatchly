// Agents space layout (0.14.7), READ-ONLY: never creates a conversation, never sends to an agent, never opens a
// conversation with unread messages (opening marks it read). Any non-GET to /api/agents/* is aborted and fails.
// Desktop: list on the left (search + Filter, "Your agents" row, date groups), the agents home on the right (one card
// per agent, full description, recent conversations, start button); the Filter sheet's agent narrows the list (terminal
// sessions are hidden by default, agents 3.1: ext/agents/test/agentsources.e2e.cjs has the rest); a start button
// opens the empty new conversation (description shown) without creating anything. Phone: the list is the page,
// the home opens over it from the top row and goes back. Light + dark screenshots.
// sh web/test/e2e/run-offline.sh ../../ext/agents/test/agentspace.e2e.cjs
const { check, step, open, enroll, logout, shot, done } = require('../../../test/e2e/lib');
// A manifest text (by language code) as the page shows it: French here, else English, else the first.
const textOf = (t) => (typeof t === 'string' ? t : (t.fr ?? t.en ?? Object.values(t)[0]));

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page, ctx } = s;
  const writes = [];
  await page.route('**/api/agents/**', (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  const get = (path) => page.evaluate(async (p) => (await fetch(`/api${p}`)).json(), path);
  const until = async (fn, arg, timeout, label) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await page.evaluate(fn, arg).catch(() => false)) return true;
      await page.waitForTimeout(200);
    }
    throw new Error(`timeout: ${label}`);
  };
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const origin = () => new URL(page.url()).origin;

  try {
    await enroll(page);
    // Needs a runtime that keeps conversations (the Agents space: Hermes, as the offline fake of the hermes package);
    // a build without one has no space and these agents (ext/agents/test/llmagent.e2e.cjs covers that case).
    if ((await page.evaluate(async () => (await fetch('/api/agents/agents')).status)) !== 200) {
      console.log('     skipped: no runtime keeps conversations in this build (no Agents space)');
      return done();
    }
    const agents = (await get('/agents/agents')).agents ?? [];
    // What the list shows by default: every conversation but the terminal's (agents 3.1).
    const sessions = ((await get('/agents/sessions')).sessions ?? []).filter((x) => x.source !== 'cli');
    // The Filter sheet: one agent (null: all), then closed.
    const pickAgent = async (name) => {
      await page.click('[data-testid=agents-filter-btn]');
      await page.waitForSelector('[data-testid=agents-filter-sheet]');
      await page.click(name ? `[data-testid=agent-filter][data-agent=${name}]` : '[data-testid=agent-filter-all]');
      await page.click('[data-testid=agents-filter-done]');
      await page.waitForSelector('[data-testid=agents-filter-sheet]', { state: 'detached' });
    };
    console.log(`     agents: ${agents.map((a) => a.name).join(', ')}; conversations: ${sessions.length}`);

    // Desktop: list + home side by side.
    await page.click('[data-testid=open-agents]');
    await page.waitForSelector('[data-testid=agents-home]');
    check(await page.isVisible('[data-testid=agents-pane]'), 'desktop: the list and the agents home side by side');
    check(await page.isVisible('[data-testid=agents-home-row].active'), '« Vos agents » row active while the home is shown');
    const cards = await page.$$eval('[data-testid=agent-card]', (els) => els.map((e) => ({ name: e.dataset.agent, up: e.dataset.available === '1', text: e.textContent })));
    check(cards.length === agents.length, `one card per agent (${cards.map((c) => c.name).join(', ')})`);
    for (const a of agents) {
      const c = cards.find((x) => x.name === a.name);
      check(!!c && c.up === a.available && c.text.includes(a.label) && (!a.description || c.text.includes(textOf(a.description))), `${a.name}: card with its full description`);
      const mine = sessions.filter((x) => x.agent === a.name).length;
      const shown = await page.$$eval(`[data-testid=agent-card][data-agent=${a.name}] [data-testid=agent-home-conv]`, (els) => els.length);
      check(shown === Math.min(3, mine), `${a.name}: ${shown} recent conversation(s) on the card (${mine} in all)`);
      const disabled = await page.$eval(`[data-testid=agent-start][data-agent=${a.name}]`, (e) => e.disabled);
      check(disabled === !a.available, `${a.name}: start button ${a.available ? 'enabled' : 'disabled'}`);
    }
    const descClipped = await page.$$eval('.agent-home-desc', (els) => els.some((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1));
    check(!descClipped, 'descriptions are not truncated');
    const colors = await page.$$eval('[data-testid=agent-card] .agent-home-head .avatar-fallback', (els) => els.map((e) => getComputedStyle(e).backgroundColor));
    check(new Set(colors).size === colors.length, `each agent has its own colour (${colors.join(' / ')})`);
    const declared = await page.$eval('[data-testid=agent-card][data-agent=assistant] .agent-home-head .avatar-fallback', (e) => getComputedStyle(e).backgroundColor).catch(() => null);
    check(declared === 'rgb(47, 138, 122)', `the manifest's colour for assistant (${declared})`);
    // Same colour for an agent in the list rows and on its card.
    const rowColor = sessions.length
      ? await page.$eval(`[data-testid=agent-conv-row][data-agent=${sessions[0].agent}] .avatar-fallback`, (e) => getComputedStyle(e).backgroundColor)
      : null;
    const cardColor = sessions.length
      ? await page.$eval(`[data-testid=agent-card][data-agent=${sessions[0].agent}] .avatar-fallback`, (e) => getComputedStyle(e).backgroundColor)
      : null;
    check(rowColor === cardColor, 'an agent keeps its colour in the list and on the home');
    check(await noHScroll(), 'desktop: no horizontal scroll');
    await shot(page, 'agentspace-desktop');

    // Groups: pinned first, then by date.
    const groups = await page.$$eval('.agent-group', (els) => els.map((e) => e.dataset.group));
    const order = ['pinned', 'today', 'week', 'older'];
    check(groups.every((g, i) => i === 0 || order.indexOf(groups[i - 1]) < order.indexOf(g)), `date groups in order (${groups.join(', ') || 'none'})`);

    // Filter by agent.
    if (agents.length > 1) {
      const target = agents.find((a) => sessions.some((x) => x.agent === a.name)) ?? agents[0];
      await pickAgent(target.name);
      const rows = await page.$$eval('[data-testid=agent-conv-row]', (els) => els.map((e) => e.dataset.agent));
      const expected = sessions.filter((x) => x.agent === target.name).length;
      check(rows.length === expected && rows.every((r) => r === target.name), `filter « ${target.label} »: ${rows.length}/${expected} rows, all of that agent`);
      check(!(await page.$('[data-testid=agent-conv-row] [data-testid=agent-conv-agents]')) || sessions.some((x) => x.helpers.length), 'filtered rows drop the redundant agent label');
      const title = await page.getAttribute('[data-testid=agents-new]', 'title');
      check(title.includes(target.label), `header button starts with the filtered agent (« ${title} »)`);
      check((await page.textContent('[data-testid=agents-filter-btn]')).includes('· 1'), 'the Filter button counts the choice');
      await shot(page, 'agentspace-filter');
      const empty = agents.find((a) => !sessions.some((x) => x.agent === a.name));
      if (empty) {
        await pickAgent(empty.name);
        await page.waitForSelector('[data-testid=agents-empty]');
        step(`filter « ${empty.label} » with no conversation: empty state`);
      }
      await pickAgent(null);
      const all = await page.$$eval('[data-testid=agent-conv-row]', (els) => els.length);
      check(all === sessions.length, `« Tous » shows every conversation (${all})`);
    }

    // Start button: the empty new conversation, nothing created.
    const up = agents.find((a) => a.available && a.description) ?? agents.find((a) => a.available);
    if (up) {
      await page.click(`[data-testid=agent-start][data-agent=${up.name}]`);
      await until((a) => location.pathname === '/agents/new' && new URLSearchParams(location.search).get('agent') === a, up.name, 8000, 'new route');
      await page.waitForSelector('[data-testid=agents-conv-empty]');
      const txt = await page.textContent('[data-testid=agents-conv-empty]');
      check(txt.includes(up.label) && (!up.description || txt.includes(textOf(up.description))), `new conversation with ${up.label}: intro with its description`);
      check(!(await page.isVisible('[data-testid=agents-home-row].active')), 'home row not active while a conversation is shown');
      await shot(page, 'agentspace-new');
      await page.click('[data-testid=agents-home-row]');
      await page.waitForSelector('[data-testid=agents-home]');
      check(new URL(page.url()).pathname === '/agents/overview', 'the home row leads back to the home (/agents/overview)');
    }

    // A read conversation from a card (never one with unread messages).
    const read = sessions.find((x) => x.unread === 0 && !x.readOnly);
    if (read) {
      const link = await page.$(`[data-testid=agent-home-conv][data-session-id="${read.id}"]`);
      if (link) {
        await link.click();
        await page.waitForSelector('[data-testid=agents-view]');
        check(new URL(page.url()).pathname === `/agents/${read.id}`, 'a recent conversation opens from its card');
        check(await page.isVisible(`[data-testid=agent-conv-row][data-session-id="${read.id}"].active`), 'its row is selected in the list');
        await shot(page, 'agentspace-conv');
      }
    }

    // Dark theme.
    await page.goto(`${origin()}/agents`);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForSelector('[data-testid=agents-home]');
    await shot(page, 'agentspace-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // Phone: the list is the page; the home opens over it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin()}/agents`);
    await page.waitForSelector('[data-testid=agents-pane]');
    check(!(await page.isVisible('[data-testid=agents-home]')), 'phone: /agents shows the list only');
    check(await noHScroll(), 'phone list: no horizontal scroll');
    // One control row (search + Filter), no row of agent chips; in the Filter sheet the chips wrap, none cut off.
    check(!(await page.$('[data-testid=agents-pane] .agent-fchip')), 'phone: no agent chips over the list (they are in the Filter sheet)');
    if (agents.length > 1) {
      await page.click('[data-testid=agents-filter-btn]');
      await page.waitForSelector('[data-testid=agents-filter-sheet]');
      const clipped = await page.$$eval('[data-testid=agents-filter-sheet] .agent-fchip', (els) => {
        const box = document.querySelector('[data-testid=agents-filter-sheet]').getBoundingClientRect();
        return els.filter((e) => e.getBoundingClientRect().right > box.right + 0.5 || e.getBoundingClientRect().left < box.left - 0.5).length;
      });
      check(clipped === 0, `phone: every chip of the Filter sheet fits (${clipped} cut off)`);
      await page.click('[data-testid=agents-filter-done]');
    }
    // "Mark all as read" over the list while a conversation is unread (not pressed: this script only reads).
    if (sessions.some((x) => x.unread > 0)) check(await page.isVisible('[data-testid=agents-read-all]'), 'phone: « Tout marquer comme lu » over the list');
    await shot(page, 'agentspace-phone-list');
    await page.click('[data-testid=agents-home-row]');
    await page.waitForSelector('[data-testid=agents-home]', { state: 'visible' });
    await page.waitForTimeout(450);
    check(await page.isVisible('[data-testid=agents-home-back]'), 'phone: home over the list, with a back button');
    check(await noHScroll(), 'phone home: no horizontal scroll');
    await shot(page, 'agentspace-phone-home');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'agentspace-phone-home-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    if (sessions.length && agents.length > 1) {
      const a = sessions[0].agent;
      await page.click(`[data-testid=agent-see-all][data-agent=${a}]`);
      await until(() => location.pathname === '/agents', null, 5000, 'see all -> list');
      await page.waitForTimeout(400);
      const rows = await page.$$eval('[data-testid=agent-conv-row]', (els) => els.map((e) => e.dataset.agent));
      check(rows.length > 0 && rows.every((r) => r === a), `phone: « Tout voir » goes back to the list filtered on ${a}`);
      await shot(page, 'agentspace-phone-filtered');
      await pickAgent(null);
    } else {
      await page.click('[data-testid=agents-home-back]');
      await until(() => location.pathname === '/agents', null, 5000, 'back');
    }
    step('phone: back on the list');
    check(writes.length === 0, `no write to Hermes (${writes.join(', ') || 'none'})`);
    check(s.blocked.length === 0, `no write to a real chat (${s.blocked.join(', ') || 'none'})`);
  } catch (e) {
    console.log('FAIL exception', e);
    check(false, 'exception');
    await shot(page, 'agentspace-error').catch(() => {});
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await page.setViewportSize({ width: 1200, height: 800 });
    await logout(page);
    await ctx.browser().close();
  }
  done(s.csp);
})();
