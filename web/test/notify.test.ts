import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { notifyRoutes } from '../server/notify.js';
import { noteChat } from '../server/pushwatch.js';
import { fakeSource, withFake } from './fakesource.js';

// Actions from a notification, on the chat's connector (a fake one here; the Desktop API calls they make are in
// ext/beeper/test/notify.test.ts).

const src = fakeSource();
withFake(src);
const app = new Hono().route('/api', notifyRoutes);
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test("read and reply go to the chat's connector; the badge follows", async () => {
  noteChat({ id: 'f1', unreadCount: 3 });
  noteChat({ id: 'f2', unreadCount: 2 });
  const r = await post('/api/notify/read', { chatID: 'f1' });
  assert.deepEqual(await r.json(), { ok: true, badge: 2 });
  assert.deepEqual(src.calls.splice(0), ['read f1']);
  const s = await post('/api/notify/reply', { chatID: 'f2', text: 'ok' });
  assert.deepEqual(await s.json(), { ok: true, badge: 0 });
  assert.deepEqual(src.calls.splice(0), ['send f2 {"text":"ok"}', 'read f2']);
});
