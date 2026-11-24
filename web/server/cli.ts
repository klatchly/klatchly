// First: the former BEEP_* variables, before any module reads the environment.
import './legacyenv.js';
import { get as httpsGet } from 'node:https';
import { Store } from './store.js';
import { addEnrollCode, liveSession, newEnrollCode, prunePush, sessionExpiry, voidKnownDevice } from './sessions.js';
import { canRemovePasskey, legacyAuth, passkeyLabel, storedOidc } from './auth.js';

// Administrative CLI, run inside the container: docker exec klatchly /nodejs/bin/node /app/dist/cli.js <cmd>
const dataDir = process.env.KLATCHLY_DATA_DIR || '/data';
const port = Number(process.env.PORT || '8080');
const ENROLL_TTL_MS = 10 * 60 * 1000;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const [cmd, sub, arg] = argv.filter((a) => !a.startsWith('--'));
const store = new Store(dataDir);
const iso = (t: number) => new Date(t).toISOString();

function usage(): never {
  process.stderr.write(
    'usage: cli.js enroll | codes revoke-all | sessions list|revoke <prefix>|revoke-all |\n' +
      '       passkeys list|rename <id> <label>|remove <id> [--force] | push list|clear | health |\n' +
      '       auth status | auth oidc unlink\n',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'enroll': {
      const code = newEnrollCode();
      store.mutate((s) => addEnrollCode(s, code, ENROLL_TTL_MS));
      const grouped = code.match(/.{5}/g)!.join('-');
      process.stdout.write(`${grouped}\n(valid 10 minutes, single use; open /enroll: add a passkey, or link the OIDC provider's account)\n`);
      return;
    }
    case 'codes': {
      if (sub !== 'revoke-all') return usage();
      const n = store.mutate((s) => {
        const n = s.enrollCodes.length;
        s.enrollCodes = [];
        return n;
      });
      process.stdout.write(`revoked ${n} enrollment code(s)\n`);
      return;
    }
    case 'sessions': {
      if (sub === 'list') {
        const now = Date.now();
        const list = store.read().sessions.filter((s) => liveSession(s, now));
        if (!list.length) process.stdout.write('no active sessions\n');
        for (const s of list) {
          process.stdout.write(
            `${s.hash.slice(0, 12)}  created ${iso(s.createdAt)}  last seen ${iso(s.lastSeen)}  expires ${iso(sessionExpiry(s))}  ${s.device ?? '-'}\n`,
          );
        }
        return;
      }
      if (sub === 'revoke' && arg && /^[0-9a-f]{6,64}$/.test(arg)) {
        const r = store.mutate((s) => {
          const match = s.sessions.filter((x) => x.hash.startsWith(arg));
          if (match.length !== 1) return match.length;
          s.sessions = s.sessions.filter((x) => x !== match[0]);
          voidKnownDevice(s, match[0]!.kd); // its known-device cookie too (server/device.ts)
          prunePush(s);
          return 1;
        });
        process.stdout.write(r === 1 ? 'revoked; its sockets close within 30 s\n' : r ? 'ambiguous prefix\n' : 'not found\n');
        process.exitCode = r === 1 ? 0 : 1;
        return;
      }
      if (sub === 'revoke-all') {
        const n = store.mutate((s) => {
          const n = s.sessions.length;
          s.sessions = [];
          s.push = [];
          delete s.deviceKey; // known-device cookies void too (server/device.ts)
          delete s.voidDevices;
          return n;
        });
        process.stdout.write(`revoked ${n} session(s); open sockets close within 30 s\n`);
        return;
      }
      return usage();
    }
    case 'passkeys': {
      if (sub === 'list') {
        const list = store.read().credentials;
        if (!list.length) process.stdout.write('no passkeys\n');
        for (const c of list) {
          process.stdout.write(`${c.id}  label=${c.label}  created ${c.createdAt}  last used ${c.lastUsedAt ?? '-'}  from ${c.addedFrom ?? '-'}\n`);
        }
        return;
      }
      if (sub === 'rename' && arg) {
        const label = passkeyLabel(argv.filter((a) => !a.startsWith('--')).slice(3).join(' '));
        if (!label) return usage();
        const found = store.mutate((s) => {
          const k = s.credentials.find((c) => c.id === arg);
          if (k) k.label = label;
          return !!k;
        });
        process.stdout.write(found ? `renamed: ${label}\n` : 'not found\n');
        process.exitCode = found ? 0 : 1;
        return;
      }
      if (sub === 'remove' && arg) {
        // The last passkey only with --force: then no one can sign in until `enroll` adds one.
        const guard = store.mutate((s) => {
          const g = canRemovePasskey(s, arg);
          if (g === 'not_found' || (g === 'last_passkey' && !flags.has('--force'))) return g;
          s.credentials = s.credentials.filter((c) => c.id !== arg);
          return null;
        });
        if (guard === 'last_passkey') {
          process.stderr.write('refused: this is the last passkey (enroll another first; --force: then nobody can sign in until `enroll`)\n');
          process.exitCode = 1;
          return;
        }
        process.stdout.write(guard ? 'not found\n' : 'removed\n');
        process.exitCode = guard ? 1 : 0;
        return;
      }
      return usage();
    }
    case 'push': {
      if (sub === 'list') {
        const list = store.read().push ?? [];
        if (!list.length) process.stdout.write('no push subscriptions\n');
        for (const p of list) {
          // Host only: the endpoint path is a secret capability, keys are never printed.
          const host = new URL(p.endpoint).hostname;
          process.stdout.write(`${p.id}  session ${p.sessionHash.slice(0, 12)}  ${host}  lang ${p.lang ?? '-'}  ${p.declarative ? 'declarative' : 'legacy-sw'}  created ${iso(p.createdAt)}\n`);
        }
        return;
      }
      if (sub === 'clear') {
        const n = store.mutate((s) => {
          const n = s.push?.length ?? 0;
          s.push = [];
          return n;
        });
        process.stdout.write(`removed ${n} push subscription(s)\n`);
        return;
      }
      return usage();
    }
    case 'auth':
      return authCommand();
    case 'health': {
      // Native HTTPS (KLATCHLY_TLS_CERT): its certificate names the public host, not 127.0.0.1; not checked here.
      const ok = process.env.KLATCHLY_TLS_CERT ? await httpsHealth() : (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) })).ok;
      process.exitCode = ok ? 0 : 1;
      return;
    }
    default:
      usage();
  }
}

