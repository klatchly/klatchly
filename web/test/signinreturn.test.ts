import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSettingsPath } from '../server/settingspages.js';
import { afterSignIn, keepReturn, keptReturn, RETURN_KEY, RETURN_MAX, RETURN_TTL_MS, saveReturn, takeReturn, type ReturnStorage } from '../client/src/signinreturn.js';

// Where the app goes once signed in (client/src/signinreturn.ts): an allow-list (a chat, a Settings page, a page of a
// space of the build), everything else home; and the return kept in the tab's sessionStorage across an OIDC sign-in.

/** As App.tsx says: Settings, or a space of this build (here /share and /agents with places). */
const isPage = (p: string) => isSettingsPath(p) || p === '/share' || p === '/agents' || /^\/agents\/[a-z0-9]{1,12}$/.test(p);
const back = (p: string, s = '') => afterSignIn(p, s, isPage);

test('afterSignIn: back to a chat, a Settings page or a space page, with its query', () => {
  assert.equal(back('/share', '?url=https%3A%2F%2Fexample.com&text=hi%20there'), '/share?url=https%3A%2F%2Fexample.com&text=hi%20there');
  assert.equal(back('/chat/abc'), '/chat/abc');
  assert.equal(back('/chat/%21room%3Abeeper.local'), '/chat/%21room%3Abeeper.local');
  for (const sub of ['media', 'files', 'links']) assert.equal(back(`/chat/abc/${sub}`), `/chat/abc/${sub}`);
  assert.equal(back('/settings/general'), '/settings/general');
  assert.equal(back('/settings/ext/share/shortcut'), '/settings/ext/share/shortcut');
  assert.equal(back('/agents/abc'), '/agents/abc');
  assert.equal(back('/share', '?'), '/share');
  // A trailing slash is normalised.
  assert.equal(back('/settings/general/'), '/settings/general');
  assert.equal(back('/share//'), '/share');
});

test('afterSignIn: anything else goes home', () => {
  for (const [p, s] of [
    ['/', ''],
    ['/enroll', '?x=1'],
    ['/enroll/', ''],
    ['//evil.example', ''],
    ['///evil.example', ''],
    ['/\\evil.example', ''],
    ['/%2F%2Fevil.example', ''],
    ['/%5Cevil.example', ''],
    ['/share%2F..', ''],
    ['/settings/%67eneral', ''],
    ['evil', ''],
    ['https://evil.example/', ''],
    ['/nope', ''],
    ['/api/extensions', ''],
    ['/chat/abc/other', ''],
    ['/chat/%E0%A4%A', ''],
    ['/chat/a%20b', ''],
    ['/chat/a%0Ab', ''],
    ['/agents/ABC', ''],
    ['/share\u0000', ''],
    ['/share x', ''],
  ] as const)
    assert.equal(back(p, s), '/', JSON.stringify(p));
  // Without a page predicate, only a chat.
  assert.equal(afterSignIn('/share', ''), '/');
  assert.equal(afterSignIn('/chat/abc', ''), '/chat/abc');
});

test('afterSignIn: an odd query is dropped, a long one up to RETURN_MAX kept, longer goes home', () => {
  assert.equal(back('/share', 'url=x'), '/share');
  assert.equal(back('/share', '?a=1#frag'), '/share');
  assert.equal(back('/share', '?a= b'), '/share');
  const long = `?text=${'x'.repeat(24_000)}`;
  assert.equal(back('/share', long), `/share${long}`);
  assert.ok(RETURN_MAX >= 30_000);
  assert.equal(back('/share', `?text=${'x'.repeat(RETURN_MAX)}`), '/');
});

/** A sessionStorage stand-in; `fail` makes every call throw (private mode). */
function storage(fail = false): ReturnStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const no = () => {
    throw new Error('blocked');
  };
  return {
    map,
    getItem: (k) => (fail ? no() : (map.get(k) ?? null)),
    setItem: (k, v) => (fail ? no() : void map.set(k, v)),
    removeItem: (k) => (fail ? no() : void map.delete(k)),
  };
}

test('kept across an OIDC sign-in: read once, deleted, checked again, dropped when old', () => {
  const now = 1_800_000_000_000;
  const s = storage();
  saveReturn(s, back('/share', '?text=hello'), now);
  assert.ok(s.map.has(RETURN_KEY));
  assert.equal(takeReturn(s, isPage, now + 60_000), '/share?text=hello');
  assert.equal(s.map.has(RETURN_KEY), false, 'deleted once read');
  assert.equal(takeReturn(s, isPage, now + 60_000), null, 'read once');
  // Old: dropped (and deleted all the same); from the future: dropped.
  saveReturn(s, '/chat/abc', now);
  assert.equal(takeReturn(s, isPage, now + RETURN_TTL_MS + 1), null);
  assert.equal(s.map.has(RETURN_KEY), false);
  assert.equal(keptReturn(keepReturn('/chat/abc', now + 10 * 60_000), isPage, now), null);
  // Home keeps nothing (and clears an earlier one).
  s.map.set(RETURN_KEY, keepReturn('/chat/abc', now));
  saveReturn(s, '/', now);
  assert.equal(s.map.has(RETURN_KEY), false);
  // A value in storage is checked as the address bar is.
  for (const to of ['//evil.example', '/enroll', '/%2F%2Fx', '/nope?x=1', 'https://evil.example'])
    assert.equal(keptReturn(JSON.stringify({ to, at: now }), isPage, now), null, to);
  for (const raw of ['', 'not json', 'null', '[]', '{"to":"/chat/a"}', '{"to":1,"at":1}', `{"to":"/chat/a","at":"${now}"}`]) assert.equal(keptReturn(raw, isPage, now), null, raw);
  assert.equal(keptReturn(JSON.stringify({ to: '/settings/general/?x=1', at: now }), isPage, now), '/settings/general?x=1');
  // A storage that throws: nothing kept, nothing read, no exception.
  const blocked = storage(true);
  saveReturn(blocked, '/chat/abc', now);
  assert.equal(takeReturn(blocked, isPage, now), null);
  assert.equal(takeReturn(undefined, isPage, now), null);
});
