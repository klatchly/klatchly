import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { dataPath } from './config.js';
import { ConnectorError, type ReceiptSupport } from './connector.js';
import { clientIp, type Env } from './context.js';
import { log } from './log.js';
import { RateLimiter } from './ratelimit.js';
import type { ConnectorModule } from './registry.js';
import { connectorFor, connectorForAccount, connectors } from './sources.js';

// Discreet reading ("Lecture discrète"): per messaging account, reading a chat in Klatchly clears its unread state
// (lists, badge, notifications) without telling the sender; only the explicit "Mark as read" sends the network's
// read receipt. Server-wide, like Settings → Extensions (one owner, several devices; the service worker's
// "Mark as read" on a notification follows it too). The choices are kept in the data volume (reading.json:
// account and chat ids and booleans, nothing else); an account never chosen follows its connector's
// receipts.byDefault. A chat may have its own choice (its menu), which wins over its account's.
// A connector without receipts cannot keep a read quiet: its accounts are never discreet, and Settings says so.

interface Choices {
  accounts: Record<string, boolean>;
  /** A chat's own choice (chat menu → "Discreet reading"): over its account's. */
  chats: Record<string, boolean>;
}
let choices: Choices | undefined;
const MAX_ACCOUNTS = 500;
const MAX_CHAT_CHOICES = 5000;
const file = () => dataPath('reading.json');

/** The booleans of a stored map whose keys pass `valid`, `max` at most. */
function booleans(v: unknown, valid: (id: string) => boolean, max: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, on] of Object.entries(v as Record<string, unknown>).slice(0, max)) if (typeof on === 'boolean' && valid(id)) out[id] = on;
  return out;
}

function load(): Choices {
  if (choices) return choices;
  choices = { accounts: {}, chats: {} };
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { accounts?: unknown; chats?: unknown };
    choices = { accounts: booleans(raw.accounts, validAccount, MAX_ACCOUNTS), chats: booleans(raw.chats, validId, MAX_CHAT_CHOICES) };
  } catch {
    // first run, or unreadable: every account on its default
  }
  return choices;
}

