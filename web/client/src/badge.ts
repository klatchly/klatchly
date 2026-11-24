// App icon badge (Badging API: installed PWAs on Chromium desktop/Android, Safari on macOS/iOS 16.4+
// home-screen apps). Feature-detected; a no-op elsewhere.

type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

import { api } from './endpoints';

let last = -1;

export function setAppBadge(n: number): void {
  const nav = navigator as BadgeNavigator;
  if (n === last || !nav.setAppBadge) return;
  last = n;
  const p = n > 0 ? nav.setAppBadge(n) : (nav.clearAppBadge?.() ?? nav.setAppBadge(0));
  p.catch(() => {});
}

let timer: number | undefined;

/**
 * Refresh the badge from the server's count (the same number pushes carry), shortly after the chat list
 * changed; falls back to the local count of the loaded chats.
 */
export function refreshBadge(local: number): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    api.badge().then(
      (r) => setAppBadge(r.badge),
      () => setAppBadge(local),
    );
  }, 1000);
}

type Counted = { unreadCount: number; isMuted?: boolean; isArchived?: boolean; isLowPriority?: boolean };
const counts = (c: Counted) => !c.isMuted && !c.isArchived && !c.isLowPriority;

/** Unread messages in the given chats; muted, archived and low-priority ones excluded. */
export function unreadTotal(chats: Counted[]): number {
  return chats.reduce((sum, c) => sum + (counts(c) ? Math.max(0, c.unreadCount || 0) : 0), 0);
}

/** Chats with unread messages (the page title), same exclusions as unreadTotal. */
export function unreadChats(chats: Counted[]): number {
  return chats.reduce((n, c) => n + (counts(c) && c.unreadCount > 0 ? 1 : 0), 0);
}
