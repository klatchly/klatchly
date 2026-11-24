import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

// The sign-in routes end to end with a software authenticator (test/softauthn.ts): enrollment with a code, passkey
// sign-in, step-up; Settings → Connexion (passkeys: add one signed in, rename, remove, never the last; connected
// devices: sign one out, all the others); absolute session expiry; the step-up on the extension switches; the removed password / TOTP /
// "none" routes; an old state file that still says "password" or "none" (the enrollment code works whatever it says);
// the client address behind trusted proxies for the enrollment lockout and the logs; the known-device cookie (void
// and deleted on sign-out, void when signed out from elsewhere).
const { createApp } = await import('../server/app.js');
const { config } = await import('../server/config.js');
const { sessions, store } = await import('../server/context.js');
const { clearEnrollLimits, enrollLockout, loginLimiter } = await import('../server/webauthn.js');
const { addEnrollCode, newEnrollCode, sha256, LEGACY_OPEN_SESSION, SESSION_MAX_MS } = await import('../server/sessions.js');
const { legacyAuth, migrateAuth } = await import('../server/auth.js');
const { SoftAuthenticator } = await import('./softauthn.js');
const { fakeBrowser } = await import('./webpush.js');
const { Hono } = await import('hono');
type Env = import('../server/context.js').Env;

const app: import('hono').Hono<Env> = createApp();
const origin = config().origin;
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

