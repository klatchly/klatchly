// Where the app goes once signed in (App.tsx): the page the sign-in showed over, with its query (a link shared into
// /share?url=…, a chat opened from a notification), so that signing in does not lose it. An allow-list, never a
// deny-list: a chat (/chat/<id>, its media, files or links), a Settings page, or a page of a space of this build;
// anything else (enrolment, an unknown or odd path, an encoded trick) goes home. Only a path of this origin: the
// address bar's own pathname and search, or that same value kept in this tab's sessionStorage across an OIDC sign-in
// (the provider's round trip always lands on /: the return path, and a shared text in it, stays on the device).
// Pure functions, no browser, no import (the tests compile this file alone): test/signinreturn.test.ts.

/** The longest return kept (path and query): room for a shared text (the share page takes 3 × 8000 characters). */
export const RETURN_MAX = 32 * 1024;
/** The sessionStorage key of the return kept across an OIDC sign-in. */
export const RETURN_KEY = 'klatchly.signin.return';
/** A kept return older than this is dropped (an abandoned sign-in, a tab reopened later). */
export const RETURN_TTL_MS = 10 * 60 * 1000;

const CHAT = /^\/chat\/([^/\\]+)(\/(media|files|links))?$/;
/** A query as the address bar gives it: '?' then printable ASCII (browsers percent-encode the rest), no fragment. */
const SEARCH = /^\?[\x21-\x22\x24-\x7e]+$/;

/** A chat id segment, percent-decoded once: as the server's validId takes it (no space, no control character). */
function chatSegment(seg: string): boolean {
  let id: string;
  try {
    id = decodeURIComponent(seg);
  } catch {
    return false;
  }
  return !!id && id.length <= 512 && !/[\u0000-\u001f\u007f\s]/.test(id);
}

/**
 * The path to go to once signed in, '/' when there is none to keep. `isPage`: whether a path is a Settings page
 * (server/settingspages.ts isSettingsPath) or a page of a space of this build (client/src/registry.ts spaceAt), as
 * App.tsx says; a space's segment never holds '%', '.' or '/' (the core checks the patterns).
 */
export function afterSignIn(pathname: string, search: string, isPage: (path: string) => boolean = () => false): string {
  if (typeof pathname !== 'string' || typeof search !== 'string' || pathname.length + search.length > RETURN_MAX) return '/';
  // A trailing slash is not part of any page: /settings/general/ is /settings/general, /enroll/ is /enroll (home).
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000- \u007f]/.test(path)) return '/';
  const chat = CHAT.exec(path);
  const ok = chat ? chatSegment(chat[1]!) : !path.includes('%') && isPage(path);
  if (!ok) return '/';
  return path + (SEARCH.test(search) ? search : '');
}

/** What is kept in sessionStorage across an OIDC sign-in. */
export interface KeptReturn {
  to: string;
  at: number;
}

/** The value to keep before leaving for the provider ('' for home: nothing to keep). */
export function keepReturn(to: string, now = Date.now()): string {
  return to && to !== '/' ? JSON.stringify({ to, at: now } satisfies KeptReturn) : '';
}

/**
 * The return a kept value names, checked again as afterSignIn checks the address bar (a value in storage is not
 * trusted more than the URL), or null: unreadable, home, or older than RETURN_TTL_MS (or from the future).
 */
export function keptReturn(raw: string | null | undefined, isPage: (path: string) => boolean = () => false, now = Date.now()): string | null {
  if (!raw || raw.length > RETURN_MAX + 100) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const k = v as Partial<KeptReturn>;
  if (!k || typeof k !== 'object' || typeof k.to !== 'string' || typeof k.at !== 'number' || !Number.isFinite(k.at)) return null;
  if (k.at > now + 60_000 || now - k.at > RETURN_TTL_MS) return null;
  const q = k.to.indexOf('?');
  const to = afterSignIn(q < 0 ? k.to : k.to.slice(0, q), q < 0 ? '' : k.to.slice(q), isPage);
  return to === '/' ? null : to;
}

/** The storage this needs (sessionStorage: per tab, per origin); every call may throw (private mode, quota). */
export type ReturnStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Keeps the return before an OIDC sign-in (nothing when home); a storage that fails keeps nothing. */
export function saveReturn(storage: ReturnStorage | undefined, to: string, now = Date.now()): void {
  try {
    const v = keepReturn(to, now);
    if (v) storage?.setItem(RETURN_KEY, v);
    else storage?.removeItem(RETURN_KEY);
  } catch {
    /* nothing kept: the sign-in ends at home */
  }
}

/** Reads the kept return once and deletes it (whatever it holds), checked again: the path to go to, or null. */
export function takeReturn(storage: ReturnStorage | undefined, isPage: (path: string) => boolean = () => false, now = Date.now()): string | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(RETURN_KEY) ?? null;
    if (raw !== null) storage?.removeItem(RETURN_KEY);
  } catch {
    return null;
  }
  return keptReturn(raw, isPage, now);
}
