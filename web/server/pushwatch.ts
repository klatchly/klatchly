import { suppressedFor } from './ws.js';
import { hasSubscriptions, pushAll, setBadgeSource, type Payload } from './push.js';
import { log } from './log.js';
import { messages } from './i18n.js';
import { kindLine } from './msgkind.js';
import { oneLine } from './richtext.js';
import { parseCallEvent } from './callevent.js';
import { isRawUserID, senderLabel } from './names.js';
import { emitChatEvent } from './chatactor.js';
import { badgeCount, dropUnread, noteChat, reseedUnread } from './badgecount.js';
import type { SourceEvent } from './connector.js';
import type { ConnectorModule } from './registry.js';
import { connectorFor } from './sources.js';
import { quietNow } from './quiet.js';
import { dropShared } from './inflight.js';

export { badgeCount, noteChat, noteRead } from './badgecount.js';

// The connectors' events (ModuleContext.feed, see sourceEvent below; Beeper: one persistent upstream socket,
// independent of browser sockets), turned into Web Push notifications for new incoming messages.
// Nothing is sent for our own messages, muted chats, old/backfilled or edited messages. Per device: nothing
// while that device has the app visible and focused, nor about the chat a visible window of that device is
// showing (see ws.ts suppressed()); other devices still get it. It also tracks unread counts for the app icon
// badge, and hands message upserts to the 'events' augmentations (chatactor.ts).

const FRESH_MS = 10 * 60 * 1000;
const CHAT_TTL_MS = 60_000;
const SEEN_MAX = 2000;
const RESEED_MS = 5 * 60_000;

type Msg = {
  id?: unknown;
  chatID?: unknown;
  senderName?: unknown;
  senderID?: unknown;
  timestamp?: unknown;
  type?: unknown;
  text?: unknown;
  isSender?: unknown;
  isHidden?: unknown;
  isDeleted?: unknown;
  editedTimestamp?: unknown;
  attachments?: unknown;
};
type ChatInfo = { title: string; type: string; isMuted: boolean; isLowPriority?: boolean; accountID?: string; at: number };

const seen = new Set<string>();
const chats = new Map<string, ChatInfo>();

// Every push (chat, a package's, test) carries the current unread total as app_badge.
setBadgeSource(() => badgeCount());

/** Recounts a connector's chats (every one: see its unreadChats) for the badge; other sources' entries stay. True when it did. */
async function seedUnread(source: ConnectorModule): Promise<boolean> {
  try {
    const seen = (await source.unreadChats()) as Record<string, unknown>[];
    reseedUnread(seen, (id) => connectorFor(id) === source);
    return true;
  } catch {
    log('pushwatch', 'unread seed failed');
    return false;
  }
}

function remember(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
  return true;
}

