import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canRemovePasskey, legacyAuth, loginMethods, passkeyLabel, stepUpLeft, stepUpMethods, STEP_UP_MS } from '../server/auth.js';
import { Lockout } from '../server/lockout.js';
import { deviceSummary, liveSession, sessionExpiry, Sessions, SESSION_MAX_MS, SESSION_TTL_MS } from '../server/sessions.js';
import { Store, type State } from '../server/store.js';

// The rules of server/auth.ts (passkeys only), sessions (sliding and absolute expiry, device names), the lockout,
// and the state file shared by the server and the CLI (its lock: audit L1). The routes: test/signin.test.ts.

const passkey = { id: 'cred', publicKey: 'x', counter: 0, createdAt: '2026-01-01T00:00:00Z', label: 'test' };
const state = (over: Partial<State> = {}): State => ({ version: 1, userHandle: 'u', credentials: [], sessions: [], enrollCodes: [], ...over });
const DAY = 24 * 3600_000;

test('lockout: free tries, then doubling waits up to the cap; a success clears it', () => {
  const l = new Lockout(3, 1000, 5000);
  for (let i = 0; i < 3; i++) l.fail('k', 0);
  assert.equal(l.remaining('k', 0), 0);
  l.fail('k', 0);
  assert.equal(l.remaining('k', 0), 1000);
  l.fail('k', 0);
  assert.equal(l.remaining('k', 0), 2000);
  for (let i = 0; i < 5; i++) l.fail('k', 0);
  assert.equal(l.remaining('k', 0), 5000, 'capped');
  assert.equal(l.remaining('other', 0), 0, 'per key');
  l.succeed('k');
  assert.equal(l.remaining('k', 0), 0);
});

test('passkeys only: the sign-in page, the step-up methods and window, the last passkey kept', () => {
  assert.deepEqual(loginMethods(state()), { passkey: true });
  assert.deepEqual(loginMethods(state(), null), { passkey: true }, 'no provider configured');
  assert.deepEqual(stepUpMethods(state()), [], 'no passkey: nothing to confirm with (the CLI enrollment adds one)');
  const now = 1_000_000_000;
  const st = state({ credentials: [passkey], sessions: [{ hash: 'h', createdAt: now, lastSeen: now, authAt: now - 60_000 }, { hash: 'old', createdAt: now, lastSeen: now }] });
  assert.deepEqual(stepUpMethods(st), ['passkey']);
  assert.equal(stepUpLeft(st, 'h', now), STEP_UP_MS - 60_000);
  assert.equal(stepUpLeft(st, 'h', now + STEP_UP_MS), 0);
  assert.equal(stepUpLeft(st, 'old', now), 0, 'no sign-in time: confirm first');
  assert.equal(stepUpLeft(st, 'missing', now), 0);
  // Never weaker without a passkey: the window is the session's sign-in, nothing allows a change by default.
  assert.equal(stepUpLeft(state({ sessions: st.sessions }), 'old', now), 0);
  assert.equal(canRemovePasskey(st, 'cred'), 'last_passkey');
  assert.equal(canRemovePasskey(st, 'nope'), 'not_found');
  assert.equal(canRemovePasskey(state({ credentials: [passkey, { ...passkey, id: 'b' }] }), 'cred'), null);
});

test('passkey names: control and line-separator characters dropped, trimmed, 60 characters at most', () => {
  assert.equal(passkeyLabel('  Pixel 9\u0000\n '), 'Pixel 9');
  assert.equal(passkeyLabel('a\u2028b\u0085c'), 'abc');
  assert.equal([...passkeyLabel('🔑'.repeat(80))!].length, 60);
  for (const bad of ['', '   ', '\u0001', 42, null, undefined]) assert.equal(passkeyLabel(bad), null);
});

test('removed modes: an old auth block is recognised for the start-up clean-up; a state from before 0.16 is clean', () => {
  assert.equal(legacyAuth(state()), null);
  assert.equal(legacyAuth(state({ auth: { mode: 'passkey' } })), null);
  assert.equal(legacyAuth(state({ auth: { mode: 'password' } as never })), 'password');
  assert.equal(legacyAuth(state({ auth: { mode: 'none', passkey: 'off' } as never })), 'none');
  assert.equal(legacyAuth(state({ auth: { mode: 'passkey', totp: {} } as never })), 'passkey (with password or TOTP data)');
});

