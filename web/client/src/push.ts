import { api } from './endpoints';
import { lang } from './i18n';

// Web Push on this device. Notification.requestPermission() must run inside a user gesture, so
// enable() is only ever called from a click handler.

export type PushState = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on';

export { isIOS, isStandalone } from './platform';
import { isIOS, isStandalone } from './platform';

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === b[i]);

/**
 * What the server stores for this device. `declarative`: this build's service worker (push-sw.js) reads
 * Declarative Web Push messages, so the server may mark them mutable (Safari then lets the worker replace
 * them). Sent at every start (resyncPush), so existing subscriptions are upgraded without re-enabling.
 * The subscription itself is unchanged: on Safari, window.pushManager and the root-scope registration's
 * pushManager share one subscription, and declarative handling depends only on the message format.
 */
const body = (sub: PushSubscription) => ({ ...sub.toJSON(), lang: lang(), declarative: true as const });

async function registration():Promise<ServiceWorkerRegistration | undefined> {
  if (!supported()) return undefined;
  return (await navigator.serviceWorker.getRegistration('/')) ?? undefined;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIOS() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.pushSubscribe(body(sub));
  return 'on';
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => false);
}

/**
 * At startup: if this device already has a subscription and permission, (re)register it with the
 * server, binding it to the current session (it was dropped with the previous session). A
 * subscription made for an older VAPID key is renewed.
 */
export async function resyncPush(): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!reg || !sub) return;
  const { publicKey } = await api.pushKey();
  const key = keyBytes(publicKey);
  if (sameKey(sub.options.applicationServerKey, key)) {
    await api.pushSubscribe(body(sub));
    return;
  }
  await sub.unsubscribe();
  const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.pushSubscribe(body(fresh));
}
