import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_TTL_MS } from './sessions.js';
import { DEFAULT_TRUSTED_PROXIES, parseCidrs, parseHeaderName } from './proxies.js';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`missing env ${name}`);
  return v;
}

function loadConfig() {
  const origin = env('KLATCHLY_ORIGIN');
  const parsed = new URL(origin);
  if (parsed.origin !== origin) throw new Error('KLATCHLY_ORIGIN must be a bare origin (scheme://host[:port])');
  const rpID = env('KLATCHLY_RP_ID');
  if (parsed.hostname !== rpID && !parsed.hostname.endsWith(`.${rpID}`)) {
    throw new Error('KLATCHLY_RP_ID must be the origin host or a parent domain of it');
  }
  // Native HTTPS (optional): both files or neither. HTTP stays the default (behind a proxy that terminates TLS).
  const tlsCert = process.env.KLATCHLY_TLS_CERT || undefined;
  const tlsKey = process.env.KLATCHLY_TLS_KEY || undefined;
  if (!tlsCert !== !tlsKey) throw new Error('KLATCHLY_TLS_CERT and KLATCHLY_TLS_KEY go together');
  return {
    origin,
    rpID,
    // Every address the app answers on: KLATCHLY_ORIGIN first, then KLATCHLY_ALT_ORIGINS (a move to a new address, the old one
    // kept a while). Each passkey belongs to one of them: its RP ID is KLATCHLY_RP_ID for KLATCHLY_ORIGIN, the host otherwise.
    sites: [{ origin, rpID }, ...parseAltOrigins(process.env.KLATCHLY_ALT_ORIGINS, origin)],
    dataDir: env('KLATCHLY_DATA_DIR', '/data'),
    port: Number(env('PORT', '8080')),
    publicDir: env('KLATCHLY_PUBLIC_DIR', new URL('./public', import.meta.url).pathname),
    sessionTtlMs: SESSION_TTL_MS, // sliding; and SESSION_MAX_MS (30 days) after the sign-in, whatever the use
    maxSessions: 10,
    // Reverse proxies whose client-IP header is believed (proxies.ts): CIDR list, loopback by default.
    trustedProxies: parseCidrs(process.env.KLATCHLY_TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES),
    clientIpHeader: parseHeaderName(process.env.KLATCHLY_CLIENT_IP_HEADER),
    tls: tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : undefined,
    // Sign-in through an OIDC provider (oidc.ts), next to the passkeys: off unless KLATCHLY_OIDC_ISSUER is set.
    oidc: parseOidc(process.env, origin),
  };
}

/** KLATCHLY_ALT_ORIGINS: comma-separated bare origins, each its own RP ID (its host). */
export function parseAltOrigins(raw: string | undefined, primary: string): { origin: string; rpID: string }[] {
  const out: { origin: string; rpID: string }[] = [];
  for (const item of (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(item);
    } catch {
      throw new Error(`KLATCHLY_ALT_ORIGINS: not an origin: ${item}`);
    }
    if (u.origin !== item) throw new Error(`KLATCHLY_ALT_ORIGINS: must be bare origins (scheme://host[:port]): ${item}`);
    // https only (a passkey checked against an http:// origin is open to anyone on the path), except a loopback test.
    if (u.protocol !== 'https:' && !LOOPBACK.has(u.hostname)) throw new Error(`KLATCHLY_ALT_ORIGINS: https only (or a loopback host): ${item}`);
    if (item === primary || out.some((x) => x.origin === item)) continue;
    out.push({ origin: item, rpID: u.hostname });
  }
  return out;
}

/** The path the OIDC provider sends the browser back to (registered at the provider as KLATCHLY_ORIGIN + this). */
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

