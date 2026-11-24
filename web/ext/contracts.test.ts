import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { checkSnapshot, fingerprint, webPath } from '../test/fingerprint.js';
import { packages } from './packages.server.js';

// What each package exposes to the others (its public entry, ext/<id>/api.ts: the types a package that requires it
// imports) against its snapshot, ext/<id>/contract.json. A change without the bump it needs (package.ts version:
// minor for additions, major for a removal or a changed signature) fails here and says which; KLATCHLY_UPDATE_CONTRACTS=1
// npm test (npm run contracts) records the new snapshot on purpose. The core's own: test/contract.test.ts.

// The packages of the build (whatever the list) that have a public entry.
const withEntry = packages.filter((p) => existsSync(webPath(`ext/${p.id}/api.ts`))).map((p) => p.id);

test('every package another one of the build requires has a public entry to check', () => {
  const required = [...new Set(packages.flatMap((p) => Object.keys(p.requires ?? {})))].filter((id) => packages.some((p) => p.id === id));
  assert.deepEqual(required.filter((id) => !withEntry.includes(id)), [], withEntry.join(','));
});

for (const id of withEntry) {
  test(`${id}: its public entry matches its snapshot, or carries the bump its change needs`, () => {
    const pkg = packages.find((p) => p.id === id)!;
    // Its own declarations only: what it takes from the core (#core/sdk.js) is the extension API's.
    const now = fingerprint([`ext/${id}/api.ts`], [`ext/${id}/`]);
    assert.ok(Object.keys(now).length > 1, 'something is exported');
    assert.equal(checkSnapshot(`${id}'s public entry (ext/${id}/api.ts)`, `ext/${id}/contract.json`, pkg.version, `ext/${id}/package.ts (version)`, now), null);
  });
}

// No connector is privileged (API 1.25): each one of the build claims its own chats and accounts. A connector without
// them would still be the legacy catch-all of chat and account routing (server/sources.ts), which nothing of the
// tree relies on.
test('every connector of the build declares owns and ownsAccount', () => {
  const missing = packages.flatMap((p) =>
    p.modules.filter((m) => m.type === 'connector').flatMap((m) => [...(m.owns ? [] : [`${p.id}:${m.id} owns`]), ...(m.ownsAccount ? [] : [`${p.id}:${m.id} ownsAccount`])]),
  );
  assert.deepEqual(missing, []);
});
