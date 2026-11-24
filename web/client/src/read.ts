import type { QueryClient } from '@tanstack/react-query';
import { api } from './endpoints';
import { findChat, upsertChat } from './cache';

const last = new Map<string, number>();
const trailing = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The chat's notifications still in the notification centre (pushes are tagged with the chat ID): read
 * here, so they go. Best effort: not every browser lists the notifications it showed.
 */
export function clearNotifications(chatID: string): void {
  try {
    void navigator.serviceWorker?.ready
      .then((r) => r.getNotifications())
      .then((ns) => {
        for (const n of ns) if (n.tag === chatID || (n.data as { chatID?: unknown } | null)?.chatID === chatID) n.close();
      })
      .catch(() => {});
  } catch {
    // no service worker here
  }
}

/**
 * Mark a chat read upstream (throttled) and clear its local unread count. The server decides whether the network is
 * told (discreet reading, server/reading.ts); the explicit "Mark as read" is reading.tsx sendReceipt.
 */
export function markChatRead(qc: QueryClient, chatID: string): void {
  // Even when already read here (read on another device, say), its notifications may still be shown.
  clearNotifications(chatID);
  const chat = findChat(qc, chatID);
  if (chat && chat.unreadCount === 0) return;
  const now = Date.now();
  const wait = 2000 - (now - (last.get(chatID) ?? 0));
  if (wait > 0) {
    // Throttled: once more when the 2 s are up (a message that came meanwhile is read too), not dropped.
    if (!trailing.has(chatID)) trailing.set(chatID, setTimeout(() => (trailing.delete(chatID), markChatRead(qc, chatID)), wait));
    return;
  }
  last.set(chatID, now);
  upsertChat(qc, { id: chatID, unreadCount: 0 });
  api.markRead(chatID).catch(() => {});
}
