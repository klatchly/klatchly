// Switching chats like a native app: a conversation already in the cache shows its messages on the first frames
// (ListPreview while the list is placed), never the skeleton, never a blank pane, without the messages moving once
// shown (the list taking over from its preview, pictures arriving, the silent refresh from the server); a mouse
// opens the chat as its button goes down. Read-only (the lib.js guard aborts writes to real chats).
// sh web/test/e2e/run-offline.sh switch.e2e.js
const { check, open, enroll, logout, shot, done } = require('./lib');

/**
 * Clicks a chat row and records every frame for `ms` after the button goes down, in the page: frames showing the
 * message skeleton, blank frames (neither skeleton nor messages on screen), the first frame with messages on screen,
 * moves of the lowest message on screen once shown, whether the chat was open before the click event, and the
 * pictures requested meanwhile.
 */
async function switchTo(page, id, ms) {
  await page.evaluate(
    ({ id, ms }) => {
      window.__sw = new Promise((resolve) => {
        const rec = { skeleton: 0, blank: 0, firstVisible: -1, moves: [], openAtClick: false, media: 0, frames: 0, preview: 0, previewIds: 0 };
        const onDown = () => {
          document.removeEventListener('pointerdown', onDown, true);
          const start = performance.now();
          document.addEventListener('click', () => (rec.openAtClick = decodeURIComponent(location.pathname) === `/chat/${id}`), { capture: true, once: true });
          const media = () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/media'));
          const mediaBefore = media().length;
          let last = null;
          // Sampled once each frame is drawn (a rendering task later): what was painted, after the resize observers
          // of that frame (the preview keeps its place there), not the layout a frame callback would force.
          const frame = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));
          const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
          const tick = () => {
            const t = performance.now() - start;
            rec.frames++;
            const pane = document.querySelector('.pane-chat');
            const box = pane?.querySelector('[data-testid=messages]')?.getBoundingClientRect();
            const sk = [...(pane?.querySelectorAll('[data-testid=skeleton]') ?? [])].some(shown);
            // Messages on screen (the list, or its preview while it is placed), whole inside the pane.
            const msgs = box
              ? [...pane.querySelectorAll('[data-testid=msg], [data-preview-mid]')].filter((e) => {
                  const r = e.getBoundingClientRect();
                  return shown(e) && r.top >= box.top && r.bottom <= box.bottom + 1;
                })
              : [];
            // The preview's copies carry no test id, message id or id: nothing finds them but the list's own.
            const preview = pane?.querySelector('[data-list-preview]');
            if (preview && shown(preview)) rec.preview++;
            if (preview) rec.previewIds = Math.max(rec.previewIds, preview.querySelectorAll('[data-testid], [data-mid], [id]').length);
            if (sk) rec.skeleton++;
            if (!sk && !msgs.length) rec.blank++;
            if (msgs.length && rec.firstVisible < 0) rec.firstVisible = Math.round(t);
            if (msgs.length) {
              // The lowest message on screen keeps its place from one frame to the next (a pixel of sub-pixel
              // rounding between the preview and the list aside).
              const low = msgs[msgs.length - 1];
              const pos = { id: low.dataset.mid ?? low.dataset.previewMid, top: low.getBoundingClientRect().top };
              if (last && (pos.id !== last.id || Math.abs(pos.top - last.top) > 1.5)) rec.moves.push(`${Math.round(t)}ms: ${last.id}@${Math.round(last.top)} -> ${pos.id}@${Math.round(pos.top)}`);
              last = pos;
            }
            if (t < ms) return frame(tick);
            rec.media = media().slice(mediaBefore).map((e) => decodeURIComponent(e.name.replace(/^.*\/api\/media/, '')).slice(0, 60));
            resolve(rec);
          };
          frame(tick);
        };
        document.addEventListener('pointerdown', onDown, true);
      });
    },
    { id, ms },
  );
  await page.click(`[data-testid=chat-row][data-chat-id="${id}"]`);
  const rec = await page.evaluate(() => window.__sw);
  console.log(`     ${id}: ${JSON.stringify(rec)}`);
  return rec;
}

