// "Forward": what is being forwarded (from the message menu, the viewer or the media page's selection) and the
// outcome, shared with the picker (Forward.tsx, its own chunk) through a tiny store. The server does the work
// (server/forward.ts): the browser names messages, never sends files.
import { useSyncExternalStore } from 'react';
import type { ForwardResult, ForwardSource } from './endpoints';
import { attachmentKind } from './attach';
import type { Attachment, Message } from './types';

export interface ForwardJob {
  sources: ForwardSource[];
  /** The files that will go, for the picker's capability hints (the server checks again). */
  files: { mime: string; size: number }[];
  /** Messages that carry text (forwarded as text, or as the caption). */
  texts: number;
}
export interface ForwardOutcome {
  id: number;
  results: ForwardResult[];
  titles: Record<string, string>;
  error?: string;
}

let job: ForwardJob | null = null;
let outcome: ForwardOutcome | null = null;
let seq = 0;
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const forwardableAtt = (a: Attachment) => !!attachmentKind(a) || (a.type === 'img' && !!a.isSticker);

/** Whether a message can be forwarded: sent (a real ID), not deleted, with text or a file. */
export function canForward(m: Message): boolean {
  if (m.isDeleted || m.id.startsWith('~') || m.sendStatus?.status === 'PENDING' || m.sendStatus?.status?.startsWith('FAIL')) return false;
  return !!m.text?.trim() || !!m.attachments?.some(forwardableAtt);
}

/** The job for messages, or single attachments of them (`att`: the attachment's index). */
export function forwardJobOf(items: { m: Pick<Message, 'id' | 'chatID' | 'text' | 'attachments'>; att?: number }[]): ForwardJob {
  const sources: ForwardSource[] = [];
  const files: ForwardJob['files'] = [];
  let texts = 0;
  for (const { m, att } of items) {
    sources.push({ chatID: m.chatID, messageID: m.id, ...(att !== undefined ? { attachment: att } : {}) });
    const atts = att !== undefined ? [m.attachments?.[att]] : (m.attachments ?? []);
    for (const a of atts) if (a && forwardableAtt(a)) files.push({ mime: a.mimeType || (a.type === 'img' ? 'image/jpeg' : a.type === 'video' ? 'video/mp4' : 'application/octet-stream'), size: a.fileSize ?? 0 });
    if (m.text?.trim()) texts++;
  }
  return { sources, files, texts };
}

export function startForward(j: ForwardJob): void {
  job = j;
  emit();
}
export function cancelForward(): void {
  job = null;
  emit();
}
export function finishForward(o: Omit<ForwardOutcome, 'id'>): void {
  job = null;
  outcome = { ...o, id: ++seq };
  emit();
}
export function dismissOutcome(id?: number): void {
  if (id !== undefined && outcome?.id !== id) return;
  outcome = null;
  emit();
}

export function useForward(): { job: ForwardJob | null; outcome: ForwardOutcome | null } {
  useSyncExternalStore(subscribe, () => version);
  return { job, outcome };
}
