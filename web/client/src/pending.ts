import { useSyncExternalStore } from 'react';
import type { Message } from './types';
import { toPlainText } from '../../server/richtext';

/** Text compared loosely: the echo is rich text (HTML) rendered from our Markdown. */
export const looseText = (s: string | undefined) => toPlainText(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();

export interface OutgoingAttachment {
  name: string;
  mime: string;
  size: number;
  /** blob: URL for images, revoked when the entry goes away. */
  previewURL?: string;
  /** Voice message duration (seconds). */
  voice?: number;
}

export interface Outgoing {
  localId: string;
  chatID: string;
  text: string;
  attachment?: OutgoingAttachment;
  replyTo?: string;
  /** unknown: sent, but the server copy could not be confirmed in time (retry may duplicate). */
  status: 'pending' | 'failed' | 'unknown';
  pendingID?: string;
  createdAt: string;
}

let items: Outgoing[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let seq = 0;

export const outgoing = {
  add(chatID: string, text: string, extra?: { attachment?: OutgoingAttachment; replyTo?: string }): Outgoing {
    const o: Outgoing = {
      localId: `local-${Date.now()}-${seq++}`,
      chatID,
      text,
      ...extra,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    items = [...items, o];
    emit();
    return o;
  },
  has(localId: string): boolean {
    return items.some((o) => o.localId === localId);
  },
  update(localId: string, patch: Partial<Outgoing>): void {
    items = items.map((o) => (o.localId === localId ? { ...o, ...patch } : o));
    emit();
  },
  remove(localId: string): void {
    const o = items.find((x) => x.localId === localId);
    if (!o) return;
    if (o.attachment?.previewURL) {
      const url = o.attachment.previewURL;
      // Let the real message's image load before dropping the preview.
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    items = items.filter((x) => x.localId !== localId);
    emit();
  },
  /** An own message arrived from the server: drop the matching optimistic entry. */
  reconcile(chatID: string, m: Message): void {
    const mine = items.filter((o) => o.chatID === chatID);
    const withAtt = !!m.attachments?.length;
    const text = looseText(m.text);
    const match =
      mine.find((o) => o.pendingID === m.id) ??
      mine.find((o) => o.status !== 'failed' && !!o.attachment === withAtt && (withAtt ? true : looseText(o.text) === text));
    if (match) outgoing.remove(match.localId);
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useOutgoing(chatID: string): Outgoing[] {
  const all = useSyncExternalStore(subscribe, () => items);
  return all.filter((o) => o.chatID === chatID);
}
