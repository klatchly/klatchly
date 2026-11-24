import type { OidcConfig } from './config.js';
import { LEGACY_OPEN_SESSION } from './sessions.js';
import type { State, StoredOidc } from './store.js';

// How the owner signs in: passkeys (WebAuthn), and, when the server is configured for one (KLATCHLY_OIDC_*, oidc.ts), an
// OIDC provider that decides how people authenticate there (passkey, password + TOTP, social login…). Only the pinned
// identity (issuer + subject: linked with an enrollment code, or KLATCHLY_OIDC_ALLOWED_SUB) gets in, never by e-mail.
// Both can be kept: the passkeys stay a fallback when the provider is down. The built-in username + password + TOTP
// and the mode "none" were removed; a state file that still says so falls back to passkeys at start (migrateAuth),
// and the enrollment code of the CLI (cli.js enroll, then /enroll) always adds a passkey or links an OIDC identity,
// whatever the state says: the owner cannot be locked out.

export type AuthMode = 'passkey';
/** How long a sign-in or a step-up allows sensitive changes (passkeys, devices, extensions, provider keys). */
export const STEP_UP_MS = 5 * 60 * 1000;

/**
 * What the state's auth block holds that no longer exists: the removed mode ("password", "none") or, in mode
 * "passkey", the leftovers of a password or TOTP set up once (hash, secret, recovery codes). Null when clean.
 */
export function legacyAuth(state: State): string | null {
  const a = state.auth as Record<string, unknown> | undefined;
  const open = state.sessions.some((s) => s.hash === LEGACY_OPEN_SESSION);
  if (!a || typeof a !== 'object') return open ? 'none' : null;
  if (a.mode !== 'passkey' && a.mode !== undefined) return String(a.mode).slice(0, 20);
  if (Object.keys(a).some((k) => k !== 'mode' && k !== 'oidc')) return 'passkey (with password or TOTP data)';
  return open ? 'none' : null;
}

/**
 * In a mutate, at start: the auth block back to passkeys only. The password hash, TOTP secret and recovery codes
 * are deleted (nothing reads them any more; they were as sensitive as the rest of the volume), and so is the shared
 * session of mode "none" with its push subscriptions. The other sessions stay: who is signed in stays signed in.
 */
export function migrateAuth(state: State): void {
  const oidc = storedOidc(state);
  state.auth = { mode: 'passkey', ...(oidc ? { oidc } : {}) };
  if (state.sessions.some((s) => s.hash === LEGACY_OPEN_SESSION)) {
    state.sessions = state.sessions.filter((s) => s.hash !== LEGACY_OPEN_SESSION);
    if (state.push) {
      const live = new Set(state.sessions.map((s) => s.hash));
      state.push = state.push.filter((p) => live.has(p.sessionHash));
    }
  }
}

/** The OIDC identity linked in the state, when well-formed. */
export function storedOidc(state: State): StoredOidc | null {
  const o = (state.auth as { oidc?: Partial<StoredOidc> } | undefined)?.oidc;
  return o && typeof o.iss === 'string' && typeof o.sub === 'string' && o.sub && typeof o.linkedAt === 'string' ? { iss: o.iss, sub: o.sub, linkedAt: o.linkedAt } : null;
}

/** Two issuer identifiers alike (as discovery compares them: "https://id.example" is "https://id.example/"). */
export function sameIssuer(a: string | URL, b: string | URL): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * Whether the identity a provider vouched for is the owner's: the configured issuer, and the subject linked with an
 * enrollment code or pinned by KLATCHLY_OIDC_ALLOWED_SUB. Never by e-mail (changeable, reassignable at most providers).
 */
export function oidcAllowed(state: State, oidc: OidcConfig | null | undefined, iss: string, sub: string): boolean {
  if (!oidc || !sub || !sameIssuer(iss, oidc.issuer)) return false;
  if (oidc.allowedSub && sub === oidc.allowedSub) return true;
  const linked = storedOidc(state);
  return !!linked && sameIssuer(linked.iss, iss) && linked.sub === sub;
}

/** Whether the owner can sign in with the provider: configured, and an identity of its issuer pinned. */
export function oidcReady(state: State, oidc: OidcConfig | null | undefined): boolean {
  if (!oidc) return false;
  const linked = storedOidc(state);
  return !!oidc.allowedSub || (!!linked && sameIssuer(linked.iss, oidc.issuer));
}

/** What the sign-in page offers (GET /api/session): the passkey button (unless only the provider can sign in), the provider's. */
export function loginMethods(state: State, oidc?: OidcConfig | null): { passkey: boolean; oidc?: { label: string } } {
  return { passkey: state.credentials.length > 0 || !oidc, ...(oidc ? { oidc: { label: oidc.label } } : {}) };
}

/**
 * How a step-up is done. Only 'passkey' is offered now; the two password forms of the removed built-in password
 * sign-in stay in the type, which the packages' API exports (extension API 1.x), and are never returned.
 */
export type StepUpMethod = 'passkey' | 'password' | 'password+code';

/** What can confirm it is the owner before a sensitive change: a passkey (none left: nothing, add one with the CLI). */
export function stepUpMethods(state: State): StepUpMethod[] {
  return state.credentials.length ? ['passkey'] : [];
}

/**
 * Whether this session may confirm with a fresh sign-in at the provider (oidc.ts: prompt=login, max_age=0, auth_time
 * checked): when the session was opened by the provider, or when the owner has no passkey. Never weaker than how the
 * session was opened: a passkey session confirms with a passkey.
 */
export function oidcStepUp(state: State, oidc: OidcConfig | null | undefined, session: string): boolean {
  if (!oidcReady(state, oidc)) return false;
  const s = state.sessions.find((x) => x.hash === session);
  return !!s && (s.method === 'oidc' || !state.credentials.length);
}

/** Milliseconds left for sensitive changes from this session: since its sign-in or its last step-up. */
export function stepUpLeft(state: State, session: string, now = Date.now()): number {
  const s = state.sessions.find((x) => x.hash === session);
  return s?.authAt ? Math.max(0, s.authAt + STEP_UP_MS - now) : 0;
}

export type GuardError = 'last_passkey' | 'last_method' | 'not_found';

/**
 * Removing passkey `id` must leave a way to sign in: another passkey, or the provider (`oidcReady`). Otherwise the
 * last one goes only with the CLI's --force (enroll another first).
 */
export function canRemovePasskey(state: State, id: string, oidcReady = false): GuardError | null {
  if (!state.credentials.some((c) => c.id === id)) return 'not_found';
  return state.credentials.length > 1 || oidcReady ? null : 'last_passkey';
}

/** Unlinking the OIDC identity must leave a way to sign in: a passkey, or the subject pinned by KLATCHLY_OIDC_ALLOWED_SUB. */
export function canUnlinkOidc(state: State, oidc: OidcConfig | null | undefined): GuardError | null {
  if (!storedOidc(state)) return 'not_found';
  return state.credentials.length || oidc?.allowedSub ? null : 'last_method';
}

export const MAX_LABEL = 60;

/** A passkey's name: control, line-separator and direction-override characters dropped, trimmed, at most MAX_LABEL characters; null when nothing is left. */
export function passkeyLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = [...v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '').trim()].slice(0, MAX_LABEL).join('').trim();
  return s || null;
}
