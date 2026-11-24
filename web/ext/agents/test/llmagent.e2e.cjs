// The runtime on llm (agents 2.0): an agent made in Settings → Agents (LLM) (step-up: the fresh sign-in of the
// script), its access shown as limited for sure and its privacy line naming the model's provider; listed on llm's
// Default models page (one entry per agent); offered in a chat's Agent panel; "Ask the agent" gives a draft from
// the model (offline: ext/llm/test/offline.mjs echoes the prompt), never sent. Then the agent is removed. On any
// list with the llm package: with Hermes in the build the Agents space shows, without it there is no space button.
// ONLY the TEST chat (lib.js guard): the agent is attached there, its draft dropped, then it is removed.
// sh web/test/e2e/run-offline.sh ../../ext/agents/test/llmagent.e2e.cjs
const { BASE, TEST_CHAT, check, step, open, enroll, logout, shot, done, allowDraft } = require('../../../test/e2e/lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  await page.addInitScript(() => localStorage.setItem('lang', 'fr'));
  const api = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const r = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json().catch(() => null) };
      },
      { method, path, body },
    );
  const q = `?chatID=${encodeURIComponent(TEST_CHAT)}`;
  let made = null;
  page.on('dialog', (d) => void d.accept());
  try {
    await enroll(page);
    if ((await api('GET', '/chatagent/llm-agents')).json?.llm !== true) {
      console.log('     skipped: no llm package in this build');
      return done();
    }

    step('the Agents space only with a runtime that keeps conversations');
    const spaceOn = (await api('GET', '/agents/agents')).status === 200;
    await page.goto(`${BASE}/`);
    await page.waitForSelector('[data-testid=chat-row]', { timeout: 30000 });
    await page.waitForTimeout(500);
    check(!!(await page.$('[data-testid=open-agents]')) === spaceOn, `space button ${spaceOn ? 'shown (Hermes in the build)' : 'absent (no runtime keeps conversations)'}`);
    if (!spaceOn) check((await api('GET', '/agents/sessions')).status === 404, 'and no space API');

    step('Settings → Agents (LLM): make one');
    await page.goto(`${BASE}/settings/ext/agents/llm-agents`);
    await page.waitForSelector('[data-testid=agents-llm]');
    await page.click('[data-testid=agents-llm-add]');
    await page.fill('[data-testid=agents-llm-name]', 'Bref e2e');
    await page.fill('[data-testid=agents-llm-color]', '#3d74b8');
    await page.fill('[data-testid=agents-llm-description]', 'Réponses courtes');
    await page.fill('[data-testid=agents-llm-instructions]', 'Tu réponds en une phrase.');
    await page.click('[data-testid=agents-llm-save]');
    await page.waitForSelector('[data-testid=agents-llm-agent-bref-e2e]');
    made = 'bref-e2e';
    const card = await page.textContent('[data-testid=agents-llm-agent-bref-e2e]');
    check(/aucun outil/.test(card) && /garanti/.test(card), 'access: limited, no tools, guaranteed');
    check(/modèle hors ligne/.test(await page.textContent('[data-testid=agents-llm-agent-bref-e2e] [data-testid=agents-llm-privacy]')), 'privacy line: the provider of its model');
    await shot(page, 'llmagent-settings');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!overflow, 'no horizontal scroll');

    step('its model: on llm\'s Default models page');
    await page.click('[data-testid=agents-llm-models]');
    await page.waitForURL(/\/settings\/ext\/llm\/models$/);
    let listed = false;
    for (let i = 0; i < 60 && !listed; i++) {
      listed = await page.evaluate(() => document.body.textContent.includes('Agent : Bref e2e'));
      if (!listed) await page.waitForTimeout(250);
    }
    check(listed, 'listed as « Agent : Bref e2e »');

    step('offered in a chat, limited for sure; a draft from the model');
    const choices = (await api('GET', '/chatagent/agents')).json;
    const mine = choices?.agents?.find((a) => a.name === 'bref-e2e');
    check(mine?.access === 'limited' && mine?.guaranteed === true && mine?.available === true, `in the chat's choices (${JSON.stringify(mine && [mine.access, mine.guaranteed, mine.available])})`);
    check(/modèle hors ligne|offline model/.test(JSON.stringify(mine?.disclosure)), 'its disclosure: the model\'s provider');
    check((await api('PUT', '/chatagent/chat', { chatID: TEST_CHAT, agent: 'bref-e2e' })).status === 200, 'attached to the test chat');
    // The images option (3.0): offered for an llm agent, off by default, on per chat.
    check(mine?.pictures === true, 'the images option is offered for it');
    const cur = (await api('GET', `/chatagent/chat${q}`)).json;
    check(cur?.config?.images === false, 'images off by default');
    const on = await api('PUT', '/chatagent/chat', { chatID: TEST_CHAT, images: true });
    check(on.status === 200 && on.json?.config?.images === true, `images on for this chat (${on.status})`);
    const ask = await api('POST', '/chatagent/ask', { chatID: TEST_CHAT, instruction: 'Dis bonjour' });
    check(ask.status === 200 && ask.json?.status === 'draft' && ask.json?.draft?.agent === 'bref-e2e', `a draft (${ask.status} ${ask.json?.status})`);
    if (ask.json?.draft?.id) allowDraft(ask.json.draft.id);
    if (ask.json?.draft?.id) check((await api('DELETE', `/chatagent/drafts/${ask.json.draft.id}`)).status === 200, 'draft dropped (never sent)');

    step('removed');
    await page.goto(`${BASE}/settings/ext/agents/llm-agents`);
    await page.waitForSelector('[data-testid=agents-llm-remove-bref-e2e]');
    await page.click('[data-testid=agents-llm-remove-bref-e2e]');
    await page.waitForSelector('[data-testid=agents-llm-agent-bref-e2e]', { state: 'detached' });
    made = null;
    check(!(await api('GET', '/chatagent/agents')).json?.agents?.some((a) => a.name === 'bref-e2e'), 'no longer offered in chats');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    await api('DELETE', `/chatagent/chat${q}`).catch(() => {});
    if (made) await api('DELETE', `/chatagent/llm-agents/${made}`).catch(() => {});
    check(s.blocked.length === 0, `no write to a real chat (${s.blocked.join(', ') || 'none'})`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page).catch(() => {});
    await s.browser.close();
    done(s.csp);
  }
})();
