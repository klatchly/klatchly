import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactionKeyFits, validReactionKey } from '../server/relay.js';
import { localMxc } from './fixtures/identities.js';

test('reaction keys: the shape (a longer key is taken only where its connector says so: reactionKeyFits)', () => {
  for (const k of ['👍', '❤️', '❤️‍🔥', '🤷‍♂️', '👍🏽', '🇫🇷', 'smiling-face', ':custom:']) assert.ok(validReactionKey(k), k);
  for (const k of ['', ' ', 'a b', '👍\n', 42, null, '\u0000', ' ', `mxc://h/${'a'.repeat(260)}`, `x ${'a'.repeat(70)}`]) assert.ok(!validReactionKey(k), String(k).slice(0, 30));
  // Up to 255 characters without whitespace or control characters pass the shape; the chat's connector decides.
  const mxc = localMxc('a'.repeat(64));
  assert.ok(validReactionKey(mxc));
  assert.ok(validReactionKey('x'.repeat(65)));
  const plain = { longReactionKey: undefined } as unknown as Parameters<typeof reactionKeyFits>[0];
  const own = { longReactionKey: (k: string) => k.startsWith('mxc://') } as unknown as Parameters<typeof reactionKeyFits>[0];
  assert.ok(reactionKeyFits(plain, '👍'));
  assert.ok(!reactionKeyFits(plain, mxc));
  assert.ok(reactionKeyFits(own, mxc));
  assert.ok(!reactionKeyFits(own, 'x'.repeat(65)));
});
