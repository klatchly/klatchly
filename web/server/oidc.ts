import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import * as client from 'openid-client';
import { oidcAllowed, oidcReady, oidcStepUp, storedOidc } from './auth.js';
import { config, type OidcConfig } from './config.js';
import { clientIp, COOKIE, store, type Env } from './context.js';
import { markKnownDevice } from './device.js';
import { messages } from './i18n.js';
import { log } from './log.js';
import { pushAll } from './push.js';
import { RateLimiter } from './ratelimit.js';
import { deviceSummary, findEnrollCode, liveSession, normalizeEnrollCode, sha256 } from './sessions.js';
import { isSettingsPath } from './settingspages.js';
import { stepUpState, type StepUpState } from './stepup.js';
import { codeOk, enrollAttempt, jsonBody, signInAllowed, startSession } from './webauthn.js';

// Sign-in through an OIDC provider (KLATCHLY_OIDC_*, config.ts), with openid-client (certified relying party): authorization
// code + PKCE (S256), `state`, `nonce`, discovery from the issuer, the ID token checked (signature against the
// provider's JWKS, iss, aud, exp, nonce). The provider only proves who it is: the session is Klatchly's own (the
// `__Host-sid` cookie, Strict, 30 days at most, revocable), and only the pinned identity (issuer + subject, auth.ts
// oidcAllowed) gets in — linked with an enrollment code (purpose 'link'), or KLATCHLY_OIDC_ALLOWED_SUB.
//
// Three purposes share the flow: 'login' (the sign-in page), 'link' (/enroll, with a code from cli.js enroll: pins the
// subject the provider answers with and opens a session), 'stepup' (a session confirms it is the owner with a fresh
// sign-in at the provider: prompt=login, max_age=0, and auth_time no older than the start of the flow).
//
// The cross-site return: the provider sends the browser back with a top-level navigation from its own site, so the
// Strict session cookie is not sent with it. The flow's secrets (PKCE verifier, nonce) stay here, in memory, keyed by
// `state`, single use, 10 minutes; the browser that started it is recognised by a short-lived `__Host-oidc` cookie in
// SameSite=Lax (sent on that navigation), whose hash the flow holds. The callback sets the session cookie on a small
// 200 page that then navigates to `/` (meta refresh: same-site, so the Strict cookie goes with it), never on a
// redirect of the same chain.

/** How long a flow may take at the provider (the flow state and the binding cookie). */
const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 100;
/** Clock difference tolerated between the provider and this server for the step-up's auth_time. */
const AUTH_TIME_SKEW_S = 60;
/** The provider's metadata are fetched again after this long (and after a failure, not before RETRY_MS). */
const METADATA_TTL_MS = 24 * 3600_000;
const RETRY_MS = 30_000;
const BIND_COOKIE = 'oidc';

type Purpose = { kind: 'login' } | { kind: 'link'; codeHash: string } | { kind: 'stepup'; session: string; returnTo: string };
type Flow = Purpose & { verifier: string; nonce: string; bind: string; started: number; expires: number };
const flows = new Map<string, Flow>();

/** The provider configured (KLATCHLY_OIDC_ISSUER…), or null. */
export const oidcConfig = (): OidcConfig | null => config().oidc;

// ── The provider (discovery) ──

let testFetch: client.CustomFetch | undefined;
let cached: { conf: client.Configuration; at: number } | undefined;
let inflight: Promise<client.Configuration> | undefined;
let failedAt = 0;

/** Tests: the provider's HTTP answered in process (no network); the discovery and the flows forgotten. */
export function resetOidc(fetchImpl?: client.CustomFetch): void {
  testFetch = fetchImpl;
  cached = undefined;
  inflight = undefined;
  failedAt = 0;
  flows.clear();
}

/** A client secret by HTTP Basic, unless the provider only takes it in the body; none for a public client (PKCE). */
function clientAuth(secret: string | undefined): client.ClientAuth {
  if (!secret) return client.None();
  const basic = client.ClientSecretBasic(secret);
  const post = client.ClientSecretPost(secret);
  return (as, meta, body, headers) => {
    const m = as.token_endpoint_auth_methods_supported;
    return (m && !m.includes('client_secret_basic') && m.includes('client_secret_post') ? post : basic)(as, meta, body, headers);
  };
}

