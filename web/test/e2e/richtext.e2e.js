// Hotfix: rich text (HTML) bodies rendered safely; optimistic sends reconciled. Sends ONLY to the test chat.
// sh web/test/e2e/run-offline.sh richtext.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

(async () => {
  const s = await open({ locale: 'en-US' });
  const { page } = s;
  let dialogs = 0;
  page.on('dialog', (d) => (dialogs++, d.dismiss()));
  await enroll(page);
  await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
  await page.waitForSelector('[data-testid=msg]');
  const stamp = Date.now().toString(36);

  const send = async (text) => {
    await page.fill('[data-testid=composer-input]', text);
    await page.click('[data-testid=send]');
  };
  await send(`rt ${stamp} https://example.org/x?y=1 and **bold** <tag> & \`code\``);
  await send(`xss ${stamp} [click](javascript:alert(1)) <img src=x onerror=alert(1)> <script>alert(2)</script>`);
  await send(`plain ${stamp} a < b`);
  // 0.18.16: a line's indent (the ✨ writes sub-items "   • ") stays in a rich body.
  await send(`ind ${stamp} **top**\n• item\n   • sub`);
  // Optimistic bubbles must turn into the real messages (no clock left behind).
  // (polling with $$: waitForFunction compiles code in the page and trips the CSP eval check)
  for (let i = 0; i < 50 && (await page.$$('[data-testid=msg-outgoing]')).length; i++) {
    if (i % 5 === 0) console.log('     pending:', JSON.stringify(await page.$$eval('[data-testid=msg-outgoing]', (els) => els.map((e) => e.dataset.status + ':' + e.textContent.slice(0, 20)))));
    await page.waitForTimeout(500);
  }
  check((await page.$$('[data-testid=msg-outgoing]')).length === 0, 'no optimistic bubble left pending');
  await page.waitForTimeout(500);

  const info = await page.$$eval('[data-testid=msg-text]', (els, st) =>
    els.filter((e) => e.textContent.includes(st)).map((e) => ({
      text: e.textContent,
      links: [...e.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      strong: !!e.querySelector('strong'),
      code: !!e.querySelector('code'),
      imgs: e.querySelectorAll('img,script').length,
    })), stamp);
  const rt = info.find((x) => x.text.startsWith('rt '));
  const xss = info.find((x) => x.text.startsWith('xss '));
  const plain = info.find((x) => x.text.startsWith('plain '));
  check(info.length === 4, `four sent messages rendered once each (${info.length})`);
  const ind = info.find((x) => x.text.startsWith('ind '));
  check(!!ind && ind.strong && ind.text.includes('\u00a0\u00a0\u00a0• sub'), `a line's indent kept in rich text (${JSON.stringify(ind?.text)})`);
  check(!!rt && rt.links.includes('https://example.org/x?y=1') && rt.strong && rt.code, 'link, bold and code rendered');
  check(!!rt && rt.text.includes('<tag> &') && !rt.text.includes('<a ') && !rt.text.includes('&lt;'), 'escaped text shown literally, no raw HTML');
  check(!!xss && xss.imgs === 0 && !xss.links.some((h) => /^javascript:/i.test(h || '')), 'no img/script elements, no javascript: link');
  check(!!plain && plain.text.endsWith('a < b'), 'plain "<" text literal');
  check(dialogs === 0, 'no script executed');
  const outer = await page.$$eval('[data-testid=msg-text]', (els) => els.some((e) => /<a href|<strong>/.test(e.textContent)));
  check(!outer, 'no literal tags in any bubble');
  await shot(page, 'hotfix-richtext-en');

  // Previews: archives list row of the test chat has no tags.
  await page.goto(BASE + '/');
  await page.click('[data-testid=open-archives]');
  await page.waitForSelector('[data-testid=chat-row]', { timeout: 15000 }).catch(() => {});
  const preview = await page.$$eval(`[data-testid=chat-row]`, (els, id) => els.filter((e) => e.dataset.chatId === id).map((e) => e.textContent), TEST_CHAT);
  check(preview.length === 0 || !/<\/?[a-z]+[ >]/i.test(preview[0]), `chat list preview without tags (${preview.length ? 'checked' : 'not in first page'})`);
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
