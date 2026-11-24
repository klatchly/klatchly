// Quiet hours (Heures calmes), offline only (a message comes from the fake Desktop API's hook into the WhatsApp group;
// without INJECT_URL the script stops). Settings → Heures calmes: WhatsApp gets a window open now; the Quiet tab
// appears; a WhatsApp message then waits under it (out of the chats, counted on its tab) instead of the inbox; "Les
// afficher maintenant" puts it back. (Another connector's quiet hours: its package's scripts, ext/<id>/test/.)
// Per chat: a chat's menu → Heures calmes… → Jamais en pause; Settings lists it, and puts it back on its network's.
// sh web/test/e2e/run-offline.sh quiet.e2e.js
const { BASE, check, step, open, enroll, settingsPage, shot, done } = require('./lib');

const injectURL = process.env.INJECT_URL;
const hooks = injectURL && injectURL.replace(/inject$/, '');
const GROUP = process.env.GROUP_CHAT || '!hikers:beeper.local';
const ACCOUNT = 'whatsapp';

/** Polls a reading of the page until `ok` (the app's CSP refuses waitForFunction's evaluation). */
async function until(read, ok, ms = 10000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (ok(await read().catch(() => null))) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

(async () => {
  if (!hooks) {
    console.log('     offline only (no INJECT_URL): skipped');
    return done([]);
  }
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  try {
    await enroll(page);
    await page.setViewportSize({ width: 1280, height: 860 });
    check(!(await page.isVisible('[data-testid=open-quiet]')), 'no Quiet tab before any quiet hours');

    // ── Settings → Heures calmes: WhatsApp, a window open now (from 10 min ago to 10 min from now, the browser's time) ──
    await settingsPage(page, 'quiet');
    await page.waitForSelector(`[data-testid=quiet-toggle-${ACCOUNT}]`, { timeout: 15000 });
    check((await page.getAttribute(`[data-testid=quiet-toggle-${ACCOUNT}]`, 'aria-checked')) === 'false', 'WhatsApp: off at first');
    await page.click(`[data-testid=quiet-toggle-${ACCOUNT}]`);
    await page.waitForSelector(`[data-testid=quiet-rule-${ACCOUNT}]`, { timeout: 5000 });
    const now = new Date();
    const from = hm(new Date(now.getTime() - 10 * 60_000));
    const to = hm(new Date(now.getTime() + 10 * 60_000));
    await page.fill(`[data-testid=quiet-rule-${ACCOUNT}-from]`, from);
    await page.fill(`[data-testid=quiet-rule-${ACCOUNT}-to]`, to);
    await page.click(`[data-testid=quiet-rule-${ACCOUNT}-save]`);
    await until(() => page.textContent(`[data-testid=quiet-state-${ACCOUNT}]`), (x) => /–/.test(x ?? ''));
    const summary = await page.textContent(`[data-testid=quiet-state-${ACCOUNT}]`);
    check(summary.includes(from) && summary.includes(to) && /Tous les jours/.test(summary), `the window is saved and summarised (${summary})`);
    check((await page.getAttribute(`[data-testid=quiet-toggle-${ACCOUNT}]`, 'aria-checked')) === 'true', 'WhatsApp: on');
    const stored = await page.evaluate(async () => (await fetch('/api/quiet')).json());
    check(!!stored.accounts[ACCOUNT] && stored.accounts[ACCOUNT].days.length === 7, 'the server keeps the rule');
    await shot(page, 'quiet-settings');

    // ── A WhatsApp message during the window: held ──
    await page.goto(`${BASE}/`);
    await page.waitForSelector('[data-testid=chat-row]', { timeout: 20000 });
    check(await page.isVisible('[data-testid=open-quiet]'), 'the Quiet tab shows once quiet hours exist');
    await fetch(`${hooks}inject/group`, { method: 'POST', body: 'pendant les heures calmes' });
    await page.waitForSelector('[data-testid=quiet-count]', { timeout: 20000 });
    // Counted with the account's other held chats that have unread messages (the canned WhatsApp has some).
    const held = Number(await page.textContent('[data-testid=quiet-count]'));
    await page.waitForTimeout(500);
    check(!(await page.isVisible(`[data-testid=chat-row][data-chat-id="${GROUP}"]`)), 'the held chat is out of the inbox');
    await page.click('[data-testid=open-quiet]');
    await page.waitForSelector(`[data-testid=chat-row][data-chat-id="${GROUP}"]`, { timeout: 10000 });
    check(/attend/.test((await page.textContent('[data-testid=quiet-head]')) ?? ''), 'the Quiet list says it waits');
    const unreadRows = await page.$$eval('.pane-list [data-testid=chat-row]', (rs) => rs.filter((r) => r.classList.contains('unread')).length);
    check(held >= 1 && held === unreadRows, `the tab counts the held chats with unread messages (${held}, ${unreadRows} listed)`);
    await shot(page, 'quiet-list');

    // "Show them now": back in the chats.
    await page.click('[data-testid=quiet-release]');
    await page.waitForSelector('[data-testid=toast]', { timeout: 5000 });
    await page.waitForSelector('[data-testid=quiet-count]', { state: 'detached', timeout: 10000 });
    check(/Rien/.test((await page.textContent('[data-testid=quiet-head]')) ?? ''), 'the Quiet list is empty');
    await page.click('[data-testid=tab-chats]');
    await page.waitForSelector(`[data-testid=chat-row][data-chat-id="${GROUP}"]`, { timeout: 10000 });
    step('released: the chat is back in the inbox');
    // A new message after the release is held again (the window is still open).
    await fetch(`${hooks}inject/group`, { method: 'POST', body: 'encore un' });
    await page.waitForSelector('[data-testid=quiet-count]', { timeout: 20000 });
    step('a later message is held again');

    // ── Per chat: never quiet ──
    await page.click('[data-testid=open-quiet]');
    await page.waitForSelector(`[data-testid=chat-row][data-chat-id="${GROUP}"]`, { timeout: 10000 });
    await page.click(`[data-testid=chat-row][data-chat-id="${GROUP}"]`, { button: 'right' });
    await page.click('[data-testid=chat-menu-quiet]', { timeout: 5000 });
    await page.waitForSelector('[data-testid=quiet-dialog]', { timeout: 5000 });
    check((await page.isChecked('[data-testid=quiet-choice-account]')), 'the dialog: "like its network" at first');
    await shot(page, 'quiet-dialog');
    await page.click('[data-testid=quiet-choice-never]');
    await page.waitForSelector('[data-testid=quiet-dialog]', { state: 'detached', timeout: 5000 });
    await page.waitForSelector('[data-testid=quiet-count]', { state: 'detached', timeout: 10000 });
    step('never quiet: the chat is not held any more');
    await settingsPage(page, 'quiet');
    await page.waitForSelector('[data-testid=quiet-chat-0]', { timeout: 10000 });
    check(/Jamais/.test((await page.textContent('[data-testid=quiet-chat-0]')) ?? ''), 'Settings lists the chat and its setting');
    await page.click('[data-testid=quiet-chat-reset-0]');
    await page.waitForSelector('[data-testid=quiet-chat-0]', { state: 'detached', timeout: 10000 });
    step('back to its network’s');

    // Off again: the tab goes.
    await page.click(`[data-testid=quiet-toggle-${ACCOUNT}]`);
    check(await until(() => page.getAttribute(`[data-testid=quiet-toggle-${ACCOUNT}]`, 'aria-checked'), (x) => x === 'false'), 'WhatsApp: off again');
    await page.goto(`${BASE}/`);
    await page.waitForSelector('[data-testid=chat-row]', { timeout: 20000 });
    check(!(await page.isVisible('[data-testid=open-quiet]')), 'no quiet hours left: no Quiet tab');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    await s.browser.close();
  }
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