async function provider(cfg: OidcConfig): Promise<client.Configuration> {
  if (cached && Date.now() - cached.at < METADATA_TTL_MS) return cached.conf;
  if (inflight) return inflight;
  if (Date.now() - failedAt < RETRY_MS) throw new Error('provider unreachable (recent failure)');
  inflight = client
    .discovery(cfg.issuer, cfg.clientId, undefined, clientAuth(cfg.clientSecret), {
      timeout: 10,
      ...(testFetch ? { [client.customFetch]: testFetch } : {}),
      // The ID token's signature is checked against the provider's JWKS too (openid-client trusts the TLS of the
      // token endpoint by default, as the spec allows): defence in depth.
      execute: [client.enableNonRepudiationChecks, ...(cfg.issuer.protocol === 'http:' ? [client.allowInsecureRequests] : [])],
    })
    .then(
      (conf) => {
        if (testFetch) conf[client.customFetch] = testFetch;
        cached = { conf, at: Date.now() };
        return conf;
      },
      (e: unknown) => {
        failedAt = Date.now();
        log('auth', 'oidc provider unreachable', { issuer: cfg.issuer.host, error: errorName(e) });
        throw e;
      },
    )
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** A library error's code (never its details: they may carry claims), for the log. */
function errorName(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return `${typeof code === 'string' ? code + ': ' : ''}${msg}`.replace(/\s+/g, ' ').slice(0, 140);
}

// ── Flows ──

/** This browser's binding to its flows: the Lax cookie (kept if it has one, set otherwise); its hash. */
function bindBrowser(c: Context): string {
  let v = getCookie(c, BIND_COOKIE, COOKIE.prefix);
  if (!v || !/^[A-Za-z0-9_-]{43}$/.test(v)) v = randomBytes(32).toString('base64url');
  setCookie(c, BIND_COOKIE, v, { prefix: COOKIE.prefix, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: FLOW_TTL_MS / 1000 });
  return sha256(v);
}

function sameBrowser(c: Context, flow: Flow): boolean {
  const v = getCookie(c, BIND_COOKIE, COOKIE.prefix);
  if (!v) return false;
  const a = Buffer.from(sha256(v), 'hex');
  const b = Buffer.from(flow.bind, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Starts a flow for `purpose`: the provider's authorization URL, where the client sends the browser. */
export async function startFlow(c: Context, purpose: Purpose): Promise<string> {
  const cfg = oidcConfig();
  if (!cfg) throw new Error('oidc not configured');
  const conf = await provider(cfg);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const now = Date.now();
  for (const [k, f] of flows) if (f.expires <= now) flows.delete(k);
  if (flows.size >= MAX_FLOWS) {
    const first = flows.keys().next();
    if (!first.done) flows.delete(first.value);
  }
  flows.set(state, { ...purpose, verifier, nonce, bind: bindBrowser(c), started: now, expires: now + FLOW_TTL_MS });
  const params: Record<string, string> = {
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  };
  // A confirmation is a fresh sign-in at the provider, not its single sign-on session.
  if (purpose.kind === 'stepup') Object.assign(params, { prompt: 'login', max_age: '0' });
  return client.buildAuthorizationUrl(conf, params).href;
}

/** Single use: the flow of `state` is gone whether or not the callback succeeds. */
function takeFlow(state: string | undefined): Flow | null {
  if (!state || state.length > 200) return null;
  const f = flows.get(state);
  flows.delete(state);
  return f && f.expires > Date.now() ? f : null;
}

// ── The page the provider sends the browser back to ──

type Failure = keyof ReturnType<typeof messages>['auth']['oidcError'];

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const pageLang = (c: Context) => (/^\s*fr\b/i.test(c.req.header('accept-language') ?? '') ? 'fr' : 'en');

/**
 * A small same-origin page: on success it navigates to `go` (meta refresh, allowed by the CSP: a same-site
 * navigation, so the Strict session cookie set here is sent with it); on a failure it says why, with a link back.
 */
function page(c: Context, r: { go: string } | { error: Failure; back: string }): Response {
  const lang = pageLang(c);
  const t = messages(lang).auth;
  const head = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">`;
  const body =
    'go' in r
      ? `${head}<meta http-equiv="refresh" content="0;url=${esc(r.go)}"><title>•</title></head><body><p><a href="${esc(r.go)}">→</a></p></body></html>`
      : `${head}<title>${esc(t.oidcTitle)}</title></head><body><main><h1>${esc(t.oidcTitle)}</h1><p data-testid="oidc-error" data-error="${r.error}">${esc(t.oidcError[r.error])}</p><p><a href="${esc(r.back)}">${esc(t.oidcBack)}</a></p></main></body></html>`;
  return c.body(body, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

/** Where a step-up may come back to: the app's own pages only (no open redirect). */
export function safeReturn(v: unknown): string {
  return typeof v === 'string' && (v === '/' || isSettingsPath(v)) ? v : '/settings/general';
}

/** Every other device that has notifications on is told a provider account now signs in (as for a new passkey). */
function alertLinked(label: string, device: string, newSession: string): void {
  void pushAll((sub) => {
    if (sub.sessionHash === newSession) return null;
    const t = messages(sub.lang).push;
    return { title: t.oidcLinkedTitle, body: t.oidcLinkedBody(label, device), tag: 'oidc-linked', url: '/settings/general' };
  })
    .then((r) => log('auth', 'oidc account linked: devices alerted', { sent: r.sent, failed: r.failed }))
    .catch(() => {});
}

// Sign-in attempts with the provider share the passkeys' limits (signInAllowed: per address, per known device); the
// confirmations are limited per session.
const stepUpLimiter = new RateLimiter(5 * 60 * 1000, 20, 10_000);
const small = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

async function begin(c: Context, purpose: Purpose): Promise<Response> {
  try {
    return c.json({ url: await startFlow(c, purpose) });
  } catch {
    return c.json({ error: 'unavailable' }, 503);
  }
}

/** Before the session check (app.ts): the sign-in, the linking with an enrollment code, and the provider's return. */
export const oidcRoutes = new Hono<Env>();

oidcRoutes.post('/auth/oidc/start', async (c) => {
  if (!oidcConfig()) return c.json({ error: 'not_found' }, 404);
  if (!signInAllowed(c)) return c.json({ error: 'rate_limited' }, 429);
  return begin(c, { kind: 'login' });
});

// Linking (/enroll): the code is checked now (the enrollment lockout), and used up only when the provider answers.
oidcRoutes.post('/enroll/oidc', small, async (c) => {
  if (!oidcConfig()) return c.json({ error: 'not_found' }, 404);
  const stop = enrollAttempt(c);
  if (stop) return stop;
  const code = normalizeEnrollCode((await jsonBody(c))?.code);
  const codeHash = code && findEnrollCode(store.read(), code);
  if (!codeHash) {
    log('auth', 'enroll code rejected', { ip: clientIp(c), for: 'oidc' });
    return c.json({ error: 'invalid' }, 400);
  }
  codeOk(c);
  return begin(c, { kind: 'link', codeHash });
});

oidcRoutes.get('/auth/oidc/callback', async (c) => {
  const cfg = oidcConfig();
  if (!cfg) return c.json({ error: 'not_found' }, 404);
  const ip = clientIp(c);
  if (!signInAllowed(c)) return page(c, { error: 'rate_limited', back: '/' });
  const q = new URL(c.req.url).searchParams;
  const flow = takeFlow(q.get('state') ?? undefined);
  const back = flow?.kind === 'stepup' ? flow.returnTo : flow?.kind === 'link' ? '/enroll' : '/';
  const reject = (error: Failure, extra: Record<string, string> = {}) => {
    log('auth', 'oidc rejected', { reason: error, purpose: flow?.kind ?? '-', ip, ...extra });
    return page(c, { error, back });
  };
  if (!flow || !sameBrowser(c, flow)) return reject('expired');
  if (q.get('error')) return reject('denied', { error: q.get('error')!.slice(0, 40).replace(/[^\w.-]/g, '?') });

  let claims: client.IDToken;
  try {
    const conf = await provider(cfg);
    // The URL registered at the provider, with what it sent back (behind a proxy, c.req.url is the internal one).
    const current = new URL(cfg.redirectUri);
    current.search = new URL(c.req.url).search;
    const tokens = await client.authorizationCodeGrant(conf, current, {
      pkceCodeVerifier: flow.verifier,
      expectedState: q.get('state')!,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
      // A step-up needs auth_time (checked below against the start of the flow).
      ...(flow.kind === 'stepup' ? { maxAge: FLOW_TTL_MS / 1000 } : {}),
    });
    const got = tokens.claims();
    if (!got) throw new Error('no ID token');
    claims = got;
  } catch (e) {
    return reject(cached ? 'invalid' : 'unavailable', { error: errorName(e) });
  }
  const { iss, sub } = claims;
  // Not secret, and what the owner needs to pin it (KLATCHLY_OIDC_ALLOWED_SUB) when it was not linked.
  const who = { iss: (() => { try { return new URL(iss).host; } catch { return '?'; } })(), sub: String(sub).slice(0, 255) };
  const device = deviceSummary(c.req.header('user-agent'));

  if (flow.kind === 'link') {
    const linked = store.mutate((st) => {
      // The code may have been used meanwhile (a passkey enrolled with it): re-checked inside the write.
      if (!st.enrollCodes.some((x) => x.hash === flow.codeHash && x.expiresAt > Date.now())) return null;
      st.enrollCodes = st.enrollCodes.filter((x) => x.hash !== flow.codeHash);
      const before = storedOidc(st);
      st.auth = { ...(st.auth ?? { mode: 'passkey' }), oidc: { iss, sub, linkedAt: new Date().toISOString() } };
      return { before };
    });
    if (!linked) return reject('code', who);
    const hash = startSession(c, 'oidc');
    markKnownDevice(c);
    log('auth', 'oidc account linked', { ...who, ...(linked.before && linked.before.sub !== sub ? { replaced: linked.before.sub.slice(0, 255) } : {}), device, ip });
    alertLinked(cfg.label, device, hash);
    return page(c, { go: '/' });
  }

  const state = store.read();
  if (!oidcAllowed(state, cfg, iss, sub)) return reject('not_allowed', who);

  if (flow.kind === 'login') {
    startSession(c, 'oidc');
    markKnownDevice(c);
    log('auth', 'login ok (oidc)', { ...who, ip });
    return page(c, { go: '/' });
  }

  // Step-up: the session that asked (its cookie is not sent on this cross-site return; the flow names it and the
  // binding cookie says it is the same browser), still signed in, still allowed to confirm this way, and a sign-in at
  // the provider made after the flow started.
  const s = state.sessions.find((x) => x.hash === flow.session);
  if (!s || !liveSession(s)) return reject('session', who);
  if (!oidcStepUp(state, cfg, flow.session)) return reject('not_allowed', { ...who, why: 'step-up method' });
  const authTime = claims.auth_time;
  if (typeof authTime !== 'number' || authTime * 1000 < flow.started - AUTH_TIME_SKEW_S * 1000) return reject('stale', { ...who, auth_time: String(authTime ?? '-') });
  store.mutate((st) => {
    const cur = st.sessions.find((x) => x.hash === flow.session);
    if (cur) cur.authAt = Date.now();
  });
  log('auth', 'step-up ok (oidc)', { session: flow.session.slice(0, 12), ip });
  return page(c, { go: flow.returnTo });
});

// ── Behind the session check (app.ts) ──

/** The step-up state of this session, and whether the provider can confirm it (its label): GET /api/auth/stepup, Settings. */
export function stepUpInfo(c: Context<Env>): StepUpState & { oidc?: string } {
  const cfg = oidcConfig();
  const base = stepUpState(c);
  return cfg && oidcStepUp(store.read(), cfg, c.get('session')!) ? { ...base, oidc: cfg.label } : base;
}

/** Settings → Connexion: the provider, if configured, and the identity that signs in with it (never a token). */
export function oidcSettings(): { label: string; issuer: string; linked: { iss: string; sub: string; linkedAt: string } | null; pinnedSub: string | null; ready: boolean } | null {
  const cfg = oidcConfig();
  if (!cfg) return null;
  const st = store.read();
  return { label: cfg.label, issuer: cfg.issuer.href, linked: storedOidc(st), pinnedSub: cfg.allowedSub ?? null, ready: oidcReady(st, cfg) };
}

export const oidcSessionRoutes = new Hono<Env>();

// A confirmation at the provider: for this session, and only when it may confirm this way (auth.ts oidcStepUp).
oidcSessionRoutes.post('/auth/stepup/oidc', small, async (c) => {
  const me = c.get('session')!;
  if (!stepUpLimiter.allow(me)) return c.json({ error: 'rate_limited' }, 429);
  const cfg = oidcConfig();
  if (!cfg || !oidcStepUp(store.read(), cfg, me)) return c.json({ error: 'invalid' }, 400);
  const body = await jsonBody(c);
  return begin(c, { kind: 'stepup', session: me, returnTo: safeReturn(body?.returnTo) });
});
