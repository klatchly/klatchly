// Reactions. Writes ONLY to the test chat (lib.js blocks anything else). Network rules of LINE-like chats
// (reactionCount = 1, allowed list) are simulated on the test chat by rewriting its capabilities in the
// browser (Playwright route): nothing in the app or the server is changed for the test.
// Real LINE chat: READ-ONLY rendering of an image reaction (LINE_QUERY finds the message).
// sh web/test/e2e/run-offline.sh reactions.e2e.js (INJECT_URL and LINE_QUERY from offline/run.mjs)
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');
const http = require('http');

const injectURL = process.env.INJECT_URL;
const post = (path, body) =>
  new Promise((resolve) => {
    if (!injectURL) return resolve(false);
    const req = http.request(injectURL.replace(/\/$/, '') + path, { method: 'POST' }, (res) => (res.resume(), resolve(res.statusCode === 200)));
    req.on('error', () => resolve(false));
    req.end(body);
  });
/** Reaction added/removed through the API, i.e. from "another device". */
const otherDevice = (mid, key, remove = false) => post('/react', JSON.stringify({ mid, key, remove }));

const enc = encodeURIComponent;
const serverMine = (page, mid) =>
  page.evaluate(
    async ({ chat, mid }) => {
      const r = await fetch(`/api/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(mid)}`);
      const m = await r.json();
      return (m.reactions || []).map((x) => x.reactionKey);
    },
    { chat: TEST_CHAT, mid },
  );
const pills = (page, mid) =>
  page.$$eval(`[data-mid="${mid}"] [data-testid=reaction]`, (els) =>
    els.map((e) => ({ text: e.textContent, mine: e.dataset.mine === '1', kind: e.dataset.kind, label: e.getAttribute('aria-label'), title: e.title, pop: e.classList.contains('pop') })),
  );
const lastMid = (page) => page.$$eval('[data-testid=msg]', (els) => els[els.length - 1].dataset.mid);
const topVisible = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid=messages] [data-virtuoso-scroller]');
    const r = sc.getBoundingClientRect();
    const el = [...document.querySelectorAll('[data-testid=msg]')].find((e) => e.getBoundingClientRect().bottom > r.top + 4);
    return el ? { id: el.dataset.mid, y: Math.round(el.getBoundingClientRect().top - r.top) } : null;
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openMenu(page, mid) {
  await page.hover(`[data-mid="${mid}"] [data-testid=bubble]`);
  // The hover row shows on hover only where the pointer can hover (@media (hover: hover)), or while focused.
  await page.focus(`[data-mid="${mid}"] [data-testid=msg-react]`);
  await page.click(`[data-mid="${mid}"] [data-testid=msg-react]`);
  await page.waitForSelector('[data-testid=message-menu]');
}

/** Test chat with rewritten capabilities (simulating a network); every other response untouched. */
async function simulateCaps(ctx, getCaps) {
  const patch = (c) => (c && c.id === TEST_CHAT ? { ...c, capabilities: getCaps() } : c);
  await ctx.route(/\/api\/chats(\/[^/?]+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    let j;
    try {
      j = await res.json();
    } catch {
      return route.fulfill({ response: res });
    }
    if (Array.isArray(j.items)) j.items = j.items.map(patch);
    else j = patch(j);
    return route.fulfill({ response: res, json: j });
  });
}

/** Second browser context on the same session (French), with the same write guard as lib.js. */
async function sameSession(s, opts) {
  const ctx = await s.browser.newContext({ viewport: { width: 1200, height: 800 }, storageState: await s.ctx.storageState(), ...opts });
  const blocked = [];
  await ctx.route('**/api/**', (route) => {
    const r = route.request();
    const u = new URL(r.url());
    const touches = u.pathname.startsWith('/api/chats/') || u.pathname.startsWith('/api/notify/');
    if (r.method() !== 'GET' && touches && !u.pathname.includes(enc(TEST_CHAT)) && !(r.postData() || '').includes(TEST_CHAT)) {
      blocked.push(`${r.method()} ${u.pathname.slice(0, 18)}…`);
      return route.abort();
    }
    return route.continue();
  });
  const csp = [];
  const page = await ctx.newPage();
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && csp.push(m.text()));
  return { ctx, page, blocked, csp };
}

