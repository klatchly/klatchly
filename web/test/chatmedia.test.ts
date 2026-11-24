import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, extractLinks, isFileAttachment, isGalleryAttachment, matchesTab, slimMessage } from '../server/chatmedia.js';

const img = (n: number) => ({ id: `mxc://local.beeper.com/i${n}`, type: 'img', mimeType: 'image/jpeg', srcURL: `mxc://local.beeper.com/i${n}`, size: { width: 10, height: 20 } });
const msg = (id: string, extra: Record<string, unknown>) => ({ id, chatID: 'chatA', senderID: '@a:x', senderName: 'A', timestamp: '2026-10-01T10:00:00Z', sortKey: id, reactions: [{ id: 'r' }], mentions: ['@b'], seen: { x: 1 }, ...extra });

test('which attachments each tab lists', () => {
  assert.ok(isGalleryAttachment({ type: 'img', mimeType: 'image/gif' }));
  assert.ok(isGalleryAttachment({ type: 'video', isGif: true }));
  assert.ok(!isGalleryAttachment({ type: 'img', isSticker: true }));
  assert.ok(!isGalleryAttachment({ type: 'img', mimeType: 'application/x-lottie+json' }));
  assert.ok(isFileAttachment({ type: 'unknown', mimeType: 'application/pdf' }));
  assert.ok(isFileAttachment({ type: 'audio', mimeType: 'audio/mpeg' }));
  assert.ok(!isFileAttachment({ type: 'audio', isVoiceNote: true }));
  assert.ok(!isFileAttachment({ type: 'img' }));
  assert.ok(!matchesTab({ id: 'x', chatID: 'c', timestamp: '', isDeleted: true, attachments: [{ type: 'img' }] }, 'media'));
});

test('links: previews first, then URLs of the text, cleaned and once each', () => {
  const links = extractLinks('Voir https://example.org/a?b=1&amp;c=2. et (https://fr.wikipedia.org/wiki/Paris_(France)) puis https://example.org/a?b=1&c=2', [
    { url: 'https://youtu.be/xyz', title: ' Une vidéo ', summary: 'S', img: 'mxc://local.beeper.com/p' },
    { url: 'javascript:alert(1)' },
    { url: 'https://evil.example/', img: 'https://tracker.example/p.png' },
  ]);
  assert.deepEqual(links, [
    { url: 'https://youtu.be/xyz', domain: 'youtu.be', title: 'Une vidéo', summary: 'S', img: 'mxc://local.beeper.com/p' },
    { url: 'https://evil.example/', domain: 'evil.example' },
    { url: 'https://example.org/a?b=1&c=2', domain: 'example.org' },
    { url: 'https://fr.wikipedia.org/wiki/Paris_(France)', domain: 'fr.wikipedia.org' },
  ]);
  // Rich text: hrefs count too; no credentials, no bare hosts, no other schemes.
  assert.deepEqual(extractLinks('<a href="https://www.beeper.com/x">here</a> ftp://a.b/c', null).map((l) => l.domain), ['beeper.com']);
  for (const u of ['https://user:pw@example.org/', 'http://localhost/', 'https://', `https://a.b/${'x'.repeat(2100)}`]) assert.equal(cleanUrl(u), undefined, u.slice(0, 30));
  assert.equal(cleanUrl('https://a.b/c!?'), 'https://a.b/c');
  assert.deepEqual(extractLinks('rien ici', []), []);
});

test('slim messages: no reactions, receipts or mentions; attachments kept in place', () => {
  const m = msg('a', { text: 'hello https://a.example/', attachments: [{ type: 'img', srcURL: 'mxc://x/1', extra: 'drop' }, { type: 'unknown', fileName: 'f.pdf' }] });
  const s = slimMessage(m as never, 'media');
  assert.deepEqual(Object.keys(s).sort(), ['attachments', 'chatID', 'id', 'senderID', 'senderName', 'sortKey', 'text', 'timestamp']);
  assert.deepEqual(s.attachments, [{ type: 'img', srcURL: 'mxc://x/1' }, { type: 'unknown', fileName: 'f.pdf' }]);
  const l = slimMessage(m as never, 'links');
  assert.equal(l.attachments, undefined);
  assert.deepEqual(l.urls, [{ url: 'https://a.example/', domain: 'a.example' }]);
});
