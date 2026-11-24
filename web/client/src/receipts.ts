import type { Message } from './types.js';
import { chatConnector } from './connectors.js';

/**
 * Read receipts. Each member's `seen` entry sits on the latest message they read, so one of our messages
 * is read by whoever appears on it or on any later message (hidden ones included). Pages newest first,
 * items newest first. Per own message, the readers' IDs sorted and comma-joined ('' = nobody yet): a
 * string, so unchanged rows keep equal props.
 */
export function readReceipts(pages: readonly { items: readonly Message[] }[], selfIDs: ReadonlySet<string>): Map<string, string> {
  return positions(pages, selfIDs, 'seen');
}

/**
 * Delivery receipts: same shape and rule as readReceipts, from each member's `delivered` position. Some
 * connectors carry them (ConnectorUI.fullDelivery); others only what their server half inferred live (Beeper:
 * WhatsApp and Signal 1:1 chats), other messages have none ('').
 */
export function deliveryReceipts(pages: readonly { items: readonly Message[] }[], selfIDs: ReadonlySet<string>): Map<string, string> {
  return positions(pages, selfIDs, 'delivered');
}

function positions(pages: readonly { items: readonly Message[] }[], selfIDs: ReadonlySet<string>, field: 'seen' | 'delivered'): Map<string, string> {
  const out = new Map<string, string>();
  const members = new Set<string>();
  for (const page of pages) {
    for (const m of page.items) {
      for (const id of Object.keys(m[field] ?? {})) if (!selfIDs.has(id)) members.add(id);
      if (m.isSender) out.set(m.id, [...members].sort().join(','));
    }
  }
  return out;
}

/**
 * The new copy of a cached message, with the old copy's delivered ticks when it has none, for a connector that
 * does not carry them whole (ConnectorUI.fullDelivery absent): they come from its server half's inference only
 * (upstream copies never carry them) and delivery does not go back. A connector that carries them whole moves its
 * positions itself; a chat no connector claims keeps nothing.
 */
export function keepDelivered(old: Message, m: Message): Message {
  const k = chatConnector(m.chatID);
  return old.delivered && !m.delivered && k && !k.fullDelivery ? { ...m, delivered: old.delivered } : m;
}
