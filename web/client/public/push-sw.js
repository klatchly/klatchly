// Web Push handlers, imported by the generated service worker (workbox importScripts).
// The payload is decrypted by the browser; it is treated as untrusted input all the same.
// Texts (action titles...) come in the payload, already in the device's language.
//
// Three shapes reach the push handler (server/push.ts wireMessage):
// 1. Safari with Declarative Web Push (iOS/iPadOS 18.4+, macOS 15.5+), message marked `mutable`:
//    event.data is null, event.notification is the notification the browser proposes to show and
//    event.appBadge its badge. If this worker shows nothing, the browser shows the proposed one, and that
//    does not count as a silent push. A non-mutable message never reaches the worker on iOS.
// 2. Other browsers: the same declarative JSON arrives as event.data ({web_push: 8030, notification, app_badge}).
// 3. Older servers: the flat {title, body, tag, url, ts, chatID, badge, labels} payload.
/* eslint-env serviceworker */
// A chat. The spaces of the build add their own targets (a space's home, optionally one of its places):
// /push-links.js, written by the server from the packages that are on (server/registry.ts) and imported just
// before this file, sets self.pushLinks to [{path, segment, former}]. They are checked again here and matched as the
// server matches them (server/extension.ts spacePlace): the home, or one segment with no slash or backslash that
// matches the segment pattern. `former` (a renamed space's old homes): a link to one of them opens the same place
// under the home now, when that is a link of the space (a local translation; nothing is served at the old path).
const CHAT_URL = /^\/chat\/[^/?#\s]{1,600}$/;
const SEGMENT = /^[A-Za-z0-9_|()[\]{},?*+-]{1,200}$/;
const HOME = /^\/[a-z][a-z0-9-]{0,31}$/;
const SPACES = (Array.isArray(self.pushLinks) ? self.pushLinks : []).flatMap((s) => {
  if (!s || typeof s !== 'object' || typeof s.path !== 'string' || !HOME.test(s.path)) return [];
  // Its former homes (a renamed space): links to them are translated, never opened as they are.
  const former = Array.isArray(s.former) ? s.former.filter((f) => typeof f === 'string' && HOME.test(f) && f !== s.path) : [];
  if (s.segment === undefined) return [{ path: s.path, former }];
  if (typeof s.segment !== 'string' || !SEGMENT.test(s.segment)) return [];
  // Brackets balanced: no ')' closes the group around it.
  let depth = 0;
  for (const c of s.segment) if ((depth += c === '(' ? 1 : c === ')' ? -1 : 0) < 0) return [];
  if (depth) return [];
  try {
    return [{ path: s.path, former, segment: new RegExp(`^(?:${s.segment})$`) }];
  } catch {
    return [];
  }
});
function spaceURL(p) {
  return SPACES.some((s) => {
    if (p === s.path) return true;
    if (!s.segment || !p.startsWith(`${s.path}/`)) return false;
    const seg = p.slice(s.path.length + 1);
    return !!seg && !/[/\\]/.test(seg) && s.segment.test(seg);
  });
}
// Never a path that a browser reads as another host ('//host', or '/' and a backslash).
const appURL = (p) => !/^\/[/\\]/.test(p) && (CHAT_URL.test(p) || spaceURL(p));
/**
 * A link to a former home of a space (a notification delivered before the space was renamed: '/old' or
 * '/old/<place>'): the same place under its home now, if that is a link of the space; else null.
 */
function renamed(p) {
  for (const s of SPACES) {
    for (const f of s.former) {
      if (p !== f && !p.startsWith(`${f}/`)) continue;
      const to = s.path + p.slice(f.length);
      return appURL(to) ? to : null;
    }
  }
  return null;
}
const appTarget = (p) => (appURL(p) ? p : renamed(p));
const CHAT_ID = /^[^\u0000-\u001f\s]{1,512}$/;

function parse(event) {
  try {
    const d = event.data ? event.data.json() : null;
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * App path of a notification target: a path, or an absolute URL of this origin (declarative `navigate`).
 * Anything else (other origin, query string, unknown route) gives null.
 */
function appPath(v) {
  if (typeof v !== 'string' || v.length > 2048) return null;
  if (v.startsWith('/') && !v.startsWith('//')) return /^\/\\/.test(v) ? null : appTarget(v);
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.origin !== self.location.origin || u.search || u.hash) return null;
  return /^\/[/\\]/.test(u.pathname) ? null : appTarget(u.pathname);
}

/** Badge from a number or a digit string (declarative app_badge allows both). */
function badgeOf(v) {
  if (typeof v === 'string' && /^\d{1,9}$/.test(v)) return Number(v);
  return typeof v === 'number' ? v : undefined;
}

/** One normalised view of the three payload shapes. */
function message(event) {
  const proposed = event.notification && typeof event.notification === 'object' ? event.notification : null;
  const d = parse(event);
  const n = d.web_push === 8030 ? obj(d.notification) : null;
  if (n && typeof n.title === 'string') {
    const data = obj(n.data);
    return { title: n.title, body: n.body, tag: n.tag, url: appPath(n.navigate), ts: n.timestamp, chatID: data.chatID, labels: data.labels, badge: badgeOf(d.app_badge), proposed };
  }
  if (proposed) {
    const data = obj(proposed.data);
    return { title: proposed.title, body: proposed.body, tag: proposed.tag, url: appPath(proposed.navigate), ts: proposed.timestamp, chatID: data.chatID, labels: data.labels, badge: badgeOf(event.appBadge), proposed };
  }
  return { title: d.title, body: d.body, tag: d.tag, url: appPath(d.url), ts: d.ts, chatID: d.chatID, labels: d.labels, badge: badgeOf(d.badge), proposed };
}

/** App icon badge (Badging API); no-op where unsupported. */
async function setBadge(n) {
  const nav = self.navigator;
  if (!nav || typeof n !== 'number' || !Number.isFinite(n) || n < 0) return;
  try {
    if (n === 0 && nav.clearAppBadge) await nav.clearAppBadge();
    else if (nav.setAppBadge) await nav.setAppBadge(Math.min(Math.floor(n), 9999));
  } catch {
    // not installed / not allowed: ignore
  }
}

/** Inline text replies are behind a flag in Chromium and absent elsewhere: feature-detect. */
const inlineReply = () => typeof NotificationEvent !== 'undefined' && 'reply' in NotificationEvent.prototype;
const maxActions = () => (typeof Notification !== 'undefined' && typeof Notification.maxActions === 'number' ? Notification.maxActions : 0);

/** A window of this app (any state), if one exists. */
async function appWindow() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.find((c) => new URL(c.url).origin === self.location.origin);
}

self.addEventListener('push', (event) => {
  const m = message(event);
  const title = str(m.title, 120) || '•';
  const url = m.url || '/';
  const tag = str(m.tag, 300);
  const chatID = typeof m.chatID === 'string' && CHAT_ID.test(m.chatID) ? m.chatID : '';
  const l = obj(m.labels);
  const labels = { reply: str(l.reply, 40), read: str(l.read, 40), placeholder: str(l.placeholder, 40), replyFailed: str(l.replyFailed, 80) };
  const actions = [];
  if (chatID && labels.reply && labels.read && maxActions() >= 2) {
    actions.push(
      inlineReply()
        ? { action: 'reply', title: labels.reply, type: 'text', placeholder: labels.placeholder || undefined }
        : { action: 'reply', title: labels.reply },
      { action: 'read', title: labels.read },
    );
  }
  // No `navigate` on what this worker shows: a click must reach notificationclick (in-app routing, actions).
  const options = {
    body: str(m.body, 300),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url, chatID, labels },
    ...(tag ? { tag, renotify: true } : {}),
    ...(typeof m.ts === 'number' && m.ts > 0 ? { timestamp: m.ts } : {}),
    ...(actions.length ? { actions } : {}),
  };
  const show = async () => {
    try {
      await self.registration.showNotification(title, options);
    } catch {
      // Some platforms reject unknown action fields: retry without actions.
      const { actions: _a, ...rest } = options;
      await self.registration.showNotification(title, rest);
    }
  };
  event.waitUntil(
    (async () => {
      if (m.proposed) {
        // Declarative message: the browser shows the proposed notification unless this worker shows one.
        // Replace it only when that adds something: Reply / Mark as read buttons, or an open window of the
        // app, where a click should route in place (postMessage) rather than the browser navigating to
        // `navigate` (a full page load). Showing nothing is fine here: the proposed one is shown.
        if (actions.length || (await appWindow().catch(() => undefined))) await show();
      } else {
        // Plain push: always show something (userVisibleOnly; browsers penalise silent pushes).
        await show();
      }
      await setBadge(m.badge);
    })(),
  );
});

