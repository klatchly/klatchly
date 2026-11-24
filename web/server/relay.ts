import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { log } from './log.js';
import type { Env } from './context.js';
import { isMime, sanitizeFileName, takesUploads, uploadFits } from './upload.js';
import { noteChat, noteRead } from './badgecount.js';
import { ConnectorError, type Chat, type ChatFlag, type Message, type OutgoingAttachment, type Page } from './connector.js';
import { decodeState, encodeState, firstState, MAX_CURSOR, mergePages, ms, type MergeItem } from './merge.js';
import { readAfterReply, readChat } from './reading.js';
import type { ConnectorModule } from './registry.js';
import { connectorFor, connectorForAccount, connectors, failureOf, from } from './sources.js';
import { sharedRead } from './inflight.js';

// Allowlisted relay. Each route is validated here, then maps to exactly one method of the connector that owns
// the chat (sources.ts; Beeper: one Desktop API call); nothing is passed through generically. Lists and searches
// ask every connector in play and merge their pages by time (merge.ts).

export const MAX_TEXT = 20_000;

const badRequest = (c: Context) => c.json({ error: 'bad_request' }, 400);

/**
 * The answer to a connector's failure: its status (never 401/403), logged without content. `source`: the
 * connector that threw (else the one sources.ts `from` saw), the only one asked how to answer.
 */
export function fail(c: Context, e: unknown, route: string, source?: ConnectorModule) {
  // A refusal the connector chose (e.g. 409 forbidden_message) carries its own code.
  if (e instanceof ConnectorError) return c.json({ error: e.code }, e.status);
  const f = failureOf(e, source);
  // The browser has gone (its read was aborted with it): nobody reads the answer, nothing to log.
  if (!c.req.raw.signal.aborted) log('upstream', 'error', { route, status: f.status });
  return c.json({ error: 'upstream' }, f.status);
}

/** The connector that owns a chat, or the 404 to answer. */
function owner(c: Context, id: string) {
  return connectorFor(id) ?? (c.json({ error: 'not_found' }, 404) as Response);
}
const unsupported = (c: Context) => c.json({ error: 'unsupported' }, 409);

export function validId(v: string | undefined): v is string {
  return !!v && v.length <= 512 && !/[\u0000-\u001f\u007f\s]/.test(v);
}

type Query = { cursor?: string; direction?: 'before' | 'after'; limit?: number };

const ACCOUNT_ID = /^[A-Za-z0-9._:@=+-]{1,200}$/;

/** Optional network filter: repeated accountIDs params. undefined = absent, null = invalid. */
function accountIDs(c: Context): string[] | null | undefined {
  const list = c.req.queries('accountIDs');
  if (!list?.length) return undefined;
  if (list.length > 20 || !list.every((a) => ACCOUNT_ID.test(a))) return null;
  return [...new Set(list)];
}

function pageQuery(c: Context, withLimit: boolean): Query | null {
  const q: Query = {};
  const cursor = c.req.query('cursor');
  const direction = c.req.query('direction');
  const limit = c.req.query('limit');
  if (cursor !== undefined) {
    if (!cursor || cursor.length > MAX_CURSOR || /[\u0000-\u001f]/.test(cursor)) return null;
    q.cursor = cursor;
  }
  if (direction !== undefined) {
    if (direction !== 'before' && direction !== 'after') return null;
    q.direction = direction;
  }
  if (limit !== undefined) {
    if (!withLimit || !/^\d{1,3}$/.test(limit)) return null;
    const n = Number(limit);
    if (n < 1 || n > 200) return null;
    q.limit = n;
  }
  return q;
}

export async function jsonObject(c: Context): Promise<Record<string, unknown> | null> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A read for the browser, shared with the identical requests under way (inflight.ts: one upstream call for them all,
 * aborted once every one of them has gone); `ttl`: a success kept that long for the same request.
 */
function shared<T>(c: Context, run: () => Promise<T>, ttl = 0): Promise<T> {
  const u = new URL(c.req.url);
  return sharedRead(`${c.req.method} ${u.pathname}${u.search}`, c.req.raw.signal, run, ttl);
}

// The top of a chat list, asked by every tab and refresh at once (a reconnect, a burst of events): kept a second.
const LIST_TOP_TTL = 1_000;

