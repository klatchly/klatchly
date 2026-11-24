import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushLinksScript } from '../server/registry.js';
import { load, plain, push } from './sw-harness.js';

const labels = { reply: 'Reply', read: 'Mark as read', placeholder: 'Message', replyFailed: 'Reply not sent' };
const full = { title: 'Alice', body: 'Salut', tag: '!a:b', url: '/chat/%21a%3Ab', ts: 5, chatID: '!a:b', badge: 7, labels };

test('push shows a notification from the payload', async () => {
  const sw = load();
  await sw.fire('push', push({ title: 'Alice', body: 'Salut', tag: '!a:b', url: '/chat/%21a%3Ab', ts: 5 }));
  assert.equal(sw.shown.length, 1);
  const [title, o] = sw.shown[0]!;
  assert.equal(title, 'Alice');
  assert.equal(o.body, 'Salut');
  assert.equal(o.tag, '!a:b');
  assert.equal(o.renotify, true);
  assert.equal((plain(o.data) as { url: string }).url, '/chat/%21a%3Ab');
  assert.equal(o.timestamp, 5);
  assert.equal(o.actions, undefined);
});

test('malformed or hostile payloads still show a safe notification', async () => {
  const sw = load({ maxActions: 2 });
  await sw.fire('push', { data: { json: () => { throw new Error('x'); } } });
  await sw.fire('push', push({ title: 42, url: 'https://evil.example/' }));
  await sw.fire('push', push({ title: 'x'.repeat(500), url: '//evil.example/chat/x', chatID: 'a b', labels, badge: -1 }));
  assert.equal(sw.shown.length, 3);
  assert.equal(sw.shown[0]![0], '•');
  assert.equal((plain(sw.shown[1]![1].data) as { url: string }).url, '/');
  assert.equal(sw.shown[2]![0].length, 120);
  assert.equal((plain(sw.shown[2]![1].data) as { url: string }).url, '/');
  assert.equal(sw.shown[2]![1].actions, undefined, 'no actions without a valid chat ID');
  assert.deepEqual(sw.badges, []);
});

test('actions where supported (button reply); badge set from the payload', async () => {
  const sw = load({ maxActions: 2 });
  await sw.fire('push', push(full));
  assert.deepEqual(plain(sw.shown[0]![1].actions), [{ action: 'reply', title: 'Reply' }, { action: 'read', title: 'Mark as read' }]);
  assert.deepEqual(sw.badges, [7]);
  const none = load({ maxActions: 0 });
  await none.fire('push', push(full));
  assert.equal(none.shown[0]![1].actions, undefined, 'maxActions 0: no actions');
});

test('inline text reply only when the platform exposes NotificationEvent.reply', async () => {
  const sw = load({ maxActions: 2, inlineReply: true });
  await sw.fire('push', push(full));
  assert.deepEqual(plain(sw.shown[0]![1].actions), [
    { action: 'reply', title: 'Reply', type: 'text', placeholder: 'Message' },
    { action: 'read', title: 'Mark as read' },
  ]);
});

test('a platform rejecting actions still gets the notification; no Badging API is fine', async () => {
  const sw = load({ maxActions: 2, showThrows: true, badge: false });
  await sw.fire('push', push(full));
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0]![1].actions, undefined);
  assert.equal(sw.shown[0]![1].body, 'Salut');
});

const note = (data: unknown) => ({ data, close: () => {} });

test('"Mark as read" posts from the worker without opening a window', async () => {
  const sw = load();
  await sw.fire('notificationclick', { action: 'read', notification: note({ url: '/chat/x', chatID: '!a:b', labels }) });
  assert.equal(sw.fetched.length, 1);
  const f = sw.fetched[0]!;
  assert.equal(f.url, '/api/notify/read');
  assert.equal(f.init.method, 'POST');
  assert.equal(f.init.credentials, 'same-origin');
  assert.equal(f.init.redirect, 'manual');
  assert.deepEqual(JSON.parse(f.init.body as string), { chatID: '!a:b' });
  assert.deepEqual(sw.opened, []);
  assert.deepEqual(sw.badges, [3]);
});