/** Whether an upserted message deserves a notification (pure; exported for tests). */
export function isNotifiable(m: Msg, now = Date.now()): boolean {
  if (typeof m.id !== 'string' || typeof m.chatID !== 'string') return false;
  if (m.isSender === true || m.isHidden === true || m.isDeleted === true || m.editedTimestamp) return false;
  if (m.type === 'REACTION' || m.type === 'NOTICE') return false;
  const ts = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN;
  return Number.isFinite(ts) && now - ts < FRESH_MS && ts - now < FRESH_MS;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function payloadFor(m: Msg, chat: Pick<ChatInfo, 'title' | 'type'>, lang?: string, badge?: number): Payload {
  const t = messages(lang).push;
  const sender =
    senderLabel(typeof m.senderName === 'string' ? m.senderName : undefined, typeof m.senderID === 'string' ? m.senderID : undefined, messages(lang).common.member) ||
    chat.title ||
    '•';
  const title = chat.type === 'group' && chat.title && chat.title !== sender ? t.groupTitle(sender, chat.title) : sender;
  const call = typeof m.text === 'string' ? parseCallEvent(m.text) : null;
  const callMsg = messages(lang).call;
  const kind = kindLine({ type: typeof m.type === 'string' ? m.type : undefined, text: typeof m.text === 'string' ? m.text : undefined, attachments: Array.isArray(m.attachments) ? m.attachments : undefined }, messages(lang).types);
  const text = call ? t.call(call.title || (call.video ? callMsg.video : callMsg.voice)) : kind ?? (typeof m.text === 'string' ? oneLine(m.text) : '');
  const body = text
    ? clip(text, 120)
    : m.type === 'IMAGE'
      ? t.photo
      : m.type === 'VIDEO'
        ? t.video
        : m.type === 'VOICE' || m.type === 'AUDIO'
          ? t.audio
          : m.type === 'STICKER'
            ? t.sticker
            : t.attachment;
  const chatID = m.chatID as string;
  const ts = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : undefined;
  return {
    title: clip(title, 80),
    body,
    tag: chatID,
    url: `/chat/${encodeURIComponent(chatID)}`,
    ...(ts ? { ts } : {}),
    chatID,
    ...(badge !== undefined ? { badge } : {}),
    labels: { reply: t.reply, read: t.markRead, placeholder: t.replyPlaceholder, replyFailed: t.replyFailed },
  };
}

async function chatInfo(chatID: string): Promise<ChatInfo | null> {
  const c = chats.get(chatID);
  if (c && Date.now() - c.at < CHAT_TTL_MS) return c;
  try {
    const source = connectorFor(chatID);
    if (!source) return c ?? null;
    const r = await source.chat(chatID, 0);
    const info = {
      title: r.title ?? '',
      type: r.type ?? 'single',
      isMuted: !!r.isMuted,
      isLowPriority: !!r.isLowPriority,
      ...(typeof r.accountID === 'string' && r.accountID ? { accountID: r.accountID } : {}),
      at: Date.now(),
    };
    chats.set(chatID, info);
    if (chats.size > 2000) chats.delete(chats.keys().next().value!);
    return info;
  } catch {
    return c ?? null;
  }
}

// Beeper resolves member names only in message lists; previews and live entries of big bridged groups
// can carry the raw Matrix ID. Names seen in entries are kept, and an unknown sender is looked up once
// in the chat's latest messages before the push title is built.
const names = new Map<string, string>();
function learn(list: readonly Msg[]): void {
  for (const m of list) {
    if (typeof m.senderID !== 'string' || typeof m.senderName !== 'string') continue;
    const n = m.senderName.trim();
    if (!n || isRawUserID(n)) continue;
    names.delete(m.senderID);
    names.set(m.senderID, n);
    if (names.size > 5000) names.delete(names.keys().next().value!);
  }
}

// Senders a lookup read the chat for and did not resolve (chat\nsender → when; not a failed lookup): not looked up again for a while, so that every message of
// a big group with an unnamed member does not read the chat's latest messages again. One lookup per chat at a time.
const unresolved = new Map<string, number>();
const UNRESOLVED_MS = 10 * 60_000;
// Whether the lookup could read the chat's messages (an upstream failure is never remembered as "no name").
const lookups = new Map<string, Promise<boolean>>();

export async function withSenderName(m: Msg, chatID: string): Promise<Msg> {
  const raw = typeof m.senderName !== 'string' || !m.senderName.trim() || isRawUserID(m.senderName);
  if (!raw || typeof m.senderID !== 'string') return m;
  const miss = `${chatID}\n${m.senderID}`;
  const missedAt = unresolved.get(miss);
  if (!names.has(m.senderID) && (missedAt === undefined || Date.now() - missedAt > UNRESOLVED_MS)) {
    let lookup = lookups.get(chatID);
    if (!lookup) {
      lookup = (async () => {
        try {
          const source = connectorFor(chatID);
          if (!source) return false;
          learn(((await source.messages(chatID, {})).items ?? []) as Msg[]);
          return true;
        } catch {
          // keep the fallback label; asked again next time
          return false;
        }
      })().finally(() => lookups.delete(chatID));
      lookups.set(chatID, lookup);
    }
    const looked = await lookup;
    if (looked && !names.has(m.senderID)) {
      unresolved.delete(miss);
      unresolved.set(miss, Date.now());
      if (unresolved.size > 2000) unresolved.delete(unresolved.keys().next().value!);
    }
  }
  const n = names.get(m.senderID);
  return n ? { ...m, senderName: n } : m;
}

/** One event of a connector (by its id): badge, notifications, the 'events' augmentations. */
export async function handleEvent(ev: { type?: unknown; entries?: unknown }, source: string): Promise<void> {
  if (!Array.isArray(ev.entries)) return;
  if (ev.type === 'chat.upserted') {
    for (const c of ev.entries as Record<string, unknown>[]) {
      if (typeof c?.id !== 'string') continue;
      noteChat(c);
      const prev = chats.get(c.id);
      chats.set(c.id, {
        title: typeof c.title === 'string' ? c.title : (prev?.title ?? ''),
        type: typeof c.type === 'string' ? c.type : (prev?.type ?? 'single'),
        isMuted: typeof c.isMuted === 'boolean' ? c.isMuted : !!prev?.isMuted,
        isLowPriority: typeof c.isLowPriority === 'boolean' ? c.isLowPriority : !!prev?.isLowPriority,
        ...(typeof c.accountID === 'string' && c.accountID ? { accountID: c.accountID } : prev?.accountID ? { accountID: prev.accountID } : {}),
        at: typeof c.isMuted === 'boolean' ? Date.now() : (prev?.at ?? 0),
      });
    }
    return;
  }
  if (ev.type !== 'message.upserted') return;
  // The 'events' augmentations' stream (chatactor.ts): own messages too, before the notification filter.
  try {
    emitChatEvent(ev, source);
  } catch {
    log('pushwatch', 'chat event stream error');
  }
  learn(ev.entries as Msg[]);
  for (const e of ev.entries as Msg[]) {
    let m = e;
    if (!m || !isNotifiable(m)) continue;
    if (!remember(`${m.chatID as string}/${m.id as string}`)) continue;
    if (!hasSubscriptions()) continue;
    const chatID = m.chatID as string;
    const chat = await chatInfo(chatID);
    // Low-priority chats never notify, even when the move did not mute them.
    if (!chat || chat.isMuted || chat.isLowPriority) continue;
    // Quiet hours (server/quiet.ts): held until its window closes, no notification meanwhile.
    if (quietNow(chatID, chat.accountID)) {
      log('push', 'held by quiet hours');
      continue;
    }
    if (chat.type === 'group') m = await withSenderName(m, chatID);
    const badge = badgeCount(chatID);
    const r = await pushAll((s) => (suppressedFor(s.sessionHash, chatID) ? null : payloadFor(m, chat, s.lang, badge)));
    log('push', 'notified', { sent: r.sent, failed: r.failed, skipped: r.skipped });
  }
}

// Reads made elsewhere (other Beeper apps) do not always come back as chat.upserted: recount now and then, every
// RESEED_MS while connected. A 'ready' recounts at once only when the last recount is older than that: a source whose
// socket drops and comes back often (a slow upstream missing its pongs) no longer pages through every chat each time
// (2026-11-18). A failed recount is tried again a minute later.
const RESEED_RETRY_MS = 60_000;
const reseeds = new Map<ConnectorModule, { timer?: NodeJS.Timeout; last: number; live?: boolean; running?: Promise<boolean> }>();

function reseedState(source: ConnectorModule) {
  let s = reseeds.get(source);
  if (!s) reseeds.set(source, (s = { last: 0 }));
  return s;
}

function scheduleReseed(source: ConnectorModule, wait: number): void {
  const s = reseedState(source);
  clearTimeout(s.timer);
  s.timer = undefined;
  const run = () => {
    s.timer = undefined;
    // One recount at a time (a 'ready' while one runs joins it).
    s.running ??= seedUnread(source).finally(() => (s.running = undefined));
    void s.running.then((ok) => {
      if (ok) s.last = Date.now();
      // Still connected (not 'closed' or off meanwhile) and nothing scheduled since: the next recount.
      if (reseeds.get(source) === s && s.timer === undefined && s.live) scheduleReseed(source, ok ? RESEED_MS : RESEED_RETRY_MS);
    });
  };
  if (wait <= 0) return run();
  s.timer = setTimeout(run, wait);
  s.timer.unref?.();
}

/** When the next recount of a connector that has just connected is due (now, unless the last one is recent). Pure; exported for tests. */
export const reseedWait = (last: number, now = Date.now()): number => Math.max(0, last + RESEED_MS - now);

/**
 * A connector whose package went off (registry.ts): its badge reseeding stops, and its chats leave the unread
 * count (they belong to nobody now). A legacy catch-all (no `owns`) keeps its entries: they cannot be told apart.
 */
export function sourceOff(source: ConnectorModule): void {
  clearTimeout(reseeds.get(source)?.timer);
  reseeds.delete(source);
  if (source.owns) dropUnread(source.owns);
}

/** A connector's event (ModuleContext.feed.event, while its package is on). */
export function sourceEvent(source: ConnectorModule, ev: SourceEvent): void {
  // Whatever the browsers' identical reads keep for a moment may be stale now (inflight.ts).
  dropShared();
  if (ev.type === 'ready') {
    const s = reseedState(source);
    s.live = true;
    scheduleReseed(source, reseedWait(s.last));
    return;
  }
  if (ev.type === 'closed') {
    const s = reseeds.get(source);
    if (s) {
      s.live = false;
      clearTimeout(s.timer);
      s.timer = undefined;
    }
    return;
  }
  handleEvent(ev, source.id).catch(() => log('pushwatch', 'handler error'));
}
