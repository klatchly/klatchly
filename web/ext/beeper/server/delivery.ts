import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dataPath, log } from '#core/sdk.js';
import { api } from './upstream.js';

// "Delivered" (grey double tick) for Beeper networks, inferred from the live upstream stream.
//
// The Desktop API carries no delivery receipts: messages only have `sendStatus` while sending, and a GET never
// returns it. What it does show, on WhatsApp and Signal, is one more message.upserted for our message about when the
// recipient's phone gets it (when WhatsApp turns to grey ✓✓): an upsert whose content is unchanged from the
// confirmed one (the receipt itself is stripped). So, per own message in a 1:1 chat of an allowed network:
// after the confirmation (sendStatus gone or SUCCESS), a later upsert with the same content means delivered.
// A `seen` entry of the other participant means delivered too (read implies delivered). Groups are ignored
// (one upsert cannot tell whose phone got it), other sources carry their own receipts, and messages not watched live
// (sent before this process started, missed while disconnected) stay unknown.
//
// What is inferred is kept in data/delivered.json (bounded, oldest out first) and added to the messages the
// connector returns (enrich*: pages, single messages, live frames), since nothing upstream keeps it.

/** Networks whose upsert sequence has been checked to behave as above (Chat.network, lower case). */
const NETWORKS = /whatsapp|signal/i;
const MAX_ENTRIES = 20_000;
const MAX_AGE_MS = 60 * 24 * 3600 * 1000;
const SAVE_DELAY_MS = 2000;
const TRACK_MAX = 2000;
// A message first seen already confirmed (sent from a phone or another app, or whose ID changed on
// confirmation) is only tracked when it is this recent: older ones are not being sent right now.
const FRESH_MS = 2 * 60_000;
const PEER_TTL_MS = 6 * 3600_000;
const PEER_MAX = 2000;

export type Delivered = Record<string, string>;
type Entry = { to: Delivered; at: number };
type Msg = Record<string, unknown>;

export type DeliveryEvent = { type: 'message.delivered'; chatID: string; messageID: string; delivered: Delivered };
type Listener = (ev: DeliveryEvent) => void;
const listeners = new Set<Listener>();
export function onDeliveryEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const key = (chatID: string, messageID: string) => `${chatID}\n${messageID}`;
const file = () => dataPath('delivered.json');

let entries: Map<string, Entry> | undefined;
let saveTimer: NodeJS.Timeout | undefined;

function store(): Map<string, Entry> {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { items?: unknown };
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const it of Array.isArray(raw.items) ? raw.items : []) {
      if (!Array.isArray(it) || it.length !== 4) continue;
      const [chatID, messageID, to, at] = it as unknown[];
      if (typeof chatID !== 'string' || typeof messageID !== 'string' || typeof at !== 'number' || at < cutoff) continue;
      if (!to || typeof to !== 'object' || Array.isArray(to)) continue;
      const clean: Delivered = {};
      for (const [p, t] of Object.entries(to as Record<string, unknown>)) if (typeof t === 'string') clean[p] = t;
      if (Object.keys(clean).length) entries.set(key(chatID, messageID), { to: clean, at });
    }
    trim(entries);
  } catch {
    // first run
  }
  return entries;
}

function trim(m: Map<string, Entry>): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  // Insertion order is age order (a mark moves its entry to the end).
  for (const [k, e] of m) {
    if (m.size <= MAX_ENTRIES && e.at >= cutoff) break;
    m.delete(k);
  }
}

/** Writes the store now (also the debounced save; tests and shutdown call it directly). */
export function flushDelivered(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!entries) return;
  trim(entries);
  try {
    const items = [...entries].map(([k, e]) => {
      const i = k.indexOf('\n');
      return [k.slice(0, i), k.slice(i + 1), e.to, e.at];
    });
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, items }) + '\n', { mode: 0o600 });
    renameSync(tmp, file());
  } catch {
    log('delivery', 'store write failed');
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flushDelivered, SAVE_DELAY_MS);
  saveTimer.unref();
}

