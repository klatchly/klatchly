import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPlanFor, imageConversion, type AttachmentCaps } from '../server/attachplan.js';
import { nameFor, prepareFile, sniffImage, untyped, type Redraw } from '../client/src/attachprep.js';

// What the composer does with a file before planning and uploading it (client/src/attachprep.ts), and the plan's
// conversion rule (server/attachplan.ts imageConversion), on made-up capabilities.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00');
const WEBP = new TextEncoder().encode('RIFF\x10\x00\x00\x00WEBPVP8 ');
const BMP = new TextEncoder().encode('BM\x46\x00\x00\x00\x00\x00\x00\x00\x36\x00');

// A network that shows PNG, JPEG and WebP as photos and takes nothing else (as some networks do).
const photosOnly: AttachmentCaps = { attachments: { 'm.image': { mimeTypes: { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1 }, caption: 1, maxSize: 1000 } } };
// A network that takes any picture and any file.
const open: AttachmentCaps = { attachments: { 'm.image': { mimeTypes: { 'image/*': 1 } }, 'm.file': { mimeTypes: { '*/*': 1 } } } };
// Only JPEG photos, other files as files.
const jpegOrFile: AttachmentCaps = { attachments: { 'm.image': { mimeTypes: { 'image/jpeg': 1 } }, 'm.file': { mimeTypes: { '*/*': 1 } } } };
const noFiles: AttachmentCaps = { attachments: {} };

test('sniffImage: picture types from their first bytes; anything else unknown', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(GIF), 'image/gif');
  assert.equal(sniffImage(WEBP), 'image/webp');
  assert.equal(sniffImage(BMP), 'image/bmp');
  assert.equal(sniffImage(new TextEncoder().encode('\x00\x00\x00\x1cftypavif\x00\x00')), 'image/avif');
  assert.equal(sniffImage(new TextEncoder().encode('%PDF-1.4\n')), undefined);
  assert.equal(sniffImage(new Uint8Array(0)), undefined);
  assert.equal(sniffImage(PNG.subarray(0, 4)), undefined);
});

test('nameFor: a pasted picture gets one; a converted one its new extension; others keep theirs', () => {
  assert.equal(nameFor('', 'image/png', false), 'image.png');
  assert.equal(nameFor('  ', 'image/jpeg', false), 'image.jpg');
  assert.equal(nameFor('', '', false), 'file');
  assert.equal(nameFor('Screenshot 2026-11-02.png', 'image/png', false), 'Screenshot 2026-11-02.png');
  assert.equal(nameFor('scan.bmp', 'image/png', true), 'scan.png');
  assert.equal(nameFor('noext', 'image/png', true), 'noext.png');
  assert.equal(nameFor('a.b.avif', 'image/jpeg', true), 'a.b.jpg');
  assert.equal(untyped(''), true);
  assert.equal(untyped('application/octet-stream'), true);
  assert.equal(untyped('image/png'), false);
});

test('a PNG screenshot is a photo where PNG photos are taken: no conversion, captioned', () => {
  assert.deepEqual(attachmentPlanFor(photosOnly, 'image/png', 500), { ok: true, caption: true, asFile: false });
  assert.equal(imageConversion(photosOnly, 'image/png', 500), undefined);
  assert.equal(imageConversion(open, 'image/png', 500), undefined);
  assert.equal(imageConversion(undefined, 'image/bmp', 500), undefined, 'no capabilities known: anything goes');
});

test('imageConversion: refused or file-only pictures become PNG (else JPEG) where that is a photo, within its limit', () => {
  assert.deepEqual(imageConversion(photosOnly, 'image/bmp', 500), { type: 'image/png', maxBytes: 1000 });
  assert.deepEqual(imageConversion(photosOnly, 'image/avif', 500), { type: 'image/png', maxBytes: 1000 });
  assert.deepEqual(imageConversion(jpegOrFile, 'image/png', 500), { type: 'image/jpeg' }, 'a PNG would only go as a file');
  assert.equal(imageConversion(jpegOrFile, 'image/jpeg', 500), undefined);
  // Too large: a JPEG within the limit (a big screenshot, or a big JPEG redrawn smaller).
  assert.deepEqual(imageConversion(photosOnly, 'image/png', 5000), { type: 'image/jpeg', maxBytes: 1000 });
  assert.deepEqual(imageConversion(photosOnly, 'image/jpeg', 5000), { type: 'image/jpeg', maxBytes: 1000 });
  // Not for: GIF (an animation would become a still), other files, SVG, HEIC (browsers cannot decode it), or a
  // network that takes no files.
  assert.equal(imageConversion(photosOnly, 'image/gif', 500), undefined);
  assert.equal(attachmentPlanFor(photosOnly, 'image/gif', 500).ok, false, 'refused as such: "type not supported"');
  assert.equal(imageConversion(photosOnly, 'application/pdf', 500), undefined);
  assert.equal(imageConversion(photosOnly, 'image/svg+xml', 500), undefined);
  assert.equal(imageConversion(photosOnly, 'image/heic', 500), undefined);
  assert.equal(imageConversion(noFiles, 'image/bmp', 500), undefined);
});

