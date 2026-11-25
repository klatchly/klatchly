import { log } from './log.js';
import { membershipOf } from './membership.js';
import { owner, project, sourceRecent, type ReadMessage } from './chatread.js';
import { connectorFor, from } from './sources.js';

// What an 'events' augmentation (one that acts in chats on its own, e.g. a chat agent) gets beyond the on-demand
// reader: the stream of new messages (the module's onEvent, fed by the registry from pushwatch.ts with the
// connectors' events), the chat's latest page with ids and authors, the chat's details, and sending in the
// user's name. Handed out by the registry to those modules only, bound to their package; every read and send
// is logged with the package id, never with content. The chat's details and sending only where the chat's
// connector allows it (capabilities.actorSend): elsewhere a package reads the latest messages and nothing more.

/** A message as an 'events' augmentation sees it: the reader's fields, plus its ids, author id and edit mark. */
export interface EventMessage extends ReadMessage {
  id: string;
  chatID: string;
  senderID?: string;
  /** Present once the message was edited. */
  editedTimestamp?: string;
  /** How many attachments it has (never their content). */
  attachments?: number;
}

/** What the stream carries: new or updated messages (other upstream events are the core's). */
export interface ChatEvent {
  type: 'message.upserted';
  entries: EventMessage[];
  /** The source of these messages: its connector's id ('beeper'…). */
  source: string;
}

export interface ChatInfo {
  title: string;
  /** 'single' or 'group'. */
  type: string;
  /** The network's name (WhatsApp, Telegram…). */
  network: string;
  /** The user's own name in this chat, when the source knows it. */
  selfName: string | null;
  /** Its source: the connector's id ('beeper'). */
  source: string;
  /** Whether a send may quote a message (replyTo): false where the network has no replies (some connectors). (1.8.0) */
  replies: boolean;
}

export interface ChatActor {
  /** The chat's latest page of messages, newest first, with ids and authors. Throws upstream errors. */
  recentMessages(chatID: string): Promise<EventMessage[]>;
  /** The chat's title, type, network and the user's name in it, where canSend. Throws upstream errors. */
  chat(chatID: string): Promise<ChatInfo>;
  /** Whether a package may send in this chat (its connector allows it: capabilities.actorSend). */
  canSend(chatID: string): boolean;
  /** Sends a text message in the user's name (optionally a reply). Throws upstream errors. */
  send(chatID: string, text: string, replyTo?: string): Promise<{ pendingMessageID?: string }>;
}

/** The fields of EventMessage, checked; null without a message id and a chat id. */
export function projectEvent(m: unknown, chatID?: string): EventMessage | null {
  const src = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
  const chat = typeof src.chatID === 'string' ? src.chatID : chatID;
  if (typeof src.id !== 'string' || typeof chat !== 'string') return null;
  const out: EventMessage = { ...project(src), id: src.id, chatID: chat };
  if (typeof src.senderID === 'string') out.senderID = src.senderID;
  if (typeof src.editedTimestamp === 'string' && src.editedTimestamp) out.editedTimestamp = src.editedTimestamp;
  if (Array.isArray(src.attachments)) out.attachments = src.attachments.length;
  return out;
}

// ── The stream (pushwatch.ts emits, the registry subscribes the 'events' modules) ──

const listeners = new Set<(ev: ChatEvent) => void>();
/** Tests: how many subscribers the stream has (one per started 'events' augmentation). */
export const chatEventSubscribers = (): number => listeners.size;

export function onChatEvent(l: (ev: ChatEvent) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** A connector's event: message upserts go to the subscribed modules, projected. */
export function emitChatEvent(ev: { type?: unknown; entries?: unknown }, source: string): void {
  if (ev.type !== 'message.upserted' || !Array.isArray(ev.entries) || !listeners.size) return;
  // Arrivals and departures (membership.ts) are no message for the packages (a chat agent would greet them).
  const entries = ev.entries.flatMap((m) => (m && typeof m === 'object' && membershipOf(m as Record<string, unknown>) ? [] : (projectEvent(m) ?? [])));
  if (!entries.length) return;
  const out: ChatEvent = { type: 'message.upserted', entries, source };
  for (const l of listeners) l(out);
}

// ── Reads and sends ──

/**
 * The actor of one package. `live`: whether that package is on (the registry's): once it is off, every read and
 * send is refused (a run still under way when it was turned off goes no further).
 */
export function chatActor(pkg: string, live: () => boolean = () => true): ChatActor {
  const on = () => {
    if (!live()) throw new Error('package off');
  };
  return {
    async recentMessages(chatID) {
      on();
      const items = await sourceRecent(chatID);
      log('chatactor', 'recent', { pkg, count: items.length });
      return items.flatMap((m) => projectEvent(m, chatID) ?? []);
    },
    async chat(chatID) {
      on();
      const source = owner(chatID);
      if (!source.capabilities.actorSend) throw new Error('unsupported chat');
      log('chatactor', 'chat', { pkg });
      const c = await from(source, () => source.chat(chatID, 50));
      const self = c.participants?.items?.find((p) => p.isSelf);
      const network = c.network ?? c.accountID ?? '';
      // Capabilities as the bridge reports them: none known means no restriction (caps.ts).
      const caps = c.capabilities as { reply?: number } | undefined;
      const replies = !caps || !Object.keys(caps).length || (caps.reply ?? 0) >= 1;
      return { title: c.title ?? '', type: c.type ?? 'single', network, selfName: self?.fullName?.trim() || null, source: source.id, replies };
    },
    canSend: (chatID) => live() && !!connectorFor(chatID)?.capabilities.actorSend,
    async send(chatID, text, replyTo) {
      on();
      const source = connectorFor(chatID);
      // Never in a chat whose connector does not allow it, whatever the package asks.
      if (!source?.capabilities.actorSend) throw new Error('unsupported chat');
      const r = await from(source, () => source.send(chatID, { text, ...(replyTo ? { replyToMessageID: replyTo } : {}) }));
      log('chatactor', 'send', { pkg, chars: text.length });
      return { pendingMessageID: r.pendingMessageID };
    },
  };
}
