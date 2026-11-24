import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMime, sanitizeFileName } from '../server/upload.js';
import { parseAttachment } from '../server/relay.js';

test('file names', () => {
  assert.equal(sanitizeFileName('photo.jpg'), 'photo.jpg');
  assert.equal(sanitizeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeFileName('a\u0000b\nc d'), 'abcd');
  assert.equal(sanitizeFileName('été 2026.png'), 'été 2026.png');
  assert.equal(sanitizeFileName('..'), undefined);
  assert.equal(sanitizeFileName(''), undefined);
  assert.equal(sanitizeFileName('x'.repeat(400))?.length, 255);
  assert.equal(sanitizeFileName(42), undefined);
});

test('mime types', () => {
  assert.ok(isMime('image/png'));
  assert.ok(isMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  assert.ok(!isMime('image/png; charset=x'));
  assert.ok(!isMime('text/html\r\nX-Evil: 1'));
  assert.ok(!isMime('IMAGE/PNG'));
});

test('attachment bodies', () => {
  assert.deepEqual(parseAttachment({ uploadID: 'u1' }), { uploadID: 'u1' });
  assert.deepEqual(parseAttachment({ uploadID: 'u1', type: 'file', size: { width: 3, height: 4 } }), {
    uploadID: 'u1',
    type: 'file',
    size: { width: 3, height: 4 },
  });
  assert.equal(parseAttachment({ uploadID: 'u1', srcURL: 'file:///x' }), null);
  assert.equal(parseAttachment({ uploadID: '' }), null);
  assert.equal(parseAttachment({ uploadID: 'a b' }), null);
  assert.equal(parseAttachment({ uploadID: 'u1', type: 'exe' }), null);
  assert.equal(parseAttachment({ uploadID: 'u1', size: { width: 0, height: 4 } }), null);
  assert.equal(parseAttachment({ uploadID: 'u1', fileName: '../x' }), null);
  assert.equal(parseAttachment({ uploadID: 'u1', duration: -1 }), null);
  assert.equal(parseAttachment([]), null);
});
