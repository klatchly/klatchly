// Messages of a kind with no text body of their own: a call, a shared contact, a location without coordinates,
// or one the connector cannot show. A connector gives them as their type ('CALL', 'CALL_MISSED', 'CONTACT', 'LOCATION',
// 'UNSUPPORTED'), any text being their detail (a contact's name and number). The bubble shows them as a small
// card; previews, quotes and push bodies as their type label, then the detail. Pure functions shared by the
// server (push bodies) and the client (bubble, previews).

import { oneLine } from './richtext.js';

/** Types always shown as a card (the type is the message; any text only its detail). */
const CARD_TYPES: ReadonlySet<string> = new Set(['CALL', 'CALL_MISSED', 'CONTACT', 'UNSUPPORTED']);

type Kinded = { type?: string; text?: string; attachments?: readonly unknown[] };

/** Whether this message shows as a card of its kind (never one with attachments, nor a location with text). */
export function isKindCard(m: Kinded): boolean {
  if (m.attachments?.length || !m.type) return false;
  return CARD_TYPES.has(m.type) || (m.type === 'LOCATION' && !m.text?.trim());
}

/** One line for a card message ("👤 Contact · Name"): its type label (from the catalog), then its detail. */
export function kindLine(m: Kinded, types: Readonly<Record<string, string>>): string | undefined {
  if (!isKindCard(m)) return undefined;
  const label = types[m.type!] ?? types.attachment ?? '';
  const detail = oneLine(m.text);
  return detail ? `${label} · ${detail}` : label;
}
