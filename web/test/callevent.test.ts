import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCallEvent } from '../server/callevent.js';
import { oneLine } from '../server/richtext.js';
import { payloadFor } from '../server/pushwatch.js';
import { callMessage, callPreviewText } from './fixtures/callevent.js';

const START = Date.UTC(2026, 10, 3, 5, 0);
const LINK = 'https://call.whatsapp.com/video/FakeToken123abc';

test('scheduled call: both shapes the API sends parse to the same call', () => {
  const rich = parseCallEvent(callMessage.text);
  assert.ok(rich);
  assert.deepEqual({ ...rich, start: rich.start.getTime() }, {
    title: '',
    start: START,
    video: true,
    link: LINK,
    location: undefined,
    description: '<ul><li>Acme Tech (current state, release planning)</li><li>Project B (questions from Bob)</li></ul>',
    rich: true,
  });
  const md = parseCallEvent(callPreviewText);
  assert.ok(md && !md.rich);
  assert.equal(md.start.getTime(), START);
  assert.equal(md.link, LINK);
  assert.equal(md.description, '* Acme Tech (current state, release planning)\n* Project B (questions from Bob)');
  // A named voice call keeps its name.
  const voice = parseCallEvent(callMessage.text.replace('<h4>call</h4>', '<h4>Weekly &amp; sync</h4>').replaceAll('/video/', '/voice/'));
  assert.equal(voice?.title, 'Weekly & sync');
  assert.equal(voice?.video, false);
});

test('scheduled call: anything else falls back to the usual rendering', () => {
  for (const s of [
    '<h4>Notes</h4><p>Start time: whenever</p>',
    '<h4>Notes</h4><p>just a heading</p>',
    '#### Title\n\nno fields',
    'Start time: Tue, 03 Nov 2026 05:00:00 UTC',
    '',
    undefined,
  ]) {
    assert.equal(parseCallEvent(s), null, String(s));
  }
  // Only a WhatsApp call link (exact host), only the bridge's RFC 1123 date.
  for (const link of ['javascript:alert(1)', 'https://call.whatsapp.com.evil.example/video/x', 'https://evil.example/call.whatsapp.com/video/x', 'http://call.whatsapp.com/video/x']) {
    assert.equal(parseCallEvent(callMessage.text.replaceAll(LINK, link)), null, link);
    assert.equal(parseCallEvent(callPreviewText.replaceAll(LINK, link)), null, link);
  }
  for (const date of ['2026-11-03T05:00:00Z', 'tomorrow', 'Tue, 3 Nov 2026 05:00 UTC', 'Tue, 03 Nov 2026 05:00:00 +0700']) {
    assert.equal(parseCallEvent(callMessage.text.replace('Tue, 03 Nov 2026 05:00:00 UTC', date)), null, date);
  }
});

test('scheduled call: encoded markup stays text', () => {
  const html = parseCallEvent(callMessage.text.replace('<h4>call</h4>', '<h4>&lt;b&gt;x&lt;/b&gt;</h4>'));
  assert.equal(html?.title, '<b>x</b>');
  const md = parseCallEvent(callPreviewText.replace('* Acme', '&lt;img src=x onerror=alert(1)&gt; Acme'));
  assert.ok(md?.description.startsWith('&lt;img src=x'));
});

test('previews: no Markdown heading marks; push says it is a call', () => {
  assert.equal(oneLine('#### Title\n\nbody  text\n## more'), 'Title body text more');
  assert.equal(oneLine('#hashtag stays'), '#hashtag stays');
  assert.equal(oneLine('<pre><code># comment\nx = 1</code></pre>'), '# comment x = 1');
  const p = payloadFor({ ...callMessage, timestamp: new Date().toISOString() }, { title: 'Group', type: 'group' }, 'fr');
  assert.equal(p.body, '📞 Appel vidéo');
});