export interface OidcConfig {
  /** The provider's issuer (discovery: <issuer>/.well-known/openid-configuration). */
  issuer: URL;
  clientId: string;
  /** Confidential client (from KLATCHLY_OIDC_CLIENT_SECRET_FILE), or a public one with PKCE only when absent. */
  clientSecret?: string;
  /** Space-separated, always with openid. */
  scopes: string;
  /** "Continue with <label>" on the sign-in page. */
  label: string;
  /** A subject pinned by the environment (KLATCHLY_OIDC_ALLOWED_SUB), next to the one linked with an enrollment code. */
  allowedSub?: string;
  redirectUri: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * KLATCHLY_OIDC_* (null when KLATCHLY_OIDC_ISSUER is unset: the instance is exactly as without it). A half-done setup stops
 * the start (a client id without an issuer, an unreadable secret file…), as any other bad setting. The issuer is
 * HTTPS; plain HTTP only on the loopback (tests).
 */
export function parseOidc(e: NodeJS.ProcessEnv, origin: string): OidcConfig | null {
  const issuerRaw = e.KLATCHLY_OIDC_ISSUER?.trim();
  if (!issuerRaw) {
    const stray = Object.keys(e).filter((k) => k.startsWith('KLATCHLY_OIDC_') && e[k]);
    if (stray.length) throw new Error(`${stray.join(', ')} set without KLATCHLY_OIDC_ISSUER`);
    return null;
  }
  let issuer: URL;
  try {
    issuer = new URL(issuerRaw);
  } catch {
    throw new Error('KLATCHLY_OIDC_ISSUER must be a URL');
  }
  if (issuer.search || issuer.hash || issuer.username || issuer.password) throw new Error('KLATCHLY_OIDC_ISSUER must be a bare URL (no query, fragment or credentials)');
  if (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && LOOPBACK.has(issuer.hostname))) throw new Error('KLATCHLY_OIDC_ISSUER must be https://');
  const clientId = e.KLATCHLY_OIDC_CLIENT_ID?.trim();
  if (!clientId) throw new Error('missing env KLATCHLY_OIDC_CLIENT_ID (with KLATCHLY_OIDC_ISSUER)');
  if (e.KLATCHLY_OIDC_CLIENT_SECRET) throw new Error('KLATCHLY_OIDC_CLIENT_SECRET: give the secret in a file, KLATCHLY_OIDC_CLIENT_SECRET_FILE');
  let clientSecret: string | undefined;
  if (e.KLATCHLY_OIDC_CLIENT_SECRET_FILE) {
    try {
      clientSecret = readFileSync(e.KLATCHLY_OIDC_CLIENT_SECRET_FILE, 'utf8').trim();
    } catch {
      throw new Error('KLATCHLY_OIDC_CLIENT_SECRET_FILE cannot be read');
    }
    if (!clientSecret) throw new Error('KLATCHLY_OIDC_CLIENT_SECRET_FILE is empty');
  }
  const scopes = new Set((e.KLATCHLY_OIDC_SCOPES ?? 'openid').split(/[\s,]+/).filter(Boolean));
  if ([...scopes].some((s) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s))) throw new Error('KLATCHLY_OIDC_SCOPES: bad scope');
  scopes.add('openid');
  const label = (e.KLATCHLY_OIDC_LABEL ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 40) || issuer.hostname;
  const allowedSub = e.KLATCHLY_OIDC_ALLOWED_SUB?.trim() || undefined;
  if (allowedSub && allowedSub.length > 255) throw new Error('KLATCHLY_OIDC_ALLOWED_SUB is too long');
  return { issuer, clientId, clientSecret, scopes: ['openid', ...[...scopes].filter((s) => s !== 'openid')].join(' '), label, allowedSub, redirectUri: origin + OIDC_CALLBACK_PATH };
}

export type Config = ReturnType<typeof loadConfig>;

let cached: Config | undefined;
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** A JSON file of the data volume (KLATCHLY_DATA_DIR), e.g. 'assist.json': a plain name, never a path. */
export function dataPath(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/.test(name) || name.includes('..')) throw new Error(`bad data file name ${JSON.stringify(name)}`);
  return join(config().dataDir, name);
}

/** The site (origin and RP ID) a request's Origin header names, if it is one of ours. */
export function siteOf(originHeader: string | undefined): { origin: string; rpID: string } | undefined {
  return originHeader === undefined ? undefined : config().sites.find((s) => s.origin === originHeader);
}
