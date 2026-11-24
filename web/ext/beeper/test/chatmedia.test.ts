import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { chatMediaRoutes } from '#core/chatmedia.js';
import { mockUpstream } from '../../../test/mock.js';
import './setup.js';

// The media page's route (core) on the Desktop API's message search (mediaMessages).

const img = (n: number) => ({ id: `mxc://local.beeper.com/i${n}`, type: 'img', mimeType: 'image/jpeg', srcURL: `mxc://local.beeper.com/i${n}`, size: { width: 10, height: 20 } });
const msg = (id: string, extra: Record<string, unknown>) => ({ id, chatID: '!chatA', senderID: '@a:x', senderName: 'A', timestamp: '2026-10-01T10:00:00Z', sortKey: id, reactions: [{ id: 'r' }], mentions: ['@b'], seen: { x: 1 }, ...extra });

// Two upstream pages of 20 hits each, then a last one; a hit from another chat and a sticker are dropped.
const pages: Record<string, { items: unknown[]; hasMore: boolean; oldestCursor: string | null }> = {
  first: { items: [...Array.from({ length: 20 }, (_, i) => msg(`m${i}`, { attachments: [img(i)] })), msg('other', { chatID: '!chatB', attachments: [img(99)] })], hasMore: true, oldestCursor: 'c1' },
  c1: { items: [msg('sticker', { attachments: [{ type: 'img', isSticker: true, srcURL: 'mxc://x/s' }] }), ...Array.from({ length: 20 }, (_, i) => msg(`n${i}`, { attachments: [img(100 + i)] }))], hasMore: true, oldestCursor: 'c2' },
  c2: { items: [msg('v1', { attachments: [{ type: 'video', mimeType: 'video/mp4', srcURL: 'mxc://x/v', duration: 12 }] })], hasMore: false, oldestCursor: 'c3' },
};
const up = mockUpstream({
  'GET /v1/messages/search': (req) => {
    const q = new URL(req.url!, 'http://x').searchParams;
    if (q.get('chatIDs') === '!boom') return [500, { message: 'x' }];
    return [200, pages[q.get('cursor') ?? 'first']];
  },
});
const app = new Hono().route('/api', chatMediaRoutes);
const get = (path: string) => app.request(path);
const searches = () => up.calls.filter((c) => c.url.startsWith('/v1/messages/search')).map((c) => new URL(c.url, 'http://x').searchParams);

before(() => up.start());
after(() => up.stop());

test('media endpoint: one chat, its media types, a few upstream pages per request', async () => {
  const r = await get('/api/chats/!chatA/media?tab=media');
  assert.equal(r.status, 200);
  const j = (await r.json()) as { items: { id: string; reactions?: unknown }[]; hasMore: boolean; cursor: string | null };
  assert.equal(j.items.length, 40);
  assert.ok(!j.items.some((m) => m.id === 'other' || m.id === 'sticker' || m.reactions));
  assert.equal(j.hasMore, true);
  assert.equal(j.cursor, 'c2');
  const qs = searches();
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[0]!.getAll('chatIDs'), ['!chatA']);
  assert.deepEqual(qs[0]!.getAll('mediaTypes'), ['image', 'video']);
  assert.equal(qs[0]!.get('excludeLowPriority'), 'false');
  assert.equal(qs[0]!.get('limit'), '20');
  assert.equal(qs[1]!.get('cursor'), 'c1');
  assert.equal(qs[1]!.get('direction'), 'before');

  const r2 = await get('/api/chats/!chatA/media?tab=media&cursor=c2');
  const j2 = (await r2.json()) as { items: { id: string }[]; hasMore: boolean; cursor: string | null };
  assert.deepEqual(j2.items.map((m) => m.id), ['v1']);
  assert.equal(j2.hasMore, false);
  assert.equal(j2.cursor, null);

  await get('/api/chats/!chatA/media?tab=files');
  assert.deepEqual(searches().pop()!.getAll('mediaTypes'), ['file']);
  await get('/api/chats/!chatA/media?tab=links');
  assert.deepEqual(searches().pop()!.getAll('mediaTypes'), ['link']);
});

test('media endpoint: strict parameters, upstream errors mapped', async () => {
  for (const p of ['?tab=photos', '?tab=media&x=1', '?cursor=', '?cursor=a%20b', `?cursor=${'c'.repeat(600)}`]) {
    assert.equal((await get(`/api/chats/!chatA/media${p}`)).status, 400, p);
  }
  assert.equal((await get('/api/chats/a%20b/media')).status, 400);
  assert.equal((await get('/api/chats/!boom/media')).status, 502);
});
