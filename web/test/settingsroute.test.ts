import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_PAGES, MOVED_PAGES, SETTINGS_SEGMENT, SETTINGS_SUB, samePlace, settingsAt, settingsHref } from '../client/src/settingsroute.js';
import * as served from '../server/settingspages.js';

test('settingsAt: the menu, the core pages, a package page in its own namespace', () => {
  assert.deepEqual(settingsAt('/settings'), { place: undefined });
  for (const id of CORE_PAGES) assert.deepEqual(settingsAt(`/settings/${id}`), { place: { core: id } });
  assert.deepEqual(settingsAt('/settings/ext/writing/ai'), { place: { pkg: 'writing', section: 'ai' } });
  // A package's page never reads as a core page, whatever its ids.
  assert.deepEqual(settingsAt('/settings/ext/notifications/language'), { place: { pkg: 'notifications', section: 'language' } });
  // A place inside a package's page (SettingsSection.segment): the page with its sub.
  assert.deepEqual(settingsAt('/settings/ext/accounts/networks/beeper_wa-1'), { place: { pkg: 'accounts', section: 'networks', sub: 'beeper_wa-1' } });
  // Unknown or malformed pages: still Settings, the menu (and the first page beside it).
  // 0.15.7's pages, now blocks: their page, and the URL that replaces theirs (the block as its anchor).
  assert.deepEqual(settingsAt('/settings/notifications'), { place: { core: 'general' }, moved: '/settings/general#notifications' });
  assert.deepEqual(settingsAt('/settings/about'), { place: { core: 'app' }, moved: '/settings/app#about' });
  for (const [id, page] of Object.entries(MOVED_PAGES)) assert.deepEqual(settingsAt(`/settings/${id}`)?.place, { core: page }, id);
  for (const p of ['/settings/', '/settings/nope', '/settings/constructor', '/settings/toString', '/settings/ext', '/settings/ext/writing', '/settings/ext/writing/ai/x.y', '/settings/ext/writing/ai/x/y', '/settings/ext/writing/ai/', '/settings/ext/Writing/ai', '/settings/ext/w/a%2Fb', '/settings/Language']) {
    assert.deepEqual(settingsAt(p), { place: undefined }, p);
  }
  for (const p of ['/', '/settingsx', '/chat/x', '/example/settings']) assert.equal(settingsAt(p), undefined, p);
});

test('settingsHref round-trips, samePlace compares pages', () => {
  for (const p of [{ core: 'app' as const }, { pkg: 'writing', section: 'ai' }, { pkg: 'accounts', section: 'networks', sub: 'a_b-c' }]) assert.deepEqual(settingsAt(settingsHref(p))?.place, p);
  // Any place inside a page is that page (its menu entry stays current).
  assert.ok(samePlace({ pkg: 'accounts', section: 'networks', sub: 'x' }, { pkg: 'accounts', section: 'networks' }));
  assert.ok(!samePlace({ pkg: 'accounts', section: 'networks', sub: 'x' }, { pkg: 'accounts', section: 'other', sub: 'x' }));
  assert.ok(samePlace({ core: 'app' }, { core: 'app' }));
  assert.ok(!samePlace({ core: 'app' }, { pkg: 'app', section: 'app' }));
  assert.ok(!samePlace(undefined, { core: 'app' }));
});

test('the server serves the same Settings pages as the client routes (two copies: one module would split the launch chunk)', () => {
  assert.deepEqual([...CORE_PAGES], [...served.CORE_PAGES]);
  assert.deepEqual(Object.keys(MOVED_PAGES).sort(), [...served.MOVED_PAGES].sort());
  assert.equal(SETTINGS_SEGMENT.source, served.SETTINGS_SEGMENT.source);
  assert.equal(SETTINGS_SUB.source, served.SETTINGS_SUB.source);
  for (const p of ['/settings', ...CORE_PAGES.map((x) => `/settings/${x}`), ...served.MOVED_PAGES.map((x) => `/settings/${x}`), '/settings/ext/writing/ai', '/settings/ext/accounts/networks/a_b-1']) assert.ok(served.isSettingsPath(p), p);
  for (const p of ['/settings/nope', '/settings/constructor', '/settings/ext/writing', '/settings/ext/writing/ai/x.y', '/settings/ext/writing/ai/x/y', '/settings/', '/settingsx']) assert.ok(!served.isSettingsPath(p), p);
});