test('inline reply posts the text; failure shows a notice', async () => {
  const sw = load();
  await sw.fire('notificationclick', { action: 'reply', reply: '  ok  ', notification: note({ url: '/chat/x', chatID: '!a:b', labels }) });
  assert.equal(sw.fetched[0]!.url, '/api/notify/reply');
  assert.deepEqual(JSON.parse(sw.fetched[0]!.init.body as string), { chatID: '!a:b', text: 'ok' });
  assert.deepEqual(sw.opened, []);
  const bad = load({ fetchStatus: 502 });
  await bad.fire('notificationclick', { action: 'reply', reply: 'ok', notification: note({ url: '/chat/x', chatID: '!a:b', labels }) });
  assert.equal(bad.shown[0]![0], 'Reply not sent');
});

test('"Reply" without inline text opens the chat with the composer focused', async () => {
  const msgs: unknown[] = [];
  const sw = load({ windows: [{ url: 'https://klatchly.example/', focus: async () => {}, postMessage: (m) => msgs.push(m) }] });
  await sw.fire('notificationclick', { action: 'reply', notification: note({ url: '/chat/abc', chatID: 'abc', labels }) });
  assert.deepEqual(plain(msgs), [{ type: 'open', url: '/chat/abc?compose=1' }]);
  assert.equal(sw.fetched.length, 0);
});

test('click focuses an open window and asks it to open the chat', async () => {
  const msgs: unknown[] = [];
  let focused = 0;
  const sw = load({ windows: [{ url: 'https://klatchly.example/', focus: async () => void focused++, postMessage: (m) => msgs.push(m) }] });
  let closed = false;
  await sw.fire('notificationclick', { action: '', notification: { data: { url: '/chat/abc' }, close: () => (closed = true) } });
  assert.ok(closed);
  assert.equal(focused, 1);
  assert.deepEqual(plain(msgs), [{ type: 'open', url: '/chat/abc' }]);
  assert.deepEqual(plain(sw.opened), []);
});

test('click with no window opens one; foreign URLs are replaced by /', async () => {
  const sw = load({ windows: [{ url: 'https://other.example/', focus: async () => {}, postMessage: () => {} }] });
  await sw.fire('notificationclick', { action: '', notification: { data: { url: 'https://evil.example' }, close: () => {} } });
  await sw.fire('notificationclick', { action: '', notification: { data: { url: '/chat/x' }, close: () => {} } });
  await sw.fire('notificationclick', { action: 'read', notification: { data: { url: '/chat/x', chatID: 'bad id' }, close: () => {} } });
  assert.deepEqual(plain(sw.opened), ['/', '/chat/x', '/chat/x']);
});

const click = async (sw: ReturnType<typeof load>, urls: string[]) => {
  for (const url of urls) await sw.fire('notificationclick', { action: '', notification: { data: { url }, close: () => {} } });
};

test("spaces' notification targets come from /push-links.js; without it, none", async () => {
  // A space of some package (the build's real ones are tested by their packages).
  const links = pushLinksScript([{ id: 'demo', path: '/demo', segment: '[a-z]{3}' }]);
  const urls = ['/demo', '/demo/abc', '/demo/abcd', '/demo/abc/x', '/demo/', '/demo?x=1', '/demox', 'https://klatchly.example/demo/abc'];
  const sw = load({ links });
  await click(sw, urls);
  assert.deepEqual(plain(sw.opened), ['/demo', '/demo/abc', '/', '/', '/', '/', '/', '/demo/abc']);
  const bare = load({ links: pushLinksScript([]) });
  await click(bare, [...urls.slice(0, 2), '/example', '/example/abc']);
  assert.deepEqual(plain(bare.opened), ['/', '/', '/', '/'], 'no space of a package is known to the core alone');
});

