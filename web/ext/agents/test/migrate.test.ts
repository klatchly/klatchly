import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dataPath } from '#core/config.js';
import { setManifestForTests } from '../server/manifest.js';
import { setRuntimes } from '../server/runtimes.js';
import { ensureMigrated, listSessions, migrateStateFile, reloadSpaceStateForTests } from '../server/space.js';
import { fakeRuntime, useFakeRuntimes } from './fake.js';

// The space's file moved with the rename of 3.0 (/hermes -> /agents): data/hermes.json becomes
// data/agents-space.json on the first start, in one rename, nothing lost (owners, unread counts, inbox, helpers).
// Both present: the new one is used, the old one left as is. None: nothing is made.

// Ids of that time: "beep_…" (the app's former name), still valid.
const S1 = 'beep_20261029_120000_0a1b2c3d';
const S2 = 'beep_20261029_130000_deadbeef';
const OLD = () => dataPath('hermes.json');
const NEW = () => dataPath('agents-space.json');
const OLD_STATE = {
  main: S1,
  inbox: [{ id: 'i1', sessionId: S1, text: 'Rappel', ts: 5, agent: 'default' }],
  owners: { [S1]: 'default', [S2]: 'assistant' },
  unread: { [S1]: 3, [S2]: 1 },
  helpers: { [S1]: ['assistant'] },
  last: { [S2]: { text: 'Mails triés', own: false } },
  inboxes: { assistant: S2 },
};

const rt = fakeRuntime('hermes', [{ id: 'default', label: 'Hermes', helpers: ['assistant'] }, { id: 'assistant', label: 'Assistant', inbox: 'Récaps' }], { mainAgent: 'default' });
rt.addConversation('default', { id: S1, title: 'Pong', lastActive: 2000, messages: 2 });
rt.addConversation('assistant', { id: S2, title: 'Mails', lastActive: 3000, messages: 4 });

beforeEach(() => {
  setManifestForTests(null);
  useFakeRuntimes({ hermes: rt.runtime });
  rmSync(OLD(), { force: true });
  rmSync(NEW(), { force: true });
  reloadSpaceStateForTests();
});
after(() => {
  setRuntimes(undefined);
  setManifestForTests(undefined);
});

test('old file only: moved in one rename, byte for byte; its unread counts, owners and helpers are read from the new one', async () => {
  const raw = JSON.stringify(OLD_STATE) + '\n';
  writeFileSync(OLD(), raw, { mode: 0o600 });
  ensureMigrated();
  assert.equal(existsSync(OLD()), false, 'the old file is gone');
  assert.equal(readFileSync(NEW(), 'utf8'), raw, 'nothing changed in the move');
  const { sessions } = await listSessions();
  const by = Object.fromEntries(sessions.map((s) => [s.id, s]));
  assert.equal(by[S1]?.unread, 3);
  assert.equal(by[S2]?.unread, 1);
  assert.equal(by[S2]?.agent, 'assistant');
  assert.deepEqual(by[S1]?.helpers, ['assistant']);
  // Once per process: a second call moves nothing more.
  assert.equal(migrateStateFile(), 'none');
});

test('migration before the first read, even without the start (the state read lazily)', async () => {
  writeFileSync(OLD(), JSON.stringify(OLD_STATE), { mode: 0o600 });
  const { sessions } = await listSessions();
  assert.equal(sessions.find((s) => s.id === S1)?.unread, 3);
  assert.equal(existsSync(OLD()), false);
  assert.equal(existsSync(NEW()), true);
});

test('both files: the new one is used, the old one left untouched', async () => {
  writeFileSync(OLD(), JSON.stringify(OLD_STATE), { mode: 0o600 });
  const newer = { ...OLD_STATE, unread: { [S1]: 7 } };
  writeFileSync(NEW(), JSON.stringify(newer), { mode: 0o600 });
  assert.equal(migrateStateFile(), 'both');
  reloadSpaceStateForTests();
  const { sessions } = await listSessions();
  assert.equal(sessions.find((s) => s.id === S1)?.unread, 7);
  assert.equal(sessions.find((s) => s.id === S2)?.unread, 0);
  assert.equal(readFileSync(OLD(), 'utf8'), JSON.stringify(OLD_STATE), 'the old file is kept as it was');
});

test('neither file: nothing is made, the state starts empty', async () => {
  assert.equal(migrateStateFile(), 'none');
  assert.equal(existsSync(NEW()), false);
  const { sessions } = await listSessions();
  assert.ok(sessions.every((s) => s.unread === 0));
});