(async () => {
  const s = await open({ locale: 'en-US' });
  const { page, ctx } = s;
  await enroll(page);
  // Count full list reloads of the test chat (live updates must not need them).
  let listLoads = 0;
  let step = 'start';
  const loadSteps = [];
  const wsLog = [];
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) => {
      try {
        const e = JSON.parse(f.payload);
        if (e.type !== 'chat.upserted') wsLog.push(`${e.type}${e.entries ? `[${e.entries.length}]` : ''}${e.entries?.[0]?.type ? ':' + e.entries[0].type : ''}`);
        if (wsLog.length > 4) wsLog.shift();
      } catch {}
    }),
  );
  page.on('request', (r) => {
    const u = new URL(r.url());
    // Reload of the newest page (older pages, with a cursor, are normal scrolling).
    if (r.method() === 'GET' && u.pathname === `/api/chats/${enc(TEST_CHAT)}/messages` && !u.searchParams.has('cursor')) {
      listLoads++;
      loadSteps.push(`${step} after ${wsLog.join(' > ')}`);
    }
  });

  // ---- 1. Native Beeper chat (no capabilities: anything goes) ----
  await page.goto(`${BASE}/chat/${enc(TEST_CHAT)}`);
  await page.waitForSelector('[data-testid=msg]');
  await page.waitForTimeout(1500);
  const mid = await lastMid(page);
  for (const k of await serverMine(page, mid)) await otherDevice(mid, k, true); // clean slate
  await page.waitForTimeout(2500);

  step = 'quickbar';
  await openMenu(page, mid);
  const quick = await page.$$eval('[data-testid=quick-reaction]', (els) => els.map((e) => e.textContent));
  check(quick.join(' ') === '❤️ 😂 😮 😢 👍 🙏', `default quick bar (${quick.join(' ')})`);
  const loadsBefore = listLoads;
  await page.click('[data-testid=quick-reaction] >> nth=0');
  let p = await pills(page, mid);
  check(p.length === 1 && p[0].text === '❤️' && p[0].mine && p[0].pop, `optimistic ❤️ pill, mine, pops in (${JSON.stringify(p)})`);
  check(/You/.test(p[0].label) && /click to remove/.test(p[0].label), `pill aria-label names "You" (${p[0].label})`);
  await page.waitForTimeout(3000);
  check((await serverMine(page, mid)).join() === '❤️', 'server has ❤️');
  check((await pills(page, mid)).length === 1, 'pill still there after the server echo');
  await shot(page, 'reactions-pill-own');

  step = 'pillremove';
  // Pill click on our own reaction removes it; no list reload, state confirmed from the server.
  await page.click(`[data-mid="${mid}"] [data-testid=reaction]`);
  check((await pills(page, mid)).length === 0, 'click on own pill removes it at once');
  await page.waitForTimeout(3500);
  check((await serverMine(page, mid)).length === 0, 'server: removed');
  check((await pills(page, mid)).length === 0, 'stays removed (no stuck optimistic state)');

  step = 'dblclick';
  // Double-click on the bubble (outside the text) toggles ❤️; double-clicking a word only selects it.
  await page.dblclick(`[data-mid="${mid}"] [data-testid=bubble] time`);
  p = await pills(page, mid);
  check(p.length === 1 && p[0].text === '❤️', `double-click on the bubble: ❤️ (${JSON.stringify(p.map((x) => x.text))})`);
  await page.waitForTimeout(2500);
  await page.dblclick(`[data-mid="${mid}"] [data-testid=msg-text]`, { position: { x: 6, y: 8 } }); // on the first word
  await page.waitForTimeout(300);
  const sel = await page.evaluate(() => window.getSelection().toString());
  p = await pills(page, mid);
  check(sel.length > 0 && p.length === 1, `double-click on a word selects it and does not toggle (selection "${sel.length} chars", pills ${p.length})`);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.dblclick(`[data-mid="${mid}"] [data-testid=bubble] time`);
  check((await pills(page, mid)).length === 0, 'second double-click removes ❤️');
  await page.waitForTimeout(3000);

  step = 'picker';
  // Picker: search in English and French, keyboard navigation, recents.
  await openMenu(page, mid);
  await page.click('[data-testid=more-reactions]');
  await page.fill('[data-testid=picker-search]', 'rire');
  let res = await page.$$eval('[data-testid=picker-results] button', (els) => els.map((e) => e.textContent));
  check(res.includes('😂') && res.length < 20, `search "rire" (fr): ${res.slice(0, 8).join(' ')}`);
  await page.fill('[data-testid=picker-search]', 'heart');
  res = await page.$$eval('[data-testid=picker-results] button', (els) => els.map((e) => e.textContent));
  check(res.includes('❤️') && res.includes('💔'), `search "heart" (en): ${res.length} results`);
  await page.fill('[data-testid=picker-search]', 'zzqx');
  check(await page.isVisible('[data-testid=picker-empty]'), 'no results message');
  await page.fill('[data-testid=picker-search]', 'party');
  await page.press('[data-testid=picker-search]', 'ArrowDown');
  const f1 = await page.evaluate(() => document.activeElement.textContent);
  await page.keyboard.press('ArrowRight');
  const f2 = await page.evaluate(() => document.activeElement.textContent);
  check(f1 && f2 && f1 !== f2, `arrow keys move through the grid (${f1} → ${f2})`);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  p = await pills(page, mid);
  check(p.length === 1 && p[0].text === f1, `Enter picks the focused emoji (${JSON.stringify(p.map((x) => x.text))})`);
  await page.waitForTimeout(2500);
  await openMenu(page, mid);
  const quick2 = await page.$$eval('[data-testid=quick-reaction]', (els) => els.map((e) => e.textContent));
  check(quick2[0] === f1, `recently used reaction leads the quick bar (${quick2.join(' ')})`);
  await page.keyboard.press('Escape');

  step = 'keyboard';
  // Keyboard: pills are buttons (Tab + Enter removes ours).
  await page.focus(`[data-mid="${mid}"] [data-testid=reaction]`);
  await page.keyboard.press('Enter');
  check((await pills(page, mid)).length === 0, 'keyboard Enter on own pill removes it');
  await page.waitForTimeout(3000);

  step = 'live';
  // ---- 2. Live updates from another device: pills change without reloading the list ----
  if (injectURL) {
    await otherDevice(mid, '🎉');
    await page.waitForTimeout(2500);
    p = await pills(page, mid);
    check(p.length === 1 && p[0].text === '🎉' && p[0].pop, `reaction from another device appears live (${JSON.stringify(p.map((x) => x.text))})`);
    await otherDevice(mid, '👀');
    await page.waitForTimeout(2500);
    check((await pills(page, mid)).length === 2, 'second live reaction');
    await otherDevice(mid, '🎉', true);
    await page.waitForTimeout(3000);
    p = await pills(page, mid);
    check(p.length === 1 && p[0].text === '👀', `removal from another device applied live (${JSON.stringify(p.map((x) => x.text))})`);
    await otherDevice(mid, '👀', true);
    await page.waitForTimeout(3000);
    check((await pills(page, mid)).length === 0, 'last one removed live');
  } else console.log('     (no INJECT_URL: live-update steps skipped)');
  check(listLoads === loadsBefore, `no full list reload for any reaction change (${listLoads - loadsBefore}: ${loadSteps.slice(-3).join(', ')})`);

  step = 'reading';
  const loadsBeforeReading = listLoads;
  // ---- 3. Reading position stays while reactions arrive on visible messages and above them ----
  if (injectURL) {
    const box = await page.locator('[data-testid=messages]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(1500);
    const before = await topVisible(page);
    const ids = await page.evaluate(() => {
      const sc = document.querySelector('[data-testid=messages] [data-virtuoso-scroller]').getBoundingClientRect();
      const all = [...document.querySelectorAll('[data-testid=msg]')];
      const vis = all.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= sc.top && r.bottom <= sc.bottom;
      });
      const above = all.filter((e) => e.getBoundingClientRect().bottom < sc.top);
      return { vis: vis.slice(0, 2).map((e) => e.dataset.mid), above: above.slice(-1).map((e) => e.dataset.mid) };
    });
    const touched = [...ids.vis, ...ids.above];
    for (const id of touched) await otherDevice(id, '🔥');
    await page.waitForTimeout(3500);
    const after = await topVisible(page);
    check(before && after && before.id === after.id && Math.abs(before.y - after.y) < 4, `reading position kept while reactions arrive (${JSON.stringify(before)} -> ${JSON.stringify(after)}, on ${touched.length} messages)`);
    await shot(page, 'reactions-scrolled');
    for (const id of touched) await otherDevice(id, '🔥', true);
    await page.waitForTimeout(3000);
    const after2 = await topVisible(page);
    check(after2 && after2.id === before.id && Math.abs(after2.y - before.y) < 4, `and while they are removed (${JSON.stringify(before)} -> ${JSON.stringify(after2)})`);
    check(listLoads === loadsBeforeReading, `no list reload meanwhile (${loadSteps.slice(loadsBeforeReading).join('; ')})`);
  }

  // ---- 4. Simulated LINE-like rules on the test chat: one reaction per user, allowed list ----
  const ALLOWED = ['❤️', '😂', '😮', '😢', '👍️', '🙏', '☕️', '🎉'];
  const s2 = await sameSession(s, { locale: 'fr-FR' });
  let caps = { reaction: 1, reactionCount: 1, allowedReactions: ALLOWED };
  await simulateCaps(s2.ctx, () => caps);
  const pg = s2.page;
  const calls = [];
  pg.on('request', (r) => {
    if (/\/reactions/.test(r.url()) && r.method() !== 'GET') calls.push(`${r.method()} ${decodeURIComponent(new URL(r.url()).pathname.split('/reactions')[1] || '').replace(/^\//, '') || JSON.parse(r.postData() || '{}').reactionKey}`);
  });
  await pg.goto(`${BASE}/chat/${enc(TEST_CHAT)}`);
  await pg.waitForSelector('[data-testid=msg]', { timeout: 20000 }).catch(async (e) => {
    await shot(pg, 'dbg-s2');
    console.log('     s2 page:', (await pg.textContent('body')).slice(0, 200));
    throw e;
  });
  await pg.waitForTimeout(1500);
  await openMenu(pg, mid);
  const q3 = await pg.$$eval('[data-testid=quick-reaction]', (els) => els.map((e) => e.textContent));
  check(q3.length === 6 && q3.every((e) => ALLOWED.includes(e)), `quick bar only offers allowed emoji, network spelling (${q3.join(' ')})`);
  await pg.click('[data-testid=more-reactions]');
  const grid = await pg.$$eval('[data-testid=picker-allowed] button', (els) => els.map((e) => e.textContent));
  check(grid.join() === ALLOWED.join() && (await pg.isVisible('.picker-hint')), `picker: only the network's list + "one reaction" hint (${grid.length})`);
  await pg.fill('[data-testid=picker-search]', 'café');
  const cafe = await pg.$$eval('[data-testid=picker-results] button', (els) => els.map((e) => e.textContent));
  check(cafe.length === 1 && cafe[0] === '☕️', `search within the allowed list (fr "café": ${cafe.join(' ')})`);
  await pg.click('[data-testid=picker-results] button');
  await pg.waitForTimeout(3000);
  await openMenu(pg, mid);
  calls.length = 0;
  await pg.click('[data-testid=quick-reaction]:has-text("😂")');
  p = await pills(pg, mid);
  check(p.length === 1 && p[0].text === '😂' && p[0].mine, `replacing: the old pill goes, the new one shows at once (${JSON.stringify(p.map((x) => x.text))})`);
  await pg.waitForTimeout(3500);
  check(calls.join(' | ').replace(/\uFE0F/g, '') === 'DELETE ☕ | POST 😂', `DELETE the old one first, then POST the new one (${calls.join(' | ')})`);
  check((await serverMine(pg, mid)).join() === '😂', 'server ends with only the new one');
  check(/Vous/.test((await pills(pg, mid))[0].label), 'French label says "Vous"');
  // A key the network does not take, already on the message (reacted from elsewhere): no "+1" offered.
  if (injectURL) {
    await otherDevice(mid, '🦄');
    await pg.waitForTimeout(3000);
    // Our own 🦄 is shown as ours; clicking it removes it (always allowed).
    const uni = (await pills(pg, mid)).find((x) => x.text === '🦄');
    check(uni && uni.mine, 'reaction outside the list still shown');
    await otherDevice(mid, '🦄', true);
    await pg.waitForTimeout(2500);
  }
  // Failure: the API refuses -> optimistic pill reverted, toast.
  await pg.route(/\/reactions/, (route) => route.abort());
  await openMenu(pg, mid);
  await pg.click('[data-testid=quick-reaction]:has-text("❤️")');
  await pg.waitForSelector('[data-testid=toast]', { timeout: 5000 }).catch(() => {});
  const toast = await pg.textContent('[data-testid=toast]').catch(() => '');
  await pg.waitForTimeout(1500);
  p = await pills(pg, mid);
  check(/réaction/i.test(toast || '') && p.length === 1 && p[0].text === '😂', `failure: toast "${toast}" and state reverted (${p.map((x) => x.text)})`);
  await pg.unroute(/\/reactions/);
  // No answer at all: reverted after 15 s.
  await pg.route(/\/reactions/, () => {});
  await pg.waitForTimeout(3500);
  await openMenu(pg, mid);
  await pg.click('[data-testid=quick-reaction]:has-text("😮")');
  check((await pills(pg, mid))[0]?.text === '😮', 'optimistic while the server does not answer');
  await pg.waitForTimeout(17000);
  p = await pills(pg, mid);
  check(p.length === 1 && p[0].text === '😂', `no answer: reverted after the timeout (${p.map((x) => x.text)})`);
  await pg.unroute(/\/reactions/);
  // Cleanup our reaction.
  await pg.click(`[data-mid="${mid}"] [data-testid=reaction]`);
  await pg.waitForTimeout(3000);
  check((await serverMine(pg, mid)).length === 0, 'test message left without reactions');

  // reaction capability absent -> no reaction UI.
  caps = { reply: 1 };
  await pg.reload();
  await pg.waitForSelector('[data-testid=msg]');
  await pg.hover(`[data-mid="${mid}"] [data-testid=bubble]`);
  check(!(await pg.isVisible(`[data-mid="${mid}"] [data-testid=msg-react]`)), 'network without reactions: no react button');
  await pg.dblclick(`[data-mid="${mid}"] [data-testid=bubble] time`);
  await pg.waitForTimeout(800);
  check((await pills(pg, mid)).length === 0, 'and double-click does nothing');

  // ---- 5. Touch: double-tap, long-press on a pill = who reacted ----
  const phone = await s.browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, locale: 'en-US', storageState: await ctx.storageState() });
  await phone.route('**/api/**', (route) => {
    const r = route.request();
    const ok = r.method() === 'GET' || new URL(r.url()).pathname.includes(enc(TEST_CHAT));
    return ok ? route.continue() : route.abort();
  });
  const mp = await phone.newPage();
  await mp.goto(`${BASE}/chat/${enc(TEST_CHAT)}`);
  await mp.waitForSelector('[data-testid=msg]');
  await mp.waitForTimeout(1500);
  const tb = await mp.locator(`[data-mid="${mid}"] [data-testid=bubble] time`).boundingBox();
  await mp.touchscreen.tap(tb.x + 4, tb.y + 4);
  await sleep(60);
  await mp.touchscreen.tap(tb.x + 4, tb.y + 4);
  await mp.waitForTimeout(400);
  p = await pills(mp, mid);
  if (p.length !== 1) {
    console.log('     tap target:', await mp.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${e.className} in ${e.closest('[data-mid]')?.dataset.mid}` : 'none'; }, { x: tb.x + 4, y: tb.y + 4 }), JSON.stringify(tb));
    await shot(mp, 'dbg-phone');
  }
  check(p.length === 1 && p[0].text === '❤️', `double-tap: ❤️ (${p.map((x) => x.text)})`);
  await mp.waitForTimeout(2500);
  const pb = await mp.locator(`[data-mid="${mid}"] [data-testid=reaction]`).boundingBox();
  const mcdp = await phone.newCDPSession(mp);
  const pt = [{ x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 }];
  await mcdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await sleep(700);
  await mcdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await mp.waitForSelector('[data-testid=reactors]', { timeout: 3000 }).catch(() => {});
  const who = await mp.textContent('[data-testid=reactors]').catch(() => '');
  check(/You/.test(who || ''), `long-press on a pill: who reacted ("${(who || '').replace(/\s+/g, ' ').trim()}")`);
  check((await pills(mp, mid)).length === 1, 'long-press did not toggle the pill');
  await shot(mp, 'reactions-phone-reactors');
  await mp.keyboard.press('Escape');
  await mp.waitForTimeout(300);
  check(!(await mp.isVisible('[data-testid=message-menu]')), 'Escape closes the sheet');
  // The bubble got room for the pill and the pinned list moved: measure again.
  const tb2 = await mp.locator(`[data-mid="${mid}"] [data-testid=bubble] time`).boundingBox();
  const hit = await mp.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x: tb2.x + 4, y: tb2.y + 4 });
  check(hit === 'TIME', `the time stays clear of the pill (tap lands on ${hit})`);
  await mp.touchscreen.tap(tb2.x + 4, tb2.y + 4);
  await sleep(60);
  await mp.touchscreen.tap(tb2.x + 4, tb2.y + 4);
  await mp.waitForTimeout(400);
  const p2 = await pills(mp, mid);
  check(p2.length === 0, `double-tap again removes the pill (${p2.map((x) => x.text)}, menu open: ${await mp.isVisible('[data-testid=message-menu]')})`);
  await mp.waitForTimeout(3000);
  check((await serverMine(mp, mid)).length === 0, 'double-tap again removes it (server)');
  await phone.close();

  // ---- 6. Real LINE chat, READ-ONLY: an image reaction made in the LINE app ----
  const lq = process.env.LINE_QUERY;
  if (lq) {
    const found = await page.evaluate(async (q) => {
      const r = await fetch(`/api/messages/search?query=${encodeURIComponent(q)}`);
      const j = await r.json();
      const m = (j.items || [])[0];
      return m ? { chat: m.chatID, id: m.id } : null;
    }, lq);
    if (found) {
      await page.goto(`${BASE}/chat/${enc(found.chat)}?m=${enc(found.id)}`);
      await page.waitForSelector(`[data-mid="${found.id}"]`, { timeout: 20000 });
      await page.waitForTimeout(2500);
      p = await pills(page, found.id);
      const img = await page.$eval(`[data-mid="${found.id}"] [data-testid=reaction] img`, (i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, alt: i.alt, lazy: i.loading })).catch(() => null);
      check(p.length >= 1 && p.some((x) => x.kind === 'image') && !p.some((x) => x.text.includes('•') || x.text.includes('mxc')), `LINE image reaction rendered as a picture (${JSON.stringify(p.map((x) => x.kind))})`);
      check(img && /^\/api\/media\/m\.jpg\?url=mxc%3A%2F%2F/.test(img.src) && img.w > 0 && img.alt === 'custom reaction' && img.lazy === 'lazy', `image through the media relay, loaded (${img && img.w}px), alt, lazy`);
      const el = page.locator(`[data-mid="${found.id}"]`);
      await el.screenshot({ path: `${process.env.SHOTS || '/shots'}/reactions-line-image.png` });
      await shot(page, 'reactions-line-chat');
      await page.goto(`${BASE}/`);
      await page.waitForTimeout(2500);
      const prev = await page.$eval(`[data-chat-id="${found.chat}"] [data-testid=chat-preview-reaction]`, (e) => e.textContent).catch(() => null);
      console.log(`     LINE chat preview is a reaction: ${prev === null ? 'no (latest event is not a reaction)' : prev ? 'yes, rendered' : 'yes, removed'}`);
      if (prev) check(/reacted/.test(prev) && !/Attachment/.test(prev), 'chat list preview: "… reacted … to …"');
    } else console.log('     (LINE message not found: read-only check skipped)');
  }

  console.log(`     writes to real chats blocked by the test guard: ${[...s.blocked, ...s2.blocked].length ? [...s.blocked, ...s2.blocked].join(', ') : 'none'}`);
  await s2.ctx.close();
  await logout(page);
  await s.browser.close();
  done([...s.csp, ...s2.csp]);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