function save(c: Choices): boolean {
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, accounts: c.accounts, chats: c.chats })}\n`, { mode: 0o600 });
    renameSync(tmp, file());
    choices = c;
    return true;
  } catch {
    log('reading', 'state write failed');
    return false;
  }
}

/** Forgets the loaded choices (tests: a fresh data file). */
export function resetReading(): void {
  choices = undefined;
}

const validAccount = (id: string) => /^[\w.:@!+-]{1,200}$/.test(id);
// As relay.ts validId (not imported: relay.ts imports this file).
const validId = (id: string) => id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f\s]/.test(id);

/** Whether an account's reads stay unseen by the sender. */
export function discreetAccount(accountID: string, source = connectorForAccount(accountID)): boolean {
  if (!source?.receipts) return false;
  return load().accounts[accountID] ?? source.receipts.byDefault === true;
}

/** A chat's own choice, if it has one (undefined: its account's). */
export const chatChoice = (chatID: string): boolean | undefined => load().chats[chatID];

// Which account a chat is on, as last seen (a chat never moves): most reads need no lookup.
const accountOfChat = new Map<string, string>();
const MAX_CHATS = 5000;

/** A chat's account, as last seen (undefined: not seen yet). */
export const accountOf = (chatID: string): string | undefined => accountOfChat.get(chatID);

/** Records a chat's account (the chats the routes return pass here), so a read needs no lookup. */
export function noteChatAccount(chatID: string, accountID: unknown): void {
  if (typeof accountID !== 'string' || !accountID) return;
  if (accountOfChat.get(chatID) === accountID) return;
  accountOfChat.delete(chatID);
  accountOfChat.set(chatID, accountID);
  if (accountOfChat.size > MAX_CHATS) accountOfChat.delete(accountOfChat.keys().next().value!);
}

/**
 * Whether a saved account may be this source's: its own, or one no connector claims right now (not listed yet since a
 * restart, or its connector is off), which then counts for every source (fail closed: reads stay quiet).
 */
const mayBe = (accountID: string, source: ConnectorModule) => (connectorForAccount(accountID) ?? source) === source;

/** Whether some account of this source reads discreetly (its default, or a choice for one of its accounts). */
function anyDiscreet(source: ConnectorModule): boolean {
  if (!source.receipts) return false;
  if (source.receipts.byDefault === true) return true;
  return Object.entries(load().accounts).some(([id, on]) => on && mayBe(id, source));
}

/** Whether a chat of this source (on this account, or one not known) was made discreet on its own. */
function anyChatDiscreet(source: ConnectorModule, accountID: string | undefined): boolean {
  return Object.entries(load().chats).some(([id, on]) => {
    if (!on || connectorFor(id) !== source) return false;
    const of = accountOfChat.get(id);
    return !accountID || !of || of === accountID;
  });
}

/**
 * Whether a chat reads discreetly: its own choice, else its account's, for an account that may be unknown: then fail
 * closed, quiet if any account of its source is. Without the chat (asked by account): also quiet when a chat that
 * may be on it was made discreet on its own (fail closed).
 */
export function discreetFor(source: ConnectorModule, accountID: string | undefined, chatID?: string): boolean {
  if (!source.receipts) return false;
  if (chatID === undefined && anyChatDiscreet(source, accountID)) return true;
  const own = chatID === undefined ? undefined : chatChoice(chatID);
  if (own !== undefined) return own;
  return accountID ? discreetAccount(accountID, source) : anyDiscreet(source);
}

/**
 * Whether reading this chat stays unseen by the sender: its own choice first. Else, when every account of its
 * connector has the same setting, no lookup; else its account, as seen before or from the connector (one chat read).
 * Unknown (no account, the lookup failed): quiet if any account of its source is (fail closed).
 */
export async function discreetChat(source: ConnectorModule, chatID: string): Promise<boolean> {
  if (!source.receipts) return false;
  const own = chatChoice(chatID);
  if (own !== undefined) return own;
  const byDefault = source.receipts.byDefault === true;
  const differing = Object.entries(load().accounts).filter(([id, on]) => on !== byDefault && mayBe(id, source));
  if (!differing.length) return byDefault;
  let accountID = accountOfChat.get(chatID);
  if (!accountID) {
    try {
      const chat = await source.chat(chatID, 0);
      noteChatAccount(chatID, chat.accountID);
      accountID = typeof chat.accountID === 'string' && chat.accountID ? chat.accountID : undefined;
    } catch {
      accountID = undefined;
    }
  }
  return discreetFor(source, accountID);
}

/** Whether the connector can tell the network now (it has send, and has not learnt that the network refuses). */
export const canSend = (r: ReceiptSupport): boolean => !!r.send && (r.sendAvailable?.() ?? true);

/** A connector's "the receipt could not go, the chat is read in Klatchly" (ReceiptSupport.send). */
const receiptRefused = (e: unknown) => e instanceof ConnectorError && e.code.startsWith('receipt_');

/**
 * A read as Klatchly makes it: `explicit` (the "Mark as read" action) tells the network; otherwise the chat's setting
 * decides. A connector without receipts gets the call it always got (markRead). `receipt`: whether the network was
 * told (as far as Klatchly knows). A plain read whose receipt the network refuses is a quiet one, never an error; the
 * explicit one says why.
 */
export async function readChat(source: ConnectorModule, chatID: string, messageID: string | undefined, explicit: boolean): Promise<{ receipt: boolean }> {
  const r = source.receipts;
  if (!r) {
    await source.markRead(chatID, messageID);
    return { receipt: true };
  }
  if (!r.send || (!explicit && (!canSend(r) || (await discreetChat(source, chatID))))) {
    await r.readQuietly(chatID);
    return { receipt: false };
  }
  try {
    await r.send(chatID, messageID);
  } catch (e) {
    if (explicit || !receiptRefused(e)) throw e;
    await r.readQuietly(chatID);
    return { receipt: false };
  }
  return { receipt: true };
}

/**
 * After a reply the user sent (composer, notification): on a source whose replies always tell (receipts.replyTells),
 * a chat read discreetly is now read for real, every earlier message (the network's receipt: what replying means
 * there). Whether the network was told; a failure is logged, never the send's. A chat that does not read discreetly
 * was told by its reads already.
 */
export async function readAfterReply(source: ConnectorModule, chatID: string): Promise<boolean> {
  const r = source.receipts;
  if (!r?.replyTells || !r.send || !canSend(r)) return false;
  try {
    if (!(await discreetChat(source, chatID))) return false;
    return (await readChat(source, chatID, undefined, true)).receipt;
  } catch {
    log('reading', 'read after reply failed', { source: source.id });
    return false;
  }
}

/** One account as Settings shows it (GET /api/reading). */
export interface ReadingAccount {
  accountID: string;
  network?: string;
  /** The account's own name on its network (its user's full name or username), for the user to tell two apart. */
  name?: string;
  /** Its connector's id. */
  source: string;
  /** Its reads stay quiet: chosen, its source's default, or no receipt can go now. */
  discreet: boolean;
  /**
   * What its connector can do (null: no receipts, never discreet). `send`: it has a read receipt; `available`: the
   * network takes it now (false after a refusal: reads stay quiet); `replyMayTell`: replying may tell anyway;
   * `replyTells`: replying always tells (every earlier message seen).
   */
  support: { discreet: boolean; send: boolean; available: boolean; replyMayTell: boolean; replyTells: boolean; note?: ReceiptSupport['note'] } | null;
}

const accountName = (a: { user?: { fullName?: unknown; username?: unknown } }): string | undefined => {
  const n = a.user?.fullName ?? a.user?.username;
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 80) : undefined;
};

/** GET /api/reading: the accounts, and the chats that have their own choice (chat id → discreet). */
export interface ReadingReply {
  accounts: ReadingAccount[];
  chats: Record<string, boolean>;
}

async function describe(): Promise<ReadingReply> {
  const out: ReadingAccount[] = [];
  for (const k of connectors()) {
    let accounts;
    try {
      accounts = await k.accounts();
    } catch {
      log('reading', 'accounts failed', { id: k.id });
      continue;
    }
    for (const a of accounts) {
      if (typeof a?.accountID !== 'string') continue;
      const r = k.receipts;
      const name = accountName(a);
      out.push({
        accountID: a.accountID,
        ...(typeof a.network === 'string' ? { network: a.network } : {}),
        ...(name ? { name } : {}),
        source: k.id,
        // Without a receipt that can go now, every read is quiet.
        discreet: !!r && (!canSend(r) || discreetAccount(a.accountID, k)),
        support: r
          ? { discreet: true, send: !!r.send, available: canSend(r), replyMayTell: r.replyMayTell === true || r.replyTells === true, replyTells: r.replyTells === true, ...(r.note ? { note: r.note } : {}) }
          : null,
      });
    }
  }
  return { accounts: out, chats: { ...load().chats } };
}

const limiter = new RateLimiter(10 * 60 * 1000, 60, 120);

export const readingRoutes = new Hono<Env>();

readingRoutes.get('/reading', async (c) => c.json(await describe()));

const small = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

/** A JSON body that is exactly {discreet}, its value passing `ok`; undefined otherwise. */
async function discreetBody(c: Context, ok: (v: unknown) => boolean): Promise<{ discreet: unknown } | undefined> {
  let b: unknown;
  try {
    b = await c.req.json();
  } catch {
    return undefined;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'discreet') || !('discreet' in b) || !ok(b.discreet)) return undefined;
  return b as { discreet: unknown };
}

const who = (c: Context<Env>) => ({ session: c.get('session')?.slice(0, 12) ?? '-', ip: clientIp(c) });

readingRoutes.put('/reading/:account', small, async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const accountID = c.req.param('account');
  const b = await discreetBody(c, (v) => typeof v === 'boolean');
  if (!validAccount(accountID) || !b) return c.json({ error: 'bad_request' }, 400);
  const discreet = b.discreet as boolean;
  const source = connectorForAccount(accountID);
  if (!source) return c.json({ error: 'not_found' }, 404);
  if (discreet && !source.receipts) return c.json({ error: 'unsupported' }, 409);
  const now = load();
  const accounts = { ...now.accounts, [accountID]: discreet };
  if (Object.keys(accounts).length > MAX_ACCOUNTS) return c.json({ error: 'too_many' }, 409);
  if (!save({ ...now, accounts })) return c.json({ error: 'write_failed' }, 500);
  log('reading', discreet ? 'discreet on' : 'discreet off', { source: source.id, ...who(c) });
  return c.json(await describe());
});

// One chat's own choice (its menu): true / false over its account's, null back to its account's. Only for a chat
// whose source can keep a read quiet and tell the network (else every read there is the same, whatever the choice).
readingRoutes.put('/reading/chat/:chat', small, async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const chatID = c.req.param('chat');
  const b = await discreetBody(c, (v) => typeof v === 'boolean' || v === null);
  if (!validId(chatID) || !b) return c.json({ error: 'bad_request' }, 400);
  const discreet = b.discreet as boolean | null;
  const source = connectorFor(chatID);
  if (!source) return c.json({ error: 'not_found' }, 404);
  if (discreet !== null && !source.receipts?.send) return c.json({ error: 'unsupported' }, 409);
  const now = load();
  const chats = { ...now.chats };
  if (discreet === null) delete chats[chatID];
  else chats[chatID] = discreet;
  if (Object.keys(chats).length > MAX_CHAT_CHOICES) return c.json({ error: 'too_many' }, 409);
  if (!save({ ...now, chats })) return c.json({ error: 'write_failed' }, 500);
  log('reading', discreet === null ? 'chat discreet reset' : discreet ? 'chat discreet on' : 'chat discreet off', { source: source.id, ...who(c) });
  return c.json(await describe());
});

// Every chat back to its account's choice (Settings).
readingRoutes.delete('/reading/chats', async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const now = load();
  const n = Object.keys(now.chats).length;
  if (n && !save({ ...now, chats: {} })) return c.json({ error: 'write_failed' }, 500);
  log('reading', 'chat choices reset', { chats: n, ...who(c) });
  return c.json(await describe());
});
