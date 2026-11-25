// Composer formatting (0.27.0): shortcuts, the bar over a selection (desktop) or docked (phones, Aa), pasted rich
// text, "• " lists, the preview behind the field, the help, what the chat's network displays, and an edit that keeps
// the formatting. The TEST chat is served with WhatsApp-like formatting (the fakes list none), then as it is (plain).
// Writes: one message in the test chat (to edit it). sh web/test/e2e/run-offline.sh format.e2e.js
const { BASE, TEST_CHAT, check, open, enroll, logout, shot, done } = require('./lib');

const chatURL = `${BASE}/chat/${encodeURIComponent(TEST_CHAT)}`;
const WA = { bold: 2, italic: 2, strikethrough: 2, inline_code: 2, code_block: 2, blockquote: 2, user_link: 1 };

/** Serves the TEST chat with this formatting (its own GET and the lists that carry it). */
async function withFormatting(target, formatting) {
  await target.route(/\/api\/chats(?:[/?]|$)/, async (r) => {
    if (r.request().method() !== 'GET') return r.continue();
    const res = await r.fetch();
    let body;
    try {
      body = await res.json();
    } catch {
      return r.fulfill({ response: res });
    }
    const fix = (c) => {
      // A chat that lists capabilities is held to them: the usual ones too (the fake lists none, allowing all).
      if (c && c.id === TEST_CHAT) c.capabilities = { reply: 1, edit: 1, delete: 1, reaction: 1, ...(c.capabilities ?? {}), formatting };
    };
    fix(body);
    (body.items ?? []).forEach(fix);
    return r.fulfill({ response: res, json: body });
  });
}

