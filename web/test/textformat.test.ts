import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoBullet,
  continueList,
  editFor,
  htmlToMarkdown,
  insertLink,
  pasteMarkdown,
  previewSpans,
  shortcutOf,
  shows,
  toggleCodeBlock,
  toggleInline,
  toggleLines,
  type TextEdit,
} from '../client/src/textformat.js';

/** Applies an edit; "|" marks the caret, "[...]" the selection, in and out. */
function run(marked: string, fn: (v: string, s: number, e: number) => TextEdit | undefined): string | undefined {
  let s = marked.indexOf('[');
  let e: number;
  let v: string;
  if (s >= 0) {
    e = marked.indexOf(']') - 1;
    v = marked.replace('[', '').replace(']', '');
  } else {
    s = e = marked.indexOf('|');
    v = marked.replace('|', '');
  }
  const ed = fn(v, s, e);
  if (!ed) return undefined;
  const out = v.slice(0, ed.from) + ed.insert + v.slice(ed.to);
  if (ed.selStart === ed.selEnd) return out.slice(0, ed.selStart) + '|' + out.slice(ed.selStart);
  return out.slice(0, ed.selStart) + '[' + out.slice(ed.selStart, ed.selEnd) + ']' + out.slice(ed.selEnd);
}

const WHATSAPP = { bold: 2, italic: 2, strikethrough: 2, inline_code: 2, code_block: 2, blockquote: 2 };
const NONE = {};

test('toggleInline: wraps the selection, keeps the spaces outside, and unwraps it again', () => {
  assert.equal(run('say [hello] now', (v, s, e) => toggleInline(v, s, e, 'bold')), 'say **[hello]** now');
  assert.equal(run('say [hello ]now', (v, s, e) => toggleInline(v, s, e, 'bold')), 'say **[hello]** now');
  assert.equal(run('say **[hello]** now', (v, s, e) => toggleInline(v, s, e, 'bold')), 'say [hello] now');
  assert.equal(run('say [**hello**] now', (v, s, e) => toggleInline(v, s, e, 'bold')), 'say [hello] now');
  assert.equal(run('a [b] c', (v, s, e) => toggleInline(v, s, e, 'italic')), 'a _[b]_ c');
  assert.equal(run('a [b] c', (v, s, e) => toggleInline(v, s, e, 'strikethrough')), 'a ~~[b]~~ c');
  assert.equal(run('a [b] c', (v, s, e) => toggleInline(v, s, e, 'inline_code')), 'a `[b]` c');
});

test('toggleInline: no selection inserts the pair with the caret inside; again takes it away', () => {
  assert.equal(run('a |', (v, s, e) => toggleInline(v, s, e, 'bold')), 'a **|**');
  assert.equal(run('a **|**', (v, s, e) => toggleInline(v, s, e, 'bold')), 'a |');
});

test('toggleInline: each line of a selection over several lines gets its own marks', () => {
  assert.equal(run('[one\n\n two ]', (v, s, e) => toggleInline(v, s, e, 'bold')), '[**one**\n\n **two**] ');
  assert.equal(run('[**one**\n**two**]', (v, s, e) => toggleInline(v, s, e, 'bold')), '[one\ntwo]');
});

test('toggleLines: quotes, bullets and numbers on whole lines, and off again', () => {
  assert.equal(run('a\nb[c\nd]e', (v, s, e) => toggleLines(v, s, e, 'blockquote')), 'a\n[> bc\n> de]');
  assert.equal(run('[> x\n> y]', (v, s, e) => toggleLines(v, s, e, 'blockquote')), '[x\ny]');
  assert.equal(run('[x\n\ny]', (v, s, e) => toggleLines(v, s, e, 'bullet')), '[• x\n\n• y]');
  assert.equal(run('[x\ny]', (v, s, e) => toggleLines(v, s, e, 'numbered')), '[1. x\n2. y]');
  assert.equal(run('[• x\n• y]', (v, s, e) => toggleLines(v, s, e, 'numbered')), '[1. x\n2. y]');
  assert.equal(run('[1. x\n2. y]', (v, s, e) => toggleLines(v, s, e, 'numbered')), '[x\ny]');
  assert.equal(run('hi\n|', (v, s, e) => toggleLines(v, s, e, 'bullet')), 'hi\n• |');
});

test('toggleCodeBlock: fences the lines with blank lines around, or an empty block with the caret inside', () => {
  assert.equal(run('see:\n[x = 1]\nok', (v, s, e) => toggleCodeBlock(v, s, e)), 'see:\n\n```\n[x = 1]\n```\n\nok');
  assert.equal(run('|', (v, s, e) => toggleCodeBlock(v, s, e)), '```\n|\n```');
  assert.equal(run('```\n[x]\n```', (v, s, e) => toggleCodeBlock(v, s, e)), '[x]');
});

