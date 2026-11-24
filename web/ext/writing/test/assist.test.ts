import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { addNote, assistPrompt, assistRoutes, cleanResult, contextLines, formatRule, loose, lostTokens, notesFor, parseFormat, prefsFor, removeNote, setPrefs } from '../server/assist.js';
import { setLlm } from '../server/ai.js';
import { setChats } from '../server/chats.js';
import { fakeChats, fakeLlm } from './fake.js';
import { defaultMsgQuick, menuTargets, msgQuickChoices, msgQuickFor, msgQuickTarget } from '../client/msgquick.js';

test('prompt: draft and conversation only in the user turn, address and mentions in the instructions', () => {
  const p = assistPrompt('translate', 'On se voit demain ? 😊', {
    target: 'vi',
    context: [{ who: 'Lan', text: 'Mai em rảnh không?' }, { who: 'Me', text: 'Oui' }],
    address: 'je suis anh, elle est em',
    keep: ['Lan Pham'],
  });
  assert.equal(p.length, 2);
  assert.match(p[0]!.content, /into Vietnamese/);
  // The user's own earlier messages in French must not lead the model to hand the draft back.
  assert.match(p[0]!.content, /always in Vietnamese, never the draft unchanged/);
  assert.match(p[0]!.content, /je suis anh, elle est em/);
  assert.match(p[0]!.content, /@Lan Pham/);
  assert.ok(!p[0]!.content.includes('demain'));
  assert.equal(p[1]!.content, '<conversation>\nLan: Mai em rảnh không?\nMe: Oui\n</conversation>\n<draft>\nOn se voit demain ? 😊\n</draft>');
  const g = assistPrompt('spelling', 'salut');
  assert.match(g[0]!.content, /Fix only spelling/);
  assert.equal(g[1]!.content, '<draft>\nsalut\n</draft>', 'no conversation for corrections');
});

// What the bridges report (capabilities.formatting, 2 = full support), trimmed.
const WHATSAPP = { bold: 2, italic: 2, strikethrough: 2, inline_code: 2, code_block: 2, blockquote: 2, unordered_list: 2, ordered_list: 2, headers: 1, inline_link: 1, user_link: 2 };
const SIGNAL = { bold: 2, italic: 2, strikethrough: 2, spoiler: 2, blockquote: 1, unordered_list: 1, ordered_list: 1, headers: 1, inline_link: 1 };
const LINKEDIN = { bold: -1, italic: -1, unordered_list: -1, headers: -1, inline_link: -1, user_link: 2 };

test("format: the result shaped for what the chat's network displays", () => {
  assert.match(formatRule(), /Keep Markdown markers/, 'not known: the Markdown stays as written');
  const wa = formatRule({ network: 'WhatsApp', formatting: WHATSAPP });
  assert.match(wa, /sent on WhatsApp/);
  assert.match(wa, /bold \(\*\*text\*\*\).*quotes/);
  assert.match(wa, /never write it: headings \("# "\), links on a text \(\[text\]\(url\)\)\./, 'partial support is not offered: named as not shown');
  assert.ok(!/displays only this formatting[^.]*headings/.test(wa));
  assert.match(wa, /a heading becomes a line of its own in bold/);
  assert.match(wa, /"text \(url\)"/);
  assert.match(wa, /a list item \(numbered or not\) a line starting with "• " or its number, never a Markdown list/, 'one level of list on WhatsApp: "• " lines');
  assert.match(wa, /blank line before and after a quote/, 'a line after a quote is not taken into it');
  const sig = formatRule({ network: 'Signal', formatting: SIGNAL });
  assert.match(sig, /a list item \(numbered or not\) a line starting with "• "/);
  assert.match(sig, /a quote its text in quotation marks/);
  assert.match(sig, /never write it: [^.]*quotes \(lines starting with "> "\)/, 'what Signal does not display, named');
  const li = formatRule({ network: 'LinkedIn', formatting: LINKEDIN });
  assert.match(li, /displays no formatting: write plain text, with no Markdown marker/);
  assert.ok(!li.includes(' in bold') && !li.includes('blank line'));
  assert.match(formatRule({ network: 'Zalo', formatting: {} }), /no formatting/, "Zalo's connector: none");
  const p = assistPrompt('grammar', 'Salut', { format: { network: 'WhatsApp', formatting: WHATSAPP } });
  assert.match(p[0]!.content, /Fix spelling and grammar[\s\S]*sent on WhatsApp[\s\S]*Keep every emoji/);
  assert.ok(!p[1]!.content.includes('WhatsApp'), 'only in the instructions');
});