const value = (page) => page.locator('[data-testid=composer-input]').inputValue();
async function select(page, from, to) {
  await page.locator('[data-testid=composer-input]').evaluate((el, [a, b]) => {
    el.focus();
    el.setSelectionRange(a, b);
  }, [from, to]);
  await page.waitForTimeout(120);
}
const selection = (page) => page.locator('[data-testid=composer-input]').evaluate((el) => [el.selectionStart, el.selectionEnd]);
/** A paste (synthetic: the browser's own insertion never runs); true when the app took it over. */
async function paste(page, html, plain) {
  const taken = await page.locator('[data-testid=composer-input]').evaluate((el, [h, p]) => {
    const dt = new DataTransfer();
    dt.setData('text/html', h);
    dt.setData('text/plain', p);
    return !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [html, plain]);
  await page.waitForTimeout(100);
  return taken;
}

(async () => {
  const s = await open();
  const { page } = s;
  const input = page.locator('[data-testid=composer-input]');
  try {
    // Before anything loads the chat: the app keeps (and persists) what it read for a minute.
    await withFormatting(page, WA);
    await enroll(page);
    await page.goto(chatURL);
    await input.waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);

    // Shortcuts on a selection, and off again; Ctrl+Z takes one back.
    await input.fill('hello world');
    await select(page, 6, 11);
    check(await page.isVisible('.field-wrap [data-testid=format-bar].floating'), 'a selection shows the floating bar');
    const bar = await page.$$eval('.field-wrap [data-testid=format-bar] [data-testid^=fmt-]', (els) => els.map((e) => e.dataset.testid).join(' '));
    check(bar === 'fmt-bold fmt-italic fmt-strikethrough fmt-inline_code fmt-code_block fmt-blockquote fmt-bullet fmt-numbered fmt-help', `the bar offers what WhatsApp displays, no link (${bar})`);
    const fb = await page.locator('.field-wrap [data-testid=format-bar]').boundingBox();
    const fi = await input.boundingBox();
    check(fb.y + fb.height <= fi.y + 2 && fb.x >= fi.x - 1, `the bar floats above the field (${JSON.stringify({ fb, fi })})`);
    await shot(page, 'format-floating');
    await page.keyboard.press('Control+b');
    check((await value(page)) === 'hello **world**', `Ctrl+B wraps the selection (${await value(page)})`);
    check(JSON.stringify(await selection(page)) === '[8,13]', 'the word stays selected');
    check((await page.getAttribute('[data-testid=fmt-bold]', 'aria-pressed')) === 'true', 'the bar shows bold as on');
    await page.keyboard.press('Control+b');
    check((await value(page)) === 'hello world', 'Ctrl+B again takes it off');
    await page.keyboard.press('Control+i');
    check((await value(page)) === 'hello _world_', 'Ctrl+I: italic');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    check((await value(page)) === 'hello world', `Ctrl+Z undoes the formatting (${await value(page)})`);
    await select(page, 6, 11);
    await page.click('[data-testid=fmt-strikethrough]');
    check((await value(page)) === 'hello ~~world~~', 'the bar button: strikethrough');
    check(await page.evaluate(() => document.activeElement?.dataset.testid === 'composer-input'), 'the bar keeps the focus in the field');
    await page.keyboard.press('Control+k');
    check((await value(page)) === 'hello ~~world~~', 'Ctrl+K writes no link where WhatsApp shows none');

    // Lists: "- " becomes "• ", a new line continues (Shift+Enter where Enter sends, as on a desktop with a mouse;
    // Enter in this headless browser, which reports no hover), an empty item ends the list.
    const enterSends = await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches);
    const newLine = enterSends ? 'Shift+Enter' : 'Enter';
    await input.fill('');
    await input.pressSequentially('- one');
    check((await value(page)) === '• one', `"- " becomes "• " (${await value(page)})`);
    await page.keyboard.press(newLine);
    await input.pressSequentially('two');
    check((await value(page)) === '• one\n• two', `${newLine}: the next item`);
    await page.keyboard.press(newLine);
    await page.keyboard.press(newLine);
    check((await value(page)) === '• one\n• two\n', `an empty item ends the list (${JSON.stringify(await value(page))})`);

    // Pasted rich text: Markdown of what the network displays, the rest as text.
    await input.fill('');
    await input.focus();
    const took = await paste(page, '<meta charset="utf-8"><h2>Plan</h2><p><b>Bold</b> and <a href="https://x.io/a">a link</a></p><ul><li>one</li><li>two</li></ul>', 'Plan\nBold and a link\none\ntwo');
    const pasted = await value(page);
    check(took && pasted === '**Plan**\n\n**Bold** and a link (https://x.io/a)\n\n• one\n• two', `a rich paste comes as WhatsApp's Markdown (${JSON.stringify(pasted)})`);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    check((await value(page)) === '', `Ctrl+Z takes the paste back (${JSON.stringify(await value(page))})`);
    check(!(await paste(page, '<span style="color:red">just text</span>', 'just text')), 'a paste with no formatting stays the browser’s own');

    // The preview behind the field: the marks dimmed, the same box as the field.
    await input.fill('a **bold** and _it_ word');
    await page.waitForTimeout(100);
    const pv = await page.evaluate(() => {
      const p = document.querySelector('.field-wrap .md-preview');
      const f = document.querySelector('[data-testid=composer-input]');
      if (!p) return null;
      const a = p.getBoundingClientRect();
      const b = f.getBoundingClientRect();
      return { bold: p.querySelector('.md-bold')?.textContent, marks: p.querySelectorAll('.md-mark').length, same: Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1 && Math.abs(a.top - b.top) < 1, cls: f.className, text: p.textContent };
    });
    check(pv && pv.bold === 'bold' && pv.marks === 4 && pv.same && /previewing/.test(pv.cls) && pv.text === 'a **bold** and _it_ word', `the preview draws the field's text, styled (${JSON.stringify(pv)})`);
    // Wrapping: a long text wraps the same way in the field and in the preview (same height as the field's content).
    await input.fill(Array.from({ length: 8 }, (_, i) => `**line ${i}** with _some_ words to wrap around the field width`).join(' '));
    await page.waitForTimeout(150);
    const wrap = await page.evaluate(() => {
      const p = document.querySelector('.field-wrap .md-preview');
      const f = document.querySelector('[data-testid=composer-input]');
      return { p: p.scrollHeight, f: f.scrollHeight };
    });
    check(Math.abs(wrap.p - wrap.f) <= 2, `the preview wraps like the field (${JSON.stringify(wrap)})`);
    await shot(page, 'format-preview');

    // Help (Ctrl+/): the link shortcut marked as not shown on WhatsApp.
    await input.fill('');
    await input.focus();
    await page.keyboard.press('Control+/');
    await page.waitForSelector('[data-testid=format-help]');
    const off = await page.$$eval('[data-testid=format-help] tr.off td:first-child', (els) => els.map((e) => e.textContent));
    check(off.length === 1 && /^Link · not shown on /.test(off[0]), `the help marks what the network does not show: the link (${off.join(' | ')})`);
    await shot(page, 'format-help');
    await page.click('[data-testid=format-help-close]');
    check(!(await page.isVisible('[data-testid=format-help]')), 'the help closes');

    // Aa: the docked bar, Escape closes it.
    await page.click('[data-testid=format-toggle]');
    check(await page.isVisible('.composer > [data-testid=format-bar].docked'), 'Aa docks the bar above the field');
    await input.fill('x');
    await select(page, 0, 1);
    check(!(await page.isVisible('.field-wrap [data-testid=format-bar]')), 'no floating bar while it is docked');
    await page.click('.composer > [data-testid=format-bar] [data-testid=fmt-bold]');
    check((await value(page)) === '**x**', 'the docked bar formats too');
    await input.focus();
    await page.keyboard.press('Escape');
    check(!(await page.isVisible('.composer > [data-testid=format-bar]')), 'Escape closes the docked bar');

    // An edit keeps the formatting: sent as Markdown, the fake bridge makes it HTML, the editor shows Markdown again.
    await input.fill('**bold** and _soft_');
    await page.click('[data-testid=send]');
    await page.locator('.msg.own strong', { hasText: 'bold' }).first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(1500);
    await input.focus();
    await page.keyboard.press('ArrowUp');
    const editor = page.locator('[data-testid=inline-edit-input]');
    await editor.waitFor({ timeout: 4000 });
    check((await editor.inputValue()) === '**bold** and _soft_', `the editor shows the formatting as Markdown (${await editor.inputValue()})`);
    await editor.evaluate((el) => el.setSelectionRange(9, 12));
    await page.keyboard.press('Control+b');
    check((await editor.inputValue()) === '**bold** **and** _soft_', 'shortcuts work in the editor');
    await page.keyboard.press('Escape');

    // A network that displays nothing (Telegram as the fakes serve it, no formatting listed): Aa greyed, no marks
    // written. Only the field is used there (a draft, nothing sent).
    await page.goto(`${BASE}/chat/${encodeURIComponent('!bob:beeper.local')}`);
    await input.waitFor();
    await page.waitForTimeout(800);
    check(await page.locator('[data-testid=format-toggle]').evaluate((el) => el.classList.contains('plain')), 'Aa shows the network displays no formatting');
    await input.fill('word');
    await select(page, 0, 4);
    await page.keyboard.press('Control+b');
    check((await value(page)) === 'word', 'Ctrl+B writes nothing where nothing shows');
    const plainBar = await page.$$eval('.field-wrap [data-testid=format-bar] [data-testid^=fmt-]', (els) => els.map((e) => e.dataset.testid).join(' '));
    check(plainBar === 'fmt-bullet fmt-numbered fmt-help', `only the lists there (${plainBar})`);
    check(!(await page.$('.field-wrap .md-preview')), 'no preview there');
    await input.fill('');

    // Phone: a selection docks the bar above the field; a tap formats and keeps the keyboard (focus).
    const phone = await s.browser.newContext({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true, storageState: await s.ctx.storageState() });
    await withFormatting(phone, WA);
    await phone.route('**/api/**', (r) => (r.request().method() === 'GET' ? r.fallback() : r.abort()));
    const pp = await phone.newPage();
    await pp.goto(chatURL);
    const pin = pp.locator('[data-testid=composer-input]');
    await pin.waitFor({ timeout: 20000 });
    await pp.waitForTimeout(800);
    await pin.fill('hello phone');
    await select(pp, 6, 11);
    check(await pp.isVisible('.composer > [data-testid=format-bar].docked'), 'phone: a selection docks the bar above the field');
    check(!(await pp.$('.field-wrap .md-preview')), 'phone: no preview (touch keyboards)');
    const pb = await pp.locator('.composer > [data-testid=format-bar] [data-testid=fmt-bold]').boundingBox();
    check(pb.width >= 40 && pb.height >= 38, `phone: bar buttons are touch targets (${Math.round(pb.width)}×${Math.round(pb.height)})`);
    await pp.locator('.composer > [data-testid=format-bar] [data-testid=fmt-bold]').tap();
    check((await pin.inputValue()) === 'hello **phone**', 'phone: tap on B wraps the selection');
    check(await pp.evaluate(() => document.activeElement?.dataset.testid === 'composer-input'), 'phone: the focus stays in the field');
    check(await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no horizontal scroll');
    await shot(pp, 'format-phone');
    await pin.fill('');
    await phone.close();
  } catch (e) {
    console.log('FAIL exception:', e && e.stack);
    check(false, 'no exception');
  } finally {
    await input.fill('').catch(() => {});
    console.log(`     writes to real chats blocked by the guard: ${s.blocked.length ? s.blocked.join(', ') : 'none'}`);
    check(s.csp.length === 0, `no CSP violations (${s.csp.length})`);
    await logout(page);
    await s.browser.close();
    done(s.csp);
  }
})();