test('insertLink: the caret where the missing part goes', () => {
  assert.equal(run('see [docs] now', (v, s, e) => insertLink(v, s, e)), 'see [docs](|) now');
  assert.equal(run('see [https://x.io/a] now', (v, s, e) => insertLink(v, s, e)), 'see [|](https://x.io/a) now');
  assert.equal(run('|', (v, s, e) => insertLink(v, s, e)), '[](|)');
});

test('autoBullet: "- " and "* " at a line start become "• ", not in a code block nor mid-line', () => {
  assert.equal(run('a\n  -|', (v, s) => autoBullet(v, s)), 'a\n  • |');
  assert.equal(run('*|', (v, s) => autoBullet(v, s)), '• |');
  assert.equal(run('a -|', (v, s) => autoBullet(v, s)), undefined);
  assert.equal(run('```\n-|', (v, s) => autoBullet(v, s)), undefined);
});

test('continueList: the next marker, the next number, and an empty item ends the list', () => {
  assert.equal(run('• one|', (v, s, e) => continueList(v, s, e)), '• one\n• |');
  assert.equal(run('   • one|', (v, s, e) => continueList(v, s, e)), '   • one\n   • |');
  assert.equal(run('9. nine|', (v, s, e) => continueList(v, s, e)), '9. nine\n10. |');
  assert.equal(run('• one\n• |', (v, s, e) => continueList(v, s, e)), '• one\n|');
  assert.equal(run('plain|', (v, s, e) => continueList(v, s, e)), undefined);
  assert.equal(run('•| one', (v, s, e) => continueList(v, s, e)), undefined);
});