/** POST from the worker: same-origin, session cookie included, no redirect following (302 = signed out). */
async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.type === 'opaqueredirect' || !res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

async function focusOrOpen(url) {
  const mine = await appWindow();
  if (mine) {
    await mine.focus();
    mine.postMessage({ type: 'open', url });
    return;
  }
  await self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = obj(event.notification.data);
  // Ours carry data.url. A declarative notification shown by the browser carries `navigate` instead: the
  // browser normally navigates there itself without firing this event, but handle it if one does.
  const url = appPath(data.url) || appPath(event.notification.navigate) || '/';
  const chatID = typeof data.chatID === 'string' && CHAT_ID.test(data.chatID) ? data.chatID : '';
  const labels = obj(data.labels);
  event.waitUntil(
    (async () => {
      if (event.action === 'read' && chatID) {
        try {
          const r = await post('/api/notify/read', { chatID });
          await setBadge(r && r.badge);
        } catch {
          // signed out or offline: nothing else to do from here
        }
        return;
      }
      const text = event.action === 'reply' && typeof event.reply === 'string' ? event.reply.trim() : '';
      if (text && chatID) {
        try {
          const r = await post('/api/notify/reply', { chatID, text: text.slice(0, 20000) });
          await setBadge(r && r.badge);
        } catch {
          await self.registration.showNotification(str(labels.replyFailed, 80) || '•', { body: text.slice(0, 120), data: { url, chatID, labels }, tag: `failed-${chatID}` });
        }
        return;
      }
      // Body click, or "Reply" without inline text: open the chat (with the composer focused).
      await focusOrOpen(event.action === 'reply' && url !== '/' ? `${url}?compose=1` : url);
    })(),
  );
});
