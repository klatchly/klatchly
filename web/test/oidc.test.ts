import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sign-in through an OIDC provider (server/oidc.ts) against a made-up one in process (test/fakeidp.ts, through
// openid-client's customFetch: no network): the happy path, each refusal (state wrong, replayed or from another
// browser; nonce, audience, issuer, expiry, signature; a subject not pinned, even with the owner's e-mail), pinning
// with an enrollment code and by KLATCHLY_OIDC_ALLOWED_SUB, the cross-site return (no session cookie on it: a page that
// navigates same-site), the step-up at the provider (prompt=login, max_age=0, auth_time), Settings, the rate limit,
// the provider down (passkeys still work), the logs without tokens.

const ISSUER = 'https://idp.example.test';
const secretDir = mkdtempSync(join(tmpdir(), 'klatchly-oidc-'));
writeFileSync(join(secretDir, 'secret'), 'client-secret-0123456789\n');
Object.assign(process.env, {
  KLATCHLY_OIDC_ISSUER: ISSUER,
  KLATCHLY_OIDC_CLIENT_ID: 'klatchly',
  KLATCHLY_OIDC_CLIENT_SECRET_FILE: join(secretDir, 'secret'),
  KLATCHLY_OIDC_LABEL: 'Test ID',
});

const { createApp } = await import('../server/app.js');
const { config, parseOidc } = await import('../server/config.js');
const { sessions, store } = await import('../server/context.js');
const { resetOidc, safeReturn } = await import('../server/oidc.js');
const { addEnrollCode, newEnrollCode, sha256 } = await import('../server/sessions.js');
const { canRemovePasskey, canUnlinkOidc, oidcAllowed, oidcReady, oidcStepUp, loginMethods } = await import('../server/auth.js');
const { clearEnrollLimits } = await import('../server/webauthn.js');
const { FakeIdp } = await import('./fakeidp.js');
type Env = import('../server/context.js').Env;
type State = import('../server/store.js').State;

const app: import('hono').Hono<Env> = createApp();
const origin = config().origin;
const idp = new FakeIdp(ISSUER, 'klatchly', 'client-secret-0123456789');
resetOidc(idp.fetch);

let n = 0;
function call(path: string, { cookies = {}, method = 'GET', body, headers = {}, ip }: { cookies?: Record<string, string | undefined>; method?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {}) {
  const cookie = Object.entries(cookies)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return app.request(
    path,
    {
      method,
      headers: {
        'x-forwarded-for': ip ?? `198.51.100.${(++n % 250) + 1}`,
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
        ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
  );
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });
const cookieOf = (r: Response, name: string) => new RegExp(`(?:^|[ ,])${name}=([A-Za-z0-9_-]{43})`).exec(r.headers.get('set-cookie') ?? '')?.[1];
const code = () => {
  const c = newEnrollCode();
  store.mutate((s) => addEnrollCode(s, c, 10 * 60_000));
  return c;
};
/** The callback path of a provider's answer (an absolute URL on KLATCHLY_ORIGIN). */
const local = (url: string) => {
  const u = new URL(url);
  assert.equal(u.origin, origin, 'back to KLATCHLY_ORIGIN');
  assert.equal(u.pathname, '/api/auth/oidc/callback');
  return u.pathname + u.search;
};

/** Starts a flow (the sign-in by default); the authorization URL and this browser's binding cookie. */
async function start(path = '/api/auth/oidc/start', opts: { body?: unknown; cookies?: Record<string, string | undefined>; ip?: string } = {}) {
  const r = await call(path, { method: 'POST', body: opts.body ?? {}, cookies: opts.cookies, ip: opts.ip });
  const j = await json(r);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  return { url: j.body.url as string, bind: cookieOf(r, 'oidc')! };
}

/** The callback's page: what it says (error code) or where it goes, and the session cookie it set. */
async function back(path: string, bind: string | undefined, extra: Record<string, string | undefined> = {}) {
  const r = await call(path, { cookies: { oidc: bind, ...extra } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const html = await r.text();
  return { error: /data-error="([a-z_]+)"/.exec(html)?.[1], go: /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)?.[1], sid: cookieOf(r, 'sid'), setCookie: r.headers.get('set-cookie') ?? '', html };
}

/** A full sign-in as `sub` (with `claims` bent); the callback's result. */
async function signIn(sub: string, claims?: Record<string, unknown>, badSignature?: boolean) {
  const { url, bind } = await start();
  return back(local(idp.approve(url, { sub, claims, badSignature })), bind);
}

const sessionOf = (sid: string) => store.read().sessions.find((s) => s.hash === sha256(sid));

test('configuration: off without KLATCHLY_OIDC_ISSUER, half a setup refused, https only, openid always asked', () => {
  const o = 'https://klatchly.example.test';
  assert.equal(parseOidc({}, o), null);
  assert.throws(() => parseOidc({ KLATCHLY_OIDC_CLIENT_ID: 'x' }, o), /without KLATCHLY_OIDC_ISSUER/);
  assert.throws(() => parseOidc({ KLATCHLY_OIDC_ISSUER: ISSUER }, o), /KLATCHLY_OIDC_CLIENT_ID/);
  assert.throws(() => parseOidc({ KLATCHLY_OIDC_ISSUER: 'http://idp.example.test', KLATCHLY_OIDC_CLIENT_ID: 'x' }, o), /https/);
  assert.throws(() => parseOidc({ KLATCHLY_OIDC_ISSUER: ISSUER, KLATCHLY_OIDC_CLIENT_ID: 'x', KLATCHLY_OIDC_CLIENT_SECRET: 's' }, o), /FILE/);
  assert.throws(() => parseOidc({ KLATCHLY_OIDC_ISSUER: ISSUER, KLATCHLY_OIDC_CLIENT_ID: 'x', KLATCHLY_OIDC_CLIENT_SECRET_FILE: join(secretDir, 'missing') }, o), /cannot be read/);
  const loop = parseOidc({ KLATCHLY_OIDC_ISSUER: 'http://127.0.0.1:4000', KLATCHLY_OIDC_CLIENT_ID: 'x', KLATCHLY_OIDC_SCOPES: 'email profile' }, o)!;
  assert.equal(loop.scopes, 'openid email profile');
  assert.equal(loop.label, '127.0.0.1');
  assert.equal(loop.clientSecret, undefined, 'a public client (PKCE only)');
  assert.equal(loop.redirectUri, 'https://klatchly.example.test/api/auth/oidc/callback');
  const cfg = config().oidc!;
  assert.equal(cfg.clientSecret, 'client-secret-0123456789');
  assert.equal(cfg.label, 'Test ID');
});

test('the rules: only the pinned issuer + subject, never by e-mail; a way to sign in always left', () => {
  const cfg = config().oidc!;
  const st: State = { version: 1, userHandle: 'u', credentials: [], sessions: [], enrollCodes: [], auth: { mode: 'passkey', oidc: { iss: ISSUER, sub: 'owner-sub', linkedAt: '2026-01-01T00:00:00Z' } } };
  assert.ok(oidcAllowed(st, cfg, ISSUER, 'owner-sub'));
  assert.ok(oidcAllowed(st, cfg, `${ISSUER}/`, 'owner-sub'), 'the same issuer identifier');
  assert.ok(!oidcAllowed(st, cfg, ISSUER, 'other-sub'));
  assert.ok(!oidcAllowed(st, cfg, 'https://other.example.test', 'owner-sub'), 'another issuer');
  assert.ok(!oidcAllowed(st, null, ISSUER, 'owner-sub'), 'not configured');
  assert.ok(oidcAllowed({ ...st, auth: { mode: 'passkey' } }, { ...cfg, allowedSub: 'env-sub' }, ISSUER, 'env-sub'), 'pinned by the environment');
  assert.ok(oidcReady(st, cfg));
  assert.ok(!oidcReady({ ...st, auth: { mode: 'passkey' } }, cfg));
  assert.deepEqual(loginMethods({ ...st, credentials: [] }, cfg), { passkey: false, oidc: { label: 'Test ID' } });
  assert.deepEqual(loginMethods(st, null), { passkey: true }, 'without the provider: exactly as before');
  const key = { id: 'k', publicKey: 'x', counter: 0, createdAt: '', label: 'k' };
  assert.equal(canRemovePasskey({ ...st, credentials: [key] }, 'k', true), null, 'the provider signs in: the last passkey may go');
  assert.equal(canRemovePasskey({ ...st, credentials: [key] }, 'k', false), 'last_passkey');
  assert.equal(canUnlinkOidc(st, cfg), 'last_method', 'nothing left to sign in with');
  assert.equal(canUnlinkOidc({ ...st, credentials: [key] }, cfg), null);
  assert.equal(canUnlinkOidc(st, { ...cfg, allowedSub: 'env-sub' }), null);
  assert.equal(canUnlinkOidc({ ...st, auth: { mode: 'passkey' } }, cfg), 'not_found');
  // Step-up at the provider: a session it opened, or no passkey at all.
  const withS = (method: 'oidc' | 'passkey' | undefined, credentials = [key]): State => ({ ...st, credentials, sessions: [{ hash: 'h', createdAt: 0, lastSeen: 0, ...(method ? { method } : {}) }] });
  assert.ok(oidcStepUp(withS('oidc'), cfg, 'h'));
  assert.ok(!oidcStepUp(withS('passkey'), cfg, 'h'), 'a passkey session confirms with a passkey');
  assert.ok(!oidcStepUp(withS(undefined), cfg, 'h'));
  assert.ok(oidcStepUp(withS('passkey', []), cfg, 'h'), 'no passkey left');
  assert.ok(!oidcStepUp(withS('oidc'), cfg, 'missing'));
  assert.equal(safeReturn('/settings/general'), '/settings/general');
  for (const bad of ['https://evil.example/', '//evil.example/x', '/api/auth/oidc/start', '/settings/../x', 42]) assert.equal(safeReturn(bad), '/settings/general', String(bad));
});

test('sign-in page: "Continue with" the provider; no passkey yet, no key button; nobody pinned yet: refused with a clear page', async () => {
  assert.deepEqual((await json(await call('/api/session'))).body, { authenticated: false, login: { passkey: false, oidc: { label: 'Test ID' } } });
  // CSRF: the start is a POST of the app only.
  assert.equal((await json(await call('/api/auth/oidc/start', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } }))).body.error, 'bad_origin');
  const r = await signIn('owner-sub');
  assert.equal(r.error, 'not_allowed');
  assert.equal(r.sid, undefined, 'no session');
  assert.match(r.html, /KLATCHLY_OIDC_ALLOWED_SUB/);
  assert.equal(store.read().sessions.length, 0);
});

const owner = { sid: '' };

test('linking with an enrollment code: pins the issuer + subject, opens a session; the code is single use', async () => {
  clearEnrollLimits();
  assert.equal((await call('/api/enroll/oidc', { method: 'POST', body: { code: 'AAAAA-AAAAA-AAAAA-AAAAA' } })).status, 400, 'a wrong code');
  const c = code();
  const { url, bind } = await start('/api/enroll/oidc', { body: { code: c } });
  assert.equal(new URL(url).origin, ISSUER);
  const r = await back(local(idp.approve(url, { sub: 'owner-sub', claims: { email: 'owner@example.test' } })), bind);
  assert.equal(r.error, undefined, r.html);
  assert.equal(r.go, '/');
  assert.ok(r.sid);
  assert.match(r.setCookie, /sid=[^;]+;.*SameSite=Strict/i);
  owner.sid = r.sid!;
  const st = store.read();
  assert.equal(st.auth?.oidc?.sub, 'owner-sub');
  assert.equal(st.auth?.oidc?.iss, ISSUER);
  assert.equal(st.enrollCodes.length, 0, 'the code used up');
  assert.equal(sessionOf(owner.sid)!.method, 'oidc');
  assert.ok(sessionOf(owner.sid)!.authAt);
  // Used up: neither a passkey nor another link with it.
  assert.equal((await call('/api/enroll/oidc', { method: 'POST', body: { code: c } })).status, 400);
  assert.equal((await call('/api/enroll/options', { method: 'POST', body: { code: c } })).status, 400);
  // A code used by something else between the start and the provider's answer: refused at the return.
  const c2 = code();
  const f = await start('/api/enroll/oidc', { body: { code: c2 } });
  store.mutate((s) => void (s.enrollCodes = []));
  const late = await back(local(idp.approve(f.url, { sub: 'intruder-sub' })), f.bind);
  assert.equal(late.error, 'code');
  assert.equal(late.sid, undefined);
  assert.equal(store.read().auth?.oidc?.sub, 'owner-sub', 'the link unchanged');
});

test('sign-in: code + PKCE + state + nonce; a Klatchly session (Strict), set on a page that navigates same-site; no token in the logs', async () => {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stdout.write;
  let r, url: string, cb: string;
  try {
    const s = await start();
    url = s.url;
    const a = new URL(url).searchParams;
    assert.equal(a.get('response_type'), 'code');
    assert.equal(a.get('client_id'), 'klatchly');
    assert.equal(a.get('code_challenge_method'), 'S256');
    assert.ok(a.get('code_challenge') && a.get('state') && a.get('nonce'));
    assert.equal(a.get('scope'), 'openid');
    assert.equal(a.get('redirect_uri'), `${origin}/api/auth/oidc/callback`);
    assert.equal(a.get('prompt'), null, 'a sign-in may use the provider’s single sign-on');
    cb = local(idp.approve(url, { sub: 'owner-sub' }));
    // The provider's return is cross-site: the Strict session cookie is not sent; the Lax binding cookie is.
    r = await back(cb, s.bind);
  } finally {
    process.stdout.write = write;
  }
  assert.equal(r.error, undefined, r.html);
  assert.equal(r.go, '/');
  assert.ok(r.sid);
  // Basic auth with the secret from the file, the verifier sent.
  assert.ok(idp.lastToken?.get('code_verifier'));
  assert.equal(idp.lastToken?.get('client_secret'), null, 'the secret by HTTP Basic, not in the form');
  const sess = sessionOf(r.sid!)!;
  assert.equal(sess.method, 'oidc');
  assert.ok(sessions.validate(r.sid), 'a Klatchly session');
  assert.equal((await call('/api/auth/settings', { cookies: { sid: r.sid } })).status, 200);
  const log = lines.join('');
  assert.match(log, /login ok \(oidc\).*sub=owner-sub/);
  const q = new URL(cb, origin).searchParams;
  assert.ok(!log.includes(q.get('code')!), 'no authorization code in the logs');
  assert.ok(!log.includes(q.get('state')!), 'no state in the logs');
  assert.ok(!/id_token|eyJ/.test(log), 'no token in the logs');
  // Revocable like any session.
  assert.equal((await call('/api/auth/logout', { method: 'POST', cookies: { sid: r.sid } })).status, 200);
  assert.equal(sessions.validate(r.sid), null);
});

test('refused: wrong, replayed or foreign state; another browser; provider error; nonce, audience, issuer, expiry, signature', async () => {
  const before = store.read().sessions.length;
  // A state nobody started.
  const s = await start();
  const cb = local(idp.approve(s.url, { sub: 'owner-sub' }));
  const wrong = cb.replace(/state=[^&]+/, 'state=not-a-flow');
  assert.equal((await back(wrong, s.bind)).error, 'expired');
  // That attempt consumed nothing of the real flow; it works once, then is replayed.
  assert.ok((await back(cb, s.bind)).sid);
  const tokens = idp.tokenRequests;
  const replay = await back(cb, s.bind);
  assert.equal(replay.error, 'expired', 'state replayed');
  assert.equal(idp.tokenRequests, tokens, 'the code not even tried again');
  // Another browser's return (no binding cookie, or another one).
  const t = await start();
  assert.equal((await back(local(idp.approve(t.url, { sub: 'owner-sub' })), undefined)).error, 'expired');
  const u = await start();
  assert.equal((await back(local(idp.approve(u.url, { sub: 'owner-sub' })), 'A'.repeat(43))).error, 'expired');
  // The provider said no.
  const v = await start();
  assert.equal((await back(local(idp.approve(v.url, { error: 'access_denied' })), v.bind)).error, 'denied');
  // What the ID token says, bent.
  const now = Math.floor(Date.now() / 1000);
  for (const [why, claims, bad] of [
    ['nonce', { nonce: 'another-nonce' }],
    ['no nonce', { nonce: undefined }],
    ['audience', { aud: 'someone-else' }],
    ['issuer', { iss: 'https://evil.example.test' }],
    ['expired', { exp: now - 3600, iat: now - 7200 }],
    ['signature', {}, true],
  ] as const) {
    const r = await signIn('owner-sub', claims, bad);
    assert.equal(r.error, 'invalid', why);
    assert.equal(r.sid, undefined, why);
  }
  // Another subject, even with the owner's e-mail.
  const other = await signIn('other-sub', { email: 'owner@example.test', email_verified: true });
  assert.equal(other.error, 'not_allowed');
  assert.equal(store.read().sessions.length, before + 1, 'only the one good return opened a session');
});

test('step-up at the provider: prompt=login, max_age=0, auth_time after the start; only for a session it opened', async () => {
  const r = await signIn('owner-sub');
  const sid = r.sid!;
  store.mutate((s) => void (s.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now() - 3600_000));
  const st0 = (await json(await call('/api/auth/stepup', { cookies: { sid } }))).body;
  assert.equal(st0.leftMs, 0);
  assert.equal(st0.oidc, 'Test ID');
  assert.equal((await call('/api/auth/sessions/revoke-others', { method: 'POST', cookies: { sid } })).status, 403, 'confirm first');
  // An old sign-in at the provider (its single sign-on session) is not a confirmation.
  const a = await start('/api/auth/stepup/oidc', { body: { returnTo: '/settings/general' }, cookies: { sid } });
  const p = new URL(a.url).searchParams;
  assert.equal(p.get('prompt'), 'login');
  assert.equal(p.get('max_age'), '0');
  const stale = await back(local(idp.approve(a.url, { sub: 'owner-sub', claims: { auth_time: Math.floor(Date.now() / 1000) - 600 } })), a.bind);
  assert.equal(stale.error, 'stale');
  const noTime = await start('/api/auth/stepup/oidc', { body: {}, cookies: { sid } });
  assert.equal((await back(local(idp.approve(noTime.url, { sub: 'owner-sub', claims: { auth_time: undefined } })), noTime.bind)).error, 'invalid', 'auth_time required');
  // Someone else at the provider cannot confirm for the owner.
  const b = await start('/api/auth/stepup/oidc', { body: {}, cookies: { sid } });
  assert.equal((await back(local(idp.approve(b.url, { sub: 'other-sub' })), b.bind)).error, 'not_allowed');
  assert.equal((await json(await call('/api/auth/stepup', { cookies: { sid } }))).body.leftMs, 0);
  // A fresh sign-in: confirmed, back on the page (an outside address is not followed); no new session.
  const c = await start('/api/auth/stepup/oidc', { body: { returnTo: 'https://evil.example/' }, cookies: { sid } });
  const ok = await back(local(idp.approve(c.url, { sub: 'owner-sub' })), c.bind);
  assert.equal(ok.error, undefined, ok.html);
  assert.equal(ok.go, '/settings/general');
  assert.equal(ok.sid, undefined, 'a step-up never opens a session');
  assert.ok((await json(await call('/api/auth/stepup', { cookies: { sid } }))).body.leftMs > 0);
  assert.equal((await call('/api/auth/sessions/revoke-others', { method: 'POST', cookies: { sid } })).status, 200);
  // The session signed out meanwhile: the confirmation is refused.
  const d = await start('/api/auth/stepup/oidc', { body: {}, cookies: { sid } });
  store.mutate((s) => void (s.sessions = s.sessions.filter((x) => x.hash !== sha256(sid))));
  assert.equal((await back(local(idp.approve(d.url, { sub: 'owner-sub' })), d.bind)).error, 'session');
});

test('a passkey session confirms with a passkey, not at the provider; without a session, no step-up start', async () => {
  const sid = store.mutate((s) => sessions.create(s, Date.now(), 'Firefox · Linux', 'passkey'));
  store.mutate((s) => void s.credentials.push({ id: 'cred', publicKey: 'x', counter: 0, createdAt: new Date().toISOString(), label: 'key' }));
  try {
    const st = (await json(await call('/api/auth/stepup', { cookies: { sid } }))).body;
    assert.deepEqual(st.methods, ['passkey']);
    assert.equal(st.oidc, undefined);
    assert.equal((await call('/api/auth/stepup/oidc', { method: 'POST', body: {}, cookies: { sid } })).status, 400);
    assert.equal((await call('/api/auth/stepup/oidc', { method: 'POST', body: {} })).status, 302, 'no session: redirected, never 401');
    // The sign-in page shows both now.
    assert.deepEqual((await json(await call('/api/session'))).body.login, { passkey: true, oidc: { label: 'Test ID' } });
  } finally {
    store.mutate((s) => void (s.credentials = []));
  }
});

test('Settings: the provider and the linked identity (never a token); unlink after a step-up, never the last way in', async () => {
  const sid = (await signIn('owner-sub')).sid!;
  const s = (await json(await call('/api/auth/settings', { cookies: { sid } }))).body;
  assert.deepEqual({ ...s.oidc, linked: { ...s.oidc.linked, linkedAt: '-' } }, { label: 'Test ID', issuer: `${ISSUER}/`, linked: { iss: ISSUER, sub: 'owner-sub', linkedAt: '-' }, pinnedSub: null, ready: true });
  assert.ok(!JSON.stringify(s).includes('client-secret'), 'no secret');
  assert.equal(s.devices.find((d: { current: boolean }) => d.current).method, 'oidc');
  // No passkey: unlinking would leave nothing to sign in with.
  assert.equal((await json(await call('/api/auth/oidc', { method: 'DELETE', cookies: { sid } }))).body.error, 'last_method');
  store.mutate((st) => void st.credentials.push({ id: 'cred', publicKey: 'x', counter: 0, createdAt: new Date().toISOString(), label: 'key' }));
  store.mutate((st) => void (st.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now() - 3600_000));
  assert.equal((await call('/api/auth/oidc', { method: 'DELETE', cookies: { sid } })).status, 403, 'step-up first');
  store.mutate((st) => void (st.sessions.find((x) => x.hash === sha256(sid))!.authAt = Date.now()));
  const after = await json(await call('/api/auth/oidc', { method: 'DELETE', cookies: { sid } }));
  assert.equal(after.status, 200);
  assert.equal(after.body.oidc.linked, null);
  assert.equal(after.body.oidc.ready, false);
  assert.equal((await signIn('owner-sub')).error, 'not_allowed', 'unlinked: no longer signs in');
  store.mutate((st) => void (st.credentials = []));
});

test('the provider down: the start says so, the passkeys still answer; back up: works again', async () => {
  resetOidc(idp.fetch);
  idp.down = true;
  try {
    assert.equal((await json(await call('/api/auth/oidc/start', { method: 'POST', body: {} }))).body.error, 'unavailable');
    assert.equal((await call('/api/auth/options', { method: 'POST' })).status, 200, 'passkey sign-in unaffected');
  } finally {
    idp.down = false;
  }
  resetOidc(idp.fetch); // the retry delay after a failure, skipped
  assert.equal((await call('/api/auth/oidc/start', { method: 'POST', body: {} })).status, 200);
});

test('rate limits: the starts and the returns count as sign-in attempts per address', async () => {
  const ip = '192.0.2.77';
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await call('/api/auth/oidc/start', { method: 'POST', body: {}, ip })).status;
  assert.equal(last, 429);
  const r = await call('/api/auth/oidc/callback?state=x&code=y', { ip });
  assert.match(await r.text(), /data-error="rate_limited"/);
});

test('pinned by KLATCHLY_OIDC_ALLOWED_SUB: that subject signs in without a link', async () => {
  const cfg = config().oidc!;
  cfg.allowedSub = 'env-sub';
  try {
    const r = await signIn('env-sub');
    assert.equal(r.error, undefined, r.html);
    assert.ok(r.sid);
    assert.equal((await signIn('other-sub')).error, 'not_allowed');
  } finally {
    delete cfg.allowedSub;
  }
});
