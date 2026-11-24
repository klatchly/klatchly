import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as webpush from 'web-push';
import { config } from './config.js';
import { log } from './log.js';

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let cached: Vapid | undefined;

/**
 * VAPID key pair in /data/vapid.json (0600), generated on first start. Regenerating it invalidates
 * every browser subscription (they are bound to the public key), so it is never rotated automatically.
 * The keys are never logged.
 */
export function vapid(): Vapid {
  if (cached) return cached;
  const file = join(config().dataDir, 'vapid.json');
  // The subject is sent to push services: the public origin (https) rather than an e-mail address.
  const subject = config().origin.startsWith('https://') ? config().origin : 'mailto:push@localhost.invalid';
  try {
    const k = JSON.parse(readFileSync(file, 'utf8')) as Partial<Vapid>;
    if (typeof k.publicKey === 'string' && typeof k.privateKey === 'string') {
      cached = { publicKey: k.publicKey, privateKey: k.privateKey, subject };
      return cached;
    }
    throw new Error('invalid vapid.json');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const keys = webpush.generateVAPIDKeys();
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  log('push', 'generated VAPID key pair');
  cached = { ...keys, subject };
  return cached;
}
