// A WeChat Channels video shared in a chat (server/wechatshare.ts): a card in the bubble, line breaks kept and the
// bridge's double escaping undone. Offline only: the test chat's messages are patched in the browser with an invented
// share in the bridge's shape. sh web/test/e2e/run-offline.sh channelscard.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

(async () => {
  const msg = {
    id: 'channels-e2e-1', chatID: TEST_CHAT, accountID: 'wechat.wxid_example0001', senderID: '@wechat_wxid_example0002:beeper.local',
    senderName: 'Alice Martin', timestamp: new Date().toISOString(), sortKey: '999999999', type: 'TEXT', isSender: false,
    text: 'Channels: Lumière简\nSpring Dance Day 💃\nThanks @ExampleDanceStudio!!! \n\n📍Lyon A&amp;amp;B Dance Center\n\n#dance #里昂\nOpen WeChat to view it.',
  };
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  await page.route(`**/api/chats/${encodeURIComponent(TEST_CHAT)}/messages**`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const r = await route.fetch();
    if (!r.ok() || !String(r.headers()['content-type']).includes('json')) return route.fulfill({ response: r });
    const body = await r.json();
    await route.fulfill({ response: r, json: { ...body, items: [msg, ...(body.items ?? [])] } });
  });
  await enroll(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
  await page.waitForSelector('[data-testid=channels-card]', { timeout: 15000 });
  const card = await page.$eval('[data-testid=channels-card]', (el) => ({
    title: el.querySelector('.call-title')?.textContent,
    kind: el.querySelector('.call-when')?.textContent,
    desc: el.querySelector('.channels-desc')?.textContent,
    lines: el.querySelector('.channels-desc')?.getClientRects()[0]?.height ?? 0,
    hint: el.querySelector('.kind-hint')?.textContent,
  }));
  console.log(`     card: ${JSON.stringify(card)}`);
  check(card.title === 'Lumière简' && card.kind === 'Vidéo WeChat Channels', 'card: author, then the kind');
  check(card.desc?.includes('Lyon A&B Dance Center') && !card.desc.includes('&amp;'), 'description: "&" decoded once per escape');
  check(card.desc?.includes('\n') && card.lines > 60 && !card.desc.includes('Open WeChat'), 'description: line breaks kept, closing line dropped');
  check(card.hint === 'Ouvrez WeChat pour la regarder.', 'card: where to watch it');
  await page.locator('[data-testid=channels-card]').scrollIntoViewIfNeeded();
  await shot(page, 'channels-card-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'channels-card-dark');
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
