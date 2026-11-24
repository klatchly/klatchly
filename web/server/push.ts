import { createHash, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as webpush from 'web-push';
import { config } from './config.js';
import { clientIp, store, type Env } from './context.js';
import { RateLimiter } from './ratelimit.js';
import type { PushSubscription, State } from './store.js';
import { vapid } from './vapid.js';
import { DEFAULT_LANG, isLanguage, messages } from './i18n.js';
import { log } from './log.js';
import { liveSession } from './sessions.js';

// Web Push (RFC 8030/8291/8292): subscriptions are stored per session; payloads are encrypted for the
// browser (aes128gcm) and signed with our VAPID key. Only well-known push services are accepted as
// endpoints, so the server never POSTs to an arbitrary URL.
//
// Every message is a Declarative Web Push message (Push API "declarative push message", WebKit, iOS/iPadOS
// 18.4+): {web_push: 8030, notification: {title, body, navigate, tag, lang, ...}, app_badge, mutable}.
// Safari shows it itself (even with the service worker evicted) and sets the badge; other browsers hand
// the same JSON to the service worker's push handler (push-sw.js reads both shapes). See wireMessage().

const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
// Exact hosts: Chromium builds without Google API keys (e.g. Chromium, not Chrome) subscribe here.
const PUSH_EXACT = ['jmt17.google.com'];
const MAX_PER_SESSION = 5;
const MAX_TOTAL = 20;
const B64URL = /^[A-Za-z0-9_-]+$/;

export function validEndpoint(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_EXACT.includes(host) || PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function b64urlBytes(v: unknown, len: number): v is string {
  if (typeof v !== 'string' || v.length > 128 || !B64URL.test(v.replace(/=+$/, ''))) return false;
  return Buffer.from(v, 'base64url').length === len;
}

const SUB_KEYS = new Set(['endpoint', 'keys', 'expirationTime', 'lang', 'declarative']);

/**
 * p256dh: uncompressed P-256 point (65 bytes, 0x04 prefix); auth: 16-byte secret; lang: a known catalog;
 * declarative: true when the device runs a service worker that understands declarative messages.
 */
export function parseSubscription(b: unknown): { endpoint: string; p256dh: string; auth: string; lang?: string; declarative?: true } | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  if (Object.keys(o).some((k) => !SUB_KEYS.has(k))) return null;
  if (o.lang !== undefined && !isLanguage(o.lang)) return null;
  if (o.declarative !== undefined && typeof o.declarative !== 'boolean') return null;
  if (o.expirationTime !== undefined && o.expirationTime !== null && typeof o.expirationTime !== 'number') return null;
  const keys = o.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys !== 'object' || Object.keys(keys).some((k) => k !== 'p256dh' && k !== 'auth')) return null;
  if (!validEndpoint(o.endpoint) || !b64urlBytes(keys.p256dh, 65) || !b64urlBytes(keys.auth, 16)) return null;
  if (Buffer.from(keys.p256dh, 'base64url')[0] !== 4) return null;
  return {
    endpoint: o.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    ...(o.lang ? { lang: o.lang as string } : {}),
    ...(o.declarative === true ? { declarative: true as const } : {}),
  };
}

/** What a notification says; turned into the wire message per subscription by wireMessage(). */
export interface Payload {
  title: string;
  body: string;
  tag: string;
  /** App path the notification opens (/chat/<id>, a space's page...); sent as an absolute `navigate` URL. */
  url: string;
  ts?: number;
  /** Chat the notification is about: enables the Reply / Mark as read actions. */
  chatID?: string;
  /** Unread count for the app icon badge (Badging API); filled from the badge source when absent. */
  badge?: number;
  /** Texts the service worker needs, in the device's language. */
  labels?: { reply: string; read: string; placeholder: string; replyFailed: string };
}

/** Push service host only: the full endpoint is a secret capability URL. */
const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '?';
  }
};

// Collapses queued notifications per chat at the push service (Topic: <= 32 base64url chars).
const topicFor = (tag: string) => createHash('sha256').update(tag).digest('base64url').slice(0, 32);

// Unread total for app_badge (pushwatch.ts registers it; kept out of this module to avoid an import cycle).
let badgeSource: (() => number) | undefined;
export function setBadgeSource(fn: () => number): void {
  badgeSource = fn;
}