(async () => {
  const s = await open({ locale: 'fr-FR' });
  const { page, ctx } = s;
  const fetched = new Set();
  page.on('request', (r) => {
    const m = /\/api\/chats\/([^/?]+)\/messages(\?|$)/.exec(r.url());
    if (m && r.method() === 'GET') fetched.add(decodeURIComponent(m[1]));
  });
  // Conversations answer late once switched on: what shows on a switch comes from the cache, and the refresh from
  // the server lands inside the frames watched (1 s), without moving anything.
  let slow = false;
  await ctx.route('**/api/chats/*/messages**', async (route) => {
    if (slow && route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 1000));
    return route.fallback();
  });
  try {
    await enroll(page);
    await page.waitForSelector('[data-testid=chat-row]');
    // The background prefetch (prefetch.ts) loads the top of the list: Bob's pictures among them.
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=chat-row]').length > 5);
    for (let i = 0; i < 40 && !(fetched.has('!bob:beeper.local') && fetched.size >= 6); i++) await page.waitForTimeout(250);
    const ids = await page.$$eval('[data-testid=chat-row]', (els) => els.map((e) => e.getAttribute('data-chat-id')));
    // The long chat (LONG_CHAT, a long history: scroll.e2e.js and persist.e2e.js) first: its cache holds only the
    // newest page, so the list loads the older one as it opens (prepended rows), without moving the rows on screen.
    const long = process.env.LONG_CHAT;
    const rest = ids.filter((id) => fetched.has(id) && id !== '!bob:beeper.local' && id !== long);
    const others = (long && fetched.has(long) ? [long, ...rest] : rest).slice(0, 3);
    check(fetched.has('!bob:beeper.local') && others.length === 3, `prefetched chats to switch through (${fetched.size}: Bob and ${others.join(' ')})`);
    if (long) check(others.includes(long), `the long chat among them (${long})`);
    await page.waitForTimeout(1000);
    slow = true;

    // A → Bob (pictures, first time) → B → C, then back to A and Bob: each from the cache.
    const [a, b, c] = others;
    const order = [a, '!bob:beeper.local', b, c, a, '!bob:beeper.local'];
    const recs = [];
    for (const id of order) recs.push(await switchTo(page, id, 1600));
    await shot(page, 'switch-bob');
    const worst = (k) => Math.max(...recs.map((r) => (Array.isArray(r[k]) ? r[k].length : r[k])));
    check(recs.every((r) => r.skeleton === 0), `no skeleton frame on a switch to a cached chat (worst ${worst('skeleton')})`);
    check(recs.every((r) => r.blank <= 1), `at most one frame without messages after the press (worst ${worst('blank')})`);
    check(recs.every((r) => r.firstVisible >= 0 && r.firstVisible < 400), `messages on screen within 400 ms of the press (${recs.map((r) => r.firstVisible).join(', ')} ms)`);
    check(recs.every((r) => r.moves.length === 0), `the messages do not move once shown, refresh from the server included (worst ${worst('moves')})`);
    check(recs.every((r) => r.openAtClick), 'the mouse opens the chat as its button goes down (before the click)');
    // Pictures seen once come back from the browser's memory: none asked again on the way back to Bob (videos stream
    // from the HTTP cache, which Playwright's routing turns off here).
    const pics = (r) => r.media.filter((u) => !u.includes('type=video'));
    check(pics(recs[5]).length === 0, `no picture loaded again when coming back to Bob (${pics(recs[5]).length}; first time ${recs[1].media.length} media)`);
    // The server's copy has replaced the cache meanwhile, in place.
    check(recs.some((r) => r.preview > 0) && recs.every((r) => r.previewIds === 0), `the preview showed (frames: ${recs.map((r) => r.preview).join(', ')}) without test ids or message ids (worst ${worst('previewIds')})`);
    check((await page.$$('.pane-chat [data-testid=msg]')).length > 0 && (await page.$$('.pane-chat [data-list-preview]')).length === 0, 'the list stays, its preview gone');
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    slow = false;
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page).catch(() => {});
    await s.browser.close();
    done(s.csp);
  }
})();
