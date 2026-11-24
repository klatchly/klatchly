import { APIError } from '@beeper/desktop-api';
import { MAX_GROUP, MAX_TITLE, type ConnectorShape, type NewChatCaps } from '#core/sdk.js';
import { api } from './upstream.js';

// Starting a conversation on a Desktop API account (moved from the core's newchat.ts, which keeps the routes and
// rebuilds every body field by field): what the account's bridge allows, its contacts, then chats/start (a
// direct chat, reusing an existing one) or POST /v1/chats (a group). Nothing else reaches the Desktop API (no
// first message, no invite toggle). Gotcha: on LinkedIn, chats/start makes the bridge SEND a first message ("New
// chat") to the person (it cannot open an empty conversation), even when it answers an error: the client opens a
// person's existing chat itself (contact.chatID) and asks before starting a new one there.

const enc = encodeURIComponent;
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,100}$/;

// ── What an account allows ────────────────────────────────────────────────

type Field = { allowed?: boolean; required?: boolean; min_length?: number; max_length?: number };
type BridgeCaps = {
  resolve_identifier?: Partial<Record<'create_dm' | 'lookup_phone' | 'lookup_email' | 'lookup_username' | 'contact_list' | 'search', boolean>>;
  group_creation?: Record<string, { name?: Field; participants?: Field } | undefined>;
};
type UpstreamAccount = { accountID: string; network?: string; status?: string; bridge?: { id?: string } };

const capsCache = new Map<string, { at: number; caps: BridgeCaps | null }>();
const CAPS_TTL = 10 * 60_000;

async function bridgeCaps(bridgeID: string | undefined): Promise<BridgeCaps | null> {
  if (!bridgeID || !BRIDGE_ID.test(bridgeID)) return null;
  const hit = capsCache.get(bridgeID);
  if (hit && Date.now() - hit.at < CAPS_TTL) return hit.caps;
  let caps: BridgeCaps | null = null;
  try {
    caps = (await api().get(`/v1/bridges/${enc(bridgeID)}/capabilities`)) as BridgeCaps;
  } catch (e) {
    // The Beeper (Matrix) account has no bridge: "Invalid bridgeID". Remembered like a success.
    if (!(e instanceof APIError) || e.status !== 400) throw e;
  }
  capsCache.set(bridgeID, { at: Date.now(), caps });
  return caps;
}

const int = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : d);

/** Summary of an account's bridge capabilities for the new-chat flow. */
export function summarize(a: UpstreamAccount, caps: BridgeCaps | null): NewChatCaps {
  const r = caps?.resolve_identifier;
  const g = caps?.group_creation?.group;
  const group =
    g && g.participants?.allowed
      ? {
          nameAllowed: !!g.name?.allowed,
          nameRequired: !!g.name?.allowed && !!g.name?.required,
          nameMax: Math.min(int(g.name?.max_length, MAX_TITLE) || MAX_TITLE, MAX_TITLE),
          min: Math.max(1, int(g.participants.min_length, 1)),
          max: Math.min(int(g.participants.max_length, MAX_GROUP) || MAX_GROUP, MAX_GROUP),
        }
      : null;
  return {
    accountID: a.accountID,
    network: a.network ?? a.accountID,
    connected: a.status === undefined || a.status === 'connected' || a.status === 'backfilling',
    // No bridge capabilities (the Beeper account): direct chats with a user ID found by the search.
    start: r ? !!r.create_dm : true,
    lookup: r ? { phone: !!r.lookup_phone, email: !!r.lookup_email, username: !!r.lookup_username } : { phone: false, email: false, username: true },
    contactList: r ? !!r.contact_list : false,
    group,
  };
}

async function accountCaps(accountID: string): Promise<NewChatCaps | null> {
  const list = (await api().accounts.list()) as unknown as UpstreamAccount[];
  const a = list.find((x) => x.accountID === accountID);
  if (!a) return null;
  return summarize(a, await bridgeCaps(a.bridge?.id));
}

// ── Contacts: found more easily, the people one talks to first ────────────

/** Lower case, accents and other marks off (Michaël → michael): how names are compared. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The queries one search asks the network: the text as typed, without accents (some networks, LinkedIn among them,
 * match "michael" to Michael only, never to Michaël), then each word of 3 letters or more on its own; 4 at most.
 */
export function contactQueries(query: string): string[] {
  const q = query.trim().replace(/\s+/g, ' ');
  const words = q.split(' ').filter((w) => [...w].length >= 3);
  const out: string[] = [];
  for (const x of [q, fold(q), ...(words.length > 1 ? words : []), ...(words.length > 1 ? words.map(fold) : [])]) {
    if (x && !out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x);
  }
  return out.slice(0, 4);
}

