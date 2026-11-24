// When a failed query is tried again (appmain.tsx's QueryClient defaults). Pure (unit-tested in test/retry.test.ts):
// errors are read by their status (api.ts HttpError), no imports.

/** Statuses that say the server or its upstream is overloaded or down: retrying soon only adds to the pile. */
const BUSY = new Set([429, 502, 503, 504]);

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

/**
 * Whether to try a failed query again (`failures`: how many times it failed so far). Twice for a network hiccup;
 * never once the session is gone (a redirect: 302); once only, late (retryDelay), when the server or its upstream
 * says it is busy or down (429, 502, 503, 504): every tab retrying at once used to snowball a slow beeper-server.
 */
export function shouldRetry(failures: number, e: unknown): boolean {
  const s = statusOf(e);
  if (s === 302) return false;
  if (s !== undefined && BUSY.has(s)) return failures < 1;
  return failures < 2;
}

/** How long before trying again: the usual backoff, or 8 to 12 s for a busy server. `rand`: Math.random (tests). */
export function retryDelay(failures: number, e: unknown, rand: () => number = Math.random): number {
  const s = statusOf(e);
  if (s !== undefined && BUSY.has(s)) return 8_000 + rand() * 4_000;
  return Math.min(1000 * 2 ** failures, 30_000);
}
