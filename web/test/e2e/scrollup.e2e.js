// Scrolling up through the older pages of a busy group (offline/beeper.mjs, "Market stall": photos with and without
// their size, albums, stickers with and without it, link previews, voice notes, replies, reactions, several days)
// moves the messages by what the reader scrolls and nothing else: never back up ("the messages vibrate up and down"
// as rows above the screen are measured, pictures arrive or an older page shows), never ahead of the wheel or finger.
// Every painted frame records where the messages on screen are, the scroll position and height, the input since the
// last frame, the scroll calls (Virtuoso's corrections), the rows that changed height and the pages fetched. Desktop
// (wheel notches) and an iPhone (390 × 844, iOS user agent: Virtuoso's iOS path, slow finger drags). Read-only (the
// lib.js guard; the phone context lets only GET requests through).
// sh web/test/e2e/run-offline.sh scrollup.e2e.js
const { BASE, check, open, enroll, logout, shot, done } = require('./lib');
const { startRecording, stopRecording, analyse, report, openList, phoneContext } = require('./scrollrec');

const BUSY = '!market:beeper.local';
const chatURL = `${BASE}/chat/${encodeURIComponent(BUSY)}`;
const openBusy = (page) => openList(page, chatURL);

(async () => {
  const s = await open({ locale: 'en-US' });
  const { page } = s;
  await enroll(page);

  // 1. Desktop: the wheel, a notch at a time, slowly, through older pages.
  await openBusy(page);
  const box = await page.locator('[data-testid=messages]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await startRecording(page);
  for (let i = 0; i < 160; i++) {
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1500);
  const drec = await stopRecording(page);
  const da = analyse(drec, 60);
  report('desktop wheel', drec, da);
  check(drec.fetches.length >= 3 && da.rowsSeen > 60, `desktop: older pages loaded and shown while scrolling up (${drec.fetches.length} pages, ${da.rowsSeen} rows seen)`);
  check(da.back + da.jumps === 0, `desktop: the messages follow the wheel only, never back up or ahead (back-moves ${da.back}, jumps ${da.jumps}, oscillations ${da.osc}, worst ${da.worst} px)`);
  await shot(page, 'scrollup-desktop');

  // 2. iPhone: a finger dragging the history down, 8 px a move, lifted and put back (the slow reading of a chat).
  const phone = await phoneContext(s.browser, s.ctx);
  const mp = await phone.newPage();
  const cdp = await phone.newCDPSession(mp);
  await openBusy(mp);
  await startRecording(mp);
  const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 195, y }] });
  for (let i = 0; i < 22; i++) {
    let y = 250;
    await touch('touchStart', y);
    for (let k = 0; k < 40; k++) {
      y += 8;
      await touch('touchMove', y);
      await mp.waitForTimeout(16);
    }
    await mp.waitForTimeout(80);
    await touch('touchEnd', y);
    await mp.waitForTimeout(100);
  }
  await mp.waitForTimeout(1500);
  const prec = await stopRecording(mp);
  const pa = analyse(prec, 8);
  report('phone touch', prec, pa);
  check(prec.fetches.length >= 3 && pa.rowsSeen > 40, `phone: older pages loaded and shown while scrolling up (${prec.fetches.length} pages, ${pa.rowsSeen} rows seen)`);
  check(pa.back + pa.jumps === 0, `phone: the messages follow the finger only, never back up or ahead (back-moves ${pa.back}, jumps ${pa.jumps}, oscillations ${pa.osc}, worst ${pa.worst} px)`);
  await shot(mp, 'scrollup-phone');
  await phone.close();

  await logout(page);
  await s.browser.close();
  done(s.csp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