test("a renamed space's former home: old notification links open the same place under the new one", async () => {
  const links = pushLinksScript([{ id: 'demo', path: '/demo', segment: '[a-z]{3}', formerPaths: ['/olddemo'] }]);
  const sw = load({ links });
  await sw.fire('push', push({ title: 'x', body: 'y', tag: 't', url: '/olddemo/abc' }));
  assert.equal((plain(sw.shown[0]![1].data) as { url: string }).url, '/demo/abc', 'translated when shown');
  const urls = ['/olddemo', '/olddemo/abc', 'https://klatchly.example/olddemo/abc', '/olddemo/abcd', '/olddemo/abc/x', '/olddemo/../chat/x', '/olddemox', '/olddemo\\x'];
  await click(sw, urls);
  assert.deepEqual(plain(sw.opened), ['/demo', '/demo/abc', '/demo/abc', '/', '/', '/', '/', '/']);
  // A hostile former path is dropped; a former path never reaches another space or the chats.
  const odd = load({ links: `self.pushLinks = ${JSON.stringify([{ path: '/demo', former: ['//evil.example', '/chat', 42, '/demo'] }])};` });
  await click(odd, ['//evil.example', '/chat', '/chat/x', '/demo']);
  assert.deepEqual(plain(odd.opened), ['/', '/demo', '/chat/x', '/demo']);
});

test('a hostile list of spaces cannot open another site or another path', async () => {
  // Bad paths, patterns that would leave the segment, or not patterns at all: dropped. Whatever a pattern
  // matches, it only ever sees one segment without a slash or a backslash.
  const list = [
    { path: '/notes', segment: '.*' },
    { path: '//evil.example' },
    { path: '/x$|^/' },
    { path: '/ok', segment: 'a)|(b' },
    { path: '/fine', segment: '[a-z]+|(x)' },
    '^\\/.*$',
    42,
  ];
  const sw = load({ links: `self.pushLinks = ${JSON.stringify(list)};` });
  await click(sw, ['/notes/x', '//evil.example', '/x', '/fine/abc', '/fine/a/b', '/fine/a\\b', '/ok/a', '/anything']);
  assert.deepEqual(plain(sw.opened), ['/', '/', '/', '/fine/abc', '/', '/', '/', '/']);
});

test('a path read as another host is never opened ("//host", "/\\host"), in either form', async () => {
  const sw = load({ links: pushLinksScript([{ id: 'demo', path: '/demo' }]) });
  await click(sw, ['https://klatchly.example//evil.example/x', '//evil.example/x', 'https://klatchly.example/%2F%2Fevil.example', '/\\evil.example/chat/x', 'https://klatchly.example/\\evil.example/x']);
  assert.deepEqual(plain(sw.opened), ['/', '/', '/', '/', '/']);
  assert.ok(!(plain(sw.opened) as string[]).some((u) => u.startsWith('//') || u.startsWith('/\\')));
});

// ── Declarative Web Push ─────────────────────────────────────────────────────

const labelsData = { chatID: '!a:b', labels };
const declNotification = {
  title: 'Alice',
  body: 'Salut',
  navigate: 'https://klatchly.example/chat/%21a%3Ab',
  tag: '!a:b',
  lang: 'fr',
  dir: 'auto',
  silent: false,
  timestamp: 5,
  data: labelsData,
};
const declarative = (o: Record<string, unknown> = {}) => ({ web_push: 8030, notification: declNotification, app_badge: 7, mutable: true, ...o });

test('declarative JSON delivered as data (browsers without declarative support): shown like before', async () => {
  const sw = load({ maxActions: 2 });
  await sw.fire('push', push(declarative()));
  assert.equal(sw.shown.length, 1);
  const [title, o] = sw.shown[0]!;
  assert.equal(title, 'Alice');
  assert.equal(o.body, 'Salut');
  assert.equal(o.tag, '!a:b');
  assert.equal(o.renotify, true);
  assert.equal(o.timestamp, 5);
  assert.equal(o.navigate, undefined, 'no navigate: clicks reach notificationclick');
  assert.deepEqual(plain(o.data), { url: '/chat/%21a%3Ab', chatID: '!a:b', labels });
  assert.deepEqual(plain(o.actions), [{ action: 'reply', title: 'Reply' }, { action: 'read', title: 'Mark as read' }]);
  assert.deepEqual(sw.badges, [7]);
});