export function deliveredFor(chatID: string, messageID: string): Delivered | undefined {
  return store().get(key(chatID, messageID))?.to;
}

/** Records that `messageID` reached `participantID` at `at` (first time wins). Returns whether it was new. */
export function markDelivered(chatID: string, messageID: string, participantID: string, at: string, now = Date.now()): boolean {
  const s = store();
  const k = key(chatID, messageID);
  const e = s.get(k);
  if (e?.to[participantID]) return false;
  const next: Entry = { to: { ...e?.to, [participantID]: at }, at: now };
  s.delete(k);
  s.set(k, next);
  trim(s);
  scheduleSave();
  const ev: DeliveryEvent = { type: 'message.delivered', chatID, messageID, delivered: next.to };
  listeners.forEach((l) => l(ev));
  return true;
}

/** Adds the known `delivered` to Desktop API messages (a list page, one message, socket entries). Pure on misses. */
export function enrichMessage<T>(m: T): T {
  if (!m || typeof m !== 'object') return m;
  const o = m as Msg;
  if (o.isSender !== true || typeof o.id !== 'string' || typeof o.chatID !== 'string') return m;
  const d = deliveredFor(o.chatID, o.id);
  if (!d) return m;
  const own = o.delivered && typeof o.delivered === 'object' ? (o.delivered as Delivered) : {};
  return { ...o, delivered: { ...d, ...own } } as T;
}

export function enrichPage<T extends { items?: unknown }>(page: T): T {
  if (!page || !Array.isArray(page.items) || !store().size) return page;
  return { ...page, items: page.items.map(enrichMessage) };
}

/**
 * A raw upstream socket frame on its way to a browser: message.upserted entries get their `delivered`.
 * Returns the frame unchanged (same string) when there is nothing to add.
 */
export function enrichFrame(text: string): string {
  if (!store().size || !text.includes('"message.upserted"')) return text;
  let ev: { type?: unknown; entries?: unknown };
  try {
    ev = JSON.parse(text) as typeof ev;
  } catch {
    return text;
  }
  if (ev.type !== 'message.upserted' || !Array.isArray(ev.entries)) return text;
  let changed = false;
  const list = ev.entries.map((m) => {
    const r = enrichMessage(m);
    if (r !== m) changed = true;
    return r;
  });
  return changed ? JSON.stringify({ ...ev, entries: list }) : text;
}

// ---- inference ----

type Track = { sig: string; confirmed: boolean };
const tracks = new Map<string, Track>();

const confirmedStatus = (m: Msg) => {
  const s = m.sendStatus as { status?: unknown } | null | undefined;
  return !s || s.status === 'SUCCESS';
};

/** What a delivery receipt does not change: content, reactions, receipts, send state. Exported for tests. */
export function signature(m: Msg): string {
  return JSON.stringify([
    m.type ?? null,
    m.text ?? null,
    m.links ?? null,
    m.reactions ?? null,
    m.editedTimestamp ?? null,
    m.attachments ?? null,
    m.isDeleted ?? null,
    m.seen ?? null,
    m.sendStatus ?? null,
  ]);
}

export type Peer = { peerID: string } | null;
type PeerResolver = (chatID: string) => Promise<Peer>;

const peers = new Map<string, { peer: Peer; at: number }>();

// Lookups under way, by chat: a burst of upserts in one chat asks upstream once.
const peerLookups = new Map<string, Promise<Peer>>();

/** The chat's other participant when it is a 1:1 chat on an allowed network, else null (cached; one lookup per chat at a time). */
export function upstreamPeer(chatID: string): Promise<Peer> {
  const c = peers.get(chatID);
  if (c && Date.now() - c.at < PEER_TTL_MS) return Promise.resolve(c.peer);
  let p = peerLookups.get(chatID);
  if (!p) {
    p = lookupPeer(chatID, c).finally(() => peerLookups.delete(chatID));
    peerLookups.set(chatID, p);
  }
  return p;
}

