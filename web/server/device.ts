import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { COOKIE, store, type Env } from './context.js';
import type { State } from './store.js';
import { KNOWN_DEVICE_MAX_AGE_S, voidKnownDevice } from './sessions.js';

// "Known device": a browser that completed a sign-in gets a signed cookie (a random id and its HMAC under a key of
// the state file), long-lived and separate from the session. It never signs anyone in: it only spares that browser
// the account slowdown and the strangers' rate-limit bucket of the sign-in (signin.ts, webauthn.ts), so that
// strangers cannot keep the owner out. Each id has its own lockout there (a stolen cookie is no free pass), and any
// change of how one signs in, or signing every device out, rotates the key: every such cookie is void (forgetDevices).
// Signing out, or being signed out from another device, voids that browser's id alone (audit H2): signing out also
// deletes the cookie (forgetKnownDevice); a device signed out from Settings or the CLI cannot be reached, so its id
// (recorded on its session at sign-in) goes on a list of void ids, kept as long as such a cookie lives
// (sessions.ts voidKnownDevice, shared with the CLI).

const NAME = 'kd';

/** The HMAC's domain string. */
export const DEVICE_DOMAIN = 'klatchly-known-device:';
/** The same before 0.26.1 (the app's former name), still verified so no browser loses its known status. */
export const LEGACY_DEVICE_DOMAIN = 'beep-known-device:';
const mac = (key: string, id: string, domain = DEVICE_DOMAIN) => createHmac('sha256', Buffer.from(key, 'base64url')).update(`${domain}${id}`).digest('base64url');
const sameMac = (want: string, got: string) => {
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
};
const cookieOptions = { prefix: COOKIE.prefix, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' } as const;

/** The id of this browser's valid known-device cookie, or null. */
export function knownDevice(c: Context): string | null {
  const v = getCookie(c, NAME, COOKIE.prefix);
  const state = store.read();
  const key = state.deviceKey;
  const m = v && /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(v);
  if (!m || !key) return null;
  if (!sameMac(mac(key, m[1]!), m[2]!) && !sameMac(mac(key, m[1]!, LEGACY_DEVICE_DOMAIN), m[2]!)) return null;
  return state.voidDevices?.some((d) => d.id === m[1]) ? null : m[1]!;
}

/** After a full sign-in: the cookie (kept when still valid), its id recorded on the session the request now has. */
export function markKnownDevice(c: Context<Env>): void {
  let id = knownDevice(c);
  if (!id) {
    let key = store.read().deviceKey;
    if (!key) key = store.mutate((st) => (st.deviceKey ??= randomBytes(32).toString('base64url')));
    id = randomBytes(16).toString('base64url');
    setCookie(c, NAME, `${id}.${mac(key, id)}`, { ...cookieOptions, maxAge: KNOWN_DEVICE_MAX_AGE_S });
  }
  const session = c.get('session');
  const kd = id;
  if (session)
    store.mutate((st) => {
      const s = st.sessions.find((x) => x.hash === session);
      if (s) s.kd = kd;
    });
}

/** Signing out (audit H2): this browser's known-device id is void and its cookie deleted. */
export function forgetKnownDevice(c: Context): void {
  const id = knownDevice(c);
  if (id) store.mutate((st) => voidKnownDevice(st, id));
  if (getCookie(c, NAME, COOKIE.prefix) !== undefined) deleteCookie(c, NAME, cookieOptions);
}

/** Voids every known-device cookie (in a mutate: the next sign-in makes a new key). */
export function forgetDevices(state: State): void {
  delete state.deviceKey;
  delete state.voidDevices;
}
