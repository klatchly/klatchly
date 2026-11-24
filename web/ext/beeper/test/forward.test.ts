import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { forwardRoutes } from '#core/forward.js';
import { mxcOf } from '../server/mxc.js';
import { mockUpstream } from '../../../test/mock.js';
import './setup.js';

const IMG = 'mxc://local.beeper.com/user_photo1';
const messages: Record<string, unknown> = {
  m1: { id: 'm1', chatID: '!chatA', text: 'a <b>caption</b> &amp; more', attachments: [{ id: IMG, type: 'img', mimeType: 'image/jpeg', fileName: 'photo.jpg', fileSize: 9, srcURL: 'file:///data/media/local.beeper.com/user_photo1', size: { width: 4, height: 3 } }] },
  m2: { id: 'm2', chatID: '!chatA', text: 'just text' },
  m3: { id: 'm3', chatID: '!chatA', text: 'gone', isDeleted: true },
  m4: { id: 'm4', chatID: '!chatA', attachments: [{ id: 'x', type: 'unknown', srcURL: 'file:///etc/passwd', fileName: 'passwd' }] },
  m5: { id: 'm5', chatID: '!chatOther', text: 'not in !chatA' },
};
const chats: Record<string, unknown> = {
  '!chatB': { id: '!chatB', capabilities: {} },
  '!chatRO': { id: '!chatRO', isReadOnly: true },
  '!chatNoFiles': { id: '!chatNoFiles', capabilities: { attachments: {} } },
};
let uploads = 0;
const up = mockUpstream({
  ...Object.fromEntries(Object.entries(messages).map(([id, m]) => [`GET /v1/chats/!chatA/messages/${id}`, () => [200, m] as [number, unknown]])),
  ...Object.fromEntries(Object.entries(chats).map(([id, c]) => [`GET /v1/chats/${id}`, () => [200, c] as [number, unknown]])),
  'GET /v1/assets/serve': () => [200, 'PNGDATA'],
  'POST /v1/assets/upload': () => [200, { uploadID: `up-${++uploads}`, fileName: 'photo.jpg', mimeType: 'image/jpeg', srcURL: 'file:///secret/path' }],
  'POST /v1/chats/!chatB/messages': () => [200, { chatID: '!chatB', pendingMessageID: 'p1' }],
});
const app = new Hono().route('/api', forwardRoutes);
const post = (body: unknown) => app.request('/api/forward', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sends = () => up.calls.filter((c) => c.method === 'POST' && c.url === '/v1/chats/!chatB/messages').map((c) => JSON.parse(c.body) as Record<string, unknown>);

before(() => up.start());
after(() => up.stop());

test('media sources: only allowlisted mxc:// (cache paths mapped back), never file paths or URLs', () => {
  assert.equal(mxcOf({ srcURL: 'file:///data/media/local.beeper.com/user_x' }), 'mxc://local.beeper.com/user_x');
  assert.equal(mxcOf({ srcURL: 'file:///etc/passwd', id: IMG }), IMG);
  for (const a of [{ srcURL: 'file:///etc/passwd' }, { srcURL: 'https://evil.example/x.jpg' }, { srcURL: 'mxc://h/../x' }, { id: 'mxc://h/a?url=file:///x' }, {}]) {
    assert.equal(mxcOf(a), undefined, JSON.stringify(a));
  }
});

test('forward a photo with its caption: fetched by mxc, uploaded, sent; nothing from the browser', async () => {
  const r = await post({ from: [{ chatID: '!chatA', messageID: 'm1' }], to: ['!chatB'] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { results: [{ chatID: '!chatB', ok: true, sent: 1 }] });
  const serve = up.calls.find((c) => c.url.startsWith('/v1/assets/serve'))!;
  assert.equal(new URL(serve.url, 'http://x').searchParams.get('url'), 'mxc://local.beeper.com/user_photo1');
  const upload = up.calls.find((c) => c.url === '/v1/assets/upload')!;
  assert.match(upload.body, /filename="photo.jpg"/);
  assert.match(upload.body, /"PNGDATA"/);
  assert.deepEqual(sends().pop(), { text: 'a caption & more', attachment: { uploadID: 'up-1', mimeType: 'image/jpeg', fileName: 'photo.jpg', size: { width: 4, height: 3 } } });
});

test('text forwards as text; per-target errors without sending there', async () => {
  const r = await post({ from: [{ chatID: '!chatA', messageID: 'm2' }], to: ['!chatB', '!chatRO'] });
  assert.deepEqual(await r.json(), { results: [{ chatID: '!chatB', ok: true, sent: 1 }, { chatID: '!chatRO', ok: false, sent: 0, error: 'read_only' }] });
  assert.deepEqual(sends().pop(), { text: 'just text' });
  const before = up.calls.length;
  const r2 = await post({ from: [{ chatID: '!chatA', messageID: 'm1' }], to: ['!chatNoFiles'] });
  assert.deepEqual(await r2.json(), { results: [{ chatID: '!chatNoFiles', ok: false, sent: 0, error: 'no_files' }] });
  assert.ok(!up.calls.slice(before).some((c) => c.method === 'POST'), 'nothing uploaded or sent');
});

test('sources must exist in their chat and hold something forwardable', async () => {
  assert.equal((await post({ from: [{ chatID: '!chatA', messageID: 'm3' }], to: ['!chatB'] })).status, 404);
  assert.equal((await post({ from: [{ chatID: '!chatA', messageID: 'm5' }], to: ['!chatB'] })).status, 404);
  assert.equal((await post({ from: [{ chatID: '!chatA', messageID: 'nope' }], to: ['!chatB'] })).status, 404);
  assert.equal((await post({ from: [{ chatID: '!chatA', messageID: 'm4' }], to: ['!chatB'] })).status, 422);
  assert.equal((await post({ from: [{ chatID: '!chatA', messageID: 'm2' }], to: ['missing'] })).status, 404);
  assert.equal((await post({ from: [{ chatID: '!chatA', messageID: 'm2' }], to: ['!chatB'], x: 1 })).status, 400);
  assert.ok(!up.calls.some((c) => c.url.includes('passwd')));
});

test('rate limited like the other send routes', async () => {
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) limited = (await post({ bad: true })).status === 429;
  assert.ok(limited);
});