async function lookupPeer(chatID: string, c: { peer: Peer } | undefined): Promise<Peer> {
  try {
    const chat = (await api().chats.retrieve(chatID, { maxParticipantCount: 5 })) as {
      type?: string;
      network?: string;
      participants?: { items?: { id?: string; isSelf?: boolean }[] };
    };
    const others = (chat.participants?.items ?? []).filter((p) => !p.isSelf && typeof p.id === 'string');
    const peer: Peer = chat.type === 'single' && NETWORKS.test(chat.network ?? '') && others.length === 1 ? { peerID: others[0]!.id! } : null;
    peers.set(chatID, { peer, at: Date.now() });
    if (peers.size > PEER_MAX) peers.delete(peers.keys().next().value!);
    return peer;
  } catch {
    return c?.peer ?? null;
  }
}

let resolvePeer: PeerResolver = upstreamPeer;
/** Tests: replace the chat lookup. */
export function setPeerResolver(r: PeerResolver | null): void {
  resolvePeer = r ?? upstreamPeer;
  peers.clear();
}
/** Tests: forget the in-memory tracking and the loaded store (the file stays). */
export function resetDeliveryState(): void {
  tracks.clear();
  clearTimeout(saveTimer);
  saveTimer = undefined;
  entries = undefined;
}

const suffix = (id: string) => id.slice(-4);

async function mark(chatID: string, messageID: string, why: 'upsert' | 'seen', at: string, seenBy?: string): Promise<void> {
  const peer = await resolvePeer(chatID);
  if (!peer) return;
  // Read implies delivered only when the reader is the peer.
  if (seenBy !== undefined && seenBy !== peer.peerID) return;
  if (markDelivered(chatID, messageID, peer.peerID, at)) log('delivery', 'inferred', { why, msg: suffix(messageID) });
}

/**
 * One upstream message.upserted batch (events.ts: the persistent socket, every chat). Synchronous bookkeeping, so the
 * order of upserts is kept; the chat lookup and the mark happen afterwards. Resolves when those are done.
 */
export function trackDelivery(list: readonly unknown[], now = Date.now()): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Msg;
    if (m.isSender !== true || typeof m.id !== 'string' || typeof m.chatID !== 'string') continue;
    if (m.type === 'REACTION' || m.isHidden === true) continue;
    const chatID = m.chatID;
    const id = m.id;
    const k = key(chatID, id);
    const at = new Date(now).toISOString();

    // Read implies delivered: a `seen` entry other than ours (the sender).
    const seen = m.seen && typeof m.seen === 'object' ? (m.seen as Record<string, unknown>) : {};
    for (const [p, t] of Object.entries(seen)) {
      if (p === m.senderID || deliveredFor(chatID, id)?.[p]) continue;
      jobs.push(mark(chatID, id, 'seen', typeof t === 'string' ? t : at, p));
    }

    const sig = signature(m);
    const confirmed = confirmedStatus(m);
    const prev = tracks.get(k);
    if (!prev) {
      const ts = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN;
      // Pending: being sent now. Confirmed at first sight: only when recent.
      if (!confirmed || (Number.isFinite(ts) && Math.abs(now - ts) < FRESH_MS)) remember(k, { sig, confirmed });
      continue;
    }
    if (prev.confirmed && confirmed && prev.sig === sig) {
      // The same confirmed content again: the delivery receipt. Done with this message.
      tracks.delete(k);
      if (!Object.keys(deliveredFor(chatID, id) ?? {}).length) jobs.push(mark(chatID, id, 'upsert', at));
      continue;
    }
    remember(k, { sig, confirmed });
  }
  return Promise.all(jobs).then(
    () => undefined,
    () => log('delivery', 'mark failed'),
  );
}

function remember(k: string, t: Track): void {
  tracks.delete(k);
  tracks.set(k, t);
  if (tracks.size > TRACK_MAX) tracks.delete(tracks.keys().next().value!);
}
