import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuActions, type MenuInput } from '../client/src/menuactions.js';

const base: MenuInput = { deleted: false, canReply: true, hasText: false, link: false, anchored: false, augmented: true, hasReactions: false, canCopyImage: true };

test('photo without caption: media actions and reply, no text actions; the augmentations\' entries for pictures', () => {
  assert.deepEqual(menuActions({ ...base, media: { kind: 'image', openable: true } }), ['open', 'save', 'copy-image', 'reply', 'augment']);
  // copy image hidden where the clipboard cannot take images
  assert.deepEqual(menuActions({ ...base, augmented: false, canCopyImage: false, media: { kind: 'image', openable: true } }), ['open', 'save', 'reply']);
});

test('photo with a caption: media first, then the caption text actions (no augmentation entry at the top)', () => {
  assert.deepEqual(menuActions({ ...base, hasText: true, media: { kind: 'image', openable: true } }), [
    'open', 'save', 'copy-image', 'reply', 'copy', 'select', 'augment',
  ]);
});

test('GIF, video, voice and files', () => {
  assert.deepEqual(menuActions({ ...base, media: { kind: 'gif', openable: true } }), ['open', 'save', 'reply', 'augment']);
  assert.deepEqual(menuActions({ ...base, media: { kind: 'video', openable: false } }), ['save', 'reply']);
  assert.deepEqual(menuActions({ ...base, media: { kind: 'audio', openable: false } }), ['save', 'reply']);
  assert.deepEqual(menuActions({ ...base, canReply: false, media: { kind: 'file', openable: true } }), ['open', 'save']);
});

test('text message: augmentation entries after the text actions, and at the top of the touch sheet only', () => {
  assert.deepEqual(menuActions({ ...base, hasText: true }), ['augment-top', 'reply', 'copy', 'select', 'augment']);
  assert.deepEqual(menuActions({ ...base, hasText: true, anchored: true }), ['reply', 'copy', 'augment']);
  assert.deepEqual(menuActions({ ...base, hasText: true, augmented: false, link: true, hasReactions: true }), ['reply', 'copy-link', 'copy', 'select', 'reactions']);
  assert.deepEqual(menuActions({ ...base, hasText: true, anchored: true, hasReactions: true }), ['reply', 'copy', 'augment', 'reactions']);
});

test('deleted message: nothing but the reactions list', () => {
  assert.deepEqual(menuActions({ ...base, deleted: true, hasText: true, hasReactions: true, media: { kind: 'image', openable: true } }), ['reactions']);
});

test('forward: after reply, for any message that can go (never a deleted one)', () => {
  assert.deepEqual(menuActions({ ...base, canForward: true, hasText: true, anchored: true, augmented: false }), ['reply', 'forward', 'copy']);
  assert.deepEqual(menuActions({ ...base, canForward: true, media: { kind: 'file', openable: true } }), ['open', 'save', 'reply', 'forward']);
  assert.deepEqual(menuActions({ ...base, canForward: true, deleted: true }), []);
});

test('audio attachment: the augmentations\' entries only when one takes audio menus (audioMenu, 1.23.0)', () => {
  const audio = { kind: 'audio' as const, openable: false };
  assert.deepEqual(menuActions({ ...base, media: audio }), ['save', 'reply'], 'text and picture entries only, as before');
  assert.deepEqual(menuActions({ ...base, media: audio, augmentedAudio: true }), ['save', 'reply', 'augment']);
  assert.deepEqual(menuActions({ ...base, media: audio, augmentedAudio: true, deleted: true }), []);
});