const smallBody = bodyLimit({ maxSize: 96 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

export const relay = new Hono<Env>();

// Every connector's accounts; one that fails is left out (logged), the others still listed. All failing: the
// first failure's answer.
relay.get('/accounts', async (c) => {
  const list = connectors();
  const got = await Promise.allSettled(list.map((k) => k.accounts()));
  const ok = got.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  got.forEach((r, i) => {
    if (r.status === 'rejected' && ok.length) log('upstream', 'accounts failed', { id: list[i]!.id, status: failureOf(r.reason, list[i]).status });
  });
  const bad = got.findIndex((r) => r.status === 'rejected');
  if (!ok.length && bad >= 0) return fail(c, (got[bad] as PromiseRejectedResult).reason, '/accounts', list[bad]);
  return c.json(ok.flat());
});

/** A connector asked for a list, with the accounts of the network filter that are its own (absent: all). */
type Asked = { source: ConnectorModule; accountIDs?: string[] };

/** The connectors a list asks: those with an account in the network filter (no filter: all), in the registry's order. */
function asked(accounts: string[] | undefined, only?: ConnectorModule): Asked[] {
  const list = connectors().filter((k) => !only || k === only);
  if (!accounts) return list.map((source) => ({ source }));
  const mine = new Map<ConnectorModule, string[]>();
  for (const a of accounts) {
    const k = connectorForAccount(a);
    if (k) mine.set(k, [...(mine.get(k) ?? []), a]);
  }
  return list.flatMap((source) => (mine.has(source) ? [{ source, accountIDs: mine.get(source)! }] : []));
}

const accountsOf = (a: Asked) => (a.accountIDs ? { accountIDs: a.accountIDs } : {});

/**
 * One page of a list over the connectors asked: a single one's own page (its cursors untouched), or their pages
 * merged by time (merge.ts) with a merged cursor. Null: a cursor that is not one of this list's.
 */
async function listPage<T, P extends Page<T>>(q: Query, list: Asked[], call: (a: Asked, q: Query) => Promise<P>, item: (x: T) => MergeItem): Promise<{ page: Page<T>; pages: P[]; single: boolean } | null> {
  if (!list.length) return { page: { items: [], hasMore: false, oldestCursor: null, newestCursor: null }, pages: [], single: true };
  if (list.length === 1) {
    // Its page as it gave it (its other fields too).
    const one = list[0]!;
    const page = await from(one.source, () => call(one, q));
    return { page, pages: [page], single: true };
  }
  const ids = list.map((a) => a.source.id);
  const state = q.cursor ? decodeState(q.cursor, ids) : firstState(ids);
  if (!state) return null;
  const live = list.filter((a) => state.sources[a.source.id]);
  const pages = await Promise.all(
    live.map((a) => {
      const at = state.sources[a.source.id]!;
      return from(a.source, () => call(a, { ...(q.limit ? { limit: q.limit } : {}), ...(at.cursor ? { cursor: at.cursor, direction: 'before' as const } : {}) }));
    }),
  );
  const { items, next } = mergePages(
    live.map((a, i) => ({ id: a.source.id, page: pages[i]!, again: state.sources[a.source.id]!.again })),
    state,
    item,
  );
  let cursor = next ? encodeState(next) : null;
  if (cursor && cursor.length > MAX_CURSOR) {
    // Sources' cursors are short; should a merged one still not fit, the list ends here rather than with a
    // cursor the next request would refuse.
    log('relay', 'merged cursor too long', { length: cursor.length });
    cursor = null;
  }
  return { page: { items, hasMore: !!cursor, oldestCursor: cursor, newestCursor: pages[0]?.newestCursor ?? null }, pages, single: false };
}

const chatItem = (x: Chat): MergeItem => ({ at: ms(x.lastActivity), pinned: !!x.isPinned });
// Search results are not pinned on top: matches by time only.
const foundChat = (x: Chat): MergeItem => ({ at: ms(x.lastActivity), pinned: false });
const messageItem = (x: Message): MergeItem => ({ at: ms(x.timestamp), pinned: false });

relay.get('/chats', async (c) => {
  const q = pageQuery(c, true);
  const accounts = accountIDs(c);
  if (!q || accounts === null) return badRequest(c);
  try {
    const r = await shared(c, () => listPage(q, asked(accounts), (a, sub) => a.source.listChats({ ...sub, ...accountsOf(a) }), chatItem), q.cursor ? 0 : LIST_TOP_TTL);
    return r ? c.json(r.page) : badRequest(c);
  } catch (e) {
    return fail(c, e, '/chats');
  }
});

const INBOXES = new Set(['primary', 'low-priority', 'archive']);
const PATCH_KEYS = new Set(['isPinned', 'isMuted', 'isLowPriority']);

function searchText(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t && t.length <= 200 && !/[\p{Cc}]/u.test(t) ? t : null;
}

// Registered before /chats/:id so "search" is never taken for a chat ID.
relay.get('/chats/search', async (c) => {
  const q = pageQuery(c, true);
  const query = searchText(c.req.query('query'));
  const inbox = c.req.query('inbox');
  const accounts = accountIDs(c);
  if (!q || query === null || accounts === null || (inbox !== undefined && !INBOXES.has(inbox))) return badRequest(c);
  if (query === undefined && inbox === undefined) return badRequest(c);
  try {
    const r = await shared(c, () => listPage(
      q,
      asked(accounts),
      (a, sub) =>
        a.source.searchChats({
          ...sub,
          ...(query ? { query } : {}),
          ...(inbox ? { inbox: inbox as 'primary' | 'low-priority' | 'archive' } : {}),
          ...accountsOf(a),
        }),
      foundChat,
    ));
    return r ? c.json(r.page) : badRequest(c);
  } catch (e) {
    return fail(c, e, '/chats/search');
  }
});

relay.get('/messages/search', async (c) => {
  const q = pageQuery(c, false);
  const query = searchText(c.req.query('query'));
  const chatID = c.req.query('chatID');
  const accounts = accountIDs(c);
  if (!q || !query || accounts === null || (chatID !== undefined && !validId(chatID))) return badRequest(c);
  // One chat: its connector only.
  const only = chatID ? connectorFor(chatID) : undefined;
  if (chatID && !only) return c.json({ error: 'not_found' }, 404);
  try {
    const r = await shared(c, () => listPage(
      q,
      asked(accounts, only),
      (a, sub) => a.source.searchMessages({ ...sub, query, limit: 20, ...(chatID ? { chatIDs: [chatID] } : {}), ...accountsOf(a) }),
      messageItem,
    ));
    if (!r) return badRequest(c);
    return c.json(r.single ? r.page : { ...r.page, chats: Object.assign({}, ...r.pages.map((p) => p.chats ?? {})) });
  } catch (e) {
    return fail(c, e, '/messages/search');
  }
});

relay.get('/chats/:id', async (c) => {
  const id = c.req.param('id');
  const participants = c.req.query('participants');
  if (!validId(id) || (participants !== undefined && participants !== 'all')) return badRequest(c);
  const source = owner(c, id);
  if (source instanceof Response) return source;
  try {
    // ?participants=all: the mention picker in large groups (API maximum).
    return c.json(await shared(c, () => source.chat(id, participants === 'all' ? 500 : 100)));
  } catch (e) {
    return fail(c, e, '/chats/:id', source);
  }
});

relay.get('/chats/:id/messages', async (c) => {
  const id = c.req.param('id');
  const q = pageQuery(c, false);
  if (!validId(id) || !q) return badRequest(c);
  const source = owner(c, id);
  if (source instanceof Response) return source;
  try {
    return c.json(await shared(c, () => source.messages(id, q)));
  } catch (e) {
    return fail(c, e, '/chats/:id/messages', source);
  }
});

const ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'file', 'gif', 'voice-note', 'sticker']);
const ATTACHMENT_KEYS = new Set(['uploadID', 'mimeType', 'fileName', 'size', 'duration', 'type']);
const dim = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000;

