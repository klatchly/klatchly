import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bubbleImage, smallImage, thumbQuery, thumbUrl } from '../client/src/thumbs.js';
import { useConnectorTraits } from '../client/src/connectors.js';

// A connector whose media go through the core's relay (/api/media?k=<its reference>, its thumbnails by the same
// parameter), and one whose entries give their own media paths, photos with thumbnails by ?c=&m= (as a bridge on
// the server may give). The core assumes no connector's (1.25): a package's own cases are in its tests.
const orig = '/api/media/m.jpg?k=abc123&type=image%2Fjpeg&name=IMG_0001.jpg';
useConnectorTraits([
  {
    id: 'relayed',
    name: 'Relayed',
    owns: (id) => id.startsWith('r:'),
    thumb: (path, p) => (/^\/api\/media\/[a-z0-9]{1,16}\.[a-z0-9]{2,5}$/.test(path) && /^[a-z0-9]{1,16}$/.test(p.get('k') ?? '') ? `k=${p.get('k')}` : undefined),
  },
  {
    id: 'other',
    name: 'Other',
    thumb: (path, p) => (path === '/api/other/media/m.jpg' && /^o:\d+$/.test(p.get('c') ?? '') && /^\d+$/.test(p.get('m') ?? '') ? `c=${encodeURIComponent(p.get('c')!)}&m=${p.get('m')}` : undefined),
  },
]);
const other = '/api/other/media/m.jpg?c=o%3A123&m=456';
const q = 'k=abc123';

test('thumbnail source of a relay URL', () => {
  assert.equal(thumbQuery(orig), q);
  assert.equal(thumbQuery(other), 'c=o%3A123&m=456');
  // No connector names them: no thumbnail (a content URI included: the core relays nobody's by default).
  for (const u of [undefined, '', '/api/other/avatar/a.jpg?id=1', '/api/preview-img?u=x', '/api/media/m.jpg', 'https://x/api/media/m.jpg?k=abc', '/api/media/m.jpg?url=mxc%3A%2F%2Fa%2Fb', '/api/media/m.jpg?url=file%3A%2F%2F%2Fetc', '/api/media/m.jpg?k=..%2Fx', '/api/other/media/m.jpg?c=o%3A1&m=x'])
    assert.equal(thumbQuery(u), undefined, String(u));
});

test('srcset of a bubble: thumbnails up to the original width, sized to the bubble', () => {
  const t = (w: number, d = w) => `/api/thumb/w${w}.webp?${q} ${d}w`;
  const big = bubbleImage(orig, 1080, 280);
  assert.equal(big.src, thumbUrl(q, 640));
  assert.equal(big.srcSet, [t(320), t(640), t(960)].join(', '));
  assert.equal(big.sizes, '280px');
  // Narrower than the largest thumbnail: the next one up is made at the original's width, and said so.
  assert.equal(bubbleImage(orig, 700, 280).srcSet, [t(320), t(640), t(960, 700)].join(', '));
  assert.equal(bubbleImage(orig, 640, 280).srcSet, [t(320), t(640)].join(', '));
  const narrow = bubbleImage(orig, 500, 280);
  assert.equal(narrow.srcSet, [t(320), t(640, 500)].join(', '));
  assert.equal(narrow.src, thumbUrl(q, 640));
  // Small already: still one thumbnail (cacheable), at its own width.
  assert.deepEqual(bubbleImage(orig, 300, 280), { src: thumbUrl(q, 320), srcSet: t(320, 300), sizes: '280px' });
  // Unknown size (some sources' older photos): every width.
  const z = bubbleImage(other, undefined, 320);
  assert.equal(z.srcSet?.split(', ').length, 3);
  assert.equal(z.sizes, '320px');
  // No thumbnail route: unchanged.
  assert.deepEqual(bubbleImage('/api/other/sticker/s.png?id=5', 1000, 140), { src: '/api/other/sticker/s.png?id=5' });
  // Retry: new URLs for every candidate.
  const r = bubbleImage(orig, 700, 280, 2);
  assert.ok(r.srcSet!.split(', ').every((c) => /[?&]r=2 \d+w$/.test(c)));
  assert.match(r.src, /&r=2$/);
  assert.deepEqual(bubbleImage('/api/other/sticker/s.png?id=5', 200, 200, 1), { src: '/api/other/sticker/s.png?id=5&r=1' });
});

test('avatars and posters', () => {
  assert.equal(smallImage(orig, 144), `/api/thumb/w144.webp?${q}`);
  assert.equal(smallImage('/api/other/avatar/a.jpg?id=1', 144), '/api/other/avatar/a.jpg?id=1');
  assert.equal(smallImage(undefined, 144), undefined);
});