// A canvas that answers `bytes` per type (redraw.ts in the browser), and records what it was asked.
const asked: { type: string; maxBytes?: number }[] = [];
const canvasOf =
  (bytes: Partial<Record<string, Uint8Array>>): Redraw =>
  async (_file, type, maxBytes) => {
    asked.push({ type, ...(maxBytes ? { maxBytes } : {}) });
    return new Blob([bytes[type] ?? (type === 'image/png' ? PNG : JPEG)], { type });
  };
const redrawTo = canvasOf({});
const cannot: Redraw = async () => null;

test('prepareFile: an untyped pasted PNG gets its type and a name; a typed one is the same file', async () => {
  const pasted = new File([PNG], '', { type: '' });
  const ready = await prepareFile(pasted, photosOnly, cannot);
  assert.deepEqual([ready.name, ready.type, ready.size], ['image.png', 'image/png', PNG.length]);
  const generic = await prepareFile(new File([PNG], 'blob', { type: 'application/octet-stream' }), photosOnly, cannot);
  assert.equal(generic.type, 'image/png');
  const snip = new File([PNG], 'image.png', { type: 'image/png' });
  assert.equal(await prepareFile(snip, photosOnly, cannot), snip);
  const pdf = new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' });
  assert.equal(await prepareFile(pdf, photosOnly, cannot), pdf);
});

test('prepareFile: a refused picture re-encoded when the browser can; left as it is when not', async () => {
  const bmp = new File([BMP], 'scan.bmp', { type: 'image/bmp' });
  const png = await prepareFile(bmp, photosOnly, redrawTo);
  assert.deepEqual([png.name, png.type], ['scan.png', 'image/png']);
  assert.equal(attachmentPlanFor(photosOnly, png.type, png.size).ok, true);
  const jpg = await prepareFile(new File([PNG], 'shot.png', { type: 'image/png' }), jpegOrFile, redrawTo);
  assert.deepEqual([jpg.name, jpg.type], ['shot.jpg', 'image/jpeg']);
  assert.equal(await prepareFile(bmp, photosOnly, cannot), bmp, 'not decodable: the plan refuses it as before');
  assert.equal(await prepareFile(bmp, photosOnly, async () => Promise.reject(new Error('x'))), bmp);
  // An untyped BMP: sniffed, then converted.
  const untypedBmp = await prepareFile(new File([BMP], '', { type: '' }), photosOnly, redrawTo);
  assert.deepEqual([untypedBmp.name, untypedBmp.type], ['image.png', 'image/png']);
  // A GIF stays a GIF (refused by the plan, not flattened).
  const gif = new File([GIF], 'anim.gif', { type: 'image/gif' });
  assert.equal(await prepareFile(gif, photosOnly, redrawTo), gif);
});

test('prepareFile: a picture too large for the network becomes a JPEG within the limit; the plan is made on what comes out', async () => {
  const big = new File([PNG, new Uint8Array(4000)], 'Screenshot.png', { type: 'image/png' });
  asked.length = 0;
  const jpg = await prepareFile(big, photosOnly, redrawTo);
  assert.deepEqual([jpg.name, jpg.type, jpg.size], ['Screenshot.jpg', 'image/jpeg', JPEG.length]);
  assert.deepEqual(asked, [{ type: 'image/jpeg', maxBytes: 1000 }]);
  assert.equal(attachmentPlanFor(photosOnly, jpg.type, jpg.size).ok, true);
  // A BMP whose PNG is too large: then a JPEG.
  asked.length = 0;
  const bmp = new File([BMP], 'scan.bmp', { type: 'image/bmp' });
  const twice = await prepareFile(bmp, photosOnly, canvasOf({ 'image/png': new Uint8Array(2000) }));
  assert.deepEqual([twice.name, twice.type], ['scan.jpg', 'image/jpeg']);
  assert.deepEqual(asked, [{ type: 'image/png', maxBytes: 1000 }, { type: 'image/jpeg', maxBytes: 1000 }]);
  // Nothing fits: the original, which the plan refuses for its size (with the limit shown).
  const kept = await prepareFile(big, photosOnly, cannot);
  assert.equal(kept, big);
  assert.equal(attachmentPlanFor(photosOnly, kept.type, kept.size).maxSize, 1000);
});
