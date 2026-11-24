import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Runs client/public/push-sw.js in a fake ServiceWorkerGlobalScope (sw.test.ts, and the packages' own tests).

// Objects created inside the VM have foreign prototypes: compare plain copies.
export const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

type Win = { url: string; focus: () => Promise<void>; postMessage: (m: unknown) => void };
type Opts = { links?: string; windows?: Win[]; maxActions?: number; inlineReply?: boolean; badge?: boolean; fetchStatus?: number; showThrows?: boolean };

// `links`: the /push-links.js the server would serve (server/registry.ts pushLinksScript); mocked push receiver.
export function load(o: Opts = {}) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: [string, Record<string, unknown>][] = [];
  const opened: string[] = [];
  const badges: (number | 'clear')[] = [];
  const fetched: { url: string; init: Record<string, unknown> }[] = [];
  const navigator = o.badge === false ? {} : {
    setAppBadge: async (n: number) => void badges.push(n),
    clearAppBadge: async () => void badges.push('clear'),
  };
  let throws = !!o.showThrows;
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => (handlers[t] = fn),
    registration: {
      showNotification: async (t: string, opt: Record<string, unknown>) => {
        if (throws && opt.actions) {
          throws = false;
          throw new TypeError('actions');
        }
        shown.push([t, opt]);
      },
    },
    clients: { matchAll: async () => o.windows ?? [], openWindow: async (u: string) => void opened.push(u) },
    location: { origin: 'https://klatchly.example' },
    navigator,
  };
  class NotificationEvent {}
  if (o.inlineReply) Object.defineProperty(NotificationEvent.prototype, 'reply', { get: () => null });
  const Notification = { maxActions: o.maxActions ?? 0 };
  const fetch = async (url: string, init: Record<string, unknown>) => {
    fetched.push({ url, init });
    const status = o.fetchStatus ?? 200;
    return { ok: status === 200, status, type: 'basic', json: async () => ({ ok: true, badge: 3 }) };
  };
  const code = readFileSync(new URL('../../client/public/push-sw.js', import.meta.url), 'utf8');
  // As sw.js does: the spaces' notification targets (/push-links.js) first, then push-sw.js, in one scope.
  const scope = { self, URL, NotificationEvent, Notification, fetch, JSON };
  if (o.links !== undefined) runInNewContext(o.links, scope);
  runInNewContext(code, scope);
  const fire = async (type: string, e: Record<string, unknown>) => {
    let p: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...e, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  return { fire, shown, opened, badges, fetched };
}

export const push = (d: unknown) => ({ data: { json: () => (typeof d === 'string' ? JSON.parse(d) : d) } });
