import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBody, decodeEntities, isHtmlBody, isRichText, toPlainText } from '../server/richtext.js';
import { payloadFor } from '../server/pushwatch.js';

const probe =
  'hotfix probe <a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">https://example.com/a?b=1</a> and <strong>bold</strong> &lt;tag&gt; &amp; <code>code</code>';

test('rich text detection is conservative', () => {
  assert.ok(isRichText(probe));
  assert.ok(isRichText('a &lt; b') && isRichText('Tom &amp; Jerry'));
  assert.equal(toPlainText('plain a &lt; b'), 'plain a < b');
  assert.equal(toPlainText('xss <a>click</a> &lt;img src=x onerror=alert(1)&gt;'), 'xss click <img src=x onerror=alert(1)>');
  assert.ok(isRichText('a<br>b') && isRichText('<p>x</p>') && isRichText('<span data-mx-spoiler>x</span>'));
  for (const s of ['a < b', 'x <3 y', '<tag> & co', 'a &lt; b <3', '&copy; only', '<script>alert(1)</script>', 'if (a<b && c>d)', '', null, undefined]) {
    assert.ok(!isRichText(s), String(s));
  }
});

test('plain text of rich bodies', () => {
  assert.equal(toPlainText(probe), 'hotfix probe https://example.com/a?b=1 and bold <tag> & code');
  assert.equal(toPlainText('line 1<br>line 2<br/>line 3'), 'line 1\nline 2\nline 3');
  assert.equal(toPlainText('<ul><li>a</li><li>b</li></ul>'), '• a\n• b');
  assert.equal(toPlainText('<mx-reply><blockquote>old</blockquote></mx-reply>new <em>one</em>'), 'new one');
  assert.equal(toPlainText('a < b & <c>'), 'a < b & <c>', 'plain text is returned as is');
  assert.equal(toPlainText('<b>x</b> <img src="x" onerror="alert(1)"> y'), 'x  y');
  assert.equal(toPlainText('<b>x</b> <img src=x onerror=alert(1)> y'), '<b>x</b> <img src=x onerror=alert(1)> y', 'malformed: literal');
  assert.equal(decodeEntities('&#x1F44D; &#128077; &quot;q&quot; &nbsp;&bogus; &#0;'), '👍 👍 "q"  &bogus; &#0;');
});

test('push bodies never carry tags', () => {
  const p = payloadFor({ id: '1', chatID: 'c', type: 'TEXT', text: probe }, { title: 'X', type: 'single' });
  assert.equal(p.body, 'hotfix probe https://example.com/a?b=1 and bold <tag> & code');
});

test('escaped plain text keeps its line breaks and is decoded once per escape', () => {
  // A WeChat Channels share as the API returns it: plain text, escaped by the bridge and again by the API.
  const share = 'Channels: Lumière\n2026 Dance Day\n\n📍Lyon A&amp;amp;B Dance Center\nOpen WeChat to view it.';
  assert.ok(isRichText(share) && !isHtmlBody(share), 'entities without tags: plain text, not markup');
  assert.equal(toPlainText(share), 'Channels: Lumière\n2026 Dance Day\n\n📍Lyon A&B Dance Center\nOpen WeChat to view it.');
  assert.equal(decodeBody('Tom &amp; Jerry &lt;3'), 'Tom & Jerry <3', 'escaped once: decoded once');
  assert.equal(decodeBody('a &amp;amp; b &amp;lt;tag&amp;gt;'), 'a & b <tag>');
  assert.equal(decodeBody('R&amp;D &amp;co'), 'R&D &co', 'an escaped "&" before a non-entity stays a single decode');
  assert.ok(isHtmlBody('a<br>b &amp; c') && isHtmlBody('<p>x</p>') && !isHtmlBody('a < b') && !isHtmlBody(null));
  assert.equal(toPlainText('x &amp;amp; y<br>z'), 'x & y\nz', 'markup escaped twice is decoded twice too');
});
