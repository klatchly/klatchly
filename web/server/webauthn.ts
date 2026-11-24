import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { config, siteOf } from './config.js';
import { RateLimiter } from './ratelimit.js';
import { deviceSummary, findEnrollCode, normalizeEnrollCode, sha256 } from './sessions.js';
import { loginMethods, passkeyLabel } from './auth.js';
import { forgetKnownDevice, knownDevice, markKnownDevice } from './device.js';
import { Lockout } from './lockout.js';
import { messages } from './i18n.js';
import { pushAll } from './push.js';
import { clientIp, clearSessionCookie, COOKIE, netKey, sessions, setSessionCookie, store, type Env } from './context.js';
import type { SignInMethod } from './store.js';
import { closeSocketsForSession } from './ws.js';
import { log } from './log.js';

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 200;

// 'auth': a sign-in; 'reg': an enrollment, bound to its code; 'stepup': a challenge of a session's step-up
// (signin.ts), usable by that session only, never to sign in; 'add': a passkey added from Settings by a signed-in
// session (signin.ts), usable by that session only.
type Pending =
  | { kind: 'reg'; codeHash: string; expires: number }
  | { kind: 'auth'; expires: number }
  | { kind: 'stepup'; session: string; expires: number }
  | { kind: 'add'; session: string; expires: number };
/** What a registration challenge is for: an enrollment code, or a session adding a passkey from Settings. */
export type RegistrationUse = { kind: 'reg'; codeHash: string } | { kind: 'add'; session: string };
const pending = new Map<string, Pending>();

function remember(challenge: string, p: Pending): void {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
  if (pending.size >= MAX_PENDING) {
    const first = pending.keys().next();
    if (!first.done) pending.delete(first.value);
  }
  pending.set(challenge, p);
}

/** Single use: the challenge is consumed whether or not it matches. */
function consume(challenge: string, check: (p: Pending) => boolean): boolean {
  const p = pending.get(challenge);
  pending.delete(challenge);
  return !!p && p.expires > Date.now() && check(p);
}

// Sign-in requests (passkey options and checks), per address (IPv6: per /64) and in all. A
// browser with a known-device cookie (device.ts) has a bucket of its own, per cookie: strangers filling the shared
// one cannot keep the owner out.
export const loginLimiter = new RateLimiter(5 * 60 * 1000, 30, 600);
const knownLimiter = new RateLimiter(5 * 60 * 1000, 30, 600);
const newEnrollLimiter = () => new RateLimiter(10 * 60 * 1000, 10, 30);
let enrollLimiter = newEnrollLimiter();
/** Forgets the enrollment request counts (tests). */
export const clearEnrollLimits = (): void => void (enrollLimiter = newEnrollLimiter());
// The enrollment code is the one secret that can be guessed (100 bits, 10 minutes): per address (IPv6: per /64), 5
// free wrong codes, then 30 s doubling up to 1 h. Counted as a failure when the attempt starts (before any await: a
// parallel burst cannot all pass), cleared by a right code.
export const enrollLockout = new Lockout(5, 30_000, 3600_000);

export function signInAllowed(c: Context): boolean {
  const kd = knownDevice(c);
  return kd ? knownLimiter.allow(`kd:${kd}`) : loginLimiter.allow(netKey(clientIp(c)));
}

const bad = (c: Context) => c.json({ error: 'invalid' }, 400);
const limited = (c: Context) => c.json({ error: 'rate_limited' }, 429);

export async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}


export const authRoutes = new Hono<Env>();

authRoutes.get('/session', (c) => {
  const login = loginMethods(store.read(), config().oidc);
  // Signed in too: /enroll offers to link the provider's account (oidc.ts) to a signed-in browser as well.
  if (c.get('session')) return c.json({ authenticated: true, login });
  return c.json({ authenticated: false, login });
});

/** The RP ID for the page asking (its Origin header, one of config.ts sites), KLATCHLY_RP_ID otherwise. */
export function rpIDFor(c: Context): string {
  return siteOf(c.req.header('origin'))?.rpID ?? config().rpID;
}

/** Options for a passkey assertion; the challenge is remembered for that use only. */
export async function assertionOptions(use: { kind: 'auth' } | { kind: 'stepup'; session: string }, rpID = config().rpID) {
  const opts = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: [],
    timeout: CHALLENGE_TTL_MS,
  });
  remember(opts.challenge, { ...use, expires: Date.now() + CHALLENGE_TTL_MS });
  return opts;
}

