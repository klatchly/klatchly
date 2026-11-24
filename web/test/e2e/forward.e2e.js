// Forward (0.14.21): from the message menu (text, a photo with its caption) and from the media page's multi-select,
// through the chat picker, then the result toast with "Open chat"; the copies arrive (server-side upload of the
// original: nothing goes through the browser). The picker's capability hints are checked read-only on the list.
// Writes: ONLY into the test chat, from the test chat (lib.js aborts any /api/forward whose sources or targets are
// not all the test chat, and every write to another chat); the test chat is re-archived at the end.
// sh web/test/e2e/run-offline.sh forward.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

const enc = encodeURIComponent;
const chatURL = (id, sub) => `${BASE}/chat/${enc(id)}${sub ? `/${sub}` : ''}`;
const PANEL = '[data-testid=forward-panel]';

const messages = (page) =>
  page.evaluate(async (id) => (await (await fetch(`/api/chats/${encodeURIComponent(id)}/messages`)).json()).items, TEST_CHAT);

async function poll(fn, ms = 30000, step = 1500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** Picks the test chat in the open picker (searched by title) and sends; the /api/forward answer. */
async function sendToTestChat(page, title) {
  await page.waitForSelector(PANEL);
  await page.fill('[data-testid=forward-search]', title.slice(0, 40));
  const row = `[data-testid=forward-chat][data-chat-id="${TEST_CHAT}"]`;
  await page.waitForSelector(row, { timeout: 15000 });
  check(await page.isEnabled(row), 'the test chat can take it');
  await page.click(row);
  check((await page.getAttribute(row, 'aria-pressed')) === 'true', 'test chat picked');
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/forward'), { timeout: 120000 }), page.click('[data-testid=forward-send]')]);
  const req = JSON.parse(res.request().postData());
  check(req.to.length === 1 && req.to[0] === TEST_CHAT && req.from.every((f) => f.chatID === TEST_CHAT && Object.keys(f).every((k) => ['chatID', 'messageID', 'attachment'].includes(k))), `request names messages only (${JSON.stringify(req.from.map((f) => [f.messageID, f.attachment]))})`);
  const body = await res.json();
  await page.waitForSelector('[data-testid=forward-toast]', { timeout: 5000 });
  return { status: res.status(), body };
}

(async () => {
  const { browser, page, csp, blocked } = await open();
  await enroll(page);
  const tag = Date.now().toString(36);
  try {
    const chat = await page.evaluate(async (id) => (await fetch(`/api/chats/${encodeURIComponent(id)}`)).json(), TEST_CHAT);
    const title = chat.title;
    console.log(`     test chat "${title}"`);
    await page.goto(chatURL(TEST_CHAT));
    await page.waitForSelector('[data-testid=composer-input]', { timeout: 20000 });
    await page.waitForTimeout(1000);

    // Safety net first: a forward to another chat never leaves the page.
    const leak = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/forward', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: [{ chatID: 'x', messageID: 'y' }], to: ['!not-the-test-chat:beeper.com'] }) });
        return r.status;
      } catch {
        return 'aborted';
      }
    });
    check(leak === 'aborted' && blocked.some((b) => b.includes('/api/forward')), `a forward to another chat is aborted by the test guard (${leak})`);
    blocked.length = 0;

    // 1. Text: a fresh message, forwarded from its menu.
    const text = `forward e2e ${tag}`;
    await page.fill('[data-testid=composer-input]', text);
    await page.click('[data-testid=send]');
    const src = await poll(async () => (await messages(page)).find((m) => m.text === text && !m.id.startsWith('~')));
    check(!!src, 'source text message stored');
    await page.waitForSelector(`[data-mid="${src.id}"]`, { timeout: 15000 });
    await page.waitForTimeout(800);
    await page.click(`[data-mid="${src.id}"] [data-testid=bubble]`, { button: 'right' });
    await page.click('[data-testid=menu-forward]');
    await page.waitForSelector(PANEL);
    // (A connector package's own hints in this picker, its chats offered or not for a text or a photo: in its own
    // scripts, ext/<id>/test/.)
    await shot(page, 'forward-picker');
    const r1 = await sendToTestChat(page, title);
    check(r1.status === 200 && r1.body.results[0].ok && r1.body.results[0].sent === 1, `text forwarded (${JSON.stringify(r1.body)})`);
    const toast = await page.textContent('[data-testid=forward-toast]');
    check(toast.includes(title.slice(0, 10)) && (await page.isVisible('[data-testid=forward-open]')), `toast with Open chat (${toast.trim()})`);
    const copies = await poll(async () => ((await messages(page)).filter((m) => m.text === text).length >= 2 ? true : null));
    check(!!copies, 'the forwarded text arrived in the test chat');

    // 2. A photo with its caption, from the menu of its album tile.
    const before = Date.now();
    const msgs = await messages(page);
    const photo = msgs.find((m) => !m.isDeleted && m.text && (m.attachments || []).some((a) => a.type === 'img' && !a.isSticker && !a.isGif));
    check(!!photo, `a captioned photo in the test chat (${photo && photo.attachments[0].fileName})`);
    if (photo) {
      const el = (await page.$(`[data-tile-mid="${photo.id}"]`)) ?? (await page.$(`[data-mid="${photo.id}"] [data-testid=bubble]`));
      await el.click({ button: 'right' });
      await page.click('[data-testid=menu-forward]');
      await page.waitForSelector(PANEL);
      const r2 = await sendToTestChat(page, title);
      check(r2.status === 200 && r2.body.results[0].ok && r2.body.results[0].sent === 1, `photo forwarded with its caption in one message (${JSON.stringify(r2.body)})`);
      const name = photo.attachments[0].fileName;
      const got = await poll(async () => (await messages(page)).find((m) => Date.parse(m.timestamp) > before - 5000 && m.id !== photo.id && (m.attachments || []).some((a) => a.fileName === name)));
      check(!!got, `the photo arrived (${name})`);
      if (got) check(got.text === photo.text && got.attachments[0].size?.width === photo.attachments[0].size?.width, 'same caption and size');
    }

    // 3. Two pictures from the media page's selection; then "Open chat".
    const before3 = Date.now();
    await page.goto(chatURL(TEST_CHAT, 'media'));
    await page.waitForSelector('[data-testid=media-cell]', { timeout: 20000 });
    await page.click('[data-testid=media-select]');
    await page.locator('[data-testid=media-cell]').nth(1).click();
    await page.locator('[data-testid=media-cell]').nth(2).click();
    await page.click('[data-testid=media-forward]');
    check((await page.textContent('[data-testid=forward-what]')).includes('2'), 'picker says 2 messages');
    const r3 = await sendToTestChat(page, title);
    check(r3.status === 200 && r3.body.results[0].ok && r3.body.results[0].sent >= 2, `two pictures forwarded (${JSON.stringify(r3.body)})`);
    await shot(page, 'forward-toast');
    await page.click('[data-testid=forward-open]');
    await page.waitForTimeout(800);
    check(page.url() === chatURL(TEST_CHAT), 'Open chat goes to the chat');
    const got3 = await poll(async () => ((await messages(page)).filter((m) => Date.parse(m.timestamp) > before3 - 5000 && (m.attachments || []).length).length >= 2 ? true : null));
    check(!!got3, 'both pictures arrived');
    await shot(page, 'forward-arrived');
  } finally {
    // Back to the archive (sending unarchives it; a late echo of the last copy can unarchive it again: retry).
    let arch = {};
    for (let i = 0; i < 4 && arch.isArchived !== true; i++) {
      await page.waitForTimeout(i ? 4000 : 3000);
      arch = await page
        .evaluate(async (id) => {
          const r = await fetch(`/api/chats/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
          await new Promise((res) => setTimeout(res, 2000));
          const c = await (await fetch(`/api/chats/${encodeURIComponent(id)}`)).json();
          return { status: r.status, isArchived: c.isArchived };
        }, TEST_CHAT)
        .catch((e) => ({ error: String(e) }));
    }
    console.log(`     test chat re-archived: ${JSON.stringify(arch)}`);
    check(arch.isArchived === true, 'test chat archived again');
  }
  check(!blocked.length, `no write to another chat (${blocked.join(', ') || 'none'})`);
  await logout(page);
  await browser.close();
  done(csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
