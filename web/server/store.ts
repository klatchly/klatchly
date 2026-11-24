import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface StoredCredential {
  id: string; // base64url credential ID
  publicKey: string; // base64url COSE public key
  counter: number;
  transports?: string[];
  createdAt: string;
  lastUsedAt?: string;
  label: string;
  addedFrom?: string; // the enrolling browser (sessions.ts deviceSummary), shown with the alert of a new passkey
}

export interface StoredSession {
  hash: string; // sha256 hex of the session id, the id itself is never stored
  createdAt: number;
  lastSeen: number;
  authAt?: number; // last full sign-in or step-up (auth.ts STEP_UP_MS): sensitive changes need a recent one
  device?: string; // browser and system at sign-in (sessions.ts deviceSummary), for Settings → connected devices
  method?: SignInMethod; // how it was opened (absent: before this was kept, a passkey)
  kd?: string; // the browser's known-device id at sign-in (device.ts): void when this session is signed out from elsewhere
}

/** How a session was opened: a passkey (sign-in or enrollment), or the OIDC provider (sign-in or linking). */
export type SignInMethod = 'passkey' | 'oidc';

/** The OIDC identity linked with an enrollment code (oidc.ts): the only one, with KLATCHLY_OIDC_ALLOWED_SUB, that signs in. */
export interface StoredOidc {
  iss: string;
  sub: string;
  linkedAt: string;
}

export interface EnrollCode {
  hash: string; // sha256 hex
  expiresAt: number;
}

export interface PushSubscription {
  id: string; // random, for the CLI
  sessionHash: string; // owning session: removed with it
  endpoint: string; // push service URL (a capability URL: never logged)
  p256dh: string; // browser public key, base64url (never logged)
  auth: string; // auth secret, base64url (never logged)
  createdAt: number;
  lang?: string; // device interface language, for notification texts
  declarative?: true; // the device's service worker reads declarative push messages (push-sw.js)
}

/**
 * How the owner signs in (auth.ts): passkeys, and the OIDC identity linked if any (the provider is configured by the
 * environment, oidc.ts). A state file from before may hold the removed modes ("password", "none") and their
 * username, password hash, TOTP secret and recovery codes: auth.ts migrateAuth drops them at start.
 */
export interface StoredAuth {
  mode: 'passkey';
  oidc?: StoredOidc;
}

export interface State {
  version: 1;
  userHandle: string; // base64url, stable WebAuthn user.id
  credentials: StoredCredential[];
  sessions: StoredSession[];
  enrollCodes: EnrollCode[];
  push?: PushSubscription[];
  auth?: StoredAuth;
  deviceKey?: string; // base64url HMAC key of the "known device" cookies (device.ts)
  voidDevices?: { id: string; until: number }[]; // known-device ids voided one by one (device.ts voidKnownDevice)
}

function emptyState(): State {
  return {
    version: 1,
    userHandle: randomBytes(32).toString('base64url'),
    credentials: [],
    sessions: [],
    enrollCodes: [],
  };
}

const LOCK_STALE_MS = 10_000;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/**
 * JSON state file shared by the server and the CLI (separate processes).
 * Every mutation is a synchronous read-modify-write followed by an atomic rename, and readers
 * reload when the file's mtime/size change, so CLI changes are seen by the server.
 */
export class Store {
  private readonly file: string;
  private cache?: State;
  private stamp = '';

  constructor(dir: string) {
    this.file = join(dir, 'state.json');
  }

  private currentStamp(): string {
    try {
      const s = statSync(this.file);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw e;
    }
  }

  read(): State {
    const stamp = this.currentStamp();
    if (this.cache && stamp === this.stamp) return this.cache;
    if (stamp === 'missing') {
      this.cache = emptyState();
    } else {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as State;
      if (parsed.version !== 1) throw new Error('unsupported state version');
      this.cache = parsed;
    }
    this.stamp = stamp;
    return this.cache;
  }

  /**
   * Read-modify-write under the state lock (state.json.lock, shared with the CLI: audit L1), always on a fresh read,
   * so that neither process writes back a state read before the other's change (a CLI `sessions revoke-all` undone
   * by the server touching a session). Synchronous; a nested call runs inside the outer one's lock.
   */
  mutate<T>(fn: (s: State) => T): T {
    if (this.depth > 0) return this.apply(fn);
    this.lock();
    this.depth++;
    try {
      return this.apply(fn);
    } finally {
      this.depth--;
      this.unlock();
    }
  }

  private depth = 0;

  private apply<T>(fn: (s: State) => T): T {
    this.cache = undefined;
    const state = structuredClone(this.read());
    const result = fn(state);
    this.write(state);
    return result;
  }

  private get lockFile(): string {
    return `${this.file}.lock`;
  }

  /**
   * Takes the lock file (O_EXCL), waiting while another process holds it. A lock older than LOCK_STALE_MS is left
   * by a process that died holding it (a write takes milliseconds): it is broken.
   */
  private lock(): void {
    const start = Date.now();
    for (let wait = 1; ; wait = Math.min(wait * 2, 50)) {
      try {
        closeSync(openSync(this.lockFile, 'wx', 0o600));
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      let age = 0;
      try {
        age = Date.now() - statSync(this.lockFile).mtimeMs;
      } catch {
        continue; // released meanwhile
      }
      if (age > LOCK_STALE_MS) {
        try {
          unlinkSync(this.lockFile);
        } catch {
          /* someone else broke it */
        }
        continue;
      }
      if (Date.now() - start > LOCK_STALE_MS + 2000) throw new Error('state.json is locked');
      Atomics.wait(SLEEP, 0, 0, wait);
    }
  }

  private unlock(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      /* broken as stale by another process: nothing to release */
    }
  }

  private write(state: State): void {
    const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(state, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    this.cache = state;
    this.stamp = this.currentStamp();
  }
}
