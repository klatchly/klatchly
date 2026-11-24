/** Minimal structured logging. Never pass tokens, cookies, message text or media URLs here. */
export function log(scope: string, msg: string, extra?: Record<string, string | number | boolean>): void {
  const parts = [new Date().toISOString(), scope, msg];
  if (extra) for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`);
  process.stdout.write(parts.join(' ') + '\n');
}