test('shortcutOf: Ctrl elsewhere, ⌘ on Apple, by physical key; AltGr (Ctrl+Alt) never', () => {
  const k = (code: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  assert.equal(shortcutOf(k('KeyB', { ctrlKey: true }), false), 'bold');
  assert.equal(shortcutOf(k('KeyB', { metaKey: true }), false), undefined);
  assert.equal(shortcutOf(k('KeyB', { metaKey: true }), true), 'bold');
  assert.equal(shortcutOf(k('KeyX', { ctrlKey: true, shiftKey: true }), false), 'strikethrough');
  assert.equal(shortcutOf(k('KeyX', { ctrlKey: true }), false), undefined);
  assert.equal(shortcutOf(k('KeyE', { ctrlKey: true, shiftKey: true }), false), 'code_block');
  assert.equal(shortcutOf(k('KeyB', { ctrlKey: true, altKey: true }), false), undefined);
  assert.equal(shortcutOf(k('KeyK', { ctrlKey: true, shiftKey: true }), false), undefined, 'Ctrl+Shift+K stays the ✨ menu');
  assert.equal(editFor('help', 'x', 0, 0), undefined);
});

test('shows: undefined formatting displays everything; else full support only', () => {
  assert.equal(shows(undefined, 'headers'), true);
  assert.equal(shows({ bold: 2, headers: 1 }, 'headers'), false);
  assert.equal(shows({ bold: 2 }, 'bold'), true);
});

test('htmlToMarkdown: a message body from Beeper comes back as the Markdown that was typed', () => {
  assert.equal(htmlToMarkdown('Hi <strong>there</strong>, <em>really</em> <del>not</del> <code>x</code>', undefined), 'Hi **there**, _really_ ~~not~~ `x`');
  assert.equal(htmlToMarkdown('line one<br>line <b>two</b>', undefined), 'line one\nline **two**');
  assert.equal(htmlToMarkdown('keeps\nits newlines', undefined), 'keeps\nits newlines');
  assert.equal(htmlToMarkdown('<blockquote>quoted<br>twice</blockquote>after', undefined), '> quoted\n> twice\n\nafter');
  assert.equal(htmlToMarkdown('<pre><code>a  &lt; b\n  c</code></pre>', undefined), '```\na  < b\n  c\n```');
  assert.equal(htmlToMarkdown('see <a href="https://x.io">the docs</a>', undefined), 'see [the docs](https://x.io)');
  assert.equal(htmlToMarkdown('<a href="https://x.io">https://x.io</a>', undefined), 'https://x.io');
  assert.equal(htmlToMarkdown('<h2>Title</h2>body', undefined), '## Title\n\nbody');
});

test('htmlToMarkdown: mentions keep their name, reply fallbacks and emoji images handled', () => {
  assert.equal(htmlToMarkdown('<a href="https://matrix.to/#/@ana:beeper.local">Ana</a> hi', undefined), 'Ana hi');
  assert.equal(htmlToMarkdown('<mx-reply><blockquote>old</blockquote></mx-reply>new <b>text</b>', undefined), 'new **text**');
  assert.equal(htmlToMarkdown('nice <img data-mx-emoticon src="mxc://a/b" alt=":party:">', undefined), 'nice :party:');
});

test('htmlToMarkdown: only what the network displays, the rest as formatRule writes it', () => {
  assert.equal(htmlToMarkdown('<b>a</b> <i>b</i> <s>c</s>', NONE), 'a b c');
  assert.equal(htmlToMarkdown('<h1>Title</h1>', WHATSAPP), '**Title**');
  assert.equal(htmlToMarkdown('<h1>Title</h1>', NONE), 'Title');
  assert.equal(htmlToMarkdown('<a href="https://x.io">docs</a>', WHATSAPP), 'docs (https://x.io)');
  assert.equal(htmlToMarkdown('<a href="mailto:a@b.c">write</a>', NONE), 'write (a@b.c)');
  assert.equal(htmlToMarkdown('<blockquote>q</blockquote>', NONE), '“q”');
  assert.equal(htmlToMarkdown('<code>x</code>', { bold: 2 }), 'x');
});

test('htmlToMarkdown: lists as "• " and numbered lines, nested ones indented', () => {
  assert.equal(htmlToMarkdown('<ul><li>one</li><li>two<ul><li>sub</li></ul></li></ul>', undefined), '• one\n• two\n   • sub');
  assert.equal(htmlToMarkdown('<ol start="3"><li>c</li><li>d</li></ol>', undefined), '3. c\n4. d');
  assert.equal(htmlToMarkdown('<p>Intro</p><ul><li>a<li>b</ul><p>End</p>', undefined, { collapse: true }), 'Intro\n\n• a\n• b\n\nEnd');
});

test('htmlToMarkdown: a Google Docs paste (styles, and the whole wrapped in a non-bold <b>)', () => {
  const html =
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">' +
    '<span style="font-weight:700;">Bold</span><span style="font-weight:400;"> and </span><span style="font-style:italic;">italic</span></p>' +
    '<p dir="ltr" style="margin-top:0pt;margin-bottom:0pt;"><span style="text-decoration:line-through;">gone</span></p></b><br class="Apple-interchange-newline">';
  assert.equal(htmlToMarkdown(html, WHATSAPP, { collapse: true }), '**Bold** and _italic_\n~~gone~~');
});

test('htmlToMarkdown: a Word paste (list paragraphs, their bullet spans, comments and styles skipped)', () => {
  const html =
    '<html><head><style>p { color: red }</style></head><body><!--StartFragment-->' +
    "<p class=MsoListParagraphCxSpFirst><span style='mso-list:Ignore'>·<span>&nbsp;&nbsp;</span></span>First</p>" +
    "<p class=MsoListParagraphCxSpLast><span style='mso-list:Ignore'>·</span><b>Second</b></p><!--EndFragment--></body></html>";
  assert.equal(htmlToMarkdown(html, undefined, { collapse: true }), '• First\n• **Second**');
});

test('htmlToMarkdown: web page whitespace collapses; tables become lines', () => {
  assert.equal(htmlToMarkdown('<div>\n  some\n   text  </div>\n<div>next</div>', undefined, { collapse: true }), 'some text\nnext');
  assert.equal(htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>', undefined, { collapse: true }), 'a b\nc');
});

test('pasteMarkdown: undefined when the HTML adds nothing to the plain text (the browser pastes it)', () => {
  assert.equal(pasteMarkdown('<span style="color:red">just text</span>', 'just text', undefined), undefined);
  assert.equal(pasteMarkdown('<b>bold</b> text', 'bold text', undefined), '**bold** text');
  assert.equal(pasteMarkdown('<b>bold</b> text', 'bold text', NONE), undefined);
  assert.equal(pasteMarkdown('', 'x', undefined), undefined);
});

test('previewSpans: marks dimmed, the text styled, only for what the network displays', () => {
  const join = (s: ReturnType<typeof previewSpans>) => s.map((x) => (x.cls ? `<${x.cls}>${x.text}` : x.text)).join('|');
  assert.equal(join(previewSpans('a **b** c', undefined)), 'a |<md-mark>**|<md-bold>b|<md-mark>**| c');
  assert.equal(join(previewSpans('a **b** c', NONE)), 'a **b** c');
  assert.equal(join(previewSpans('snake_case_name', undefined)), 'snake_case_name');
  assert.equal(join(previewSpans('> hi', undefined)), '<md-mark>> |<md-quote>hi');
  assert.equal(previewSpans('x\n```\n**no**\n```', undefined).map((s) => s.text).join(''), 'x\n```\n**no**\n```');
  assert.ok(previewSpans('```\n**no**\n```', undefined).some((s) => s.cls === 'md-pre' && s.text === '**no**'));
});

// --- Review fixes (0.27.0) ---

test('htmlToMarkdown: "<br>\\n" is one line break, not a paragraph', () => {
  assert.equal(htmlToMarkdown('<strong>x</strong><br>\nline2', undefined), '**x**\nline2');
  assert.equal(htmlToMarkdown('<p>a<br />\r\nline2</p>', undefined), 'a\nline2');
});

test('htmlToMarkdown: what a reply fallback holds, tags included, is dropped', () => {
  assert.equal(htmlToMarkdown('<mx-reply><blockquote><a href="https://matrix.to/#/@a:b">@a:b</a><br>look <img alt="😀"></blockquote></mx-reply><strong>ok</strong>', undefined), '**ok**');
});

test('htmlToMarkdown: twice-escaped text decoded twice; a code span with a backtick; a code block language', () => {
  assert.equal(htmlToMarkdown('F&amp;amp;S <b>x</b>', undefined), 'F&S **x**');
  assert.equal(htmlToMarkdown('<code>a`b</code>', undefined), '`` a`b ``');
  assert.equal(htmlToMarkdown('<pre><code class="language-js">x()</code></pre>', undefined), '```js\nx()\n```');
});

test('htmlToMarkdown: a nested list in source whitespace stays tight', () => {
  assert.equal(htmlToMarkdown('<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n<li>c</li>\n</ul>', undefined, { collapse: true }), '• a\n   • b\n• c');
});

test('htmlToMarkdown edit: what the network does not show comes back as its text, nothing added', () => {
  assert.equal(htmlToMarkdown('<blockquote>q</blockquote>', NONE, { edit: true }), 'q');
  assert.equal(htmlToMarkdown('see <a href="https://x.io">docs</a>', NONE, { edit: true }), 'see docs');
});

test('pasteMarkdown: code from an editor (white-space: pre) keeps the plain paste', () => {
  assert.equal(pasteMarkdown('<div style="white-space: pre;"><div><span style="font-weight: bold;">const</span> x</div></div>', 'const x', undefined), undefined);
});

test('toggleInline: marks that are not this pair are left alone', () => {
  assert.equal(run('foo_[bar]_baz', (v, s, e) => toggleInline(v, s, e, 'italic')), '_[foo_bar_baz]_');
  assert.equal(run('[**a** b **c**]', (v, s, e) => toggleInline(v, s, e, 'bold')), '**[**a** b **c**]**');
  assert.equal(run('__[a]__', (v, s, e) => toggleInline(v, s, e, 'italic')), '_[__a__]_');
});

test('line edits at the very start of a text that begins with a new line', () => {
  assert.equal(run('|\nhello', (v, s, e) => toggleLines(v, s, e, 'bullet')), '• |\nhello');
  assert.equal(run('|\nhello', (v, s, e) => toggleLines(v, s, e, 'blockquote')), '> |\n\nhello');
});

test('toggleCodeBlock: two blocks selected are not one to unwrap', () => {
  const v = '```\na\n```\n\n```\nb\n```';
  const ed = toggleCodeBlock(v, 0, v.length);
  assert.ok(!ed.insert.startsWith('a\n```'), ed.insert);
});

test('toggleLines: a blank line before the text that follows a quote', () => {
  assert.equal(run('[q]\nnext', (v, s, e) => toggleLines(v, s, e, 'blockquote')), '[> q]\n\nnext');
});

test('shortcutOf: letters by the letter typed (Dvorak copy stays copy), "/" wherever it is', () => {
  const k = (code: string, key: string, o: Partial<{ ctrlKey: boolean; shiftKey: boolean }> = {}) => ({ code, key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...o });
  assert.equal(shortcutOf(k('KeyI', 'c'), false), undefined, 'Dvorak Ctrl+C');
  assert.equal(shortcutOf(k('KeyN', 'b'), false), 'bold', 'Dvorak Ctrl+B');
  assert.equal(shortcutOf(k('KeyB', 'и'), false), 'bold', 'Cyrillic layout: by position');
  assert.equal(shortcutOf(k('Period', '/', { shiftKey: true }), false), 'help', 'AZERTY Shift+:');
  assert.equal(shortcutOf(k('Digit7', '/', { shiftKey: true }), false), 'help', 'QWERTZ Shift+7');
});
