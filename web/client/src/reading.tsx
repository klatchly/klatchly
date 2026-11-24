import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, HttpError, type ReadingReply } from './endpoints';
import { upsertChat } from './cache';
import { useT } from './i18n';
import { clearNotifications } from './read';
import type { Chat } from './types';

// Discreet reading (server/reading.ts): which accounts read without telling the sender, and the explicit
// "Mark as read" that tells them. Opening a chat still calls the plain read (read.ts): the server decides.

export const readingKey = ['reading'] as const;

export const useReading = () => useQuery({ queryKey: readingKey, queryFn: api.reading, staleTime: 5 * 60_000 });

/**
 * A chat's discreet reading as the server applies it (server/reading.ts discreetChat): `discreet`, its own choice
 * (`own`, undefined: its account's) over its account's; quiet anyway when no receipt can go now. `choosable`: its
 * menu offers the choice (the network takes a read receipt from Klatchly now, so the choice changes something).
 */
export function chatReading(reading: ReadingReply | undefined, chat: Pick<Chat, 'id' | 'accountID'> | undefined) {
  const a = chat && reading?.accounts.find((x) => x.accountID === chat.accountID);
  const s = a?.support;
  const own = chat ? reading?.chats?.[chat.id] : undefined;
  const choosable = !!s?.send && s.available;
  const discreet = !!s && (own === undefined || !choosable ? !!a?.discreet : own);
  return { discreet, own, choosable, send: !!s?.send, replyMayTell: !!s?.replyMayTell || !!s?.replyTells, replyTells: !!s?.replyTells };
}

/** Whether this chat reads discreetly and its network takes a read receipt from Klatchly: the "Mark as read" action then. */
export function canSendReceipt(reading: ReadingReply | undefined, chat: Pick<Chat, 'id' | 'accountID'> | undefined): boolean {
  const r = chatReading(reading, chat);
  return r.discreet && r.send;
}

/** Sets a chat's own choice (null: back to its account's); the reply updates every view. */
export async function setChatDiscreet(qc: QueryClient, chatID: string, discreet: boolean | null): Promise<void> {
  qc.setQueryData(readingKey, await api.setChatDiscreet(chatID, discreet));
}

/** Tells the network the chat was read; the toast text for the outcome. */
export async function sendReceipt(qc: QueryClient, chatID: string, t: ReturnType<typeof useT>): Promise<string> {
  try {
    await api.sendReadReceipt(chatID);
    upsertChat(qc, { id: chatID, unreadCount: 0 });
    clearNotifications(chatID);
    return t.reading.sent;
  } catch (e) {
    if (e instanceof HttpError && e.code === 'receipt_unavailable') return t.reading.unavailable;
    if (e instanceof HttpError && e.code === 'receipt_skipped') return t.reading.skipped;
    return t.reading.sendFailed;
  }
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M2.5 12.5l4 4 8-9M10.5 15.5l1 1 8-9" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The conversation header's "Mark as read", only in a chat that reads discreetly. */
export function MarkReadButton({ chat, notify }: { chat: Chat | undefined; notify: (text: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const reading = useReading().data;
  if (!chat || !canSendReceipt(reading, chat)) return null;
  return (
    <button
      type="button"
      className="icon-btn"
      data-testid="conv-mark-read"
      aria-label={`${t.reading.markRead} · ${t.reading.markReadHint}`}
      title={`${t.reading.markRead} · ${t.reading.markReadHint}`}
      onClick={() => void sendReceipt(qc, chat.id, t).then(notify)}
    >
      <CheckIcon />
    </button>
  );
}

/** In the conversation header, after the network: an eye struck through while the chat reads discreetly. */
export function DiscreetMark({ chat }: { chat: Chat | undefined }) {
  const t = useT();
  const reading = useReading().data;
  if (!chat || !chatReading(reading, chat).discreet) return null;
  return (
    <span className="discreet-mark" role="img" data-testid="conv-discreet" aria-label={t.reading.title} title={t.reading.title}>
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path
          d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13 13 0 0 1-2.6 3.8M6.6 6.6C4.6 8 3.2 10 2.5 12c1 2.5 4.5 7 9.5 7 1.9 0 3.6-.6 5-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

// The chats whose reply hint was shown (this device): once per chat, never again.
const HINT_KEY = 'reply-hint-shown';
const HINT_MAX = 500;
function firstHint(chatID: string): boolean {
  try {
    const seen = JSON.parse(localStorage.getItem(HINT_KEY) ?? '[]') as unknown;
    const list = Array.isArray(seen) ? seen.filter((x): x is string => typeof x === 'string') : [];
    if (list.includes(chatID)) return false;
    localStorage.setItem(HINT_KEY, JSON.stringify([...list, chatID].slice(-HINT_MAX)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Above the composer, once per chat that reads discreetly on a network where replying may tell the sender anyway
 * (ReceiptSupport.replyMayTell), or always does (replyTells: said as certain): one short line, dismissible.
 */
export function ReplyHint({ chat }: { chat: Chat | undefined }) {
  const t = useT();
  const reading = useReading().data;
  const r = chatReading(reading, chat);
  const applies = r.discreet && r.replyMayTell;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (applies && chat && firstHint(chat.id)) setShown(true);
  }, [applies, chat?.id]);
  if (!shown) return null;
  return (
    <div className="reply-hint" role="note" data-testid="reply-hint" data-sure={r.replyTells || undefined}>
      <span>{r.replyTells ? t.reading.replyHintSure : t.reading.replyHint}</span>
      <button type="button" className="icon-btn small" aria-label={t.common.close} onClick={() => setShown(false)}>
        ×
      </button>
    </div>
  );
}
