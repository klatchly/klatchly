/**
 * Progressive lockout after failed attempts (the enrollment code, per address: webauthn.ts), in memory, per key: the first `free` failures in a row cost nothing, each one after locks the key for
 * `baseMs`, doubled every time, up to `maxMs`. Callers count an attempt as a failure when it starts (fail, before any
 * await: parallel requests cannot all pass the check) and clear the key when it succeeds. Failures are forgotten
 * after a day without one; a restart clears everything.
 */
export class Lockout {
  private readonly keys = new Map<string, { fails: number; until: number; last: number }>();

  constructor(
    private readonly free: number,
    private readonly baseMs: number,
    private readonly maxMs: number,
  ) {}

  /** Milliseconds the key is still locked for (0: free to try). */
  remaining(key: string, now = Date.now()): number {
    const e = this.keys.get(key);
    if (!e) return 0;
    if (now - e.last > 24 * 3600_000) {
      this.keys.delete(key);
      return 0;
    }
    return Math.max(0, e.until - now);
  }

  fail(key: string, now = Date.now()): void {
    if (this.keys.size > 10_000) {
      for (const [k, v] of this.keys) if (now - v.last > 3600_000 && v.until <= now) this.keys.delete(k);
    }
    const e = this.keys.get(key) ?? { fails: 0, until: 0, last: now };
    if (now - e.last > 24 * 3600_000) e.fails = 0;
    e.fails++;
    e.last = now;
    const over = e.fails - this.free;
    if (over > 0) e.until = now + Math.min(this.maxMs, this.baseMs * 2 ** Math.min(over - 1, 30));
    this.keys.set(key, e);
  }

  succeed(key: string): void {
    this.keys.delete(key);
  }
}
