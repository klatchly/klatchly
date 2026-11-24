import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from './config.js';
import { Store } from './store.js';
import { Sessions } from './sessions.js';
import { clientAddress, isTrusted } from './proxies.js';
import { log } from './log.js';

export type Env = { Variables: { session?: string } };

export const store = new Store(config().dataDir);
export const sessions = new Sessions(store, config().sessionTtlMs, config().maxSessions);

// "__Host-sid" (Secure, Path=/, no Domain). Chromium refuses __Host- cookies over plain http, even on
// localhost, so a non-https origin (local tests only) uses a plain Secure "sid" cookie instead.
export const COOKIE = {
  name: 'sid',
  prefix: config().origin.startsWith('https://') ? ('host' as const) : undefined,
};

/** `expiresAt`: when the session ends (sessions.ts sessionExpiry); a new session by default. */
export function setSessionCookie(c: Context, id: string, expiresAt = Date.now() + config().sessionTtlMs): void {
  setCookie(c, COOKIE.name, id, {
    prefix: COOKIE.prefix,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE.name, { prefix: COOKIE.prefix, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' });
}

/**
 * The key of a client address for rate limits and lockouts: an IPv4 address as is (also when IPv4-mapped), an IPv6
 * address by its /64, the block one subscriber gets (rotating within it must not give fresh tries).
 */
export function netKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('%')[0]!.split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = [...h, ...new Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function peerOf(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // an in-process request (tests): no socket
  }
}

let warned = false;

/**
 * The client's address, for log lines, rate limits and lockouts (proxies.ts): the socket's peer, or, when that peer
 * is a trusted proxy (KLATCHLY_TRUSTED_PROXIES), what its client-IP header (KLATCHLY_CLIENT_IP_HEADER) says. Never used to
 * grant anything else.
 */
export function clientIp(c: Context): string {
  const cfg = config();
  const peer = peerOf(c);
  const header = c.req.header(cfg.clientIpHeader);
  if (header && peer && !warned && !isTrusted(peer, cfg.trustedProxies)) {
    // Once per process: a proxy in front that is not declared (every client would share its address).
    warned = true;
    log('server', 'client-IP header ignored: the peer is not a trusted proxy (KLATCHLY_TRUSTED_PROXIES)', { peer, header: cfg.clientIpHeader });
  }
  return clientAddress(peer, header, cfg.trustedProxies);
}
