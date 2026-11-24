// Scheduled call messages (WhatsApp call events): a card in the bubble, a one-line list preview. Offline only: the
// test chat's list entry and messages are patched in the browser with the sanitized fixture (build-test, from
// `npm test`). sh web/test/e2e/run-offline.sh callcard.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

(async () => {
  const { callMessage, callPreviewText } = await import('../../build-test/test/fixtures/callevent.js');
  // Starts tomorrow at 14:00 in Paris (13:00 UTC in winter), so the card says "demain à 14:00".
  const d = new Date(Date.now() + 86_400_000);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 0)).toUTCString().replace('GMT', 'UTC');
  const at = (s) => s.replace('Tue, 03 Nov 2026 05:00:00 UTC', start);
  const msg = { ...callMessage, chatID: TEST_CHAT, timestamp: new Date().toISOString(), text: at(callMessage.text) };

  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Paris' });
  // The test chat becomes a group whose latest message is the call.
  await page.route('**/api/chats?**', async (route) => {
    const r = await route.fetch();
    if (!r.ok() || !String(r.headers()['content-type']).includes('json')) return route.fulfill({ response: r });
    const body = await r.json();
    // The (archived) test chat moved to the top of the inbox.
    if (!route.request().url().includes('cursor=')) {
      const chat = await (await page.request.get(`${BASE}/api/chats/${encodeURIComponent(TEST_CHAT)}`)).json();
      body.items = [chat, ...(body.items ?? []).filter((c) => c.id !== TEST_CHAT)];
    }
    for (const c of body.items ?? []) if (c.id === TEST_CHAT) Object.assign(c, { type: 'group', title: 'Call group', isArchived: false, lastActivity: msg.timestamp, preview: { ...msg, text: at(callPreviewText) } });
    await route.fulfill({ response: r, json: body });
  });
  await page.route(`**/api/chats/${encodeURIComponent(TEST_CHAT)}/messages**`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const r = await route.fetch();
    if (!r.ok() || !String(r.headers()['content-type']).includes('json')) return route.fulfill({ response: r });
    const body = await r.json();
    await route.fulfill({ response: r, json: { ...body, items: [msg, ...(body.items ?? [])] } });
  });
  await enroll(page);

  const preview = await page.textContent(`[data-testid=chat-row][data-chat-id="${TEST_CHAT}"] .chat-preview`);
  console.log(`     preview: ${preview}`);
  check(/^Alice Martin\s*: 📞 Appel vidéo · .+14:00$/.test(preview ?? '') && !preview.includes('#'), 'list preview: "📞 Appel vidéo · <date> 14:00", no Markdown');

  await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
  await page.waitForSelector('[data-testid=call-card]', { timeout: 15000 });
  const card = await page.$eval('[data-testid=call-card]', (el) => ({
    title: el.querySelector('.call-title')?.textContent,
    when: el.querySelector('[data-testid=call-when]')?.textContent,
    tip: el.querySelector('[data-testid=call-when]')?.getAttribute('title'),
    items: el.querySelectorAll('.call-desc li').length,
    href: el.querySelector('[data-testid=call-join]')?.getAttribute('href'),
    rel: el.querySelector('[data-testid=call-join]')?.getAttribute('rel'),
    join: el.querySelector('[data-testid=call-join]')?.textContent,
    aria: el.querySelector('[data-testid=call-join]')?.getAttribute('aria-label'),
  }));
  console.log(`     card: ${JSON.stringify(card)}`);
  check(card.title === 'Appel vidéo' && card.when === 'demain à 14:00', 'card: kind, start relative in the local time zone');
  check(!!card.tip && card.tip.includes('14:00') && /\d{4}/.test(card.tip), 'card: absolute date in the tooltip');
  check(card.items === 2, 'card: description list kept');
  check(card.href === 'https://call.whatsapp.com/video/FakeToken123abc' && card.join === 'Rejoindre' && card.rel.includes('noopener'), 'card: join button opens the link');
  check(/^Rejoindre Appel vidéo, .*14:00 \(nouvel onglet\)$/.test(card.aria ?? ''), 'card: join button says what, when, and that it opens a tab');
  check((await page.$$(`[data-mid="${msg.id}"] .link-card`)).length === 0, 'no link preview under the card');
  await shot(page, 'callcard-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'callcard-dark');

  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
