// Low-priority folder (0.8.0): header button + count, chat menu move in/out (the move mutes, the way back
// restores the mute), live moves between the lists through the websocket. Only the TEST chat is changed:
// it is moved to low priority while archived, unarchived (it lands in the low-priority list, never in the
// inbox), moved back, and ends archived with its starting mute / low-priority state.
// sh web/test/e2e/run-offline.sh lowpri.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

const row = `[data-testid=chat-row][data-chat-id="${TEST_CHAT}"]`;

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  const api = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const r = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json().catch(() => null) };
      },
      { method, path, body },
    );
  const chatPath = `/chats/${encodeURIComponent(TEST_CHAT)}`;
  const flags = async () => {
    const c = (await api('GET', chatPath)).json || {};
    return { isArchived: !!c.isArchived, isMuted: !!c.isMuted, isLowPriority: !!c.isLowPriority };
  };
  const menuOn = async () => {
    await page.click(row, { button: 'right' });
    await page.waitForSelector('[data-testid=chat-menu]');
  };
  const toView = async (id) => {
    if (await page.$('[data-testid=tab-chats]')) await page.click('[data-testid=tab-chats]');
    if (id) await page.click(`[data-testid=${id}]`);
    await page.waitForTimeout(300);
  };
  let start;
  try {
    await enroll(page);
    start = await flags();
    console.log(`     test chat at start: ${JSON.stringify(start)}`);
    check(start.isArchived && !start.isLowPriority, 'test chat starts archived, not low priority');

    // Header: the button sits next to the archive one; its count matches the server's list.
    // The header's controls (the counts drawn inside the buttons, *-count, left out).
    const order = await page.$$eval('.list-header [data-testid]', (els) => els.map((e) => e.dataset.testid).filter((id) => !id.endsWith('-count')));
    check(order.indexOf('open-lowpri') >= 0 && order.indexOf('open-lowpri') + 1 === order.indexOf('open-archives'), `low-priority button next to the archives (${order.join(',')})`);
    const low = (await api('GET', '/chats/search?inbox=low-priority&limit=50')).json;
    const expected = (low?.items || []).filter((c) => !c.isArchived && c.unreadCount > 0).length;
    // Absent when no low-priority chat is unread (no 30 s wait for it).
    const shown = (await (await page.$('[data-testid=lowpri-count]'))?.textContent()) ?? null;
    check((shown ? Number(shown) : 0) === expected, `count = low-priority chats with unread messages (${shown ?? 0} / ${expected})`);
    const lowIDs = new Set((low?.items || []).map((c) => c.id));
    const inboxIDs = await page.$$eval('[data-testid=chat-row]', (els) => els.map((e) => e.dataset.chatId));
    check(!inboxIDs.some((id) => lowIDs.has(id)), 'no low-priority chat in the inbox');
    await shot(page, 'lowpri-header');

    // Move it in from the archive view.
    await toView('open-archives');
    await page.waitForSelector(row);
    await menuOn();
    check((await page.textContent('[data-testid=chat-menu-lowpri]')).trim() === 'Déplacer dans Peu prioritaires', 'menu offers « Déplacer dans Peu prioritaires »');
    await shot(page, 'lowpri-menu');
    await page.click('[data-testid=chat-menu-lowpri]');
    await page.waitForTimeout(1200);
    let f = await flags();
    check(f.isLowPriority && f.isMuted && f.isArchived, `moved in: low priority + muted, still archived (${JSON.stringify(f)})`);
    await menuOn();
    check((await page.textContent('[data-testid=chat-menu-lowpri]')).trim() === 'Remettre dans la boîte de réception', 'menu now offers « Remettre dans la boîte de réception »');

    // Unarchive: archive wins over low priority, so it goes to the low-priority list, not the inbox.
    await page.click('[data-testid=chat-menu-archive]');
    await page.waitForTimeout(1500);
    await toView();
    check(!(await page.$(row)), 'unarchived low-priority chat is not in the inbox');
    await toView('open-lowpri');
    // No text title since 0.14.1 (section tabs): the view is the low-priority tab's, marked current.
    const tab = await page.$('[data-testid=open-lowpri][aria-current=page]');
    check(!!tab && /^Peu prioritaires/.test((await tab.getAttribute('aria-label')) || ''), 'view « Peu prioritaires » (its tab current)');
    await page.waitForSelector(row, { timeout: 8000 }).catch(() => {});
    check(!!(await page.$(row)), 'test chat listed in the low-priority view');
    await shot(page, 'lowpri-view');

    // Live: changes made elsewhere (direct API call, the websocket brings chat.upserted) move the row.
    let t0 = Date.now();
    await api('PATCH', chatPath, { isLowPriority: false });
    await page.waitForSelector(row, { state: 'detached', timeout: 10000 }).catch(() => {});
    check(!(await page.$(row)), `live: leaves the low-priority view (${Date.now() - t0} ms)`);
    f = await flags();
    check(!f.isLowPriority && f.isMuted === start.isMuted, `way back restores the mute (${JSON.stringify(f)})`);
    await toView();
    await page.waitForSelector(row, { timeout: 10000 }).catch(() => {});
    check(!!(await page.$(row)), 'live: shows up in the inbox');
    t0 = Date.now();
    await api('PATCH', chatPath, { isLowPriority: true });
    await page.waitForSelector(row, { state: 'detached', timeout: 10000 }).catch(() => {});
    check(!(await page.$(row)), `live: leaves the inbox when moved in elsewhere (${Date.now() - t0} ms)`);
    await toView('open-lowpri');
    await page.waitForSelector(row, { timeout: 10000 }).catch(() => {});
    check(!!(await page.$(row)), 'live: shows up in the low-priority view');

    // Move it back from the menu.
    await menuOn();
    await page.click('[data-testid=chat-menu-lowpri]');
    await page.waitForSelector(row, { state: 'detached', timeout: 5000 }).catch(() => {});
    check(!(await page.$(row)), 'menu « Remettre… »: leaves the low-priority view');
    await toView();
    check(!!(await page.$(row)), 'menu « Remettre… »: back in the inbox at once');
    // Still there once the delayed list refetches have run.
    await page.waitForTimeout(6500);
    check(!!(await page.$(row)), 'menu « Remettre… »: still in the inbox after the refetch');
    f = await flags();
    check(!f.isLowPriority && f.isMuted === start.isMuted, `mute back to its starting value (${JSON.stringify(f)})`);

    // Phone layout: header buttons fit.
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(300);
    const fits = await page.$eval('.list-header', (h) => h.scrollWidth <= h.clientWidth);
    check(fits, 'phone: header does not overflow');
    await shot(page, 'lowpri-phone');
    await page.setViewportSize({ width: 1200, height: 800 });
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    // Restore: not low priority, starting mute, archived.
    const end = await page
      .evaluate(
        async ({ id, muted }) => {
          const p = `/api/chats/${encodeURIComponent(id)}`;
          const j = (m, path, body) => fetch(path, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          let c = await (await fetch(p)).json();
          if (c.isLowPriority) await j('PATCH', p, { isLowPriority: false });
          c = await (await fetch(p)).json();
          if (!!c.isMuted !== muted) await j('PATCH', p, { isMuted: muted });
          await j('POST', `${p}/archive`, { archived: true });
          await new Promise((r) => setTimeout(r, 1500));
          c = await (await fetch(p)).json();
          return { isArchived: !!c.isArchived, isMuted: !!c.isMuted, isLowPriority: !!c.isLowPriority };
        },
        { id: TEST_CHAT, muted: start ? start.isMuted : false },
      )
      .catch((e) => ({ error: String(e) }));
    console.log(`     test chat at end: ${JSON.stringify(end)}`);
    check(end.isArchived && !end.isLowPriority && (!start || end.isMuted === start.isMuted), 'test chat ends archived, as it started');
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.blocked.length === 0, 'no write attempted on a real chat');
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