/** How well a name matches the query, accents and case aside: every word, the start, then any word. */
export function nameScore(name: string, query: string): number {
  const n = fold(name);
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const hits = words.filter((w) => n.split(/[\s.'-]+/).some((p) => p.startsWith(w))).length;
  return (hits === words.length ? 20 : hits * 5) + (n.startsWith(words[0]!) ? 3 : 0) + (n === words.join(' ') ? 10 : 0);
}

type People = { at: number; chats: Map<string, string | null> };
const peopleCache = new Map<string, People>();
const PEOPLE_TTL = 10 * 60_000;
const PEOPLE_PAGES = 5;

/**
 * The people one has a conversation with on an account (its latest 500 chats), by their id and handle: their
 * direct chat's id, or null when one only shares a group with them. Cached 10 minutes per account.
 */
async function people(accountID: string): Promise<Map<string, string | null>> {
  const hit = peopleCache.get(accountID);
  if (hit && Date.now() - hit.at < PEOPLE_TTL) return hit.chats;
  const chats = new Map<string, string | null>();
  let cursor: string | undefined;
  for (let i = 0; i < PEOPLE_PAGES; i++) {
    const page = (await api().get('/v1/chats', {
      query: { accountIDs: [accountID], limit: 100, ...(cursor ? { cursor, direction: 'before' } : {}) },
    })) as { items?: { id?: unknown; type?: unknown; participants?: { items?: { id?: unknown; username?: unknown; isSelf?: unknown }[] } }[]; hasMore?: unknown; oldestCursor?: unknown };
    for (const c of page.items ?? []) {
      if (typeof c.id !== 'string') continue;
      for (const p of c.participants?.items ?? []) {
        if (p.isSelf === true) continue;
        for (const key of [p.id, p.username]) {
          if (typeof key !== 'string' || !key) continue;
          if (c.type === 'single') chats.set(key, c.id);
          else if (!chats.has(key)) chats.set(key, null);
        }
      }
    }
    if (page.hasMore !== true || typeof page.oldestCursor !== 'string') break;
    cursor = page.oldestCursor;
  }
  peopleCache.set(accountID, { at: Date.now(), chats });
  return chats;
}

/** Tests: forget the people read per account. */
export const resetPeopleForTests = () => peopleCache.clear();

type Found = { id?: unknown; username?: unknown; fullName?: unknown; [k: string]: unknown };

export const newChat: NonNullable<ConnectorShape['newChat']> = {
  caps: accountCaps,
  // Several queries (contactQueries) merged, each person once; the people one already talks to first (inChats,
  // with their direct chat: opening it sends nothing), then by how well the name matches.
  async searchContacts(id, query) {
    const [lists, known] = await Promise.all([
      Promise.all(
        contactQueries(query).map((q, i) =>
          (api().get(`/v1/accounts/${enc(id)}/contacts`, { query: { query: q } }) as Promise<{ items?: unknown }>).then(
            (r) => (Array.isArray(r?.items) ? (r.items as Found[]) : []),
            // The query as typed must answer; the others are extras.
            (e) => (i === 0 ? Promise.reject(e) : []),
          ),
        ),
      ),
      people(id).catch(() => new Map<string, string | null>()),
    ]);
    const seen = new Set<string>();
    const merged: { c: Found; score: number; order: number }[] = [];
    for (const c of lists.flat()) {
      if (typeof c?.id !== 'string' || seen.has(c.id)) continue;
      seen.add(c.id);
      const chat = known.has(c.id) ? known.get(c.id) : typeof c.username === 'string' && known.has(c.username) ? known.get(c.username) : undefined;
      const found: Found = chat === undefined ? c : { ...c, inChats: true, ...(chat ? { chatID: chat } : {}) };
      merged.push({ c: found, score: (chat !== undefined ? 100 : 0) + nameScore(typeof c.fullName === 'string' ? c.fullName : '', query), order: merged.length });
    }
    return merged.sort((a, b) => b.score - a.score || a.order - b.order).map((x) => x.c);
  },
  listContacts: async (id, cursor) =>
    (await api().get(`/v1/accounts/${enc(id)}/contacts/list`, {
      query: { limit: 100, ...(cursor ? { cursor, direction: 'before' } : {}) },
    })) as { items?: unknown; hasMore?: unknown; oldestCursor?: unknown },
  start: async (body) => (await api().post('/v1/chats/start', { body: { accountID: body.accountID, user: body.user } })) as Record<string, unknown>,
  create: async (body) => (await api().post('/v1/chats', { body })) as Record<string, unknown>,
};
