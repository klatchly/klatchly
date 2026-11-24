import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SignInMethod, State, Store, StoredSession } from './store.js';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** Sliding expiry: a session unused this long is gone. */
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** Absolute expiry (audit M3): however much it is used, a session ends this long after its sign-in. */
export const SESSION_MAX_MS = 30 * 24 * 3600 * 1000;

/**
 * The shared session of the removed sign-in mode "none" (before passkeys only): a fixed hash no cookie can produce.
 * Only for the start-up clean-up of an old state file (auth.ts migrateAuth): it never validates. Its input keeps the
 * app's former name on purpose (compatibility): old state files hold exactly this hash.
 */
export const LEGACY_OPEN_SESSION = sha256('beep:sign-in-off');

/** When a session ends: unused for SESSION_TTL_MS, or SESSION_MAX_MS after its sign-in, whichever comes first. */
export const sessionExpiry = (s: StoredSession, ttlMs = SESSION_TTL_MS, maxMs = SESSION_MAX_MS): number => Math.min(s.lastSeen + ttlMs, s.createdAt + maxMs);

export const liveSession = (s: StoredSession, now = Date.now(), ttlMs = SESSION_TTL_MS, maxMs = SESSION_MAX_MS): boolean =>
  s.hash !== LEGACY_OPEN_SESSION && sessionExpiry(s, ttlMs, maxMs) > now;

/** The known-device cookie's lifetime (device.ts): longer than a session's absolute end, it is for signing in again. */
export const KNOWN_DEVICE_MAX_AGE_S = 90 * 24 * 3600;
/** Void known-device ids kept at most (the oldest go first): one per device signed out, each for the cookie's lifetime. */
const MAX_VOID_DEVICES = 500;

/**
 * Voids one known-device id (device.ts; in a mutate): that browser's cookie no longer spares it anything. For a
 * device signed out from elsewhere (Settings, the CLI), whose cookie cannot be deleted.
 */
export function voidKnownDevice(state: State, id: string | undefined, now = Date.now()): void {
  if (!id || !state.deviceKey) return;
  const list = (state.voidDevices ?? []).filter((d) => d.until > now && d.id !== id);
  list.push({ id, until: now + KNOWN_DEVICE_MAX_AGE_S * 1000 });
  state.voidDevices = list.slice(-MAX_VOID_DEVICES);
}

/** Push subscriptions live and die with the session that created them. */
export function prunePush(state: State): void {
  if (!state.push) return;
  const live = new Set(state.sessions.map((s) => s.hash));
  state.push = state.push.filter((p) => live.has(p.sessionHash));
}

/**
 * A short, non-identifying summary of a User-Agent for the list of connected devices: browser and system
 * ("Firefox · Linux"), or what is known of them. Never the raw string.
 */
export function deviceSummary(ua: string | undefined): string {
  const u = ua ?? '';
  const os = /iPad/.test(u)
    ? 'iPadOS'
    : /iPhone|iPod/.test(u)
      ? 'iOS'
      : /Android/.test(u)
        ? 'Android'
        : /CrOS/.test(u)
          ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(u)
            ? 'macOS'
            : /Windows/.test(u)
              ? 'Windows'
              : /Linux/.test(u)
                ? 'Linux'
                : '';
  const browser = /Edg(e|A|iOS)?\//.test(u)
    ? 'Edge'
    : /OPR\/|Opera/.test(u)
      ? 'Opera'
      : /SamsungBrowser\//.test(u)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(u)
          ? 'Firefox'
          : /Chrome\/|CriOS\/|Chromium\//.test(u)
            ? 'Chrome'
            : /Safari\//.test(u)
              ? 'Safari'
              : '';
  return [browser, os].filter(Boolean).join(' · ') || '?';
}

function prune(state: State, ttlMs: number, maxMs: number, now: number): void {
  state.sessions = state.sessions.filter((s) => liveSession(s, now, ttlMs, maxMs));
  state.enrollCodes = state.enrollCodes.filter((c) => c.expiresAt > now);
  prunePush(state);
}

export interface ValidSession {
  hash: string;
  /** The expiry moved (persisted): send the cookie again with `expiresAt`. */
  renewed: boolean;
  expiresAt: number;
}

export class Sessions {
  constructor(
    private readonly store: Store,
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly maxMs = SESSION_MAX_MS,
  ) {}

  /** Creates a session (after a full sign-in) and returns the raw id (only ever sent to the browser). */
  create(state: State, now = Date.now(), device?: string, method?: SignInMethod): string {
    prune(state, this.ttlMs, this.maxMs, now);
    const id = randomBytes(32).toString('base64url');
    state.sessions.push({ hash: sha256(id), createdAt: now, lastSeen: now, authAt: now, ...(device ? { device } : {}), ...(method ? { method } : {}) });
    if (state.sessions.length > this.max) {
      state.sessions.sort((a, b) => b.lastSeen - a.lastSeen);
      state.sessions.length = this.max;
    }
    return id;
  }

  /** Returns the session if valid; slides the expiry (persisted at most every 5 min), never past the absolute one. */
  validate(id: string | undefined, now = Date.now()): ValidSession | null {
    if (!id || id.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const hash = sha256(id);
    return this.validateHash(hash, now);
  }

  validateHash(hash: string, now = Date.now()): ValidSession | null {
    const s = this.store.read().sessions.find((x) => x.hash === hash);
    if (!s || !liveSession(s, now, this.ttlMs, this.maxMs)) return null;
    if (now - s.lastSeen < TOUCH_INTERVAL_MS) return { hash, renewed: false, expiresAt: sessionExpiry(s, this.ttlMs, this.maxMs) };
    const touched = this.store.mutate((st) => {
      const cur = st.sessions.find((x) => x.hash === hash);
      if (cur) cur.lastSeen = now;
      prune(st, this.ttlMs, this.maxMs, now);
      return cur;
    });
    // Revoked meanwhile (the CLI, another device): gone.
    if (!touched || !liveSession(touched, now, this.ttlMs, this.maxMs)) return null;
    return { hash, renewed: true, expiresAt: sessionExpiry(touched, this.ttlMs, this.maxMs) };
  }

  revoke(hash: string): void {
    this.store.mutate((st) => {
      st.sessions = st.sessions.filter((x) => x.hash !== hash);
      prunePush(st);
    });
  }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 20 base32 characters = 100 bits. */
export function newEnrollCode(): string {
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += B32[b & 31];
  return out;
}

export function normalizeEnrollCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const c = input.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-7]{20}$/.test(c) ? c : null;
}

/** Constant-time lookup of an unexpired enrollment code; returns its hash. */
export function findEnrollCode(state: State, code: string, now = Date.now()): string | null {
  const h = Buffer.from(sha256(code), 'hex');
  let found: string | null = null;
  for (const c of state.enrollCodes) {
    const ok = timingSafeEqual(h, Buffer.from(c.hash, 'hex'));
    if (ok && c.expiresAt > now) found = c.hash;
  }
  return found;
}

export function addEnrollCode(state: State, code: string, ttlMs: number, now = Date.now()): void {
  state.enrollCodes = state.enrollCodes.filter((c) => c.expiresAt > now);
  state.enrollCodes.push({ hash: sha256(code), expiresAt: now + ttlMs });
}
