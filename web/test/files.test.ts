import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extLabel, extOf, fileKind, middleTruncate, normName, previewOf, splitName } from '../client/src/files.js';

test('normName: NFC, no control / bidi-override characters, no path parts', () => {
  const nfd = 'Báo cáo Tháng 10.pdf'; // "Báo cáo Tháng 10.pdf" decomposed (as some networks send it)
  assert.notEqual(nfd, nfd.normalize('NFC'));
  assert.equal(normName(nfd), 'Báo cáo Tháng 10.pdf');
  assert.equal(normName(nfd).length, 'Báo cáo Tháng 10.pdf'.length);
  assert.equal(normName('invoice‮fdp.exe'), 'invoicefdp.exe');
  assert.equal(normName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(normName('  a\tb\n.txt '), 'ab.txt');
  assert.equal(normName(undefined), '');
});

test('extOf / fileKind: from the name, else from the MIME type', () => {
  assert.equal(extOf('Rapport.PDF'), 'pdf');
  assert.equal(extOf('archive.tar.gz'), 'gz');
  assert.equal(extOf('noext'), '');
  assert.equal(extOf('.hidden'), '');
  assert.equal(extOf(undefined, 'application/pdf'), 'pdf');
  assert.equal(extOf('x', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx');
  assert.equal(extOf(undefined, 'image/jpeg'), 'jpg');
  assert.equal(extOf('weird.ext-with-dash'), '');
  assert.equal(fileKind('a.pdf'), 'pdf');
  assert.equal(fileKind('a.docx'), 'doc');
  assert.equal(fileKind('a.xlsx'), 'sheet');
  assert.equal(fileKind('a.csv'), 'sheet');
  assert.equal(fileKind('a.pptx'), 'slides');
  assert.equal(fileKind('a.zip'), 'archive');
  assert.equal(fileKind('a.7z'), 'archive');
  assert.equal(fileKind('voice.m4a'), 'audio');
  assert.equal(fileKind('clip.mov'), 'video');
  assert.equal(fileKind('noext', 'application/pdf'), 'pdf');
  assert.equal(fileKind('noext', 'audio/ogg'), 'audio');
  assert.equal(fileKind('a.bin'), 'generic');
  assert.equal(fileKind(undefined, undefined), 'generic');
  assert.equal(previewOf('a.PDF'), 'pdf');
  assert.equal(previewOf('a.docx'), undefined);
  assert.equal(previewOf('compte-rendu.html'), 'html');
  assert.equal(previewOf('page.HTM'), 'html');
  assert.equal(previewOf('fichier', 'text/html; charset=utf-8'), 'html');
  assert.equal(extLabel('a.docx'), 'DOCX');
});

test('middleTruncate keeps the start and the extension', () => {
  assert.equal(middleTruncate('short.pdf', 30), 'short.pdf');
  const long = 'Contrat de location 2026 version finale signée.pdf';
  const cut = middleTruncate(long, 30);
  assert.ok([...cut].length <= 30, cut);
  assert.ok(cut.endsWith('signée.pdf'), cut);
  assert.ok(cut.startsWith('Contrat de'), cut);
  assert.ok(cut.includes('…'));
  // no extension: still cut in the middle
  const noext = middleTruncate('a'.repeat(20) + 'b'.repeat(20), 21);
  assert.equal([...noext].length, 21);
  assert.ok(noext.startsWith('aaa') && noext.endsWith('bbb'));
  // code points, never half an emoji
  const emoji = middleTruncate('😀'.repeat(40) + '.txt', 20);
  assert.equal([...emoji].length, 20);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), 'no lone surrogate');
  assert.ok(emoji.endsWith('.txt'));
});

test('splitName: the tail (end of the name and extension) is kept whole for a CSS middle ellipsis', () => {
  assert.deepEqual(splitName('CV_Hervault_Cooperation.pdf'), { head: 'CV_Hervault_Coope', tail: 'ration.pdf' });
  assert.deepEqual(splitName('short.pdf'), { head: '', tail: 'short.pdf' });
  assert.deepEqual(splitName('abcdefghijklmnop'), { head: 'abcdefghij', tail: 'klmnop' });
  const s = splitName('😀'.repeat(12) + '.txt');
  assert.equal(s.head + s.tail, '😀'.repeat(12) + '.txt');
  assert.equal(s.tail, '😀'.repeat(6) + '.txt');
});