authRoutes.post('/auth/options', async (c) => {
  if (!signInAllowed(c)) return limited(c);
  return c.json(await assertionOptions({ kind: 'auth' }, rpIDFor(c)));
});

/**
 * Verifies a passkey assertion against a challenge remembered for `use` (sign-in: 'auth' from /auth/options; step-up: 'stepup' of that session) and records its use (counter, last used). The credential's
 * id, or null.
 */
export async function checkPasskey(raw: unknown, use: { kind: 'auth' } | { kind: 'stepup'; session: string } = { kind: 'auth' }): Promise<string | null> {
  const response = raw as AuthenticationResponseJSON | undefined;
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') return null;
  const state = store.read();
  const cred = state.credentials.find((x) => x.id === response.id);
  if (!cred) return null;
  if (response.response?.userHandle && response.response.userHandle !== state.userHandle) return null;
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (ch) => consume(ch, (p) => p.kind === use.kind && (p.kind !== 'stepup' || (use.kind === 'stepup' && p.session === use.session))),
      // Any of our sites (config.ts sites): the browser binds a passkey's RP ID to the page's own address.
      expectedOrigin: config().sites.map((x) => x.origin),
      expectedRPID: config().sites.map((x) => x.rpID),
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey, 'base64url'),
        counter: cred.counter,
        transports: cred.transports as never,
      },
      requireUserVerification: true,
    });
  } catch {
    return null;
  }
  if (!verification.verified) return null;
  store.mutate((st) => {
    const cur = st.credentials.find((x) => x.id === cred.id);
    if (cur) {
      cur.counter = verification.authenticationInfo.newCounter;
      cur.lastUsedAt = new Date().toISOString();
    }
  });
  return cred.id;
}

/**
 * Opens a new session for this browser (a new id: the one it had, if any, is revoked) after a full sign-in; the
 * request goes on with it. Its hash.
 */
export function startSession(c: Context, method: SignInMethod = 'passkey'): string {
  const old = c.get('session');
  const device = deviceSummary(c.req.header('user-agent'));
  const sid = store.mutate((st) => {
    if (old) st.sessions = st.sessions.filter((s) => s.hash !== old);
    return sessions.create(st, Date.now(), device, method);
  });
  if (old) closeSocketsForSession(old);
  setSessionCookie(c, sid);
  const hash = sha256(sid);
  c.set('session', hash);
  return hash;
}

authRoutes.post('/auth/verify', async (c) => {
  if (!signInAllowed(c)) return limited(c);
  const body = await jsonBody(c);
  if (!(await checkPasskey(body?.response))) {
    log('auth', 'passkey sign-in rejected', { ip: clientIp(c) });
    return bad(c);
  }
  startSession(c, 'passkey');
  markKnownDevice(c);
  log('auth', 'login ok', { ip: clientIp(c) });
  return c.json({ ok: true });
});

authRoutes.post('/auth/logout', (c) => {
  const s = c.get('session');
  if (s) {
    sessions.revoke(s);
    closeSocketsForSession(s);
  }
  clearSessionCookie(c);
  // The known-device cookie too (audit H2): void on the server, then deleted (device.ts).
  forgetKnownDevice(c);
  // Otherwise the photos and files seen stay in the browser's HTTP cache (private, max-age 7 days).
  // "cache" only: "storage" would also unregister the service worker.
  c.header('Clear-Site-Data', '"cache"');
  return c.json({ ok: true });
});

/** Takes one enrollment attempt (a wrong code until `codeOk`), or answers 429. Synchronous: call it first. */
export function enrollAttempt(c: Context): Response | null {
  const key = netKey(clientIp(c));
  if (!enrollLimiter.allow(key)) return limited(c);
  const ms = enrollLockout.remaining(key);
  if (ms > 0) return c.json({ error: 'locked', retryAfter: Math.ceil(ms / 1000) }, 429);
  enrollLockout.fail(key);
  return null;
}
export const codeOk = (c: Context) => enrollLockout.succeed(netKey(clientIp(c)));

/**
 * A new passkey (enrolled with a code, or added from Settings): every other device that has notifications on is told
 * (a passkey added by someone with a code from the server shell, or with a stolen session, would otherwise go
 * unseen), and Settings shows it (signin.ts describe). `except`: the session that added it.
 */
