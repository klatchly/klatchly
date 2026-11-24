// New conversation (pencil button in the chat list header): account chips, contact search, exact lookup hint,
// direct chat and group creation, errors, remembered account, phone sheet (a connector package's own accounts: in
// its scripts, ext/<id>/test/).
// Nothing is created or opened on a real network: POST /api/chats/start and POST /api/chats are answered by
// mocks in the page (the lib.js guard aborts them otherwise); the mocks hand back the TEST chat, so the app
// navigates there. Contact searches are real read-only GETs (QUERY, default "Ali": Alice, Alicia, Alina in the offline fake, offline/beeper.mjs).
// Phone-number lookups are mocked too (an exact lookup asks the network).
// Env: CODE (enroll), ACCOUNT (direct, default the Beeper account), GROUP_ACCOUNT (default WhatsApp),
// QUERY (default "Ali").
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

const QUERY = process.env.QUERY || 'Ali';
const enc = encodeURIComponent;

(async () => {
  const { browser, ctx, page, csp, blocked } = await open({ locale: 'fr-FR' });
  const writes = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && (p === '/api/chats' || p === '/api/chats/start')) writes.push({ path: p, body: r.postDataJSON() });
  });
  // The test chat as the "opened" conversation.
  let testChat;
  let startCalls = 0;
  let failNext = false;
  await page.route('**/api/chats/start', async (route) => {
    startCalls++;
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 404, json: { error: 'upstream', code: 'not_found' } });
    }
    return route.fulfill({ json: testChat });
  });
  await page.route(/\/api\/chats$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ json: testChat });
  });
  // Exact phone lookups never reach a network.
  await page.route(/\/api\/accounts\/[^/]+\/contacts\?query=%2B/, (route) => route.fulfill({ json: { items: [] } }));

  try {
    await enroll(page);
    testChat = await page.evaluate(async (id) => (await fetch(`/api/chats/${encodeURIComponent(id)}`)).json(), TEST_CHAT);
    check(testChat?.id === TEST_CHAT, 'test chat loaded (mock answer)');
    const accounts = await page.evaluate(async () => (await fetch('/api/accounts')).json());
    const byNet = (n) => accounts.find((a) => a.network === n);
    // WhatsApp by default: its bridge looks up phone numbers (Beeper's own account has no capabilities).
    const direct = accounts.find((a) => a.accountID === process.env.ACCOUNT) ?? byNet('WhatsApp') ?? accounts[0];
    const groupAcc = accounts.find((a) => a.accountID === process.env.GROUP_ACCOUNT) ?? byNet('WhatsApp');

    // Button: same size as the other header buttons.
    const nb = await page.locator('[data-testid=new-chat]').boundingBox();
    const sb = await page.locator('[data-testid=open-settings]').boundingBox();
    check(nb && sb && Math.round(nb.width) === Math.round(sb.width) && Math.round(nb.height) === Math.round(sb.height), `button sized like the others (${nb?.width}x${nb?.height})`);
    check((await page.getAttribute('[data-testid=new-chat]', 'aria-label')) === 'Nouvelle discussion', 'French label');

    await page.click('[data-testid=new-chat]');
    await page.waitForSelector('[data-testid=new-chat-panel]');
    check(await page.locator('.newchat.popover').isVisible(), 'desktop: popover');
    check((await page.locator('[data-testid=newchat-account]').count()) === accounts.length, `one chip per account (${accounts.length})`);

    // Account step.
    await page.click(`[data-testid=newchat-account][data-account="${direct.accountID}"]`);
    await page.waitForSelector(`[data-testid=newchat-step][data-account="${direct.accountID}"]`);
    const fs = await page.$eval('[data-testid=newchat-search]', (el) => getComputedStyle(el).fontSize);
    check(fs === '16px', `search field 16px (${fs})`);

    // Exact lookup hint (mocked, nothing found) + "open anyway" error path.
    await page.fill('[data-testid=newchat-search]', '+33 6 00 00 00 00');
    await page.waitForSelector('[data-testid=newchat-empty]', { timeout: 15000 });
    const hint = await page.textContent('[data-testid=newchat-hint]');
    check(/\+33600000000/.test(hint ?? ''), `phone number hint: ${hint}`);
    if (await page.isVisible('[data-testid=newchat-start-exact]')) {
      failNext = true;
      await page.click('[data-testid=newchat-start-exact]');
      await page.waitForSelector('[data-testid=newchat-error]');
      check(/introuvable/i.test((await page.textContent('[data-testid=newchat-error]')) ?? ''), 'not found: readable French error');
      const w = writes.at(-1);
      check(w?.path === '/api/chats/start' && w.body.user.phoneNumber === '+33600000000' && Object.keys(w.body).join() === 'accountID,user', 'exact start body {accountID, user:{phoneNumber}}');
    } else console.log('note: this account does not look up phone numbers (no "open anyway")');

    // Real (read-only) search, then a mocked start.
    await page.fill('[data-testid=newchat-search]', QUERY);
    await page.waitForSelector('[data-testid=contact-row]', { timeout: 40000 });
    await shot(page, 'newchat-desktop-results');
    // 0.18.13: someone one already talks with comes first and opens their chat as it is (no start call); the
    // start path is checked on someone new.
    const known = await page.locator('[data-testid=contact-row]:has([data-testid=contact-known])').count();
    console.log(`     results already in conversations: ${known}`);
    const first = page.locator('[data-testid=contact-row]:not(:has([data-testid=contact-known]))').first();
    const cid = await first.getAttribute('data-contact-id');
    await first.click();
    await page.waitForURL(`**/chat/${enc(TEST_CHAT)}`, { timeout: 15000 });
    check(!(await page.isVisible('[data-testid=new-chat-panel]')), 'panel closed after opening');
    const w = writes.at(-1);
    check(w?.path === '/api/chats/start' && w.body.accountID === direct.accountID && w.body.user.id === cid, 'start body: account + contact id');
    // Polled with evaluate: our CSP blocks waitForFunction's polling.
    let focused = false;
    for (let i = 0; i < 40 && !focused; i++) {
      focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'composer-input');
      if (!focused) await page.waitForTimeout(250);
    }
    check(focused, 'composer focused');

    // Remembered account.
    await page.goto(BASE + '/');
    await page.click('[data-testid=new-chat]');
    await page.waitForSelector('[data-testid=newchat-step]');
    check((await page.getAttribute('[data-testid=newchat-step]', 'data-account')) === direct.accountID, 'last account remembered');

    // Someone one already talks with (0.18.13): their chat opens as it is, no start call (on LinkedIn a start sends
    // them a first message).
    await page.fill('[data-testid=newchat-search]', QUERY);
    await page.waitForSelector('[data-testid=contact-row]', { timeout: 40000 });
    await page.waitForTimeout(800);
    const knownRow = page.locator('[data-testid=contact-row]:has([data-testid=contact-known])').first();
    console.log(`     rows: ${await page.locator('[data-testid=contact-row]').count()}, known: ${await knownRow.count()}, account: ${await page.getAttribute('[data-testid=newchat-step]', 'data-account')}`);
    if (await knownRow.count()) {
      const before = writes.length;
      await knownRow.click();
      await page.waitForURL('**/chat/**', { timeout: 15000 });
      check(writes.length === before && !(await page.isVisible('[data-testid=new-chat-panel]')), 'a person already in a conversation: their chat opens, nothing started');
      await page.goto(BASE + '/');
      await page.click('[data-testid=new-chat]');
      await page.waitForSelector('[data-testid=newchat-step]');
    } else check(false, 'a result already in conversations (the fake has one)');

    // Group (mocked create).
    if (groupAcc) {
      await page.click(`[data-testid=newchat-account][data-account="${groupAcc.accountID}"]`);
      await page.waitForSelector(`[data-testid=newchat-step][data-account="${groupAcc.accountID}"]`);
      if (await page.isVisible('[data-testid=newchat-group-toggle]')) {
        await page.click('[data-testid=newchat-group-toggle]');
        await page.fill('[data-testid=newchat-search]', QUERY);
        await page.waitForSelector('[data-testid=contact-row]', { timeout: 40000 }).catch(() => {});
        const rows = page.locator('[data-testid=contact-row]');
        const n = Math.min(2, await rows.count());
        check(await page.isDisabled('[data-testid=newchat-create]'), 'create disabled with nobody picked');
        for (let i = 0; i < n; i++) await rows.nth(i).click();
        if (await page.isVisible('[data-testid=newchat-title]')) await page.fill('[data-testid=newchat-title]', 'klatchly e2e');
        await shot(page, 'newchat-group');
        if (!(await page.isDisabled('[data-testid=newchat-create]'))) {
          await page.click('[data-testid=newchat-create]');
          await page.waitForURL(`**/chat/${enc(TEST_CHAT)}`, { timeout: 15000 });
          const g = writes.at(-1);
          check(g?.path === '/api/chats' && g.body.type === 'group' && g.body.participantIDs.length === n, `group body: ${JSON.stringify({ ...g?.body, participantIDs: g?.body.participantIDs.length })}`);
        } else console.log(`note: group needs more people than found (${n}): ${await page.textContent('[data-testid=newchat-count]')}`);
      } else console.log('note: no group creation on', groupAcc.network);
    }

    // Discord: its bridge cannot create DMs.
    const discord = byNet('Discord');
    if (discord) {
      await page.goto(BASE + '/');
      await page.click('[data-testid=new-chat]');
      await page.click(`[data-testid=newchat-account][data-account="${discord.accountID}"]`);
      await page.waitForSelector(`[data-testid=newchat-step][data-account="${discord.accountID}"] [data-testid=newchat-search]`);
      // The note follows the bridge capabilities (Discord's create_dm changed from false to true on 2026-10-30).
      const caps = await page.evaluate(async (id) => (await fetch(`/api/accounts/${encodeURIComponent(id)}/new-chat`)).json(), discord.accountID);
      const expectNote = !caps.start && !caps.group;
      const note = await page.waitForFunction(() => /Discord ne permet pas/.test(document.querySelector('[data-testid=newchat-step]')?.textContent ?? ''), null, { timeout: 5000 }).then(() => true, () => false);
      check(note === expectNote, `Discord: cannot-start note ${expectNote ? 'shown' : 'absent'} as the bridge says (start=${caps.start})`);
    }

    await page.keyboard.press('Escape');
    check(!(await page.isVisible('[data-testid=new-chat-panel]')), 'Escape closes');

    // Phone: bottom sheet.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US' });
    for (const c of await ctx.cookies()) await phone.addCookies([c]);
    await phone.route('**/api/chats/start', (r) => r.abort());
    await phone.route(/\/api\/chats$/, (r) => (r.request().method() === 'POST' ? r.abort() : r.fallback()));
    const pp = await phone.newPage();
    await pp.goto(BASE + '/');
    await pp.waitForSelector('[data-testid=new-chat]', { timeout: 30000 });
    await pp.tap('[data-testid=new-chat]');
    await pp.waitForSelector('[data-testid=new-chat-panel]');
    check(await pp.locator('.newchat.sheet').isVisible(), 'phone: bottom sheet');
    await pp.waitForTimeout(600); // slide-in animation
    const box = await pp.locator('.newchat.sheet').boundingBox();
    console.log(`     phone sheet box: ${JSON.stringify(box)}`);
    check(box && box.width <= 390 && box.y + box.height <= 845, 'phone: sheet on screen');
    await shot(pp, 'newchat-phone');
    await pp.close();
    await phone.close();

    check(startCalls >= 1, `start went to the mock (${startCalls}x)`);
    check(!blocked.length, `no write blocked by the guard ${blocked.join(', ')}`);
  } catch (e) {
    check(false, `exception: ${e.message}`);
    await shot(page, 'newchat-error').catch(() => {});
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await ctx.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await logout(page);
    await browser.close();
  }
  done(csp);
})();
