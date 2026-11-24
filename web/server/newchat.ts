import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { log } from './log.js';
import type { Env } from './context.js';
import { EMAIL, normalizePhone } from './identifier.js';
import type { CreateBody, NewChatCaps, StartBody, StartUser } from './connector.js';
import type { ConnectorModule } from './registry.js';
import { connectorForAccount, failureOf } from './sources.js';
import { validId } from './relay.js';

// Starting a conversation: per-account contact search and list, what the account allows (its connector's
// newChat), then a direct chat (reusing an existing one) or a group. Every body is rebuilt field by field
// here; the connector gets nothing else (no first message, no invite toggle). An account that only lists the
// people one already has a conversation with (caps.existingOnly) creates nothing: its contacts' ids are chats.

export const ACCOUNT_ID = /^[A-Za-z0-9._:@=+-]{1,200}$/;
const CC = /[\p{Cc}]/u;
export const MAX_GROUP = 250;
export const MAX_TITLE = 300;

const bad = (c: Context) => c.json({ error: 'bad_request' }, 400);
const smallBody = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

export const validAccountID = (v: unknown): v is string => typeof v === 'string' && ACCOUNT_ID.test(v);
const validUserID = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 512 && !/[\p{Cc}\s]/u.test(v);
const shortText = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !CC.test(v);

/** Contact search text: trimmed, 1–200 characters, no control character. */
export function contactQuery(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t && t.length <= 200 && !CC.test(t) ? t : null;
}

export type { CreateBody, StartBody, StartUser };
const USER_KEYS = new Set(['id', 'username', 'phoneNumber', 'email', 'fullName']);

/** POST /api/chats/start: {accountID, user: {id?, username?, phoneNumber?, email?, fullName?}}, nothing else. */
export function parseStart(b: Record<string, unknown>): StartBody | null {
  if (Object.keys(b).some((k) => k !== 'accountID' && k !== 'user')) return null;
  if (!validAccountID(b.accountID)) return null;
  const u = b.user;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const raw = u as Record<string, unknown>;
  if (Object.keys(raw).some((k) => !USER_KEYS.has(k))) return null;
  const user: StartUser = {};
  if (raw.id !== undefined) {
    if (!validUserID(raw.id)) return null;
    user.id = raw.id;
  }
  if (raw.username !== undefined) {
    if (typeof raw.username !== 'string' || !/^@?[^\s\p{Cc}]{1,128}$/u.test(raw.username)) return null;
    user.username = raw.username;
  }
  if (raw.phoneNumber !== undefined) {
    const p = typeof raw.phoneNumber === 'string' ? normalizePhone(raw.phoneNumber) : null;
    if (!p) return null;
    user.phoneNumber = p;
  }
  if (raw.email !== undefined) {
    if (typeof raw.email !== 'string' || raw.email.length > 254 || !EMAIL.test(raw.email)) return null;
    user.email = raw.email;
  }
  if (raw.fullName !== undefined) {
    if (!shortText(raw.fullName, 200)) return null;
    user.fullName = raw.fullName;
  }
  // fullName alone only ranks candidates: something must identify the person.
  if (!user.id && !user.username && !user.phoneNumber && !user.email) return null;
  return { accountID: b.accountID, user };
}

/** POST /api/chats: {accountID, type, participantIDs, title?}; single = exactly one participant, no title. */
export function parseCreate(b: Record<string, unknown>): CreateBody | null {
  if (Object.keys(b).some((k) => !['accountID', 'type', 'participantIDs', 'title'].includes(k))) return null;
  if (!validAccountID(b.accountID)) return null;
  if (b.type !== 'single' && b.type !== 'group') return null;
  const ids = b.participantIDs;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_GROUP || !ids.every(validUserID)) return null;
  if (new Set(ids).size !== ids.length) return null;
  if (b.type === 'single' && (ids.length !== 1 || b.title !== undefined)) return null;
  const out: CreateBody = { accountID: b.accountID, type: b.type, participantIDs: [...(ids as string[])] };
  if (b.title !== undefined) {
    if (!shortText(b.title, MAX_TITLE)) return null;
    out.title = b.title.trim();
  }
  return out;
}

// ── What an account allows: the connector's (connector.ts NewChatCaps) ──

export type { NewChatCaps };

// ── Contacts ──────────────────────────────────────────────────────────────

export type Contact = {
  id: string;
  username?: string;
  phoneNumber?: string;
  email?: string;
  fullName?: string;
  imgURL?: string;
  cannotMessage?: boolean;
  isSelf?: boolean;
  /** One already has a conversation with them on this account. (1.11.0) */
  inChats?: boolean;
  /** Their direct chat on this account, when one exists: opened as it is (starting one could send a message). (1.11.0) */
  chatID?: string;
};

const str = (v: unknown, max: number) => (typeof v === 'string' && v && v.length <= max && !CC.test(v) ? v : undefined);

