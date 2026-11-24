import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTarget, MAX_SOURCES, MAX_TARGETS, parseForward, partsOf, type SourceParts } from '../server/forward.js';
import { localMxc, SELF } from './fixtures/identities.js';

const IMG = localMxc('photo1');
const messages: Record<string, unknown> = {
  m1: { id: 'm1', chatID: 'chatA', text: 'a <b>caption</b> &amp; more', attachments: [{ id: IMG, type: 'img', mimeType: 'image/jpeg', fileName: 'photo.jpg', fileSize: 9, srcURL: `file:///data/media/local.beeper.com/${SELF.username}_photo1`, size: { width: 4, height: 3 } }] },
  m2: { id: 'm2', chatID: 'chatA', text: 'just text' },
  m3: { id: 'm3', chatID: 'chatA', text: 'gone', isDeleted: true },
  m4: { id: 'm4', chatID: 'chatA', attachments: [{ id: 'x', type: 'unknown', srcURL: 'file:///etc/passwd', fileName: 'passwd' }] },
  m5: { id: 'm5', chatID: 'chatOther', text: 'not in chatA' },
};
test('request validation: known keys, valid IDs, bounded lists, no duplicates', () => {
  const ok = { from: [{ chatID: 'chatA', messageID: 'm1' }], to: ['chatB'] };
  assert.deepEqual(parseForward(ok), ok);
  assert.deepEqual(parseForward({ from: [{ chatID: 'chatA', messageID: 'm1', attachment: 2 }], to: ['chatB'] })?.from[0]?.attachment, 2);
  const src = (i: number) => ({ chatID: 'chatA', messageID: `m${i}` });
  for (const bad of [
    null,
    [],
    { from: [], to: ['chatB'] },
    { from: [src(1)], to: [] },
    { from: [src(1)], to: ['chatB'], extra: 1 },
    { from: [{ ...src(1), url: IMG }], to: ['chatB'] },
    { from: [{ chatID: 'chat A', messageID: 'm1' }], to: ['chatB'] },
    { from: [src(1)], to: ['chat\nB'] },
    { from: [src(1)], to: ['chatB', 'chatB'] },
    { from: [src(1), src(1)], to: ['chatB'] },
    { from: [{ ...src(1), attachment: -1 }], to: ['chatB'] },
    { from: [{ ...src(1), attachment: 1.5 }], to: ['chatB'] },
    { from: Array.from({ length: MAX_SOURCES + 1 }, (_, i) => src(i)), to: ['chatB'] },
    { from: [src(1)], to: Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `c${i}`) },
    { from: [src(1)], to: [42] },
  ]) {
    assert.equal(parseForward(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
});

const file = (mime: string, size?: number) => ({ kind: 'file' as const, mime, size, open: async () => ({ status: 200, headers: {}, body: null }) });
const parts = (files: ReturnType<typeof file>[], text = ''): SourceParts[] => [{ files, text }];

test('target checks: read-only, capabilities, sizes, text length, text-only connector', () => {
  const img = parts([file('image/jpeg', 1000)], 'cap');
  assert.deepEqual(checkTarget({ id: 'b' }, img), { caption: [true] });
  assert.deepEqual(checkTarget({ id: 'b', readOnly: true }, img), { error: 'read_only' });
  assert.deepEqual(checkTarget({ id: 'z', textOnly: true }, img), { error: 'text_only' });
  assert.deepEqual(checkTarget({ id: 'z', textOnly: true }, parts([], 'hello')), { caption: [false] });
  assert.deepEqual(checkTarget({ id: 'b', caps: { attachments: {} } }, img), { error: 'no_files' });
  const imagesOnly = { attachments: { 'm.image': { mimeTypes: { 'image/*': 2 as const }, caption: 0 as const, maxSize: 5000 } } };
  assert.deepEqual(checkTarget({ id: 'b', caps: imagesOnly }, img), { caption: [false] });
  assert.deepEqual(checkTarget({ id: 'b', caps: imagesOnly }, parts([file('image/jpeg', 6000)])), { error: 'too_large' });
  assert.deepEqual(checkTarget({ id: 'b', caps: imagesOnly }, parts([file('application/pdf', 10)])), { error: 'unsupported_type' });
  assert.deepEqual(checkTarget({ id: 'b' }, parts([file('video/mp4', 101 * 1024 * 1024)])), { error: 'too_large' });
  assert.deepEqual(checkTarget({ id: 'b', caps: { maxTextLength: 3 } }, parts([], 'hello')), { error: 'text_too_long' });
  // Two files and a text: the text goes on its own.
  assert.deepEqual(checkTarget({ id: 'b' }, parts([file('image/jpeg', 1), file('image/png', 1)], 'x')), { caption: [false] });
});

test('parts of a message: the named attachment, its text in plain form; nothing for deleted or empty', () => {
  const open = () => async () => ({ status: 200, headers: {}, body: null });
  const p = partsOf(messages.m1 as never, undefined, open);
  assert.ok(typeof p === 'object');
  assert.equal(p.text, 'a caption & more');
  assert.equal(p.files[0]!.name, 'photo.jpg');
  assert.deepEqual([p.files[0]!.width, p.files[0]!.height], [4, 3]);
  assert.equal(partsOf(messages.m1 as never, 3, open), 'not_found');
  assert.equal(partsOf(messages.m3 as never, undefined, open), 'not_found');
  assert.equal(partsOf({ id: 'e' }, undefined, open), 'empty');
  assert.equal(partsOf(messages.m1 as never, 0, () => undefined), 'empty');
});

