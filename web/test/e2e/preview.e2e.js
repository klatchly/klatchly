// Hotfix: link previews. Sends only to the test chat; SSRF probes go to the preview route directly.
// sh web/test/e2e/run-offline.sh preview.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page } = s;
  await enroll(page);

  // Server-side guard, through the real route.
  const probe = await page.evaluate(async () => {
    const get = async (u) => {
      const r = await fetch(u, { redirect: 'manual' });
      return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
    };
    const q = (u) => `/api/preview?url=${encodeURIComponent(u)}&lang=fr`;
    return {
      loop: await get(q('http://127.0.0.1:8080/healthz')),
      internal: await get(q('http://beeper-server:23373/v1/info')),
      meta: await get(q('http://169.254.169.254/latest/meta-data/')),
      docker: await get(q('http://172.17.0.1/')),
      ftp: await get(q('ftp://example.com/')),
      badLang: await get('/api/preview?url=https%3A%2F%2Fexample.com%2F&lang=xx'),
      unsigned: await get('/api/preview-img?u=https%3A%2F%2Fexample.com%2Fa.png&s=AAAA'),
      ok: await get(q('https://example.com/')),
    };
  });
  for (const k of ['loop', 'internal', 'meta', 'docker']) check(probe[k].status === 200 && !probe[k].body.title, `internal target refused: ${k}`);
  check(probe.ftp.status === 400 && probe.badLang.status === 400 && probe.unsigned.status === 400, 'bad scheme / lang / unsigned image -> 400');
  check(probe.ok.body?.title === 'Example Domain', `public page previewed (${probe.ok.body?.title})`);

  // UI: card under a message with a link (sent to the test chat).
  await page.goto(`${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`);
  await page.waitForSelector('[data-testid=composer-input]');
  const stamp = Date.now().toString(36);
  await page.fill('[data-testid=composer-input]', `preview ${stamp} https://github.com/beeper/desktop-api-js`);
  await page.click('[data-testid=send]');
  let card = null;
  for (let i = 0; i < 30 && !card; i++) {
    await page.waitForTimeout(500);
    card = await page.$$eval('[data-testid=msg]', (els, st) => {
      const el = els.find((e) => e.textContent.includes(st));
      const c = el?.querySelector('[data-testid=link-preview]');
      const img = c?.querySelector('img');
      return c ? { title: c.querySelector('.link-card-title')?.textContent, href: c.getAttribute('href'), img: img?.getAttribute('src')?.slice(0, 20), loaded: img ? img.complete && img.naturalWidth > 0 : null } : null;
    }, stamp);
  }
  check(!!card?.title, `preview card rendered (${card?.title})`);
  check(card?.href === 'https://github.com/beeper/desktop-api-js', 'card links to the URL');
  check(!card?.img || (card.img.startsWith('/api/preview-img') && card.loaded), `image proxied same-origin and loaded (${JSON.stringify(card && { img: card.img, loaded: card.loaded })})`);
  await shot(page, 'hotfix-preview-fr');
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