/**
 * Plaintext budget: aes128gcm in a single 4096-byte record (RFC 8291 caps the body at 4096 bytes:
 * 86-byte header, 16-byte tag, 1 padding delimiter) leaves 3993 bytes; keep a margin.
 */
export const MAX_MESSAGE_BYTES = 3800;

type Sub = Pick<PushSubscription, 'lang' | 'declarative'>;

/**
 * The JSON sent to one subscription.
 *
 * - `notification` is what Safari displays by itself: `navigate` must be an absolute URL (WebKit parses it
 *   without a base), `data` carries what the service worker needs for actions (chat ID, labels).
 * - `mutable`: only for devices whose service worker reads this format (they said so when subscribing).
 *   Safari then still wakes the worker, which may replace the notification (in-app routing, actions);
 *   if it shows nothing, the declarative notification is shown and no silent-push penalty applies.
 *   Without it, iOS shows the notification directly and never runs the (possibly older) worker.
 * - Unknown members are ignored by declarative parsers (WebKit's and the Push API's), so for devices
 *   not yet known to run the new worker the old top-level fields are kept: a worker from before this
 *   format (Chrome/Firefox until it updates) keeps working.
 */
export function wireMessage(p: Payload, sub: Sub): Record<string, unknown> {
  const origin = config().origin;
  const data: Record<string, unknown> = {};
  if (p.chatID) data.chatID = p.chatID;
  if (p.labels) data.labels = p.labels;
  const notification: Record<string, unknown> = {
    title: p.title || '•',
    body: p.body,
    navigate: new URL(p.url, origin).href,
    tag: p.tag,
    lang: sub.lang ?? DEFAULT_LANG,
    dir: 'auto',
    silent: false,
    icon: `${origin}/icon-192.png`,
    ...(p.ts ? { timestamp: p.ts } : {}),
    ...(Object.keys(data).length ? { data } : {}),
  };
  const badge = p.badge ?? badgeSource?.();
  const legacy = sub.declarative ? {} : { ...p, ...(badge !== undefined ? { badge } : {}) };
  return {
    web_push: 8030,
    notification,
    ...(typeof badge === 'number' && Number.isFinite(badge) && badge >= 0 ? { app_badge: Math.floor(badge) } : {}),
    mutable: !!sub.declarative,
    ...legacy,
  };
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const clipText = (s: unknown, n: number) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Serialised message within MAX_MESSAGE_BYTES: drops the legacy copy, then trims texts (only for huge IDs). */
export function serialize(m: Record<string, unknown>): string {
  let s = JSON.stringify(m);
  if (bytes(s) <= MAX_MESSAGE_BYTES) return s;
  const { web_push, notification, app_badge, mutable } = m as { web_push: number; notification: Record<string, unknown>; app_badge?: number; mutable: boolean };
  const n = { ...notification };
  s = JSON.stringify({ web_push, notification: n, app_badge, mutable });
  if (bytes(s) <= MAX_MESSAGE_BYTES) return s;
  delete n.icon;
  if (n.data && typeof n.data === 'object') n.data = { chatID: (n.data as Record<string, unknown>).chatID };
  n.body = clipText(n.body, 60);
  n.title = clipText(n.title, 40);
  s = JSON.stringify({ web_push, notification: n, app_badge, mutable });
  if (bytes(s) <= MAX_MESSAGE_BYTES) return s;
  // An absurdly long ID: the chat cannot be targeted; still say something.
  delete n.data;
  n.tag = topicFor(String(n.tag));
  n.navigate = `${config().origin}/`;
  return JSON.stringify({ web_push, notification: n, app_badge, mutable });
}

/** Encrypted request for one subscription (exported for tests). */
export function buildRequest(sub: Pick<PushSubscription, 'endpoint' | 'p256dh' | 'auth' | 'lang' | 'declarative'>, payload: Payload) {
  const v = vapid();
  return webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    serialize(wireMessage(payload, sub)),
    {
      vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey },
      TTL: 6 * 3600,
      urgency: 'high',
      topic: topicFor(payload.tag),
      contentEncoding: 'aes128gcm',
    },
  );
}

type Outcome = 'ok' | 'gone' | 'error';

