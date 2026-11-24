import { heldNow } from './quiet.js';
import { noteChatAccount } from './reading.js';

// Unread messages per chat for the app icon badge: seeded from the chat list when the push watcher connects,
// kept current by chat.upserted, and by Klatchly's own archive / mute / low-priority actions as soon as they
// succeed (upstream WebSocket delivery is at-most-once, so the event alone could be missed). A chat held by quiet
// hours (server/quiet.ts) is left out until its window closes.

type Unread = { n: number; muted: boolean; archived: boolean; lowPriority: boolean; account?: string; at: number };
const unread = new Map<string, Unread>();
const MAX = 10_000;

/** Records a chat (full or partial: missing fields keep their previous value). */
export function noteChat(c: Record<string, unknown>): void {
  if (typeof c.id !== 'string') return;
  noteChatAccount(c.id, c.accountID);
  const prev = unread.get(c.id) ?? { n: 0, muted: false, archived: false, lowPriority: false, at: 0 };
  const at = typeof c.lastActivity === 'string' ? Date.parse(c.lastActivity) || prev.at : prev.at;
  const account = typeof c.accountID === 'string' && c.accountID ? c.accountID : prev.account;
  unread.set(c.id, {
    ...(account ? { account } : {}),
    at,
    n: typeof c.unreadCount === 'number' && c.unreadCount >= 0 ? Math.min(c.unreadCount, 1e6) : prev.n,
    muted: typeof c.isMuted === 'boolean' ? c.isMuted : prev.muted,
    archived: typeof c.isArchived === 'boolean' ? c.isArchived : prev.archived,
    lowPriority: typeof c.isLowPriority === 'boolean' ? c.isLowPriority : prev.lowPriority,
  });
  if (unread.size > MAX) unread.delete(unread.keys().next().value!);
}

/** Replaces the chats `owned` selects (the upstream ones) with a fresh full list. */
export function reseedUnread(chats: Record<string, unknown>[], owned: (id: string) => boolean): void {
  for (const id of [...unread.keys()]) if (owned(id)) unread.delete(id);
  for (const c of chats) noteChat(c);
}

/** Forgets the chats `owned` selects (a connector gone off). */
export function dropUnread(owned: (id: string) => boolean): void {
  for (const id of [...unread.keys()]) if (owned(id)) unread.delete(id);
}

export function noteRead(chatID: string): void {
  const u = unread.get(chatID);
  if (u) u.n = 0;
}

/**
 * Total unread messages in non-muted, non-archived, non-low-priority chats that quiet hours do not hold;
 * `atLeastOne` counts a just-received message.
 */
export function badgeCount(atLeastOne?: string, now = Date.now()): number {
  let n = 0;
  for (const [id, u] of unread) {
    if (u.muted || u.archived || u.lowPriority) continue;
    const count = id === atLeastOne ? Math.max(u.n, 1) : u.n;
    if (count && heldNow({ id, unreadCount: count, lastActivity: id === atLeastOne ? now : u.at, ...(u.account ? { accountID: u.account } : {}) }, now)) continue;
    n += count;
  }
  if (atLeastOne && !unread.has(atLeastOne)) n += 1;
  return n;
}
