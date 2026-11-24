// Stored copy + background loading (0.4.1), wipe on sign-out (0.4.2), read-only (the lib.js guard aborts writes to real chats).
// sh web/test/e2e/run-offline.sh persist.e2e.js
const { BASE, check, open, enroll, logout, shot, done } = require('./lib');

const stored = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('klatchly-cache', 1);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          const get = db.transaction('kv').objectStore('kv').get('queries');
          get.onsuccess = () => {
            const s = get.result;
            db.close();
            resolve(s ? { buster: s.buster, keys: s.state.queries.map((q) => q.queryKey[0]) } : null);
          };
          get.onerror = () => resolve(null);
        };
      }),
  );

// Milliseconds from the click on a chat row to its first message on screen, timed in the page.
async function openChat(page, id) {
  await page.evaluate(() => {
    const start = performance.now();
    window.__open = new Promise((resolve) => {
      const mo = new MutationObserver(() => {
        if (!document.querySelector('[data-testid=msg]')) return;
        mo.disconnect();
        resolve(Math.round(performance.now() - start));
      });
      mo.observe(document.body, { subtree: true, childList: true });
    });
  });
  await page.click(`[data-testid=chat-row][data-chat-id="${id}"]`);
  return page.evaluate(() => window.__open);
}

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page, ctx } = s;
  const fetched = new Set();
  const answered = new Set();
  const msgsOf = (u) => /\/api\/chats\/([^/?]+)\/messages(\?|$)/.exec(u);
  page.on('request', (r) => {
    const m = msgsOf(r.url());
    if (m && r.method() === 'GET') fetched.add(decodeURIComponent(m[1]));
  });
  page.on('response', (r) => {
    const m = msgsOf(r.url());
    if (m && r.ok()) answered.add(decodeURIComponent(m[1]));
  });
  // Slow network for the chat list and conversations, when switched on.
  let slow = false;
  await ctx.route('**/api/chats**', async (route) => {
    if (slow && route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 4000));
    return route.fallback();
  });

  await enroll(page);
  await page.waitForTimeout(8000);
  console.log(`     conversations loaded in the background: ${fetched.size}`);
  check(fetched.size >= 3 && fetched.size <= 14, 'top conversations prefetched (3..14)');
  const snap = await stored(page);
  const n = (k) => snap?.keys.filter((x) => x === k).length ?? 0;
  console.log(`     stored copy: ${JSON.stringify({ buster: snap?.buster, chats: n('chats'), messages: n('messages'), other: snap?.keys.filter((k) => !['chats', 'messages'].includes(k)) })}`);
  check(n('chats') === 1 && n('messages') >= 3, 'chat list and conversations stored in IndexedDB');

  // A prefetched chat opens without waiting for the network.
  const ids = await page.$$eval('[data-testid=chat-row]', (els) => els.map((e) => e.getAttribute('data-chat-id')));
  const target = ids.find((id) => fetched.has(id));
  slow = true;
  const openMs = await openChat(page, target);
  check(openMs < 300, `prefetched chat shows its messages at once (${openMs} ms, network delayed 4 s)`);

  // Reload with a slow network: the list and the conversation come from the stored copy.
  await page.goto(`${BASE}/`);
  const t0 = Date.now();
  await page.waitForSelector('[data-testid=chat-row]');
  const listMs = Date.now() - t0;
  check(listMs < 2000, `chat list shown from the stored copy after reload (${listMs} ms, network delayed 4 s)`);
  answered.clear();
  const reopenMs = await openChat(page, target);
  check(reopenMs < 300, `conversation shown from the stored copy (${reopenMs} ms)`);
  await shot(page, 'persist-reload');
  slow = false;
  // The server copy then replaces it.
  await page.waitForTimeout(6000);
  check(answered.has(target), `the open conversation is then refreshed from the server (${answered.size} loaded)`);

  // Local traces before sign-out: a draft (typed only, never sent), learned names, a picture in the HTTP cache.
  await page.fill('[data-testid=composer-input]', 'brouillon e2e (jamais envoyé)');
  await page.waitForTimeout(800);
  const traces = () => page.evaluate(() => ({ drafts: localStorage.getItem('drafts'), names: localStorage.getItem('klatchly.names.v1') }));
  const before = await traces();
  console.log(`     before sign-out: names ${before.names ? JSON.parse(before.names).length : 0}`);
  check(!!before.drafts?.includes('brouillon e2e'), 'draft stored before sign-out');
  // (Playwright routing turns the HTTP cache off: the picture cache is checked by clearcache.e2e.js.)

  // Sign-out wipes everything read in the app; a reload then shows the login, not old chats.
  const logoutRes = page.waitForResponse((r) => r.url().endsWith('/api/auth/logout'));
  await logout(page);
  check((await (await logoutRes).headerValue('clear-site-data')) === '"cache"', 'logout answers Clear-Site-Data: "cache"');
  await page.waitForTimeout(500);
  check((await stored(page)) === null, 'stored copy deleted on sign-out');
  const after = await traces();
  check(after.drafts === null && after.names === null, 'drafts and learned names deleted on sign-out');
  await page.goto(`${BASE}/`);
  await page.waitForSelector('[data-testid=unlock]');
  check((await page.$$('[data-testid=chat-row]')).length === 0, 'no chat visible after sign-out and reload');

  console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
