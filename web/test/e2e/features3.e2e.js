// Feature 3: voice messages, mentions, drafts. Sends ONLY to the test chat; the mention picker is opened
// read-only in a real group (nothing typed there is sent; lib.js blocks any write to it anyway).
// sh web/test/e2e/run-offline.sh features3.e2e.js
const fs = require('fs');
const { BASE, SHOTS, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

const chatURL = (id) => `${BASE}/chat/${encodeURIComponent(id)}`;

async function lastMessages(page, n = 3) {
  return page.evaluate(async ([id, n]) => (await (await fetch(`/api/chats/${encodeURIComponent(id)}/messages`)).json()).items.slice(0, n), [TEST_CHAT, n]);
}

async function waitSettled(page) {
  for (let i = 0; i < 40 && (await page.$$('[data-testid=msg-outgoing]')).length; i++) await page.waitForTimeout(500);
}

(async () => {
  const s = await open({ locale: 'en-US', permissions: ['microphone'] });
  const { page, ctx } = s;
  await enroll(page);
  const res = await page.request.get(BASE + '/');
  const pp = res.headers()['permissions-policy'] || '';
  check(/microphone=\(self\)/.test(pp) && /camera=\(\)/.test(pp) && /geolocation=\(\)/.test(pp), `Permissions-Policy: ${pp}`);

  // --- Voice, desktop (click to start, click to send) ----------------------------------------------
  await page.goto(chatURL(TEST_CHAT));
  await page.waitForSelector('[data-testid=mic]');
  const fmt = await page.evaluate(() => ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4'].filter((t) => MediaRecorder.isTypeSupported(t)));
  console.log('     MediaRecorder types in this Chromium:', JSON.stringify(fmt));
  await page.click('[data-testid=mic]');
  await page.waitForSelector('[data-testid=voice-bar]');
  await page.waitForTimeout(2600);
  const time = await page.textContent('[data-testid=voice-time]');
  const bars = await page.$$eval('.rec-levels span', (els) => els.length);
  check(/^0:0[2-3]$/.test(time) && bars > 5, `recording: time ${time}, ${bars} level bars`);
  await shot(page, 'voice-en-recording');
  await page.click('[data-testid=voice-cancel]');
  check(!(await page.$('[data-testid=voice-bar]')), 'cancel closes the recorder');
  const before = (await lastMessages(page, 1))[0]?.id;
  await page.waitForTimeout(800);
  check((await lastMessages(page, 1))[0]?.id === before, 'cancelled recording sent nothing');

  await page.click('[data-testid=mic]');
  await page.waitForTimeout(3200);
  await page.click('[data-testid=voice-send]');
  await waitSettled(page);
  await page.waitForTimeout(1000);
  const [voice] = await lastMessages(page, 1);
  const a = voice?.attachments?.[0];
  check(!!a && a.isVoiceNote === true && a.type === 'audio', `sent as a voice note (${JSON.stringify(a && { type: a.type, isVoiceNote: a.isVoiceNote, mime: a.mimeType, duration: a.duration })})`);
  // The API does not echo the duration we send; the file itself is checked with ffprobe when debugging by hand.
  console.log(`     attachment duration from the API: ${a?.duration ?? 'not returned'}`);
  if (a?.srcURL) {
    const b64 = await page.evaluate(async (u) => {
      const r = await fetch(`/api/media?url=${encodeURIComponent(u)}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    }, a.srcURL);
    fs.writeFileSync(`${SHOTS}/voice-desktop.bin`, Buffer.from(b64, 'base64'));
  }
  await page.waitForSelector('[data-testid=voice-player]');
  const players = await page.$$('[data-testid=voice-player]');
  const player = players[players.length - 1];
  await (await player.$('[data-testid=voice-speed]')).click();
  check((await (await player.$('[data-testid=voice-speed]')).textContent()) === '1.5×', 'speed toggles to 1.5×');
  await (await player.$('[data-testid=voice-play]')).click();
  await page.waitForTimeout(1500);
  const playing = await player.evaluate((el) => {
    const au = el.querySelector('audio');
    return { t: au.currentTime, rate: au.playbackRate, paused: au.paused };
  });
  check(playing.t > 0.5 && playing.rate === 1.5, `voice note plays from /api/media (${JSON.stringify(playing)})`);
  await shot(page, 'voice-en-player');

  // --- Voice, phone (press and hold, slide to cancel) ---------------------------------------------
  const phone = await s.browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, locale: 'fr-FR', storageState: await ctx.storageState() });
  await phone.grantPermissions(['microphone'], { origin: BASE });
  await phone.route('**/api/**', (r) => {
    const q = r.request();
    const ok = q.method() === 'GET' || q.url().includes(encodeURIComponent(TEST_CHAT)) || (q.postData() || '').includes(TEST_CHAT) || q.url().endsWith('/api/upload');
    return ok ? r.continue() : r.abort();
  });
  const mp = await phone.newPage();
  await mp.goto(chatURL(TEST_CHAT));
  await mp.waitForSelector('[data-testid=mic]');
  const cdp = await phone.newCDPSession(mp);
  const box = await mp.locator('[data-testid=mic]').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const touch = (type, px) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y }] });
  // slide left to cancel
  const before2 = (await lastMessages(mp, 1))[0]?.id;
  await touch('touchStart', x);
  await mp.waitForTimeout(1200);
  await shot(mp, 'voice-fr-hold');
  for (let d = 10; d <= 150; d += 20) {
    await touch('touchMove', x - d);
    await mp.waitForTimeout(30);
  }
  await touch('touchEnd', x - 150);
  await mp.waitForTimeout(1000);
  check(!(await mp.$('[data-testid=voice-bar]')) && (await lastMessages(mp, 1))[0]?.id === before2, 'slide-to-cancel discards the recording');
  // hold and release to send
  await touch('touchStart', x);
  await mp.waitForTimeout(2500);
  await touch('touchEnd', x);
  for (let i = 0; i < 40 && (await mp.$$('[data-testid=msg-outgoing]')).length; i++) await mp.waitForTimeout(500);
  await mp.waitForTimeout(1000);
  const [held] = await lastMessages(mp, 1);
  check(held?.id !== before2 && held?.attachments?.[0]?.isVoiceNote === true, 'press-and-hold sends a voice note');
  await shot(mp, 'voice-fr-player-phone');
  await phone.close();

  // --- Drafts --------------------------------------------------------------------------------------
  await page.goto(chatURL(TEST_CHAT));
  await page.waitForSelector('[data-testid=composer-input]');
  await page.fill('[data-testid=composer-input]', 'draft e2e text');
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=chat-row]');
  const draftRow = async () => page.$$eval('[data-testid=chat-row]', (els, id) => els.find((e) => e.dataset.chatId === id)?.querySelector('[data-testid=chat-draft]')?.textContent ?? null, TEST_CHAT);
  check((await draftRow())?.startsWith('Draft: draft e2e text'), `draft shown in the chat list (${await draftRow()})`);
  await page.reload();
  await page.waitForSelector('[data-testid=chat-row]');
  check(!!(await draftRow()), 'draft kept after reload (this device)');
  await page.click('[data-testid=open-settings]');
  await page.click('[data-testid=lang-fr]');
  await page.click('[data-testid=settings-close]');
  check((await draftRow())?.startsWith('Brouillon :'), 'draft label translated');
  await shot(page, 'drafts-fr-list');
  await page.goto(chatURL(TEST_CHAT));
  await page.waitForSelector('[data-testid=composer-input]');
  check((await page.inputValue('[data-testid=composer-input]')) === 'draft e2e text', 'composer restored from the draft');
  await page.fill('[data-testid=composer-input]', '');
  await page.goto(BASE + '/');
  await page.waitForSelector('[data-testid=chat-row]');
  check(!(await draftRow()), 'cleared draft disappears');
  await page.click('[data-testid=open-settings]');
  await page.click('[data-testid=lang-en]');
  await page.click('[data-testid=settings-close]');

  // --- Mentions: picker in a real group, read-only ---------------------------------------------------
  const group =
    process.env.GROUP_CHAT ||
    (await page.evaluate(async () => {
      const r = await (await fetch('/api/chats?limit=50')).json();
      const g = r.items.find((c) => c.type === 'group' && c.unreadCount === 0 && (c.capabilities?.formatting?.user_link ?? 0) >= 1 && (c.participants?.total ?? 0) > 2);
      return g?.id;
    }));
  if (group) {
    await page.goto(chatURL(group));
    await page.waitForSelector('[data-testid=composer-input]');
    await page.waitForTimeout(1500);
    const letter = await page.evaluate(async (id) => {
      const c = await (await fetch(`/api/chats/${encodeURIComponent(id)}`)).json();
      const p = c.participants.items.find((x) => !x.isSelf && x.fullName);
      return p ? p.fullName[0] : '';
    }, group);
    await page.click('[data-testid=composer-input]');
    await page.keyboard.type(`@${letter}`);
    await page.waitForSelector('[data-testid=mention-picker]', { timeout: 5000 }).catch(() => {});
    const opts = await page.$$('[data-testid=mention-option]');
    check(opts.length > 0, `mention picker lists participants (${opts.length})`);
    await shot(page, 'mentions-en-picker');
    if (opts.length) {
      await page.keyboard.press('Enter');
      const val = await page.inputValue('[data-testid=composer-input]');
      check(/^@\S.* $/.test(val), 'picking inserts "@Name "');
    }
    await page.fill('[data-testid=composer-input]', '');
    await page.goto(BASE + '/');
    await page.waitForSelector('[data-testid=chat-row]');
  } else console.log('     (no suitable group found for the picker check)');
  console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
  check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
