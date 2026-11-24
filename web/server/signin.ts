import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { canRemovePasskey, canUnlinkOidc, oidcReady, passkeyLabel, stepUpMethods } from './auth.js';
import { clientIp, store, type Env } from './context.js';
import { forgetDevices, markKnownDevice } from './device.js';
import { log } from './log.js';
import { RateLimiter } from './ratelimit.js';
import { oidcConfig, oidcSettings, stepUpInfo } from './oidc.js';
import { stepUpState } from './stepup.js';
import { deviceSummary, liveSession, prunePush, sessionExpiry, voidKnownDevice } from './sessions.js';
import type { State } from './store.js';
import { alertNewPasskey, assertionOptions, checkPasskey, checkRegistration, jsonBody, registrationOptions, rpIDFor } from './webauthn.js';
import { closeSocketsForSession } from './ws.js';

// Settings → Général → Connexion (session required: mounted after the session check, app.ts): the passkeys (list,
// add one on this device, rename, remove, never the last way to sign in), the OIDC provider when one is configured (the identity linked:
// issuer and subject, never a token; unlink), and the connected devices (list, sign one out, sign out everywhere
// else). Every change needs a recent sign-in or step-up (auth.ts STEP_UP_MS, stepup.ts; with a passkey, or at the
// provider: oidc.ts); reading does not.

// Step-up and new-passkey challenges, per session (the sign-in limiter's global bucket is the strangers' too).
const stepUpLimiter = new RateLimiter(5 * 60 * 1000, 30, 10_000);

const small = bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: 'too_large' }, 413) });
// A registration response carries the new public key and the authenticator's data (attestation "none": no certificates).
const registration = bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });
const bad = (c: Context) => c.json({ error: 'invalid' }, 400);

/** A session's id in the API: the start of its hash (the hash of the cookie, itself never stored). */
const SESSION_ID = /^[0-9a-f]{16}$/;
const sessionId = (hash: string) => hash.slice(0, 16);
/** A passkey's id: its base64url credential id. */
const PASSKEY_ID = /^[A-Za-z0-9_-]{1,1400}$/;

export interface PasskeyInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  addedFrom: string | null;
}

export interface DeviceInfo {
  id: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  device: string | null;
  /** How it signed in: 'passkey' or 'oidc'. */
  method: string;
  current: boolean;
}

function describe(c: Context<Env>) {
  const state = store.read();
  const me = c.get('session')!;
  const now = Date.now();
  const passkeys: PasskeyInfo[] = state.credentials.map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt ?? null, addedFrom: k.addedFrom ?? null }));
  const devices: DeviceInfo[] = state.sessions
    .filter((s) => liveSession(s, now))
    .sort((a, b) => Number(b.hash === me) - Number(a.hash === me) || b.lastSeen - a.lastSeen)
    .map((s) => ({ id: sessionId(s.hash), createdAt: s.createdAt, lastSeen: s.lastSeen, expiresAt: sessionExpiry(s), device: s.device ?? null, method: s.method ?? 'passkey', current: s.hash === me }));
  return { mode: 'passkey' as const, passkeys, devices, oidc: oidcSettings(), stepUp: stepUpInfo(c) };
}

/** The change needs a recent sign-in or step-up (auth.ts STEP_UP_MS). */
const needsStepUp = (c: Context<Env>) => stepUpState(c).leftMs <= 0;
const refuse = (c: Context, error: string, status: 400 | 403 | 404 = 400) => c.json({ error }, status);
const who = (c: Context) => ({ session: c.get('session')!.slice(0, 12), ip: clientIp(c) });

/** Signs the given sessions out (in a mutate): their push subscriptions go; returns their hashes. */
function dropSessions(st: State, gone: (hash: string) => boolean): string[] {
  const out = st.sessions.filter((s) => gone(s.hash)).map((s) => s.hash);
  st.sessions = st.sessions.filter((s) => !gone(s.hash));
  prunePush(st);
  return out;
}

export const signinSettingsRoutes = new Hono<Env>();

signinSettingsRoutes.get('/auth/settings', (c) => c.json(describe(c)));

// How long this session may still make sensitive changes, and how to confirm (stepup.ts): for the packages' pages
// that guard a change the same way (client/src/StepUp.tsx).
signinSettingsRoutes.get('/auth/stepup', (c) => c.json(stepUpInfo(c)));

// A passkey step-up's challenge: for this session only, never a sign-in.
signinSettingsRoutes.post('/auth/stepup/options', async (c) => {
  if (!stepUpLimiter.allow(c.get('session')!)) return c.json({ error: 'rate_limited' }, 429);
  return c.json(await assertionOptions({ kind: 'stepup', session: c.get('session')! }, rpIDFor(c)));
});

// Confirms it is the owner with a passkey, on a challenge of /auth/stepup/options for this session (nothing to guess:
// no lockout). This session may then make sensitive changes for STEP_UP_MS.
signinSettingsRoutes.post('/auth/stepup/passkey', small, async (c) => {
  const body = await jsonBody(c);
  const me = c.get('session')!;
  if (!stepUpMethods(store.read()).includes('passkey')) return bad(c);
  if (!(await checkPasskey(body?.response, { kind: 'stepup', session: me }))) {
    log('auth', 'step-up (passkey) rejected', who(c));
    return bad(c);
  }
  store.mutate((st) => {
    const s = st.sessions.find((x) => x.hash === me);
    if (s) s.authAt = Date.now();
  });
  log('auth', 'step-up ok', who(c));
  return c.json({ ok: true });
});

// ── Passkeys ──

