// Runs E2E scripts against offline instances (server.mjs), several at a time: one instance per worker, each script
// on the next free worker with its own enrollment code, its output in /shots/<name>.log. A script that changes the
// instance it runs on for everyone signed in there (extensions.e2e.js turns packages off and on…) says so on one of
// its first lines, `// e2e-instance: alone [NAME=value…]` (the variables for that instance's server.mjs and its
// fakes): it gets an instance of its own. Prints one line per script with its time and result, then a summary;
// exits 1 when any script failed. Called by ../run-offline.sh inside the Playwright image:
//   node offline/run.mjs <jobs> [<script>…]   (paths relative to test/e2e)
// Without scripts: the core's (test/e2e/*.e2e.js) and those of each package of the build (ext/<id>/test/*.e2e.cjs,
// packages.mjs), the longest first by their last run's times ($SHOTS/.durations.json), else by size. With
// KLATCHLY_PACKAGES set, the build must have been composed from that list (else it says so and stops).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { builtPackages, coreScripts, packageScripts } from './packages.mjs';

const [jobsArg, ...named] = process.argv.slice(2);
const jobs = Math.max(1, Number(jobsArg) || 1);
const ROOT = process.env.R_ROOT ?? process.cwd();
const E2E = join(ROOT, 'test/e2e');
const SHOTS = process.env.SHOTS ?? '/shots';
// A script that hangs (a wait without timeout) is killed and counted as failed, so the suite always ends.
const SCRIPT_TIMEOUT = (Number(process.env.SCRIPT_TIMEOUT) || 600) * 1000;
const name = (t) => basename(t).replace(/\.e2e\.c?js$/, '');
// The canned chats the scripts would otherwise look for among a real account's (offline/beeper.mjs).
const SCRIPT_ENV = { TEST_CHAT: '!test:beeper.local', LONG_CHAT: '!alice:beeper.local', GROUP_CHAT: '!hikers:beeper.local', LINE_QUERY: 'sticker reaction', QUERY: 'Ali' };

const built = builtPackages(ROOT);
const wanted = (process.env.KLATCHLY_PACKAGES ?? '').split(/[\s,]+/).filter(Boolean);
if (wanted.length && wanted.join(',') !== built.join(',')) {
  console.error(`KLATCHLY_PACKAGES=${wanted.join(',')} but the build has ${built.join(',')}: build with the same list first (from web/: KLATCHLY_PACKAGES=… npm test && KLATCHLY_PACKAGES=… npm run build)`);
  process.exit(2);
}
console.log(`packages: ${built.join(', ')}`);

const DURATIONS = join(SHOTS, '.durations.json');
let durations = {};
try {
  durations = JSON.parse(readFileSync(DURATIONS, 'utf8'));
} catch {}
const weight = (t) => durations[name(t)] ?? statSync(join(E2E, t)).size / 1000;
const scripts = named.length ? named : [...coreScripts(ROOT), ...packageScripts(ROOT)].sort((a, b) => weight(b) - weight(a));

/** `// e2e-instance: alone A=1 B=2` among a script's first lines: its own instance, with those variables. */
function aloneEnv(script) {
  const head = readFileSync(join(E2E, script), 'utf8').split('\n').slice(0, 30).join('\n');
  const m = /^\/\/ e2e-instance: alone((?: [A-Z][A-Z0-9_]*=\S*)*)\s*$/m.exec(head);
  return m ? Object.fromEntries(m[1].trim().split(/\s+/).filter(Boolean).map((kv) => kv.split('='))) : null;
}