type AttachmentInput = OutgoingAttachment;

export function parseAttachment(v: unknown): AttachmentInput | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (Object.keys(a).some((k) => !ATTACHMENT_KEYS.has(k))) return null;
  if (typeof a.uploadID !== 'string' || !validId(a.uploadID)) return null;
  const out: AttachmentInput = { uploadID: a.uploadID };
  if (a.mimeType !== undefined) {
    if (!isMime(a.mimeType)) return null;
    out.mimeType = a.mimeType;
  }
  if (a.fileName !== undefined) {
    const n = sanitizeFileName(a.fileName);
    if (!n || n !== a.fileName) return null;
    out.fileName = n;
  }
  if (a.size !== undefined) {
    const sz = a.size as Record<string, unknown> | null;
    if (!sz || typeof sz !== 'object' || Object.keys(sz).some((k) => k !== 'width' && k !== 'height')) return null;
    if (!dim(sz.width) || !dim(sz.height)) return null;
    out.size = { width: sz.width as number, height: sz.height as number };
  }
  if (a.duration !== undefined) {
    if (typeof a.duration !== 'number' || !Number.isFinite(a.duration) || a.duration < 0 || a.duration > 864_000) return null;
    out.duration = a.duration;
  }
  if (a.type !== undefined) {
    if (typeof a.type !== 'string' || !ATTACHMENT_TYPES.has(a.type)) return null;
    out.type = a.type as AttachmentInput['type'];
  }
  return out;
}