let n = 0;
/** A request through the loopback proxy (trusted by default), from its own client address unless `ip` says. */
function call(path: string, { sid, method = 'GET', body, headers = {}, ip, peer = '127.0.0.1' }: { sid?: string; method?: string; body?: unknown; headers?: Record<string, string>; ip?: string; peer?: string } = {}) {
  return app.request(
    path,
    {
      method,
      headers: {
        'x-forwarded-for': ip ?? `203.0.113.${(++n % 250) + 1}`,
        'user-agent': UA,
        ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
        ...(sid ? { cookie: `sid=${sid}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { incoming: { socket: { remoteAddress: peer } } },
  );
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });
const cookieOf = (r: Response) => /sid=([A-Za-z0-9_-]{43})/.exec(r.headers.get('set-cookie') ?? '')?.[1];
const newSession = (authAgo = 0) =>
  store.mutate((s) => {
    const id = sessions.create(s, Date.now(), 'Safari · iOS');
    s.sessions[s.sessions.length - 1]!.authAt = Date.now() - authAgo;
    return id;
  });
const age = (sid: string) => store.mutate((s) => void (s.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now() - 3600_000));
const live = (id: string) => !!sessions.validate(id);
const code = () => {
  const c = newEnrollCode();
  store.mutate((s) => addEnrollCode(s, c, 10 * 60_000));
  return c;
};

/** Enrolls `key` with a fresh code; the new session's id. */
async function enroll(key: InstanceType<typeof SoftAuthenticator>, label = 'Linux', opts: { ip?: string } = {}) {
  clearEnrollLimits(); // 30 enrollment requests per 10 minutes in all: this file makes more
  const c = code();
  const options = await json(await call('/api/enroll/options', { method: 'POST', body: { code: c }, ip: opts.ip }));
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const r = await call('/api/enroll/verify', { method: 'POST', body: { code: c, response: key.register(options.body as { challenge: string }), label }, ip: opts.ip });
  assert.equal(r.status, 200);
  return cookieOf(r)!;
}

/** Signs in with `key`; the response. */
async function signIn(key: InstanceType<typeof SoftAuthenticator>, bend: Parameters<InstanceType<typeof SoftAuthenticator>['assert']>[2] = {}) {
  const options = (await json(await call('/api/auth/options', { method: 'POST' }))).body as { challenge: string };
  return call('/api/auth/verify', { method: 'POST', body: { response: key.assert(options, store.read().userHandle, bend) } });
}

const keyA = new SoftAuthenticator(origin, config().rpID);
const keyB = new SoftAuthenticator(origin, config().rpID);
const owner = { sid: '' };

test('defaults: passkeys only; the removed password, TOTP and mode routes are gone; CSRF and the session check hold', async () => {
  assert.deepEqual((await json(await call('/api/session'))).body, { authenticated: false, login: { passkey: true } });
  for (const [method, path] of [['POST', '/api/auth/password'], ['POST', '/api/auth/second'], ['PUT', '/api/auth/mode'], ['PUT', '/api/auth/password'], ['POST', '/api/auth/totp'], ['POST', '/api/auth/stepup']] as const) {
    assert.equal((await call(path, { method, body: {} })).status, 302, `${path}: no session, redirect (never 401)`);
  }
  const sid = newSession();
  for (const [method, path] of [['POST', '/api/auth/password'], ['PUT', '/api/auth/mode'], ['PUT', '/api/auth/password'], ['POST', '/api/auth/totp'], ['POST', '/api/auth/recovery'], ['POST', '/api/auth/stepup']] as const) {
    assert.equal((await call(path, { sid, method, body: { mode: 'none', password: 'x' } })).status, 404, `${path}: removed`);
  }
  assert.equal((await json(await call('/api/auth/sessions/revoke-others', { sid, method: 'POST', headers: { origin: 'https://evil.example' } }))).body.error, 'bad_origin');
  assert.equal((await call('/api/auth/settings')).status, 302);
  const s = (await json(await call('/api/auth/settings', { sid }))).body;
  assert.equal(s.mode, 'passkey');
  assert.deepEqual(s.passkeys, []);
  store.mutate((st) => void (st.sessions = st.sessions.filter((x) => x.hash !== sha256(sid))));
});

test('enrollment with a code: a passkey and a session, the code single use; the label and device recorded', async () => {
  clearEnrollLimits();
  const c = code();
  const options = (await json(await call('/api/enroll/options', { method: 'POST', body: { code: c } }))).body as { challenge: string; user: { id: string } };
  assert.equal(options.user.id, store.read().userHandle);
  // A wrong origin, a wrong RP ID, no user verification, an assertion instead of a creation: refused (each burns the challenge).
  for (const bend of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { flags: 0x41 }, { type: 'webauthn.get' }]) {
    const opts = (await json(await call('/api/enroll/options', { method: 'POST', body: { code: c } }))).body as { challenge: string };
    assert.equal((await call('/api/enroll/verify', { method: 'POST', body: { code: c, response: keyA.register(opts, bend) } })).status, 400, JSON.stringify(bend));
  }
  // The challenge of another code is not this code's.
  const other = code();
  const otherOpts = (await json(await call('/api/enroll/options', { method: 'POST', body: { code: other } }))).body as { challenge: string };
  assert.equal((await call('/api/enroll/verify', { method: 'POST', body: { code: c, response: keyA.register(otherOpts) } })).status, 400, 'challenge bound to its code');
  const r = await call('/api/enroll/verify', { method: 'POST', body: { code: c, response: keyA.register(options), label: ' My\u0000 laptop ' } });
  assert.equal(r.status, 200);
  owner.sid = cookieOf(r)!;
  assert.ok(live(owner.sid));
  const st = store.read();
  assert.equal(st.credentials.length, 1);
  assert.equal(st.credentials[0]!.label, 'My laptop');
  assert.equal(st.credentials[0]!.addedFrom, 'Firefox · Linux');
  assert.equal(st.sessions.find((s) => s.hash === sha256(owner.sid))!.device, 'Firefox · Linux');
  // Used up: not again, even with a fresh challenge.
  assert.equal((await call('/api/enroll/options', { method: 'POST', body: { code: c } })).status, 400);
});

test('passkey sign-in: a new session; replay, wrong origin, foreign user, step-up challenge, counter going back refused', async () => {
  const r = await signIn(keyA);
  assert.equal(r.status, 200);
  const sid = cookieOf(r)!;
  assert.ok(live(sid));
  assert.ok(store.read().credentials[0]!.lastUsedAt, 'last use recorded');
  // The same challenge twice.
  const options = (await json(await call('/api/auth/options', { method: 'POST' }))).body as { challenge: string };
  const response = keyA.assert(options, store.read().userHandle);
  assert.equal((await call('/api/auth/verify', { method: 'POST', body: { response } })).status, 200);
  assert.equal((await call('/api/auth/verify', { method: 'POST', body: { response } })).status, 400, 'replay');
  assert.equal((await signIn(keyA, { origin: 'https://evil.example' })).status, 400, 'origin');
  assert.equal((await signIn(keyA, { userHandle: Buffer.from('someone else').toString('base64url') })).status, 400, 'foreign user handle');
  assert.equal((await signIn(keyA, { flags: 0x01 })).status, 400, 'no user verification');
  assert.equal((await signIn(keyA, { counter: 1 })).status, 400, 'counter going back (a cloned key)');
  assert.equal((await signIn(keyB)).status, 400, 'unknown credential');
  // A step-up challenge (of a session) does not sign in.
  const up = (await json(await call('/api/auth/stepup/options', { sid, method: 'POST' }))).body as { challenge: string };
  assert.equal((await call('/api/auth/verify', { method: 'POST', body: { response: keyA.assert(up, store.read().userHandle) } })).status, 400);
});

test('step-up with a passkey: for this session only; it reopens the window for sensitive changes', async () => {
  const sid = owner.sid;
  age(sid);
  assert.equal((await json(await call('/api/auth/stepup', { sid }))).body.leftMs, 0);
  const other = newSession();
  // Another session's challenge, a sign-in challenge: refused.
  const theirs = (await json(await call('/api/auth/stepup/options', { sid: other, method: 'POST' }))).body as { challenge: string };
  assert.equal((await call('/api/auth/stepup/passkey', { sid, method: 'POST', body: { response: keyA.assert(theirs, store.read().userHandle) } })).status, 400);
  const login = (await json(await call('/api/auth/options', { method: 'POST' }))).body as { challenge: string };
  assert.equal((await call('/api/auth/stepup/passkey', { sid, method: 'POST', body: { response: keyA.assert(login, store.read().userHandle) } })).status, 400);
  const mine = (await json(await call('/api/auth/stepup/options', { sid, method: 'POST' }))).body as { challenge: string };
  assert.equal((await call('/api/auth/stepup/passkey', { sid, method: 'POST', body: { response: keyA.assert(mine, store.read().userHandle) } })).status, 200);
  const left = (await json(await call('/api/auth/stepup', { sid }))).body;
  assert.ok(left.leftMs > 0 && left.methods.includes('passkey'));
  store.mutate((st) => void (st.sessions = st.sessions.filter((x) => x.hash !== sha256(other))));
});

test('a new passkey alerts the other devices (Web Push) and shows in Settings', async () => {
  // A device with notifications on (the owner's session), its push service faked.
  const browser = fakeBrowser();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/test-alert';
  store.mutate((st) => void (st.push = [{ id: 'p1', sessionHash: sha256(owner.sid), endpoint, ...browser.keys, createdAt: Date.now(), lang: 'en' }]));
  const sent: { url: string; body: Buffer }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: Buffer.from(init.body as Uint8Array) });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  try {
    await enroll(keyB, 'Phone');
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((ok) => setTimeout(ok, 20));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, endpoint);
  const msg = JSON.parse(browser.decrypt(sent[0]!.body)) as { notification: { title: string; body: string; navigate: string } };
  assert.equal(msg.notification.title, 'New passkey added');
  assert.match(msg.notification.body, /“Phone”, from Firefox · Linux/);
  assert.equal(msg.notification.navigate, `${origin}/settings/general`);
  const s = (await json(await call('/api/auth/settings', { sid: owner.sid }))).body;
  assert.deepEqual(s.passkeys.map((k: { label: string; addedFrom: string }) => [k.label, k.addedFrom]), [['My laptop', 'Firefox · Linux'], ['Phone', 'Firefox · Linux']]);
});

test('passkeys in Settings: rename and remove behind the step-up, never the last one', async () => {
  const sid = owner.sid;
  const id = keyB.credentialId;
  age(sid);
  assert.equal((await json(await call(`/api/auth/passkeys/${id}`, { sid, method: 'PUT', body: { label: 'x' } }))).body.error, 'step_up');
  assert.equal((await json(await call(`/api/auth/passkeys/${id}`, { sid, method: 'DELETE' }))).body.error, 'step_up');
  store.mutate((st) => void (st.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now()));
  assert.equal((await call(`/api/auth/passkeys/${id}`, { sid, method: 'PUT', body: { label: '  ' } })).status, 400, 'empty name');
  const renamed = await json(await call(`/api/auth/passkeys/${id}`, { sid, method: 'PUT', body: { label: '\u202ePixel\u0007 ' + 'z'.repeat(80) } }));
  assert.equal(renamed.status, 200);
  const label = renamed.body.passkeys.find((k: { id: string }) => k.id === id).label as string;
  assert.ok(label.startsWith('Pixel') && [...label].length === 60 && !label.includes('\u0007'), label);
  assert.equal((await call('/api/auth/passkeys/nope', { sid, method: 'PUT', body: { label: 'x' } })).status, 404);
  assert.equal((await call(`/api/auth/passkeys/${'%2F..'}`, { sid, method: 'DELETE' })).status, 400, 'not an id');
  // Two: one may go; the last one may not.
  assert.equal((await call(`/api/auth/passkeys/${id}`, { sid, method: 'DELETE' })).status, 200);
  assert.equal((await signIn(keyB)).status, 400, 'the removed one no longer signs in');
  assert.deepEqual((await json(await call(`/api/auth/passkeys/${keyA.credentialId}`, { sid, method: 'DELETE' }))).body, { error: 'last_passkey' });
  assert.equal(store.read().credentials.length, 1);
  assert.equal((await signIn(keyA)).status, 200);
});

test('connected devices: listed (this one first), one signed out, all the others; behind the step-up', async () => {
  const sid = owner.sid;
  const phone = newSession();
  const tablet = newSession();
  store.mutate((st) => void st.push!.push({ id: 'p2', sessionHash: sha256(phone), endpoint: 'https://fcm.googleapis.com/fcm/send/phone', p256dh: 'x', auth: 'y', createdAt: Date.now() }));
  const s = (await json(await call('/api/auth/settings', { sid }))).body;
  const devices = s.devices as { id: string; current: boolean; device: string; expiresAt: number; createdAt: number }[];
  assert.ok(devices[0]!.current && devices[0]!.device === 'Firefox · Linux', 'this device first');
  assert.equal(devices.filter((d) => d.current).length, 1);
  assert.ok(devices.every((d) => /^[0-9a-f]{16}$/.test(d.id) && d.expiresAt <= d.createdAt + SESSION_MAX_MS));
  const phoneId = sha256(phone).slice(0, 16);
  assert.equal((await json(await call(`/api/auth/sessions/${devices[0]!.id}`, { sid, method: 'DELETE' }))).body.error, 'current', 'not this one (Sign out)');
  age(sid);
  assert.equal((await json(await call(`/api/auth/sessions/${phoneId}`, { sid, method: 'DELETE' }))).body.error, 'step_up');
  assert.equal((await json(await call('/api/auth/sessions/revoke-others', { sid, method: 'POST' }))).body.error, 'step_up');
  store.mutate((st) => void (st.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now()));
  assert.equal((await call(`/api/auth/sessions/${phoneId}`, { sid, method: 'DELETE' })).status, 200);
  assert.ok(!live(phone) && live(tablet) && live(sid));
  assert.ok(!store.read().push!.some((p) => p.id === 'p2'), "its notifications stop");
  assert.equal((await call(`/api/auth/sessions/${phoneId}`, { sid, method: 'DELETE' })).status, 404);
  const deviceKey = store.read().deviceKey;
  const r = await call('/api/auth/sessions/revoke-others', { sid, method: 'POST' });
  assert.equal(r.status, 200);
  assert.ok(!live(tablet) && live(sid));
  assert.equal(((await r.json()) as { devices: unknown[] }).devices.length, 1);
  assert.notEqual(store.read().deviceKey, deviceKey, 'the known-device cookies are void');
  assert.match(r.headers.get('set-cookie') ?? '', /kd=/, 'this browser gets a new one');
});

test('sessions: an absolute end 30 days after the sign-in, however much the session is used', async () => {
  const sid = newSession();
  const hash = sha256(sid);
  // Used every day for 29 days: still valid, and the cookie never outlives the absolute end.
  store.mutate((st) => {
    const s = st.sessions.find((x) => x.hash === hash)!;
    s.createdAt = Date.now() - 29 * 24 * 3600_000;
    s.lastSeen = Date.now() - 6 * 60_000;
  });
  const r = await call('/api/auth/settings', { sid });
  assert.equal(r.status, 200);
  const maxAge = Number(/Max-Age=(\d+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]);
  assert.ok(maxAge > 23 * 3600 && maxAge <= 24 * 3600, `cookie renewed until the absolute end (${maxAge} s)`);
  // A day later: over, even though it was just used.
  store.mutate((st) => {
    const s = st.sessions.find((x) => x.hash === hash)!;
    s.createdAt = Date.now() - 30 * 24 * 3600_000 - 1000;
    s.lastSeen = Date.now();
  });
  assert.equal((await call('/api/auth/settings', { sid })).status, 302);
  assert.ok(!store.read().sessions.some((x) => x.hash === hash) || !live(sid));
});

test('extensions: turning one on or off needs a recent sign-in or step-up (audit L2)', async () => {
  const sid = newSession();
  age(sid);
  assert.deepEqual((await json(await call('/api/extensions/aside', { sid, method: 'PUT', body: { enabled: false } }))).body, { error: 'step_up' });
  store.mutate((st) => void (st.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now()));
  const r = await call('/api/extensions/aside', { sid, method: 'PUT', body: { enabled: false } });
  assert.notEqual(r.status, 403, 'confirmed: the switch is judged on its merits');
});

test('an old state file in mode "password" or "none": passkeys only, the enrollment code still works, sessions kept', async () => {
  const before = store.read();
  const legacySid = newSession();
  store.mutate((st) => {
    st.auth = { mode: 'password', username: 'sam', password: 'scrypt$17$8$1$AAAA$BBBB', totp: { secret: 'GEZDGNBVGY3TQOJQ', createdAt: 1, lastStep: 0 }, recovery: ['a'.repeat(64)], passkey: 'alone' } as never;
    st.sessions.push({ hash: LEGACY_OPEN_SESSION, createdAt: Date.now(), lastSeen: Date.now() });
    (st.push ??= []).push({ id: 'open', sessionHash: LEGACY_OPEN_SESSION, endpoint: 'https://fcm.googleapis.com/fcm/send/open', p256dh: 'x', auth: 'y', createdAt: Date.now() });
  });
  // Before the start-up clean-up: nothing of the old mode is reachable.
  assert.deepEqual((await json(await call('/api/session'))).body, { authenticated: false, login: { passkey: true } });
  assert.equal((await call('/api/auth/settings')).status, 302, 'the shared session of mode "none" never validates');
  assert.ok(live(legacySid), 'a session signed in before stays signed in');
  // The way back in from the server shell: a code, then /enroll.
  const k = new SoftAuthenticator(origin, config().rpID);
  const sid = await enroll(k, 'Rescue');
  assert.ok(live(sid));
  assert.equal(legacyAuth(store.read()), 'password');
  store.mutate(migrateAuth);
  const st = store.read();
  assert.deepEqual(st.auth, { mode: 'passkey' }, 'password hash, TOTP secret and recovery codes deleted');
  assert.ok(!st.sessions.some((s) => s.hash === LEGACY_OPEN_SESSION) && !st.push!.some((p) => p.id === 'open'));
  // The exact hash old state files hold (sha256 of the former app name's "beep:sign-in-off"): never to change.
  assert.equal(LEGACY_OPEN_SESSION, '25b810625efb577be8dc2ecdd7efeed8d5b900e8b6a6d3d11cef9f90af28399b');
  assert.equal(legacyAuth(st), null);
  assert.ok(live(legacySid) && live(sid));
  assert.equal(legacyAuth({ ...st, auth: { mode: 'none' } as never }), 'none');
  assert.equal(legacyAuth({ ...st, auth: { mode: 'passkey', passkey: 'off' } as never }), 'passkey (with password or TOTP data)');
  assert.equal(legacyAuth({ ...st, auth: undefined }), null, 'a state from before 0.16: passkeys, nothing to do');
  assert.ok(before.credentials.length >= 1);
});

test('trusted proxies: the enrollment lockout and the logs use the client behind the proxy, never a forged header', async () => {
  clearEnrollLimits();
  // Through the trusted proxy: each wrong code counts for its client address; five free, the sixth locks.
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await call('/api/enroll/options', { method: 'POST', body: { code: 'AAAAA-AAAAA-AAAAA-AAAAA' }, ip: '198.51.100.7' })).status);
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 400, 429], 'five wrong codes free, the sixth locks');
  // Another client behind the same proxy is not locked.
  assert.equal((await call('/api/enroll/options', { method: 'POST', body: { code: 'AAAAA-AAAAA-AAAAA-AAAAA' }, ip: '198.51.100.8' })).status, 400);
  // A stranger reaching the port directly, claiming the owner's address in X-Forwarded-For: counted as itself...
  for (let i = 0; i < 7; i++) await call('/api/enroll/options', { method: 'POST', body: { code: 'AAAAA-AAAAA-AAAAA-AAAAA' }, ip: '192.0.2.10', peer: '198.51.100.66' });
  assert.ok(enrollLockout.remaining('198.51.100.66') > 0, 'the stranger locked itself out');
  assert.equal(enrollLockout.remaining('192.0.2.10'), 0, 'the owner it claimed to be is not');
  // ...so the owner, coming through the proxy from that address, enrolls.
  const k = new SoftAuthenticator(origin, config().rpID);
  await enroll(k, 'Owner', { ip: '192.0.2.10' });
  // The sign-in limiter too: a fresh forged address per request from one socket is one bucket.
  for (let i = 0; i < 30; i++) loginLimiter.allow('198.51.100.99');
  const forged = await call('/api/auth/options', { method: 'POST', ip: `192.0.2.${200}`, peer: '198.51.100.99' });
  assert.equal(forged.status, 429);
  // Log lines say the client address (the proxy's peer is not the client).
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stdout.write;
  try {
    await call('/api/session', { ip: '2001:db8::42' });
    await call('/api/session', { ip: '2001:db8::43', peer: '198.51.100.5' });
  } finally {
    process.stdout.write = write;
  }
  assert.ok(lines.some((l) => / http GET .*ip=2001:db8::42/.test(l)), lines.join(''));
  assert.ok(lines.some((l) => / http GET .*ip=198\.51\.100\.5/.test(l)), 'untrusted peer: its own address');
  assert.ok(!lines.some((l) => l.includes('2001:db8::43')), 'the forged header is not logged as the client');
});

test('requireStepUp (the sdk one, for packages): a recent sign-in or step-up, else 403 step_up', async () => {
  const { requireStepUp } = await import('../server/stepup.js');
  const sid = newSession();
  const guarded = new Hono<Env>()
    .use('*', async (c, next) => (c.set('session', sha256(sid)), next()))
    .put('/x', requireStepUp, (c) => c.json({ ok: true }));
  assert.equal((await guarded.request('/x', { method: 'PUT' })).status, 200, 'just signed in');
  age(sid);
  const r = await guarded.request('/x', { method: 'PUT' });
  assert.deepEqual([r.status, await r.json()], [403, { error: 'step_up' }]);
  assert.equal((await call('/api/auth/stepup')).status, 302, 'no session: nothing to say');
});

test('adding a passkey from Settings: behind the step-up, a challenge of this session only, the others alerted', async () => {
  const sid = newSession();
  const other = newSession();
  const keyC = new SoftAuthenticator(origin, config().rpID);
  const before = store.read().credentials.length;
  // Without a recent sign-in or step-up: neither the options nor the passkey.
  age(sid);
  assert.deepEqual((await json(await call('/api/auth/passkeys/options', { sid, method: 'POST' }))).body, { error: 'step_up' });
  assert.equal((await call('/api/auth/passkeys', { sid, method: 'POST', body: { response: {}, label: 'x' } })).status, 403);
  assert.equal((await call('/api/auth/passkeys/options', { method: 'POST' })).status, 302, 'no session: redirect');
  store.mutate((st) => void (st.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now()));
  const options = async (who = sid) => (await json(await call('/api/auth/passkeys/options', { sid: who, method: 'POST' }))).body as { challenge: string; user: { id: string }; excludeCredentials: { id: string }[] };
  const add = (response: unknown, label?: string, who = sid) => call('/api/auth/passkeys', { sid: who, method: 'POST', body: { response, label } });
  const opts = await options();
  assert.equal(opts.user.id, store.read().userHandle, 'the same user: the new passkey signs in as the owner');
  assert.deepEqual(new Set(opts.excludeCredentials.map((x) => x.id)), new Set(store.read().credentials.map((x) => x.id)), 'the passkeys already there excluded');
  // Another session's challenge, an enrollment code's, a sign-in's: refused (each burns its challenge).
  assert.equal((await add(keyC.register(await options(other)))).status, 400, "another session's challenge");
  clearEnrollLimits();
  const c = code();
  const reg = (await json(await call('/api/enroll/options', { method: 'POST', body: { code: c } }))).body as { challenge: string };
  assert.equal((await add(keyC.register(reg))).status, 400, "an enrollment code's challenge");
  const login = (await json(await call('/api/auth/options', { method: 'POST' }))).body as { challenge: string };
  assert.equal((await add(keyC.register(login))).status, 400, "a sign-in's challenge");
  // A wrong origin, a wrong RP ID, no user verification, an assertion instead of a creation.
  for (const bend of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { flags: 0x41 }, { type: 'webauthn.get' }]) {
    assert.equal((await add(keyC.register(await options(), bend))).status, 400, JSON.stringify(bend));
  }
  assert.equal(store.read().credentials.length, before, 'nothing added so far');
  // The other device has notifications on (and so does this one: it is not told of its own passkey).
  const browser = fakeBrowser();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/test-add';
  store.mutate((st) => {
    (st.push ??= []).push({ id: 'add-other', sessionHash: sha256(other), endpoint, ...browser.keys, createdAt: Date.now(), lang: 'fr' });
    st.push.push({ id: 'add-self', sessionHash: sha256(sid), endpoint: 'https://fcm.googleapis.com/fcm/send/test-self', ...fakeBrowser().keys, createdAt: Date.now(), lang: 'en' });
  });
  const sent: { url: string; body: Buffer }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: Buffer.from(init.body as Uint8Array) });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  let r: Response;
  const good = keyC.register(await options());
  try {
    r = await add(good, ' Yubi\u0000key ');
    for (let i = 0; i < 50 && !sent.some((x) => x.url === endpoint); i++) await new Promise((ok) => setTimeout(ok, 20));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(r.status, 200);
  const s = (await r.json()) as { passkeys: { id: string; label: string; addedFrom: string }[] };
  const k = s.passkeys.find((x) => x.id === keyC.credentialId)!;
  assert.deepEqual([k.label, k.addedFrom], ['Yubikey', 'Firefox · Linux']);
  assert.equal(store.read().credentials.length, before + 1);
  assert.ok(live(sid) && !cookieOf(r), 'this session stays as it is (no new cookie)');
  assert.ok(sent.some((x) => x.url === endpoint), 'the other device alerted');
  assert.ok(!sent.some((x) => x.url.endsWith('/test-self')), 'not this one');
  const msg = JSON.parse(browser.decrypt(sent.find((x) => x.url === endpoint)!.body)) as { notification: { title: string; body: string } };
  assert.match(msg.notification.body, /« Yubikey »/);
  // Replayed, or the same authenticator again on fresh options: refused, nothing doubled.
  assert.equal((await add(good)).status, 400, 'replay');
  assert.deepEqual((await json(await add(keyC.register(await options())))).body, { error: 'exists' });
  // No name: named after the browser. The new passkey signs in.
  const keyD = new SoftAuthenticator(origin, config().rpID);
  const named = (await json(await add(keyD.register(await options())))).body as { passkeys: { id: string; label: string }[] };
  assert.equal(named.passkeys.find((x) => x.id === keyD.credentialId)!.label, 'Firefox · Linux');
  assert.equal((await signIn(keyC)).status, 200);
  store.mutate((st) => {
    st.push = st.push!.filter((p) => !p.id.startsWith('add-'));
    st.sessions = st.sessions.filter((x) => x.hash !== sha256(other) && x.hash !== sha256(sid));
  });
});

test('the known-device cookie (audit H2): 90 days, recorded on the session, void and deleted on sign-out, void when signed out from elsewhere', async () => {
  const kdOf = (r: Response) => r.headers.getSetCookie().find((x) => x.startsWith('kd='));
  // A sign-in sets it (no valid one sent): 90 days, HttpOnly, Strict; its id is on the new session.
  const r = await signIn(keyA);
  assert.equal(r.status, 200);
  const set = kdOf(r)!;
  assert.match(set, /Max-Age=7776000/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  const kd = /^kd=([^;]+)/.exec(set)![1]!;
  const id = kd.split('.')[0]!;
  const sid = cookieOf(r)!;
  assert.equal(store.read().sessions.find((x) => x.hash === sha256(sid))!.kd, id);
  // Signing in again from this browser keeps it (no new cookie), recorded on the new session too.
  const options = (await json(await call('/api/auth/options', { method: 'POST' }))).body as { challenge: string };
  const again = await call('/api/auth/verify', { method: 'POST', body: { response: keyA.assert(options, store.read().userHandle) }, headers: { cookie: `kd=${kd}` } });
  assert.equal(again.status, 200);
  assert.equal(kdOf(again), undefined, 'still valid: kept');
  // Signed under the app's current name; a cookie signed under its former one (before 0.26.1) is still known.
  const macOf = (domain: string, x: string) => createHmac('sha256', Buffer.from(store.read().deviceKey!, 'base64url')).update(`${domain}${x}`).digest('base64url');
  assert.equal(kd.split('.')[1], macOf('klatchly-known-device:', id), 'signed with the new domain');
  const oldId = 'A'.repeat(22);
  const oldKd = `${oldId}.${macOf('beep-known-device:', oldId)}`;
  const o1 = (await json(await call('/api/auth/options', { method: 'POST' }))).body as { challenge: string };
  const legacy = await call('/api/auth/verify', { method: 'POST', body: { response: keyA.assert(o1, store.read().userHandle) }, headers: { cookie: `kd=${oldKd}` } });
  assert.equal(legacy.status, 200);
  assert.equal(kdOf(legacy), undefined, 'a cookie signed under the former name: still valid, kept');
  assert.equal(store.read().sessions.find((x) => x.hash === sha256(cookieOf(legacy)!))!.kd, oldId);
  const forged = await call('/api/auth/verify', { method: 'POST', body: { response: keyA.assert((await json(await call('/api/auth/options', { method: 'POST' }))).body as { challenge: string }, store.read().userHandle) }, headers: { cookie: `kd=${oldId}.${macOf('other-known-device:', oldId)}` } });
  assert.ok(kdOf(forged), 'another domain: not known, a new cookie');
  const sid2 = cookieOf(again)!;
  assert.equal(store.read().sessions.find((x) => x.hash === sha256(sid2))!.kd, id);
  // Sign-out: the session cookie and this one deleted, its id void on the server.
  const out = await call('/api/auth/logout', { method: 'POST', headers: { cookie: `sid=${sid2}; kd=${kd}` } });
  assert.equal(out.status, 200);
  assert.match(kdOf(out) ?? '', /^kd=;.*Max-Age=0/);
  assert.ok(out.headers.getSetCookie().some((x) => /^sid=;.*Max-Age=0/.test(x)));
  assert.ok(store.read().voidDevices?.some((d) => d.id === id && d.until > Date.now()), 'void on the server');
  // That cookie sent again (a copy kept): not known any more, the next sign-in gets a new one.
  const o2 = (await json(await call('/api/auth/options', { method: 'POST' }))).body as { challenge: string };
  const back = await call('/api/auth/verify', { method: 'POST', body: { response: keyA.assert(o2, store.read().userHandle) }, headers: { cookie: `kd=${kd}` } });
  assert.equal(back.status, 200);
  const fresh = /^kd=([^;]+)/.exec(kdOf(back) ?? '')?.[1];
  assert.ok(fresh && fresh !== kd, 'a new known-device cookie');
  // Signed out from another device (Settings → Connected devices): its id void, never the signing-out browser's own.
  const freshId = fresh.split('.')[0]!;
  const victim = cookieOf(back)!;
  const me = newSession();
  store.mutate((st) => void (st.sessions.find((x) => x.hash === sha256(me))!.kd = 'Z'.repeat(22)));
  assert.equal((await call(`/api/auth/sessions/${sha256(victim).slice(0, 16)}`, { sid: me, method: 'DELETE' })).status, 200);
  assert.ok(store.read().voidDevices!.some((d) => d.id === freshId), 'the signed-out device: void');
  assert.ok(!store.read().voidDevices!.some((d) => d.id === 'Z'.repeat(22)));
  // Signing out without the cookie: nothing to delete, nothing voided.
  const n = store.read().voidDevices!.length;
  const plain = await call('/api/auth/logout', { method: 'POST', sid: me });
  assert.equal(kdOf(plain), undefined);
  assert.equal(store.read().voidDevices!.length, n);
  // Every device signed out: the key rotates, the list goes with it.
  const owner2 = newSession();
  assert.equal((await call('/api/auth/sessions/revoke-others', { sid: owner2, method: 'POST' })).status, 200);
  assert.equal(store.read().voidDevices, undefined);
});