async function deliver(sub: PushSubscription, payload: Payload): Promise<Outcome> {
  let res: Response;
  try {
    const req = buildRequest(sub, payload);
    res = await fetch(req.endpoint, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.body ?? undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
  } catch {
    log('push', 'send failed', { host: hostOf(sub.endpoint) });
    return 'error';
  }
  if (res.status >= 200 && res.status < 300) return 'ok';
  if (res.status === 404 || res.status === 410) return 'gone';
  log('push', 'push service error', { host: hostOf(sub.endpoint), status: res.status });
  return 'error';
}

function liveSubscriptions(state: State, sessionHash?: string): PushSubscription[] {
  const now = Date.now();
  const live = new Set(state.sessions.filter((s) => liveSession(s, now)).map((s) => s.hash));
  return (state.push ?? []).filter((p) => live.has(p.sessionHash) && (!sessionHash || p.sessionHash === sessionHash));
}

export function hasSubscriptions(): boolean {
  return liveSubscriptions(store.read()).length > 0;
}

/**
 * Sends to every live subscription (or one session's); `payload` returns null to skip a subscription.
 * Dead endpoints (404/410) are pruned.
 */
export async function pushAll(
  payload: (sub: PushSubscription) => Payload | null,
  sessionHash?: string,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const all = liveSubscriptions(store.read(), sessionHash);
  const jobs = all.map((s) => ({ s, p: payload(s) })).filter((j): j is { s: PushSubscription; p: Payload } => j.p !== null);
  const subs = jobs.map((j) => j.s);
  const results = await Promise.all(jobs.map((j) => deliver(j.s, j.p)));
  const gone = new Set(subs.filter((_, i) => results[i] === 'gone').map((s) => s.id));
  if (gone.size) {
    store.mutate((st) => {
      st.push = (st.push ?? []).filter((p) => !gone.has(p.id));
    });
    log('push', 'pruned dead subscriptions', { n: gone.size });
  }
  return { sent: results.filter((r) => r === 'ok').length, failed: results.filter((r) => r !== 'ok').length, skipped: all.length - jobs.length };
}

const subscribeLimiter = new RateLimiter(10 * 60 * 1000, 20, 60);
const testLimiter = new RateLimiter(10 * 60 * 1000, 10, 20);
const small = bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

async function json(c: Context): Promise<unknown> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export const pushRoutes = new Hono<Env>();

pushRoutes.get('/push/key', (c) => c.json({ publicKey: vapid().publicKey }));

pushRoutes.post('/push/subscribe', small, async (c) => {
  if (!subscribeLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const session = c.get('session')!;
  const sub = parseSubscription(await json(c));
  if (!sub) return c.json({ error: 'bad_request' }, 400);
  const ok = store.mutate((st) => {
    const list = (st.push ??= []);
    // Same endpoint: re-bind to this session (re-login on the same device) and refresh the keys, language
    // and service worker capability (an older client re-subscribing drops `declarative`).
    const existing = list.find((p) => p.endpoint === sub.endpoint);
    if (existing) {
      delete existing.lang;
      delete existing.declarative;
      Object.assign(existing, sub, { sessionHash: session });
      return true;
    }
    if (list.filter((p) => p.sessionHash === session).length >= MAX_PER_SESSION || list.length >= MAX_TOTAL) return false;
    list.push({ id: randomBytes(6).toString('hex'), sessionHash: session, createdAt: Date.now(), ...sub });
    return true;
  });
  if (!ok) return c.json({ error: 'too_many' }, 409);
  log('push', 'subscribed', { host: hostOf(sub.endpoint) });
  return c.json({ ok: true });
});

pushRoutes.post('/push/unsubscribe', small, async (c) => {
  const body = (await json(c)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'endpoint') || typeof body.endpoint !== 'string' || body.endpoint.length > 2048) {
    return c.json({ error: 'bad_request' }, 400);
  }
  const session = c.get('session')!;
  const n = store.mutate((st) => {
    const before = st.push?.length ?? 0;
    st.push = (st.push ?? []).filter((p) => !(p.endpoint === body.endpoint && p.sessionHash === session));
    return before - st.push.length;
  });
  return c.json({ ok: true, removed: n });
});

pushRoutes.post('/push/test', async (c) => {
  if (!testLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const r = await pushAll((s) => {
    const t = messages(s.lang).push;
    return { title: t.testTitle, body: t.testBody, tag: 'test', url: '/' };
  }, c.get('session')!);
  return c.json({ sent: r.sent, failed: r.failed });
});