relay.post('/chats/:id/messages', smallBody, async (c) => {
  const id = c.req.param('id');
  const body = await jsonObject(c);
  if (!validId(id) || !body) return badRequest(c);
  if (Object.keys(body).some((k) => k !== 'text' && k !== 'replyToMessageID' && k !== 'attachment')) return badRequest(c);
  const { text, replyToMessageID } = body;
  const attachment = body.attachment === undefined ? undefined : parseAttachment(body.attachment);
  if (attachment === null) return badRequest(c);
  if (text !== undefined && (typeof text !== 'string' || text.length > MAX_TEXT)) return badRequest(c);
  const hasText = typeof text === 'string' && !!text.trim();
  if (!hasText && !attachment) return badRequest(c);
  if (replyToMessageID !== undefined && (typeof replyToMessageID !== 'string' || !validId(replyToMessageID))) {
    return badRequest(c);
  }
  const source = owner(c, id);
  if (source instanceof Response) return source;
  // A file goes only to a chat of the connector that took the upload.
  if (attachment && !takesUploads(source)) return unsupported(c);
  if (attachment && !uploadFits(attachment.uploadID, source)) return badRequest(c);
  try {
    const res = await source.send(id, {
      ...(hasText ? { text: text as string } : {}),
      ...(replyToMessageID ? { replyToMessageID: replyToMessageID as string } : {}),
      ...(attachment ? { attachment } : {}),
    });
    // Where replying always tells (receipts.replyTells), a discreet chat is now read for real; not awaited.
    void readAfterReply(source, id);
    return c.json({ chatID: res.chatID, pendingMessageID: res.pendingMessageID });
  } catch (e) {
    return fail(c, e, 'POST /chats/:id/messages', source);
  }
});

relay.post('/chats/:id/read', smallBody, async (c) => {
  const id = c.req.param('id');
  if (!validId(id)) return badRequest(c);
  let messageID: string | undefined;
  // receipt: true is the explicit "Mark as read": the network is told even when the chat reads discreetly.
  let explicit = false;
  if (c.req.header('content-length') !== '0' && c.req.header('content-type')) {
    const body = await jsonObject(c);
    if (!body || Object.keys(body).some((k) => k !== 'messageID' && k !== 'receipt')) return badRequest(c);
    if (body.messageID !== undefined) {
      if (typeof body.messageID !== 'string' || !validId(body.messageID)) return badRequest(c);
      messageID = body.messageID;
    }
    if (body.receipt !== undefined && body.receipt !== true) return badRequest(c);
    explicit = body.receipt === true;
  }
  const source = owner(c, id);
  if (source instanceof Response) return source;
  if (explicit && source.receipts && !source.receipts.send) return unsupported(c);
  try {
    const { receipt } = await readChat(source, id, messageID, explicit);
    // A discreet read moves nothing upstream (no chat.upserted follows): the badge drops it now.
    noteRead(id);
    return c.json({ ok: true, receipt });
  } catch (e) {
    return fail(c, e, 'POST /chats/:id/read', source);
  }
});

// Reply targets that are not loaded yet.
relay.get('/chats/:id/messages/:mid', async (c) => {
  const id = c.req.param('id');
  const mid = c.req.param('mid');
  if (!validId(id) || !validId(mid)) return badRequest(c);
  const source = owner(c, id);
  if (source instanceof Response) return source;
  try {
    return c.json(await shared(c, () => source.message(id, mid)));
  } catch (e) {
    return fail(c, e, '/chats/:id/messages/:mid', source);
  }
});

/**
 * The shape of a reaction key: emoji (with ZWJ / variation selectors) or a short network key, no whitespace or
 * control characters; or a longer one (up to 255) without them, which only a connector that says it is one of its own
 * takes (reactionKeyFits: e.g. an image reaction's media URI, removing one's own, re-using one where the network allows).
 */
export function validReactionKey(v: unknown): v is string {
  if (typeof v !== 'string' || !v.length || v.length > 255) return false;
  return !/[\p{Cc}\p{Z}\s]/u.test(v);
}

/** Whether the chat's connector takes this key: a short one always, a longer one when it says so (ConnectorShape.longReactionKey). */
export const reactionKeyFits = (source: ConnectorModule, key: string): boolean => key.length <= 64 || !!source.longReactionKey?.(key);