export function alertNewPasskey(label: string, device: string, except: string): void {
  void pushAll((sub) => {
    if (sub.sessionHash === except) return null;
    const t = messages(sub.lang).push;
    return { title: t.passkeyAddedTitle, body: t.passkeyAddedBody(label, device), tag: 'passkey-added', url: '/settings/general' };
  })
    .then((r) => log('auth', 'new passkey: devices alerted', { sent: r.sent, failed: r.failed }))
    .catch(() => {});
}

/**
 * Options for a passkey registration, the challenge remembered for `use` only. The passkeys already there are
 * excluded: an authenticator that holds one answers "already registered" instead of making a second.
 */
export async function registrationOptions(use: RegistrationUse, rpID = config().rpID) {
  const state = store.read();
  const opts = await generateRegistrationOptions({
    rpName: '•',
    rpID,
    userID: Buffer.from(state.userHandle, 'base64url'),
    userName: 'me',
    userDisplayName: 'me',
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: state.credentials.map((x) => ({ id: x.id, transports: x.transports as never })),
    timeout: CHALLENGE_TTL_MS,
  });
  remember(opts.challenge, { ...use, expires: Date.now() + CHALLENGE_TTL_MS });
  return opts;
}

/** A registration verified against a challenge remembered for `use` (single use either way): the credential, or null. */
export async function checkRegistration(raw: unknown, use: RegistrationUse) {
  const response = raw as RegistrationResponseJSON | undefined;
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') return null;
  const same = (p: Pending) => (use.kind === 'reg' ? p.kind === 'reg' && p.codeHash === use.codeHash : p.kind === 'add' && p.session === use.session);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: (ch) => consume(ch, same),
      // Any of our sites (config.ts sites): the browser binds a passkey's RP ID to the page's own address.
      expectedOrigin: config().sites.map((x) => x.origin),
      expectedRPID: config().sites.map((x) => x.rpID),
      requireUserVerification: true,
    });
  } catch {
    return null;
  }
  if (!verification.verified || !verification.registrationInfo) return null;
  const { credential } = verification.registrationInfo;
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports as string[] | undefined,
  };
}

authRoutes.post('/enroll/options', async (c) => {
  const stop = enrollAttempt(c);
  if (stop) return stop;
  const body = await jsonBody(c);
  const code = normalizeEnrollCode(body?.code);
  if (!code) return bad(c);
  const state = store.read();
  const codeHash = findEnrollCode(state, code);
  if (!codeHash) {
    log('auth', 'enroll code rejected', { ip: clientIp(c) });
    return bad(c);
  }
  codeOk(c);
  return c.json(await registrationOptions({ kind: 'reg', codeHash }, rpIDFor(c)));
});

authRoutes.post('/enroll/verify', async (c) => {
  const stop = enrollAttempt(c);
  if (stop) return stop;
  const body = await jsonBody(c);
  const code = normalizeEnrollCode(body?.code);
  if (!code) return bad(c);
  const codeHash = findEnrollCode(store.read(), code);
  if (!codeHash) {
    log('auth', 'enroll code rejected', { ip: clientIp(c) });
    return bad(c);
  }
  codeOk(c);
  const credential = await checkRegistration(body?.response, { kind: 'reg', codeHash });
  if (!credential) return bad(c);
  const old = c.get('session');
  const device = deviceSummary(c.req.header('user-agent'));
  const label = passkeyLabel(body?.label) ?? 'passkey';
  const sid = store.mutate((st) => {
    // The code may have been used concurrently; re-check inside the write.
    if (!st.enrollCodes.some((x) => x.hash === codeHash && x.expiresAt > Date.now())) return null;
    st.enrollCodes = st.enrollCodes.filter((x) => x.hash !== codeHash);
    if (!st.credentials.some((x) => x.id === credential.id)) {
      st.credentials.push({
        ...credential,
        createdAt: new Date().toISOString(),
        label,
        addedFrom: device,
      });
    }
    if (old) st.sessions = st.sessions.filter((s) => s.hash !== old);
    return sessions.create(st, Date.now(), device, 'passkey');
  });
  if (!sid) return bad(c);
  if (old) closeSocketsForSession(old);
  setSessionCookie(c, sid);
  c.set('session', sha256(sid));
  markKnownDevice(c);
  log('auth', 'passkey enrolled', { label, device, ip: clientIp(c) });
  alertNewPasskey(label, device, sha256(sid));
  return c.json({ ok: true });
});

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, COOKIE.name, COOKIE.prefix);
}
