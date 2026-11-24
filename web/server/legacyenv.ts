// The app was called beep before 0.26.0: its environment variables were BEEP_*. Imported first by the entry points
// (index.ts, cli.ts), before any module reads the environment: each BEEP_<name> the process still receives fills
// KLATCHLY_<name> when that one is unset or empty (compose passes its listed variables as empty strings). Said once on
// stderr, to rename them. It covers what reaches the process (docker run -e, an override's environment:); compose.yml
// itself interpolates only KLATCHLY_* from .env: rename the .env (docs/self-hosting.md, "Upgrading from beep").
const renamed: string[] = [];
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith('BEEP_') || !v) continue;
  const name = `KLATCHLY_${k.slice('BEEP_'.length)}`;
  if (process.env[name]) continue;
  process.env[name] = v;
  renamed.push(k);
}
if (renamed.length) process.stderr.write(`[env] renamed variables, still read under their former names: ${renamed.sort().join(', ')} (BEEP_* is now KLATCHLY_*)\n`);