/**
 * Passkeys, and the OIDC provider (auth.ts, oidc.ts): what signs in, and what an old state file still held (dropped
 * at the server's next start). `auth oidc unlink`: the linked identity no longer signs in (its sessions stay).
 */
function authCommand(): void {
  if (sub === 'oidc' && arg === 'unlink') {
    const before = store.mutate((s) => {
      const o = storedOidc(s);
      if (o) s.auth = { mode: 'passkey' };
      return o;
    });
    process.stdout.write(before ? `unlinked ${before.iss} ${before.sub} (its sessions stay: sessions revoke-all to sign them out)\n` : 'no OIDC account linked\n');
    process.exitCode = before ? 0 : 1;
    return;
  }
  if (sub !== 'status') return usage();
  const state = store.read();
  const legacy = legacyAuth(state);
  const oidc = storedOidc(state);
  const issuer = process.env.KLATCHLY_OIDC_ISSUER;
  const pinned = process.env.KLATCHLY_OIDC_ALLOWED_SUB;
  process.stdout.write(
    `mode passkey\npasskeys ${state.credentials.length}${state.credentials.length ? '' : ' (none: cli.js enroll, then /enroll)'}\n` +
      `oidc ${issuer ? `provider ${issuer}` : 'off (KLATCHLY_OIDC_ISSUER unset)'}\n` +
      (oidc ? `oidc linked ${oidc.iss} subject ${oidc.sub} since ${oidc.linkedAt}\n` : issuer ? 'oidc linked none (cli.js enroll, then on /enroll choose the provider)\n' : '') +
      (pinned ? `oidc pinned by KLATCHLY_OIDC_ALLOWED_SUB: subject ${pinned}\n` : '') +
      (legacy ? `stored mode ${legacy}: removed, the server falls back to passkeys at start\n` : ''),
  );
}

function httpsHealth(): Promise<boolean> {
  return new Promise((ok) => {
    const req = httpsGet({ host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false, timeout: 4000 }, (res) => {
      res.resume();
      ok(res.statusCode === 200);
    });
    req.on('error', () => ok(false));
    req.on('timeout', () => req.destroy());
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
