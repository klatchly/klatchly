// Agents inside chats (0.13): per-chat Agent panel (header chip, risk notes, full-tools warning), "Ask the agent"
// from the composer -> draft card (Modifier / Ignorer / Envoyer), a real call by an own "@agent" message in the
// chat (server-side trigger), loop protection (the sent reply does not call the agent again), direct mode with and
// without the "[Agent]" prefix, validation, phone sheet with 16 px fields.
// ONLY the TEST chat: the agent is attached there, reads its messages, and writes there (4 short messages at most);
// lib.js blocks any other chat write, chatagent ones included. At the end the agent is removed from the test
// chat, its drafts dropped, and the chat re-archived. Needs Hermes with the "chat" profile (offline:
// ext/hermes/test/offline.mjs), answering « Réponds juste : X » with X.
// sh web/test/e2e/run-offline.sh ../../ext/agents/test/chatagent.e2e.cjs
// (then remove the passkey it created: docker exec klatchly /nodejs/bin/node /app/dist/cli.js passkeys list|remove <id>)
const { BASE, TEST_CHAT, check, step, open, enroll, logout, shot, done, allowDraft } = require('../../../test/e2e/lib');

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
  const q = `?chatID=${encodeURIComponent(TEST_CHAT)}`;
  const state = async () => (await api('GET', `/chatagent/chat${q}`)).json;
  // Polls with page.evaluate (Playwright's own polling evaluates strings: refused by the app's CSP).
  const until = async (fn, timeout, label) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn().catch(() => false)) return true;
      await page.waitForTimeout(500);
    }
    throw new Error(`timeout: ${label}`);
  };
  const registerDrafts = async () => {
    const st = await state();
    for (const d of st?.drafts ?? []) allowDraft(d.id);
    return st;
  };
  const bubbles = () => page.$$eval('[data-testid=bubble]', (els) => els.map((e) => (e.textContent ?? '').trim()));
  // User calls are spaced by 5 s on the server (from the start of the previous one): wait out what is left.
  let lastCall = 0;
  const called = () => (lastCall = Date.now());
  const spaced = () => page.waitForTimeout(Math.max(0, lastCall + 5500 - Date.now()));
  let exitErr;
  try {
    await enroll(page);
    // Needs a runtime that keeps conversations (the Agents space: Hermes, as the offline fake of the hermes package);
    // a build without one has no space and these agents (ext/agents/test/llmagent.e2e.cjs covers that case).
    if ((await page.evaluate(async () => (await fetch('/api/agents/agents')).status)) !== 200) {
      console.log('     skipped: no runtime keeps conversations in this build (no Agents space)');
      return done();
    }
    const agents = (await api('GET', '/chatagent/agents')).json;
    const chat = agents?.agents?.find((a) => a.name === 'chat');
    check(agents?.default === 'chat' && chat?.available === true && chat?.access === 'limited', `limited "chat" agent (manifest: access, chatDefault) available and default (${JSON.stringify(agents?.agents?.map((a) => [a.name, a.available, a.access]))})`);
    check(agents?.contextLines === 20, `how many messages go at each call (${agents?.contextLines})`);
    const space = (await api('GET', '/agents/agents')).json;
    check(!(space?.agents ?? []).some((a) => a.name === 'chat'), 'the chat profile is not offered in the Agents space');

    // Clean start on the test chat.
    await api('DELETE', `/chatagent/chat${q}`);
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=composer-input]');
    await page.waitForSelector('[data-testid=agent-head-btn]');
    check((await page.getAttribute('[data-testid=agent-head-btn]', 'data-on')) === '0', 'header chip: no agent yet');

    // Panel: risk notes, full-tools warning, then the safe settings.
    await page.click('[data-testid=agent-head-btn]');
    await page.waitForSelector('[data-testid=agent-panel] [data-testid=agent-save]');
    const privacy = await page.textContent('[data-testid=agent-privacy]');
    check(/\((offline runtime|runtime hors ligne)\)/.test(privacy), `privacy line names where the chosen agent sends the chat (manifest disclosure): ${privacy}`);
    const limitedNote = await page.textContent('[data-testid=agent-panel] label:has([data-testid=agent-choice-chat])');
    check(/(web search only, no memory|recherche web seulement, sans mémoire)/.test(limitedNote), `limited agent: the host's note (manifest accessNote): ${limitedNote}`);
    check(!(await page.isVisible('[data-testid=agent-risk]')), '"me only" by default: no risk note');
    await page.check('[data-testid=agent-trigger-mention]');
    check(await page.isVisible('[data-testid=agent-risk]'), '"anyone who mentions it": risk note');
    await page.check('[data-testid=agent-trigger-auto]');
    check(await page.isVisible('[data-testid=agent-risk]'), '"automatic": risk note');
    await page.check('[data-testid=agent-choice-default]');
    check(await page.isVisible('[data-testid=agent-full-warning]'), 'Hermes: full-tools warning');
    check((await page.getAttribute('[data-testid=agent-full-warning]', 'data-access')) === 'full', 'the warning follows the declared access (full), not the profile name');
    check((await page.inputValue('[data-testid=agent-handle]')) === 'hermes', 'mention word follows the agent');
    await page.check('[data-testid=agent-choice-assistant]');
    check((await page.getAttribute('[data-testid=agent-full-warning]', 'data-access')) === 'extended', 'declared extended: its own warning');
    await page.check('[data-testid=agent-choice-chat]');
    check(!(await page.isVisible('[data-testid=agent-full-warning]')), 'limited agent: no warning');
    await page.check('[data-testid=agent-trigger-me]');
    check(await page.isChecked('[data-testid=agent-send-draft]') && (await page.isChecked('[data-testid=agent-disclose]')), 'defaults: draft mode, prefix on');
    await shot(page, 'chatagent-panel');
    await page.click('[data-testid=agent-save]');
    await until(async () => (await page.getAttribute('[data-testid=agent-head-btn]', 'data-on')) === '1', 10000, 'chip on');
    const handle = (await state())?.config?.handle;
    check(handle === 'agent', `attached: handle @${handle}`);

    // Validation (settings only through the API, checked).
    check((await api('PUT', '/chatagent/chat', { chatID: TEST_CHAT, trigger: 'sometimes' })).status === 400, 'bad trigger refused');
    check((await api('PUT', '/chatagent/chat', { chatID: TEST_CHAT, handle: 'a b' })).status === 400, 'bad handle refused');
    check((await api('PUT', '/chatagent/chat', { chatID: TEST_CHAT, dailyCap: 1000 })).status === 400, 'cap too high refused');

    // Ask from the composer: the field's text is the instruction (not sent), the answer is a draft.
    const input = page.locator('[data-testid=composer-input]');
    await input.fill('Réponds juste : pong');
    await page.click('[data-testid=assist-btn]');
    await page.click('[data-testid=agent-ask]');
    called();
    await page.waitForSelector('[data-testid=agent-draft]', { timeout: 120000 });
    check((await input.inputValue()) === '', 'instruction left the field (not sent)');
    const t1 = (await page.textContent('[data-testid=agent-draft-text]')) ?? '';
    check(/^\[Agent\]\s*\S/.test(t1.trim()), `draft card with the prefix preview (${t1.trim().slice(0, 60)})`);
    await shot(page, 'chatagent-draft');
    await registerDrafts();
    await page.click('[data-testid=agent-draft-edit]');
    await until(async () => (await input.inputValue()).startsWith('[Agent]'), 5000, 'draft in the field');
    // The card goes when the drafts are read again, after the field is filled (ChatAgent act: refresh), later under load.
    await page.waitForSelector('[data-testid=agent-draft]', { state: 'hidden', timeout: 5000 }).catch(() => {});
    check(!(await page.isVisible('[data-testid=agent-draft]')), 'Modifier: draft moved into the field');
    await input.fill('');

    await spaced();
    await input.fill('Réponds juste : pong');
    await page.click('[data-testid=assist-btn]');
    await page.click('[data-testid=agent-ask]');
    called();
    await page.waitForSelector('[data-testid=agent-draft]', { timeout: 120000 });
    await registerDrafts();
    await page.click('[data-testid=agent-draft-drop]');
    await until(async () => !(await page.isVisible('[data-testid=agent-draft]')), 5000, 'draft dropped');
    step('Ignorer: draft dropped');

    // A real call: an own message with @agent in the chat -> the server (Beeper events) makes a draft.
    await spaced();
    await input.fill('@agent réponds juste : pong (test Klatchly)');
    await page.click('[data-testid=send]');
    called();
    await page.waitForSelector('[data-testid=agent-draft]', { timeout: 120000 });
    step('own @agent message in the chat -> draft');
    await registerDrafts();
    const sentBefore = (await bubbles()).length;
    await page.click('[data-testid=agent-draft-send]');
    await until(async () => (await bubbles()).some((b) => b.startsWith('[Agent]')), 30000, 'sent draft in the chat');
    step('Envoyer: "[Agent] …" sent in the test chat');
    // Loop protection: the echo of that send must not call the agent again (a call is in the audit at once, before
    // the agent answers: a few seconds after the echo is enough).
    await page.waitForTimeout(3000);
    const st = await state();
    check(!st.drafts.length, 'no new draft from the echo of the sent reply');
    check(st.audit.filter((a) => a.kind === 'trigger').length === 3, `exactly 3 calls so far (${st.audit.map((a) => a.kind).join(',')})`);
    check(st.usage.today >= 3, `usage counted (${st.usage.today})`);
    console.log(`     messages: ${sentBefore} -> ${(await bubbles()).length}`);

    // Direct mode, prefix on then off.
    await api('PUT', '/chatagent/chat', { chatID: TEST_CHAT, send: 'direct' });
    await spaced();
    called();
    let r = await api('POST', '/chatagent/ask', { chatID: TEST_CHAT, instruction: 'Réponds juste : direct un' });
    check(r.status === 200 && ['sent', 'skipped'].includes(r.json?.status), `direct ask (${r.status} ${r.json?.status})`);
    await spaced();
    await api('PUT', '/chatagent/chat', { chatID: TEST_CHAT, disclose: false });
    r = await api('POST', '/chatagent/ask', { chatID: TEST_CHAT, instruction: 'Réponds juste : direct deux' });
    check(r.status === 200, `direct ask without prefix (${r.status} ${r.json?.status})`);
    const last = (await state()).audit.find((a) => a.kind === 'sent');
    check(!!last && !last.text.startsWith('['), `sent without prefix (${(last?.text ?? '').slice(0, 40)})`);

    // History in the panel.
    await page.click('[data-testid=agent-head-btn]');
    await page.click('[data-testid=agent-history] summary');
    check((await page.$$('[data-testid=agent-history] li')).length > 3, 'activity listed in the panel');
    await page.keyboard.press('Escape');

    // Phone width: bottom sheet, 16 px fields.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.click('[data-testid=agent-head-btn]');
    await page.waitForSelector('[data-testid=agent-panel].sheet');
    const sizes = await page.$$eval('[data-testid=agent-panel] input[type=text], [data-testid=agent-panel] select, [data-testid=agent-panel] textarea, [data-testid=agent-panel] input[type=number]', (els) =>
      els.map((e) => getComputedStyle(e).fontSize),
    );
    check(sizes.length > 0 && sizes.every((x) => x === '16px'), `phone: sheet, fields at 16 px (${sizes.join(',')})`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(!overflow, 'phone: no horizontal scroll');
    await shot(page, 'chatagent-phone');
    await page.click('[data-testid=agent-close]');
  } catch (e) {
    exitErr = e;
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    // Remove the agent from the test chat (drafts dropped), re-archive the chat.
    const rm = await api('DELETE', `/chatagent/chat${q}`).catch((e) => ({ error: String(e) }));
    console.log(`     agent removed from the test chat: ${JSON.stringify(rm.status ?? rm)}`);
    const arch = await page
      .evaluate(async (id) => {
        const r = await fetch(`/api/chats/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
        await new Promise((res) => setTimeout(res, 1500));
        const c = await (await fetch(`/api/chats/${encodeURIComponent(id)}`)).json();
        return { status: r.status, isArchived: c.isArchived };
      }, TEST_CHAT)
      .catch((e) => ({ error: String(e) }));
    console.log(`     test chat re-archived: ${JSON.stringify(arch)}`);
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await ctx.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