test('device names: browser and system from the User-Agent, never the raw string', () => {
  const cases: [string, string][] = [
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox · Linux'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1', 'Safari · iOS'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome · macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge · Windows'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1', 'Chrome · iPadOS'],
    ['curl/8.0', '?'],
  ];
  for (const [ua, want] of cases) assert.equal(deviceSummary(ua), want, ua);
  assert.equal(deviceSummary(undefined), '?');
});

test('sessions: sliding 7 days, and an absolute end 30 days after the sign-in whatever the use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'klatchly-sess-'));
  const store = new Store(dir);
  const sessions = new Sessions(store, SESSION_TTL_MS, 10);
  const t0 = Date.now();
  const id = store.mutate((s) => sessions.create(s, t0, 'Firefox · Linux'));
  const s0 = store.read().sessions[0]!;
  assert.equal(s0.device, 'Firefox · Linux');
  assert.equal(sessionExpiry(s0), t0 + SESSION_TTL_MS);
  // Used every 6 days: it slides...
  let t = t0;
  for (let i = 0; i < 4; i++) {
    t += 6 * DAY;
    const v = sessions.validate(id, t);
    assert.ok(v?.renewed, `day ${(t - t0) / DAY}`);
    assert.equal(v.expiresAt, Math.min(t + SESSION_TTL_MS, t0 + SESSION_MAX_MS));
  }
  // ...until its absolute end, even used the minute before.
  assert.ok(sessions.validate(id, t0 + SESSION_MAX_MS - 60_000));
  assert.equal(sessions.validate(id, t0 + SESSION_MAX_MS), null);
  assert.ok(!liveSession({ hash: 'x', createdAt: t0, lastSeen: t0 + SESSION_MAX_MS - 1 }, t0 + SESSION_MAX_MS));
  // Not used for 7 days: gone too.
  const id2 = store.mutate((s) => sessions.create(s, t0));
  assert.equal(sessions.validate(id2, t0 + SESSION_TTL_MS), null);
  // A session revoked by another process meanwhile (the CLI) is not brought back by touching it.
  const id3 = store.mutate((s) => sessions.create(s, t0));
  const other = new Store(dir);
  other.mutate((s) => void (s.sessions = []));
  assert.equal(sessions.validate(id3, t0 + 6 * 60_000), null);
});

test('migration: a state file from before 0.16 (no auth block): its passkeys and sessions keep working', () => {
  const dir = mkdtempSync(join(tmpdir(), 'klatchly-auth-'));
  const now = Date.now();
  const store = new Store(dir);
  const sessions = new Sessions(store, SESSION_TTL_MS, 10);
  const id = store.mutate((s) => sessions.create(s, now));
  const hash = store.read().sessions[0]!.hash;
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, userHandle: 'u', credentials: [passkey], sessions: [{ hash, createdAt: now, lastSeen: now }], enrollCodes: [] }));
  assert.equal(legacyAuth(store.read()), null);
  assert.equal(sessions.validate(id, now)?.hash, hash);
});

test('state file lock (audit L1): the server and the CLI writing at once lose nothing; a stale lock is broken', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'klatchly-lock-'));
  const store = new Store(dir);
  store.mutate(() => {});
  const N = 300;
  // The "CLI": another process writing the same file in a loop.
  const storeUrl = new URL('../server/store.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', `const { Store } = await import(${JSON.stringify(storeUrl)}); const s = new Store(${JSON.stringify(dir)}); console.log('ready'); for (let i = 0; i < ${N}; i++) s.mutate((st) => void st.enrollCodes.push({ hash: 'cli' + i, expiresAt: 1e15 }));`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((ok) => child.stdout.once('data', () => ok()));
  for (let i = 0; i < N; i++) store.mutate((st) => void st.enrollCodes.push({ hash: `srv${i}`, expiresAt: 1e15 }));
  assert.equal(await new Promise((ok) => child.on('exit', ok)), 0);
  const codes = new Store(dir).read().enrollCodes;
  assert.equal(codes.filter((c) => c.hash.startsWith('cli')).length, N, 'every write of the CLI kept');
  assert.equal(codes.filter((c) => c.hash.startsWith('srv')).length, N, 'every write of the server kept');
  assert.ok(!existsSync(join(dir, 'state.json.lock')), 'released');
  // A lock left by a process that died holding it.
  writeFileSync(join(dir, 'state.json.lock'), '');
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(join(dir, 'state.json.lock'), old, old);
  store.mutate((st) => void (st.enrollCodes = []));
  assert.deepEqual(new Store(dir).read().enrollCodes, []);
  // A nested write runs inside the outer one's lock.
  assert.equal(store.mutate(() => store.mutate(() => 7)), 7);
});
