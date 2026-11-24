import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatConnector, connectorMediaQuery, isConnectorMediaRef, lowPriorityShown, useConnectorTraits } from '../../../client/src/connectors.js';
import { reactionView } from '../../../client/src/reactions.js';
import { keepDelivered } from '../../../client/src/receipts.js';
import { smallImage, thumbQuery } from '../../../client/src/thumbs.js';
import type { Message } from '../../../client/src/types.js';
import { isBeeperChatID } from '../package.js';
import { beeperTraits, toMxc } from '../client/traits.js';

// Beeper's client traits (client/traits.ts), as the core's pure client modules use them: what moved out of the core
// in 1.25 gives the same answers as before (the /api/media and /api/thumb URLs byte for byte, so the browsers' HTTP
// cache and the thumbnail cache keep their entries), and nothing of it without the beeper package.

useConnectorTraits([beeperTraits]);
const enc = encodeURIComponent;

test('its chats: Matrix room ids', () => {
  assert.ok(isBeeperChatID('!room:beeper.local'));
  for (const id of ['other:u:1', 'x', '', undefined]) assert.ok(!isBeeperChatID(id), String(id));
  assert.equal(chatConnector('!room:beeper.local')?.id, 'beeper');
  assert.equal(chatConnector('other:u:1'), undefined);
});

test('media references: the /api/media parameters the core used to build (cache paths mapped back, strict)', () => {
  const golden: [string, string][] = [
    ['mxc://local.beeper.com/user_abc', 'mxc://local.beeper.com/user_abc'],
    ['file:///data/media/local.beeper.com/user_x', 'mxc://local.beeper.com/user_x'],
    ['/data/media/local.beeper.com/user_y', 'mxc://local.beeper.com/user_y'],
    ['file:///data/media/local-whatsapp.localhost/ba_x/!room/f1.jpg', 'mxc://local-whatsapp.localhost/ba_x/!room/f1.jpg'],
    ['localmxc://local-signal/abc', 'localmxc://local-signal/abc'],
    ['mxc://h/abc?encryptedFileInfoJSON=eyJ2IjoidjIifQ', 'mxc://h/abc?encryptedFileInfoJSON=eyJ2IjoidjIifQ'],
  ];
  for (const [ref, mxc] of golden) {
    assert.equal(toMxc(ref), mxc, ref);
    assert.equal(connectorMediaQuery(ref), `url=${enc(mxc)}`, ref);
    assert.ok(isConnectorMediaRef(ref), ref);
  }
  for (const ref of ['file:///data/media/h/../x', 'file:///etc/passwd', '/data/media/h/a/b/c/d/e', 'https://example.org/a.jpg', 'mxc://h', 'mxc://h/a b', '']) {
    assert.equal(connectorMediaQuery(ref), undefined, ref);
    assert.ok(!isConnectorMediaRef(ref), ref);
  }
});

test('thumbnails of its relay URLs: by the same content URI, as the core made them', () => {
  const mxc = 'mxc://local.beeper.com/user_abc';
  const orig = `/api/media/m.jpg?url=${enc(mxc)}&type=image%2Fjpeg&name=IMG_0001.jpg`;
  assert.equal(thumbQuery(orig), `url=${enc(mxc)}`);
  assert.equal(thumbQuery(`/api/media/m.mp4?url=${enc('localmxc://local-signal/v')}`), `url=${enc('localmxc://local-signal/v')}`);
  assert.equal(smallImage(orig, 144), `/api/thumb/w144.webp?url=${enc(mxc)}`);
  for (const u of ['/api/media/m.jpg?url=file%3A%2F%2F%2Fetc', 'https://x/api/media/m.jpg?url=mxc%3A%2F%2Fa%2Fb', '/api/media/m.jpg', '/api/other/m.jpg?url=mxc%3A%2F%2Fa%2Fb'])
    assert.equal(thumbQuery(u), undefined, u);
});

test('image reactions, the low-priority inbox, cached delivery ticks, Markdown in native Matrix chats', () => {
  const key = 'mxc://local.beeper.com/user_sticker1';
  assert.deepEqual(reactionView({ reactionKey: key }), { kind: 'image', text: '', img: key });
  assert.ok(lowPriorityShown());
  assert.equal(beeperTraits.lowPriority, true);
  // Only while the server has Beeper on (registry.ts useLowPriorityShown): turned off, the tab and its query go.
  assert.ok(lowPriorityShown(new Set(['beeper', 'zalo'])));
  assert.ok(!lowPriorityShown(new Set(['zalo'])));
  assert.ok(!lowPriorityShown(new Set()));
  const cached = { id: 'm1', chatID: '!room:beeper.local', delivered: { a: 'x' } } as unknown as Message;
  assert.deepEqual(keepDelivered(cached, { ...cached, delivered: undefined }).delivered, { a: 'x' });
  const k = chatConnector('!room:beeper.local')!;
  assert.equal(k.displaysMarkdown?.({ accountID: 'matrix', network: 'Beeper' }), true);
  assert.equal(k.displaysMarkdown?.({ accountID: 'line', network: 'LINE' }), false);
});

test('without the beeper package: none of it (the core assumes no connector)', () => {
  useConnectorTraits([]);
  try {
    const mxc = 'mxc://local.beeper.com/user_abc';
    assert.equal(connectorMediaQuery(mxc), undefined);
    assert.equal(thumbQuery(`/api/media/m.jpg?url=${enc(mxc)}`), undefined);
    assert.equal(reactionView({ reactionKey: mxc }).kind, 'shortcode');
    assert.ok(!lowPriorityShown());
    const cached = { id: 'm1', chatID: '!room:beeper.local', delivered: { a: 'x' } } as unknown as Message;
    assert.equal(keepDelivered(cached, { ...cached, delivered: undefined }).delivered, undefined);
  } finally {
    useConnectorTraits([beeperTraits]);
  }
});