/** An offline instance on its own ports; resolves once its enrollment codes are written. */
function instance(i, env) {
  const port = 3095 + i;
  const codeFile = `/tmp/klatchly-offline-codes.${i}`;
  const child = spawn('node', ['--conditions=klatchly-test', 'test/e2e/offline/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, R_ROOT: ROOT, R_INDEX: String(i), R_ORIGIN: `http://localhost:${port}`, R_RP: 'localhost', R_PORT: String(port), R_CODE_FILE: codeFile, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const ready = new Promise((ok, no) => {
    const t0 = Date.now();
    const poll = () => {
      if (existsSync(codeFile) && statSync(codeFile).size > 0) return ok();
      if (child.exitCode !== null || Date.now() - t0 > 60_000) return no(new Error(`offline instance ${i} did not start:\n${log}`));
      setTimeout(poll, 200);
    };
    poll();
  });
  return { port, upstream: 23999 + i, child, ready, codes: () => readFileSync(codeFile, 'utf8').trim().split('\n'), used: 0, log: () => log };
}

/**
 * One script on one instance: its exit code, its time, and the counts of its checks. The instance's scripts share
 * one passkey (lib.js SESSION_FILE: the first enrolls, the next ones unlock), as enrollment is rate-limited.
 */
async function run(inst, script) {
  const code = inst.codes()[inst.used++];
  const log = join(SHOTS, `${name(script)}.log`);
  // Every script starts from the same canned data (what the previous one sent, read or changed is gone).
  const hooks = `http://127.0.0.1:${inst.upstream}/__`;
  await fetch(`${hooks}reset`, { method: 'POST' });
  const t0 = Date.now();
  return new Promise((ok) => {
    const child = spawn('node', [script], {
      cwd: E2E,
      env: { ...process.env, ...SCRIPT_ENV, BASE: `http://localhost:${inst.port}`, CODE: code, SHOTS, SESSION_FILE: `/tmp/klatchly-offline-session.${inst.port}.json`, INJECT_URL: `${hooks}inject` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => ((out += `\nkilled: still running after ${SCRIPT_TIMEOUT / 1000} s\n`), child.kill('SIGKILL')), SCRIPT_TIMEOUT);
    child.on('close', (rc) => {
      clearTimeout(timer);
      const okCount = (out.match(/^ok  /gm) ?? []).length;
      const fails = (out.match(/^FAIL/gm) ?? []).length;
      writeFileSync(log, out);
      ok({ script, rc: rc ?? 1, ms: Date.now() - t0, okCount, fails, out });
    });
  });
}

const results = [];
const report = (r) => {
  results.push(r);
  const status = r.rc === 0 ? 'ok  ' : 'FAIL';
  console.log(`${status} ${String(Math.round(r.ms / 1000)).padStart(4)}s ${name(r.script).padEnd(16)} ${r.okCount} ok, ${r.fails} failed${r.rc !== 0 && !r.fails ? ` (exit ${r.rc})` : ''}`);
};

const own = new Map(scripts.map((t) => [t, aloneEnv(t)]));
const alone = scripts.filter((t) => own.get(t));
const shared = scripts.filter((t) => !own.get(t));
const instances = [];
try {
  // The shared pool, then one instance per script that runs alone.
  const pool = Array.from({ length: Math.min(jobs, shared.length) }, (_, i) => instance(i, {}));
  const solo = alone.map((t, k) => [t, instance(pool.length + k, own.get(t))]);
  instances.push(...pool, ...solo.map(([, i]) => i));
  await Promise.all(instances.map((i) => i.ready));
  const queue = [...shared];
  const worker = async (inst) => {
    for (let t = queue.shift(); t; t = queue.shift()) report(await run(inst, t));
  };
  await Promise.all([...pool.map(worker), ...solo.map(([t, inst]) => run(inst, t).then(report))]);
} finally {
  for (const i of instances) i.child.kill();
}
// The times of this run, for the order of the next one.
for (const r of results) durations[name(r.script)] = Math.round(r.ms / 1000);
try {
  writeFileSync(DURATIONS, `${JSON.stringify(durations, null, 1)}\n`);
} catch {}
const failed = results.filter((r) => r.rc !== 0);
const total = Math.round(results.reduce((s, r) => s + r.ms, 0) / 1000);
console.log(`\n${results.length} script(s), ${total}s of script time on ${instances.length} instance(s); ${failed.length ? `${failed.length} FAILED: ${failed.map((r) => name(r.script)).join(', ')}` : 'all passed'}`);
console.log(`logs and screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