test('declarative JSON with the legacy copy: the declarative part wins; string badge accepted', async () => {
  const sw = load();
  await sw.fire('push', push({ ...full, title: 'old', ...declarative({ app_badge: '0' }) }));
  assert.equal(sw.shown[0]![0], 'Alice');
  assert.deepEqual(sw.badges, ['clear']);
});

test('declarative navigate: other origins, queries and unknown paths fall back to /', async () => {
  const sw = load({ links: pushLinksScript([{ id: 'demo', path: '/demo', segment: '[a-z]{3}' }]) });
  const bad = ['https://evil.example/chat/x', 'https://klatchly.example/chat/x?y=1', 'https://klatchly.example/api/jobs', 'javascript:alert(1)', 'https://klatchly.example/demo/a/b', '//evil.example/chat/x'];
  for (const navigate of bad) await sw.fire('push', push(declarative({ notification: { ...declNotification, navigate } })));
  assert.deepEqual(sw.shown.map(([, o]) => (o.data as { url: string }).url), bad.map(() => '/'));
  await sw.fire('push', push(declarative({ notification: { ...declNotification, navigate: 'https://klatchly.example/demo/abc' } })));
  assert.equal((sw.shown[bad.length]![1].data as { url: string }).url, '/demo/abc');
});

// Safari: event.data is null; event.notification is the proposed notification, event.appBadge its badge.
const proposed = (o: Record<string, unknown> = {}) => ({
  data: null,
  appBadge: 3,
  notification: { title: 'Alice', body: 'Salut', tag: '!a:b', navigate: 'https://klatchly.example/chat/%21a%3Ab', data: labelsData, ...o },
});

test('Safari, no app window, no actions: the proposed notification is left to the browser; badge set', async () => {
  const sw = load({ maxActions: 0 });
  await sw.fire('push', proposed());
  assert.equal(sw.shown.length, 0, 'nothing shown by the worker: the browser shows the declarative one');
  assert.deepEqual(sw.badges, [3]);
});

test('Safari with an app window open: replaced so that a click routes in place', async () => {
  const msgs: unknown[] = [];
  const win = { url: 'https://klatchly.example/chat/other', focus: async () => {}, postMessage: (m: unknown) => msgs.push(m) };
  const sw = load({ maxActions: 0, windows: [win] });
  await sw.fire('push', proposed());
  assert.equal(sw.shown.length, 1);
  const [title, o] = sw.shown[0]!;
  assert.equal(title, 'Alice');
  assert.equal(o.tag, '!a:b');
  assert.equal(o.navigate, undefined);
  assert.deepEqual(plain(o.data), { url: '/chat/%21a%3Ab', chatID: '!a:b', labels });
  await sw.fire('notificationclick', { action: '', notification: { data: o.data, close: () => {} } });
  assert.deepEqual(plain(msgs), [{ type: 'open', url: '/chat/%21a%3Ab' }]);
});

test('Safari where actions are supported: replaced to add Reply / Mark as read', async () => {
  const sw = load({ maxActions: 2 });
  await sw.fire('push', proposed());
  assert.equal(sw.shown.length, 1);
  assert.equal((sw.shown[0]![1].actions as unknown[]).length, 2);
});

test('Safari: a window of another origin does not count', async () => {
  const sw = load({ windows: [{ url: 'https://other.example/', focus: async () => {}, postMessage: () => {} }] });
  await sw.fire('push', proposed({ data: null }));
  assert.equal(sw.shown.length, 0);
});

test('click on a browser-shown declarative notification (if a browser fires the event): uses navigate', async () => {
  const sw = load();
  await sw.fire('notificationclick', { action: '', notification: { data: null, navigate: 'https://klatchly.example/chat/%21a%3Ab', close: () => {} } });
  await sw.fire('notificationclick', { action: '', notification: { data: labelsData, navigate: 'https://evil.example/chat/x', close: () => {} } });
  await sw.fire('notificationclick', { action: 'read', notification: { data: labelsData, navigate: 'https://klatchly.example/chat/%21a%3Ab', close: () => {} } });
  assert.deepEqual(plain(sw.opened), ['/chat/%21a%3Ab', '/']);
  assert.equal(sw.fetched[0]!.url, '/api/notify/read');
});
