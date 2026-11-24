// Composer writing help (0.7.0): fix at three levels, translate with context, undo, shortcuts, per-chat
// settings, original kept under the sent message (only for us). Only the TEST chat: its messages are the
// context sent to the model, and one translated message is sent there, then the chat is re-archived.
// sh web/test/e2e/run-offline.sh ../../ext/writing/test/assist.e2e.cjs
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('../../../test/e2e/lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  let exitErr;
  try {
    await enroll(page);
    await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
    await page.waitForSelector('[data-testid=composer-input]');
    const input = page.locator('[data-testid=composer-input]');
    // Settings reachable without text: from the ✨ menu (actions greyed out) and from the header.
    await input.fill('');
    await page.click('[data-testid=assist-btn]');
    check(await page.isDisabled('[data-testid=assist-grammar]'), 'empty field: actions greyed out, menu still opens');
    check(await page.isVisible('[data-testid=assist-open-settings]'), 'empty field: chat settings reachable');
    await page.keyboard.press('Escape');
    await page.click('[data-testid=assist-head-btn]');
    check(await page.isVisible('[data-testid=assist-head-menu] [data-testid=assist-address]'), 'header shortcut opens the chat settings');
    await page.keyboard.press('Escape');

    // Settings for this chat: how I address the person (no AI call).
    await page.click('[data-testid=assist-btn]');
    await page.click('[data-testid=assist-open-settings]');
    await page.fill('[data-testid=assist-address]', 'je suis anh, il est em (test)');
    await page.click('[data-testid=assist-save]');
    await page.waitForSelector('[data-testid=assist-head-context]', { timeout: 5000 }).catch(() => {});
    // 0.15.9: a compact chip, the chat language's code and a mark for the address; the full summary in its tooltip.
    const chip = page.locator('[data-testid=assist-head-btn]');
    const code = ((await page.textContent('[data-testid=assist-head-lang]').catch(() => '')) || '').trim();
    check(/^[A-Z]{2}$/.test(code), `header chip shows the chat language's code (${code})`);
    check(await page.isVisible('[data-testid=assist-head-context]'), 'header chip marks that an address is set');
    check(!((await chip.textContent()) || '').includes('je suis anh'), 'no preview of the address in the chip');
    check(((await chip.getAttribute('title')) || '').includes('je suis anh'), 'the address in its tooltip');
    const chipW = (await chip.boundingBox())?.width ?? 999;
    check(chipW <= 90, `header chip stays compact (${Math.round(chipW)} px)`);
    await shot(page, 'assist-header');

    const draft = 'salut, je pense que on pourrais se voir demain soir ? 😊🎉 regarde https://example.com/a?b=1';
    await input.fill(draft);
    check(await page.isEnabled('[data-testid=assist-btn]'), 'AI button enabled with text');

    // Spelling only, from the menu.
    await page.click('[data-testid=assist-btn]');
    await page.waitForSelector('[data-testid=assist-menu]');
    // Who answers: the server's KLATCHLY_LLM_LABEL, in the UI language.
    const where = /Envoyé au modèle IA \((.+?)\)/.exec(await page.textContent('[data-testid=assist-menu]'));
    check(!!where, `menu reminds where the text goes (${where?.[1]})`);
    await shot(page, 'assist-menu');
    let t0 = Date.now();
    await page.click('[data-testid=assist-spelling]');
    await page.waitForSelector('[data-testid=assist-bar]', { timeout: 30000 });
    const fixed = await input.inputValue();
    console.log(`     spelling (${Date.now() - t0} ms): ${fixed}`);
    check(fixed !== draft && ['😊', '🎉', 'https://example.com/a?b=1'].every((x) => fixed.includes(x)), 'spelling fixed, emoji and link kept');
    check((await page.textContent('[data-testid=assist-original]')) === draft, 'the original stays under the field after a fix');
    await page.click('[data-testid=assist-undo]');
    check((await input.inputValue()) === draft, 'undo restores the draft');

    // Grammar by shortcut, then Ctrl+Z.
    await input.focus();
    t0 = Date.now();
    await page.keyboard.press('Control+Shift+K');
    await page.waitForSelector('[data-testid=assist-bar]', { timeout: 30000 });
    console.log(`     grammar (${Date.now() - t0} ms): ${await input.inputValue()}`);
    check((await input.inputValue()) !== draft, 'Ctrl+Shift+K fixes grammar');
    await page.keyboard.press('Control+Z');
    check((await input.inputValue()) === draft, 'Ctrl+Z puts the draft back');


    // Translate into Vietnamese by shortcut: original shown under the field.
    await input.focus();
    t0 = Date.now();
    await page.keyboard.press('Control+Shift+L');
    await page.waitForSelector('[data-testid=assist-original]', { timeout: 40000 });
    const vi = await input.inputValue();
    console.log(`     translate vi (${Date.now() - t0} ms): ${vi}`);
    check(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(vi) && vi.includes('😊') && vi.includes('https://example.com/a?b=1'), 'translated into Vietnamese, emoji and link kept');
    check((await page.textContent('[data-testid=assist-original]')) === draft, 'original shown under the field');
    await shot(page, 'assist-translated');

    // Send it (test chat): the original stays under our message, only for us, after a reload too.
    await page.click('[data-testid=send]');
    const shown = await page.waitForSelector('[data-testid=msg-sent-original]', { timeout: 30000 }).then(() => true, () => false);
    check(shown, 'original shown under the sent message');
    // The original kept on the server and the message in the chat's history before the reload (not a fixed wait).
    const isStored = () =>
      page.evaluate(
        async ({ id, sent }) => {
          const notes = (await (await fetch(`/api/assist/notes?chatID=${encodeURIComponent(id)}`)).json()).items;
          const items = (await (await fetch(`/api/chats/${encodeURIComponent(id)}/messages`)).json()).items ?? [];
          return Object.values(notes).some((n) => n.original.includes('demain soir')) && items.some((m) => m.isSender && (m.text ?? '').includes(sent));
        },
        { id: TEST_CHAT, sent: vi.slice(0, 20) },
      );
    let stored = false;
    for (let i = 0; i < 40 && !(stored = await isStored()); i++) await page.waitForTimeout(250);
    check(stored, 'the original kept on the server, the message in the history');
    await page.reload();
    await page.waitForSelector('[data-testid=msg]');
    const kept = await page.waitForSelector('[data-testid=msg-sent-original]', { timeout: 15000 }).then(() => true, () => false);
    check(kept, 'original still there after a reload');
    if (kept) check((await page.textContent('[data-testid=msg-sent-original]')).includes('demain soir'), 'it is the French original');
    await shot(page, 'assist-sent');

  } catch (e) {
    exitErr = e;
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    // Clean the test setting (also after a failure).
    await page
      .evaluate(async (id) => fetch('/api/assist/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatID: id, address: '' }) }), TEST_CHAT)
      .catch(() => {});
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
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