/** Only the documented User fields, as strings of sane length. */
export function cleanContact(v: unknown): Contact | null {
  if (!v || typeof v !== 'object') return null;
  const u = v as Record<string, unknown>;
  if (!validUserID(u.id)) return null;
  const out: Contact = { id: u.id };
  const username = str(u.username, 200);
  const phoneNumber = str(u.phoneNumber, 32);
  const email = str(u.email, 254);
  const fullName = str(u.fullName, 300);
  const imgURL = str(u.imgURL, 2048);
  if (username) out.username = username;
  if (phoneNumber) out.phoneNumber = phoneNumber;
  if (email) out.email = email;
  if (fullName) out.fullName = fullName;
  if (imgURL) out.imgURL = imgURL;
  if (u.cannotMessage === true) out.cannotMessage = true;
  if (u.isSelf === true) out.isSelf = true;
  if (u.inChats === true) out.inChats = true;
  if (typeof u.chatID === 'string' && validId(u.chatID)) out.chatID = u.chatID;
  return out;
}

const cleanList = (items: unknown): Contact[] => (Array.isArray(items) ? items.map(cleanContact).filter((c): c is Contact => !!c) : []);

/** A connector's refusal: status plus its machine-readable code when it has one (never its message). */
function refusal(c: Context, e: unknown, route: string, source?: ConnectorModule) {
  const { status, code } = failureOf(e, source);
  log('upstream', 'error', { route, status, ...(code ? { code } : {}) });
  return c.json({ error: 'upstream', ...(code ? { code } : {}) }, status);
}

type NewChatSource = ConnectorModule & { newChat: NonNullable<ConnectorModule['newChat']> };

/** The connector that has this account, when it starts conversations (null: none, 404). */
function sourceOf(accountID: string): NewChatSource | null {
  const k = connectorForAccount(accountID);
  return k?.newChat ? (k as NewChatSource) : null;
}
const notFound = (c: Context) => c.json({ error: 'not_found' }, 404);

export const newChatRoutes = new Hono<Env>();

newChatRoutes.get('/accounts/:accountID/new-chat', async (c) => {
  const id = c.req.param('accountID');
  if (!validAccountID(id)) return bad(c);
  const source = sourceOf(id);
  if (!source) return notFound(c);
  try {
    const caps = await source.newChat.caps(id);
    return caps ? c.json(caps) : c.json({ error: 'not_found' }, 404);
  } catch (e) {
    return refusal(c, e, '/accounts/:id/new-chat', source);
  }
});

newChatRoutes.get('/accounts/:accountID/contacts', async (c) => {
  const id = c.req.param('accountID');
  const query = contactQuery(c.req.query('query'));
  if (!validAccountID(id) || !query) return bad(c);
  const source = sourceOf(id);
  if (!source) return notFound(c);
  try {
    return c.json({ items: cleanList(await source.newChat.searchContacts(id, query)) });
  } catch (e) {
    return refusal(c, e, '/accounts/:id/contacts', source);
  }
});

newChatRoutes.get('/accounts/:accountID/contacts/list', async (c) => {
  const id = c.req.param('accountID');
  const cursor = c.req.query('cursor');
  if (!validAccountID(id) || (cursor !== undefined && (!cursor || cursor.length > 512 || CC.test(cursor)))) return bad(c);
  if (Object.keys(c.req.query()).some((k) => k !== 'cursor')) return bad(c);
  const source = sourceOf(id);
  if (!source) return notFound(c);
  try {
    const r = await source.newChat.listContacts(id, cursor);
    const next = typeof r?.oldestCursor === 'string' && r.oldestCursor.length <= 512 ? r.oldestCursor : null;
    return c.json({ items: cleanList(r?.items), hasMore: r?.hasMore === true && !!next, oldestCursor: next });
  } catch (e) {
    return refusal(c, e, '/accounts/:id/contacts/list', source);
  }
});

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

newChatRoutes.post('/chats/start', smallBody, async (c) => {
  const raw = await jsonBody(c);
  const body = raw && parseStart(raw);
  if (!body) return bad(c);
  const source = sourceOf(body.accountID);
  if (!source) return notFound(c);
  try {
    const caps = await source.newChat.caps(body.accountID);
    if (!caps) return c.json({ error: 'not_found' }, 404);
    if (caps.existingOnly) return bad(c);
    if (!caps.start) return c.json({ error: 'unsupported' }, 409);
    const chat = await source.newChat.start(body);
    return c.json({ ...chat, id: chat.id ?? chat.chatID });
  } catch (e) {
    return refusal(c, e, 'POST /chats/start', source);
  }
});

newChatRoutes.post('/chats', smallBody, async (c) => {
  const raw = await jsonBody(c);
  const body = raw && parseCreate(raw);
  if (!body) return bad(c);
  const source = sourceOf(body.accountID);
  if (!source) return notFound(c);
  try {
    const caps = await source.newChat.caps(body.accountID);
    if (!caps) return c.json({ error: 'not_found' }, 404);
    if (caps.existingOnly) return bad(c);
    // Groups only where the bridge documents group creation, within its limits.
    if (body.type === 'group') {
      const g = caps.group;
      if (!g) return c.json({ error: 'unsupported' }, 409);
      const n = body.participantIDs.length;
      if (n < g.min || n > g.max) return bad(c);
      if (body.title && (!g.nameAllowed || body.title.length > g.nameMax)) return bad(c);
      if (!body.title && g.nameRequired) return bad(c);
    } else if (!caps.start) {
      return c.json({ error: 'unsupported' }, 409);
    }
    const chat = await source.newChat.create(body);
    return c.json({ ...chat, id: chat.id ?? chat.chatID });
  } catch (e) {
    return refusal(c, e, 'POST /chats', source);
  }
});