relay.post('/chats/:id/messages/:mid/reactions', smallBody, async (c) => {
  const id = c.req.param('id');
  const mid = c.req.param('mid');
  const body = await jsonObject(c);
  if (!validId(id) || !validId(mid) || !body) return badRequest(c);
  if (Object.keys(body).some((k) => k !== 'reactionKey') || !validReactionKey(body.reactionKey)) return badRequest(c);
  const source = owner(c, id);
  if (source instanceof Response) return source;
  if (!reactionKeyFits(source, body.reactionKey)) return badRequest(c);
  if (!source.react) return unsupported(c);
  try {
    await source.react(id, mid, body.reactionKey);
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e, 'POST /chats/:id/messages/:mid/reactions', source);
  }
});

relay.delete('/chats/:id/messages/:mid/reactions/:key', async (c) => {
  const id = c.req.param('id');
  const mid = c.req.param('mid');
  const key = c.req.param('key');
  if (!validId(id) || !validId(mid) || !validReactionKey(key)) return badRequest(c);
  const source = owner(c, id);
  if (source instanceof Response) return source;
  if (!reactionKeyFits(source, key)) return badRequest(c);
  if (!source.unreact) return unsupported(c);
  try {
    await source.unreact(id, mid, key);
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e, 'DELETE /chats/:id/messages/:mid/reactions/:key', source);
  }
});

relay.post('/chats/:id/archive', smallBody, async (c) => {
  const id = c.req.param('id');
  const body = await jsonObject(c);
  if (!validId(id) || !body) return badRequest(c);
  if (Object.keys(body).some((k) => k !== 'archived') || typeof body.archived !== 'boolean') return badRequest(c);
  const source = owner(c, id);
  if (source instanceof Response) return source;
  if (!source.archive) return unsupported(c);
  try {
    await source.archive(id, body.archived);
    noteChat({ id, isArchived: body.archived });
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e, 'POST /chats/:id/archive', source);
  }
});

// Only pin, mute and low priority; title, draft, avatar (a local file path upstream), expiry... are not reachable.
// Low priority comes alone (Beeper: it also mutes the chat, and moving it back undoes only a mute it set).
relay.patch('/chats/:id', smallBody, async (c) => {
  const id = c.req.param('id');
  const body = await jsonObject(c);
  if (!validId(id) || !body) return badRequest(c);
  const keys = Object.keys(body);
  if (!keys.length || keys.some((k) => !PATCH_KEYS.has(k) || typeof body[k] !== 'boolean')) return badRequest(c);
  if ('isLowPriority' in body && keys.length !== 1) return badRequest(c);
  const source = owner(c, id);
  if (source instanceof Response) return source;
  if (!source.update || keys.some((k) => !source.capabilities.flags.includes(k as ChatFlag))) return unsupported(c);
  try {
    const { chat, applied } = await source.update(id, body as Partial<Record<ChatFlag, boolean>>);
    // The badge takes the new flags at once (the upstream event may never come).
    noteChat({ ...applied, ...chat, id });
    return c.json(chat);
  } catch (e) {
    return fail(c, e, 'PATCH /chats/:id', source);
  }
});

// Edit/delete: the connector relays them for our own, non-deleted messages only (409 forbidden_message).
relay.put('/chats/:id/messages/:mid', smallBody, async (c) => {
  const id = c.req.param('id');
  const mid = c.req.param('mid');
  const body = await jsonObject(c);
  if (!validId(id) || !validId(mid) || !body) return badRequest(c);
  const { text } = body;
  if (Object.keys(body).some((k) => k !== 'text') || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
    return badRequest(c);
  }
  const source = owner(c, id);
  if (source instanceof Response) return source;
  if (!source.edit) return unsupported(c);
  try {
    await source.edit(id, mid, text);
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e, 'PUT /chats/:id/messages/:mid', source);
  }
});

relay.delete('/chats/:id/messages/:mid', async (c) => {
  const id = c.req.param('id');
  const mid = c.req.param('mid');
  const forEveryone = c.req.query('forEveryone');
  if (!validId(id) || !validId(mid) || (forEveryone !== undefined && forEveryone !== 'true' && forEveryone !== 'false')) {
    return badRequest(c);
  }
  const source = owner(c, id);
  if (source instanceof Response) return source;
  if (!source.deleteMessage) return unsupported(c);
  try {
    await source.deleteMessage(id, mid, forEveryone === undefined ? undefined : forEveryone === 'true');
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e, 'DELETE /chats/:id/messages/:mid', source);
  }
});