// Adding a passkey on this device, signed in already (the enrollment code of the CLI stays for a device that is not):
// behind the step-up, a registration challenge for this session only, the passkeys already there excluded.
signinSettingsRoutes.post('/auth/passkeys/options', async (c) => {
  const me = c.get('session')!;
  if (needsStepUp(c)) return refuse(c, 'step_up', 403);
  if (!stepUpLimiter.allow(me)) return c.json({ error: 'rate_limited' }, 429);
  return c.json(await registrationOptions({ kind: 'add', session: me }, rpIDFor(c)));
});

// The new passkey, on a challenge of /auth/passkeys/options for this session (still behind the step-up: the window
// may have closed during the ceremony). Named by the owner (or after this browser), alerted to the other devices
// like an enrollment (webauthn.ts alertNewPasskey). This session stays as it is.
signinSettingsRoutes.post('/auth/passkeys', registration, async (c) => {
  const me = c.get('session')!;
  if (needsStepUp(c)) return refuse(c, 'step_up', 403);
  const body = await jsonBody(c);
  const credential = await checkRegistration(body?.response, { kind: 'add', session: me });
  if (!credential) {
    log('auth', 'passkey add rejected', who(c));
    return bad(c);
  }
  const device = deviceSummary(c.req.header('user-agent'));
  const label = passkeyLabel(body?.label) ?? (device !== '?' ? device : 'passkey');
  const added = store.mutate((st) => {
    if (st.credentials.some((x) => x.id === credential.id)) return false;
    st.credentials.push({ ...credential, createdAt: new Date().toISOString(), label, addedFrom: device });
    return true;
  });
  if (!added) return refuse(c, 'exists');
  log('auth', 'passkey added (settings)', { label, device, ...who(c) });
  alertNewPasskey(label, device, me);
  return c.json(describe(c));
});

signinSettingsRoutes.put('/auth/passkeys/:id', small, async (c) => {
  const id = c.req.param('id');
  const body = await jsonBody(c);
  const label = passkeyLabel(body?.label);
  if (!PASSKEY_ID.test(id) || !label) return bad(c);
  if (needsStepUp(c)) return refuse(c, 'step_up', 403);
  const found = store.mutate((st) => {
    const k = st.credentials.find((x) => x.id === id);
    if (k) k.label = label;
    return !!k;
  });
  if (!found) return refuse(c, 'not_found', 404);
  log('auth', 'passkey renamed', { passkey: id.slice(0, 12), ...who(c) });
  return c.json(describe(c));
});

signinSettingsRoutes.delete('/auth/passkeys/:id', (c) => {
  const id = c.req.param('id');
  if (!PASSKEY_ID.test(id)) return bad(c);
  if (needsStepUp(c)) return refuse(c, 'step_up', 403);
  // Checked again inside the write: two removals at once cannot take the last two.
  const guard = store.mutate((st) => {
    const g = canRemovePasskey(st, id, oidcReady(st, oidcConfig()));
    if (!g) st.credentials = st.credentials.filter((x) => x.id !== id);
    return g;
  });
  if (guard) return refuse(c, guard, guard === 'not_found' ? 404 : 400);
  log('auth', 'passkey removed', { passkey: id.slice(0, 12), ...who(c) });
  return c.json(describe(c));
});

// ── The OIDC provider ──

// The identity linked with an enrollment code no longer signs in (the sessions it opened stay: sign them out below).
// Refused when nothing would be left to sign in with (no passkey, no KLATCHLY_OIDC_ALLOWED_SUB).
signinSettingsRoutes.delete('/auth/oidc', (c) => {
  if (needsStepUp(c)) return refuse(c, 'step_up', 403);
  const cfg = oidcConfig();
  const r = store.mutate((st) => {
    const g = canUnlinkOidc(st, cfg);
    if (g) return { g };
    const before = st.auth?.oidc;
    st.auth = { mode: 'passkey' };
    return { g: null, before };
  });
  if (r.g) return refuse(c, r.g, r.g === 'not_found' ? 404 : 400);
  log('auth', 'oidc account unlinked', { sub: r.before?.sub.slice(0, 255) ?? '-', ...who(c) });
  return c.json(describe(c));
});

// ── Connected devices (sessions) ──

// One device signed out (not this one: that is Sign out). Its sockets close now, its notifications stop, its
// known-device cookie is void.
signinSettingsRoutes.delete('/auth/sessions/:id', (c) => {
  const id = c.req.param('id');
  if (!SESSION_ID.test(id)) return bad(c);
  if (needsStepUp(c)) return refuse(c, 'step_up', 403);
  const me = c.get('session')!;
  if (sessionId(me) === id) return refuse(c, 'current');
  const gone = store.mutate((st) => {
    const match = st.sessions.filter((s) => sessionId(s.hash) === id);
    if (match.length !== 1) return [];
    // Its known-device cookie no longer spares it anything (audit H2; never this browser's own).
    const mine = st.sessions.find((s) => s.hash === me)?.kd;
    if (match[0]!.kd !== mine) voidKnownDevice(st, match[0]!.kd);
    return dropSessions(st, (h) => h === match[0]!.hash);
  });
  if (!gone.length) return refuse(c, 'not_found', 404);
  for (const s of gone) closeSocketsForSession(s);
  log('auth', 'device signed out', { device: id.slice(0, 12), ...who(c) });
  return c.json(describe(c));
});

// Every other device signed out; the known-device cookies are void too (device.ts), this browser gets a new one.
signinSettingsRoutes.post('/auth/sessions/revoke-others', (c) => {
  if (needsStepUp(c)) return refuse(c, 'step_up', 403);
  const me = c.get('session')!;
  const gone = store.mutate((st) => {
    forgetDevices(st);
    return dropSessions(st, (h) => h !== me);
  });
  for (const s of gone) closeSocketsForSession(s);
  markKnownDevice(c);
  log('auth', 'other devices signed out', { n: gone.length, ...who(c) });
  return c.json(describe(c));
});
