/** Fixed-window in-memory limiter, keyed per client IP plus one global bucket. */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly perKey: number,
    private readonly global: number,
  ) {}

  private bump(key: string, limit: number, now: number): boolean {
    let e = this.hits.get(key);
    if (!e || e.reset <= now) {
      e = { n: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.n++;
    return e.n <= limit;
  }

  allow(ip: string, now = Date.now()): boolean {
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }
    // The address's own bucket first: the global one counts only requests still under it, so one address that
    // keeps asking (and is refused) cannot fill the global bucket and lock everyone else out.
    if (!this.bump(`ip:${ip}`, this.perKey, now)) return false;
    return this.bump('\0global', this.global, now);
  }
}