test('format: validated', () => {
  assert.deepEqual(parseFormat({ network: ' WhatsApp ', formatting: WHATSAPP }), { network: 'WhatsApp', formatting: WHATSAPP });
  assert.deepEqual(parseFormat({ network: 'Zalo', formatting: {} }), { network: 'Zalo', formatting: {} });
  for (const bad of [null, 'WhatsApp', [], { network: '', formatting: {} }, { network: 'x'.repeat(61), formatting: {} }, { network: 'a\nb', formatting: {} },
    { network: 'W' }, { network: 'W', formatting: [] }, { network: 'W', formatting: { bold: 3 } }, { network: 'W', formatting: { bold: 1.5 } }, { network: 'W', formatting: { bold: '2' } }]) {
    assert.equal(parseFormat(bad), undefined, JSON.stringify(bad));
  }
});

test("format: the route hands the chat's network to the model, refuses a malformed one", async () => {
  const llm = fakeLlm(() => '**Ok**');
  setLlm(llm.provider);
  setChats(fakeChats().reader);
  const app = new Hono().route('/api/assist', assistRoutes);
  const post = (body: unknown) => app.request('/api/assist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await post({ chatID: '!f:x', mode: 'spelling', text: '# ok', format: { network: 'WhatsApp', formatting: WHATSAPP } });
  assert.deepEqual(await ok.json(), { text: '**Ok**' });
  assert.match(llm.calls[0]!.messages[0]!.content as string, /sent on WhatsApp/);
  await post({ chatID: '!f:x', mode: 'spelling', text: 'ok' });
  assert.match(llm.calls[1]!.messages[0]!.content as string, /Keep Markdown markers/, 'no format: as before');
  assert.equal((await post({ chatID: '!f:x', mode: 'spelling', text: 'ok', format: { network: 'W', formatting: { bold: 9 } } })).status, 400);
  setLlm(undefined);
  setChats(undefined);
});

test('lost tokens: emoji, links and mentions must survive', () => {
  assert.deepEqual(lostTokens('Coucou 👋🏽 voir https://x.fr/a?b=1 @Minh Le', 'Xin chào 👋🏽 xem https://x.fr/a?b=1 @Minh Le', ['Minh Le']), []);
  assert.deepEqual(lostTokens('bravo 🎉🎉', 'chúc mừng 🎉'), ['🎉'], 'a repeated emoji counts twice');
  assert.deepEqual(lostTokens('lien https://a.b/c', 'link'), ['https://a.b/c']);
  assert.deepEqual(lostTokens('merci @Kim', 'cảm ơn Kim', ['Kim']), ['@Kim']);
  assert.deepEqual(lostTokens('👨‍👩‍👧 ok', '👨‍👩‍👧 được'), [], 'ZWJ family kept whole');
});

test('model output cleaned, context lines chronological and trimmed', () => {
  assert.equal(cleanResult('<draft>\nXin chào\n</draft>'), 'Xin chào');
  const lines = contextLines([
    { text: 'deux', isSender: true, timestamp: '2026-10-29T10:01:00Z' },
    { text: 'un<br>ligne', senderName: 'Lan', timestamp: '2026-10-29T10:00:00Z' },
    { text: 'caché', isHidden: true, timestamp: '2026-10-29T10:02:00Z' },
    { text: '❤️', type: 'REACTION', timestamp: '2026-10-29T10:03:00Z' },
  ]);
  assert.deepEqual(lines, [{ who: 'Lan', text: 'un ligne' }, { who: 'Me', text: 'deux' }]);
});

test('stored settings and originals of translated messages', () => {
  assert.deepEqual(prefsFor('!c:x'), {});
  setPrefs('!c:x', { lang: 'vi', address: 'je suis em' });
  setPrefs('!c:x', { address: '' });
  assert.deepEqual(prefsFor('!c:x'), { lang: 'vi' });
  setPrefs('!c:x', { quick: 'translate:vi' });
  assert.deepEqual(prefsFor('!c:x'), { lang: 'vi', quick: 'translate:vi' });
  setPrefs('!c:x', { quick: 'none' });
  assert.deepEqual(prefsFor('!c:x'), { lang: 'vi', quick: 'none' }, 'quick button hidden');
  setPrefs('!c:x', { quick: undefined });
  assert.deepEqual(prefsFor('!c:x'), { lang: 'vi' }, 'back to the default');
  addNote('!c:x', 'Hẹn **mai** gặp', 'À demain', 'vi');
  assert.deepEqual(notesFor('!c:x'), { 'Hẹn mai gặp': { original: 'À demain', lang: 'vi' } });
  assert.equal(loose('<p>Hẹn <strong>mai</strong>\ngặp</p>'), 'Hẹn mai gặp', 'the echo (rich text) finds the same key');
  removeNote('!c:x', 'Hẹn mai gặp');
  assert.deepEqual(notesFor('!c:x'), {});
});

test('quick action on messages: stored per chat, validated, unset = the first language for received messages', async () => {
  setPrefs('!m:x', { msgQuick: 'translate:en' });
  assert.deepEqual(prefsFor('!m:x'), { msgQuick: 'translate:en' });
  setPrefs('!m:x', { msgQuick: undefined });
  assert.deepEqual(prefsFor('!m:x'), {}, 'back to the default');
  // Mounted where the registry mounts it (writing's `mounts`).
  const app = new Hono().route('/api/assist', assistRoutes);
  const put = (body: unknown) => app.request('/api/assist/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await put({ chatID: '!m:x', msgQuick: 'none' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { msgQuick: 'none' });
  for (const bad of ['translate:xx', 'spelling', 'fr', 3]) assert.equal((await put({ chatID: '!m:x', msgQuick: bad })).status, 400, String(bad));
  // Any supported language, offered or not (a chat keeps its choice when the list changes).
  assert.deepEqual(await (await put({ chatID: '!m:x', msgQuick: 'translate:ja' })).json(), { msgQuick: 'translate:ja' });
  assert.deepEqual(await (await put({ chatID: '!m:x', quick: 'translate:de', lang: 'ko' })).json(), { msgQuick: 'translate:ja', quick: 'translate:de', lang: 'ko' });
  for (const bad of [{ quick: 'translate:xx' }, { lang: 'xx' }, { lang: 'VI' }]) assert.equal((await put({ chatID: '!m:x', ...bad })).status, 400, JSON.stringify(bad));
  await put({ chatID: '!m:x', quick: '' });
  // '' clears the chat's language (back to the first of the user's list), as a translation would set it again.
  assert.deepEqual(await (await put({ chatID: '!m:x', lang: '' })).json(), { msgQuick: 'translate:ja' });
  assert.deepEqual(prefsFor('!m:x'), { msgQuick: 'translate:ja' }, 'no empty lang kept');
  const reset = await put({ chatID: '!m:x', msgQuick: '' });
  assert.deepEqual(await reset.json(), {}, "'' clears it");
});

test('quick action on messages: which messages get the button', () => {
  assert.equal(msgQuickTarget(undefined), 'fr', 'the default lists: French first');
  assert.equal(msgQuickTarget(undefined, ['en', 'fr']), 'en', 'unset: the first language for received messages');
  assert.equal(msgQuickTarget('translate:fr', ['en']), 'fr', 'a chat keeps its choice');
  assert.equal(msgQuickFor({ text: 'Xin chào' }, '', undefined, ['ja']), 'ja');
  assert.equal(msgQuickTarget(''), 'fr');
  assert.equal(msgQuickTarget('translate:en'), 'en');
  assert.equal(msgQuickTarget('none'), undefined);
  const m = { text: 'Xin chào', type: 'TEXT' };
  assert.equal(msgQuickFor(m, undefined), 'fr', 'received text, default French');
  assert.equal(msgQuickFor(m, 'translate:en'), 'en');
  assert.equal(msgQuickFor(m, 'none'), undefined, 'turned off');
  assert.equal(msgQuickFor({ ...m, isSender: true }, undefined), undefined, 'not on our own messages');
  assert.equal(msgQuickFor({ ...m, isDeleted: true }, undefined), undefined, 'not on deleted ones');
  assert.equal(msgQuickFor({ ...m, type: 'NOTICE' }, undefined), undefined, 'not on notices');
  assert.equal(msgQuickFor({ text: '  ' }, undefined), undefined, 'not without text (photo only)');
  assert.equal(msgQuickFor(m, undefined, { target: 'fr', status: 'done' }), undefined, 'already translated');
  assert.equal(msgQuickFor(m, undefined, { target: 'fr', status: 'loading' }), undefined, 'being translated');
  assert.equal(msgQuickFor(m, undefined, { target: 'fr', status: 'error' }), 'fr', 'failed: can be asked again');
  assert.equal(msgQuickFor(m, undefined, { target: 'en', status: 'done' }), 'fr', 'shown in another language');
});

test('message menu: translations at their place; the touch sheet of a text message puts the one-tap one first', () => {
  assert.deepEqual(menuTargets('text', true, false, 'en'), ['fr', 'en'], 'desktop popover: in order, nothing on top');
  assert.deepEqual(menuTargets('top', true, false, 'en'), []);
  assert.deepEqual(menuTargets('top', false, false, 'en'), ['en'], 'touch sheet: the quick one heads it');
  assert.deepEqual(menuTargets('text', false, false, 'en'), ['fr'], '…and is not repeated');
  assert.deepEqual(menuTargets('top', false, true, 'en'), [], 'a caption: media actions stay first');
  assert.deepEqual(menuTargets('text', false, true, 'en'), ['fr', 'en']);
  assert.deepEqual(menuTargets('top', false, false, undefined), [], 'no quick action (off, or already shown)');
  // The user's languages for received messages (Settings), in their order.
  assert.deepEqual(menuTargets('text', true, false, 'en', ['en', 'ja']), ['en', 'ja']);
  assert.deepEqual(menuTargets('text', false, false, 'en', ['en', 'ja']), ['ja']);
  assert.deepEqual(menuTargets('text', false, false, 'de', ['ja']), ['ja'], "a chat's one-tap language outside the list heads the sheet");
  assert.deepEqual(menuTargets('top', false, false, 'de', ['ja']), ['de']);
  assert.deepEqual(menuTargets('text', true, false, undefined, ['ko']), ['ko'], 'one language');
});

test('settings choices: the chat keeps a value no longer offered', () => {
  assert.deepEqual(msgQuickChoices(['fr', 'en']), ['translate:fr', 'translate:en']);
  assert.deepEqual(msgQuickChoices(['ja'], 'translate:fr'), ['translate:ja', 'translate:fr']);
  assert.deepEqual(msgQuickChoices(['ja'], 'none'), ['translate:ja']);
  assert.equal(defaultMsgQuick(['de', 'fr']), 'translate:de');
});
