import { readFileSync } from 'node:fs';
import BeeperDesktop, { APIError } from '@beeper/desktop-api';
import type { Failure } from '#core/sdk.js';

// The Desktop API (beeper-server): where it is (KLATCHLY_UPSTREAM, never published) and its token (KLATCHLY_TOKEN_FILE, a
// secret file). The token is the account's: it goes in the Authorization header of calls made here, never
// anywhere else (no response, log or browser frame carries it).

const DEFAULT_UPSTREAM = 'http://beeper-server:23373';
const DEFAULT_TOKEN_FILE = '/run/secrets/beeper_token';

let base: string | undefined;
/** Base URL of the Desktop API, without a trailing slash. */
export const upstreamUrl = (): string => (base ??= (process.env.KLATCHLY_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, ''));
/** Its WebSocket (live events). */
export const upstreamWs = (): string => upstreamUrl().replace(/^http/, 'ws') + '/v1/ws';

let token: string | undefined;
export function upstreamToken(): string {
  if (token === undefined) {
    const t = readFileSync(process.env.KLATCHLY_TOKEN_FILE || DEFAULT_TOKEN_FILE, 'utf8').trim();
    if (!t) throw new Error('empty upstream token file');
    token = t;
  }
  return token;
}

/** Why the connector cannot run (the package's check): the token file is missing or empty. */
export function tokenProblem(): string | null {
  try {
    upstreamToken();
    return null;
  } catch {
    return 'token file missing or empty (KLATCHLY_TOKEN_FILE)';
  }
}

let client: BeeperDesktop | undefined;

/** Typed JSON client for beeper-server. No retries: a retried POST could send a message twice. */
export function api(): BeeperDesktop {
  client ??= new BeeperDesktop({
    baseURL: upstreamUrl(),
    accessToken: upstreamToken(),
    maxRetries: 0,
    timeout: 30_000,
    logLevel: 'off',
  });
  return client;
}

/** Maps upstream errors to a status safe to return (never 401/403 to the browser). */
export function upstreamStatus(e: unknown): 400 | 404 | 409 | 422 | 429 | 502 | 504 {
  if (e instanceof APIError && typeof e.status === 'number') {
    if ([400, 404, 409, 422, 429].includes(e.status)) return e.status as 400 | 404 | 409 | 422 | 429;
    return 502;
  }
  if (e instanceof Error && e.name === 'APIConnectionTimeoutError') return 504;
  return 502;
}

/**
 * The connector's `failure`: an upstream error's status, plus the API's machine-readable code when it has one
 * (never its message). Undefined for errors that are not the Desktop API client's (the core answers 502).
 */
export function upstreamFailure(e: unknown): Failure | undefined {
  if (!(e instanceof APIError) && !(e instanceof Error && e.name === 'APIConnectionTimeoutError')) return undefined;
  const raw = e instanceof APIError && e.error && typeof e.error === 'object' ? (e.error as { code?: unknown }).code : undefined;
  const code = typeof raw === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : undefined;
  return { status: upstreamStatus(e), ...(code ? { code } : {}) };
}
