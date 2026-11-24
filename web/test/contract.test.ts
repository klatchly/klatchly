import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_API } from '../server/extension.js';
import { checkSnapshot, fingerprint } from './fingerprint.js';

// The extension API (server/extension.ts EXTENSION_API) against its snapshot, test/contract.json: what server/sdk.ts
// and client/src/sdk.ts export, the module contracts (server/extension.ts, client/src/extension.ts, and through
// them registry.ts, connector.ts…), and every declaration of the core they refer to. A change without the bump it needs fails here
// and says which one; KLATCHLY_UPDATE_CONTRACTS=1 npm test (npm run contracts) records the new snapshot on purpose.
// (The snapshot itself is the check of the fingerprint: an entry it stopped seeing shows up as removed.)

const ENTRIES = ['server/sdk.ts', 'server/extension.ts', 'client/src/extension.ts', 'client/src/sdk.ts'];

test('the extension API matches its snapshot, or carries the bump its change needs', () => {
  const now = fingerprint(ENTRIES, ['server/', 'client/src/']);
  assert.ok(Object.keys(now).length > 50, 'the fingerprint sees the contract');
  assert.equal(checkSnapshot('The extension API', 'test/contract.json', EXTENSION_API, 'server/extension.ts (EXTENSION_API)', now), null);
});
