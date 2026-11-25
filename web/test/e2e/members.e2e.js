// Arrivals and departures in groups (0.28.0): "X joined the chat" / "X was invited to the chat" (no type, as
// beeper-server sends them) drawn as one discreet line, grouped by default; one by one or hidden from Settings →
// Reading; hidden or shown again from a chat's menu. The events are added to a group's messages as served (the
// fakes have none). Writes: none to chats (the choices go to the instance's data volume).
// sh web/test/e2e/run-offline.sh members.e2e.js
const { BASE, check, open, enroll, settingsPage, leaveSettings, logout, shot, done } = require('./lib');

const GROUP = '!hikers:beeper.local';
const chatURL = `${BASE}/chat/${encodeURIComponent(GROUP)}`;
const row = `[data-testid=chat-row][data-chat-id="${GROUP}"]`;

async function withEvents(page) {
  await page.route(/\/api\/chats\/[^/]+\/messages(?:\?|$)/, async (r) => {
    if (r.request().method() !== 'GET' || !decodeURIComponent(r.request().url()).includes(GROUP)) return r.fallback();
    const res = await r.fetch();
    const body = await res.json();
    const items = body.items ?? [];
    if (!items.length || r.request().url().includes('cursor=')) return r.fulfill({ response: res, json: body });
    // Newest first: three events just before the newest message.
    const at = new Date(Date.parse(items[0].timestamp) - 60_000);
    const ev = (id, text, sender, s) => ({ id, chatID: GROUP, accountID: items[0].accountID, senderID: sender, senderName: sender, text, timestamp: new Date(at.getTime() + s * 1000).toISOString(), sortKey: String(at.getTime() + s), isSender: false });
    const events = [ev('$mem3', 'Bao joined the chat', '@bao:beeper.local', 3), ev('$mem2', 'Ana joined the chat', '@ana:beeper.local', 2), ev('$mem1', 'Ana was invited to the chat', '@whatsappbot:beeper.local', 1)];
    body.items = [items[0], ...events, ...items.slice(1)];
    return r.fulfill({ response: res, json: body });
  });
}

const lines = (page) => page.$$eval('[data-testid=members-line]', (els) => els.map((e) => e.textContent.trim()));

async function openChat(page) {
  await page.goto(chatURL);
  await page.waitForSelector('[data-testid=composer-input]', { timeout: 20000 });
  await page.waitForTimeout(800);
}

(async () => {
  const s = await open();
  const { page } = s;
  try {
    await enroll(page);
    await withEvents(page);
    await openChat(page);

    // Default: one grouped line, the invitation of someone who joined not repeated.
    let l = await lines(page);
    check(l.length === 1 && /^Joined: Ana and Bao/.test(l[0]), `one grouped line (${JSON.stringify(l)})`);
    check(!(await page.$$eval('.msg', (els) => els.some((e) => /joined the chat|was invited/.test(e.textContent)))), 'no bubble for them');
    await page.click('[data-testid=members-toggle]');
    const items = await page.$$eval('[data-testid=members-list] li', (els) => els.length);
    check(items === 3, `the line unfolds into each event (${items})`);
    await shot(page, 'members-grouped');

    // Settings → Reading: one by one, then hidden.
    await settingsPage(page, 'reading');
    check((await page.getAttribute('[data-testid=members-mode]', 'data-value')) === 'group', 'the setting shows Grouped');
    await page.click('[data-testid=members-mode-each]');
    await page.waitForSelector('[data-testid=members-mode][data-value=each]');
    await shot(page, 'members-setting');
    await leaveSettings(page);
    await openChat(page);
    l = await lines(page);
    check(l.length === 2 && l[0] === 'Ana joined' && l[1] === 'Bao joined', `one by one, the invitation folded into the arrival (${JSON.stringify(l)})`);

    await settingsPage(page, 'reading');
    await page.click('[data-testid=members-mode-hide]');
    await page.waitForSelector('[data-testid=members-mode][data-value=hide]');
    await leaveSettings(page);
    await openChat(page);
    check((await lines(page)).length === 0, 'hidden');

    // The chat's menu: shown again here (grouped, as all chats hide them), then back to hidden.
    await page.click(row, { button: 'right' });
    await page.waitForSelector('[data-testid=chat-menu]');
    await page.click('[data-testid=chat-menu-members-show]');
    await page.waitForTimeout(400);
    l = await lines(page);
    check(l.length === 1, `shown again in this chat (${JSON.stringify(l)})`);
    await page.click(row, { button: 'right' });
    await page.click('[data-testid=chat-menu-members-hide]');
    await page.waitForTimeout(400);
    check((await lines(page)).length === 0, 'hidden again from its menu');

    // Back to the default for the instance.
    await settingsPage(page, 'reading');
    await page.click('[data-testid=members-mode-group]');
    await page.waitForSelector('[data-testid=members-mode][data-value=group]');
    await leaveSettings(page);
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
