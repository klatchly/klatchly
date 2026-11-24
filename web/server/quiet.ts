import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { dataPath } from './config.js';
import { clientIp, type Env } from './context.js';
import { log } from './log.js';
import { isHeld, quietSince, validRule, type QuietRule, type QuietRules } from './quiethours.js';
import { RateLimiter } from './ratelimit.js';
import { accountOf } from './reading.js';
import { connectorFor, connectorForAccount, connectors } from './sources.js';

// Quiet hours ("Heures calmes", server/quiethours.ts has the rules): per messaging account and per chat, a daily
// window during which a chat that receives a message is held: no push notification, out of the app badge, out of
// the inbox (the client's Quiet list shows it), until the window closes. Server-wide, like discreet reading (one
// owner, several devices). Kept in the data volume (quiet.json: account and chat ids, times, days and a time zone,
// nothing else). Beeper's own apps are not told: their notifications are theirs.

let rules: QuietRules | undefined;
const MAX_ACCOUNTS = 500;
const MAX_CHAT_RULES = 5000;
const file = () => dataPath('quiet.json');

const validAccount = (id: string) => /^[\w.:@!+-]{1,200}$/.test(id);
// As reading.ts validId.
const validId = (id: string) => id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f\s]/.test(id);

function load(): QuietRules {
  if (rules) return rules;
  rules = { accounts: {}, chats: {} };
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { accounts?: unknown; chats?: unknown; releasedAt?: unknown };
    const accounts: Record<string, QuietRule> = {};
    const chats: Record<string, QuietRule | false> = {};
    if (raw.accounts && typeof raw.accounts === 'object') {
      for (const [id, r] of Object.entries(raw.accounts).slice(0, MAX_ACCOUNTS)) {
        const ok = validRule(r);
        if (ok && validAccount(id)) accounts[id] = ok;
      }
    }
    if (raw.chats && typeof raw.chats === 'object') {
      for (const [id, r] of Object.entries(raw.chats).slice(0, MAX_CHAT_RULES)) {
        const ok = r === false ? false : validRule(r);
        if (ok !== undefined && validId(id)) chats[id] = ok;
      }
    }
    rules = { accounts, chats, ...(typeof raw.releasedAt === 'number' && raw.releasedAt > 0 ? { releasedAt: raw.releasedAt } : {}) };
  } catch {
    // first run, or unreadable: no quiet hours
  }
  return rules;
}

function save(next: QuietRules): boolean {
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, ...next })}\n`, { mode: 0o600 });
    renameSync(tmp, file());
    rules = next;
    return true;
  } catch {
    log('quiet', 'state write failed');
    return false;
  }
}

/** Forgets the loaded rules (tests: a fresh data file). */
export function resetQuiet(): void {
  rules = undefined;
}

/** The rules as they stand (the badge and the routes read them). */
export const quietRules = (): QuietRules => load();

/** Whether a message arriving now in this chat is held (no push): its window is open. */
export function quietNow(chatID: string, accountID: string | undefined, now = Date.now()): boolean {
  return quietSince(load(), chatID, accountID ?? accountOf(chatID), now) !== null;
}

/** Whether a chat, as the badge knows it, is held now (left out of the count). */
export function heldNow(chat: { id: string; accountID?: string; unreadCount?: number; lastActivity?: string | number }, now = Date.now()): boolean {
  return isHeld(load(), { ...chat, accountID: chat.accountID ?? accountOf(chat.id) }, now);
}

/** One account as Settings shows it. */
export interface QuietAccount {
  accountID: string;
  network?: string;
  name?: string;
  source: string;
}

/** GET /api/quiet: the accounts (for Settings) and every rule. */
export interface QuietReply extends QuietRules {
  list: QuietAccount[];
}

const accountName = (a: { user?: { fullName?: unknown; username?: unknown } }): string | undefined => {
  const n = a.user?.fullName ?? a.user?.username;
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 80) : undefined;
};

async function describe(): Promise<QuietReply> {
  const list: QuietAccount[] = [];
  for (const k of connectors()) {
    let accounts;
    try {
      accounts = await k.accounts();
    } catch {
      log('quiet', 'accounts failed', { id: k.id });
      continue;
    }
    for (const a of accounts) {
      if (typeof a?.accountID !== 'string') continue;
      const name = accountName(a);
      list.push({ accountID: a.accountID, ...(typeof a.network === 'string' ? { network: a.network } : {}), ...(name ? { name } : {}), source: k.id });
    }
  }
  const r = load();
  return { list, accounts: { ...r.accounts }, chats: { ...r.chats }, ...(r.releasedAt ? { releasedAt: r.releasedAt } : {}) };
}

const limiter = new RateLimiter(10 * 60 * 1000, 60, 120);
export const quietRoutes = new Hono<Env>();

quietRoutes.get('/quiet', async (c) => c.json(await describe()));

const small = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

/** A JSON body that is exactly {rule}: a rule, null (none of its own) or, for a chat, false (never quiet). */
async function ruleBody(c: Context, allowFalse: boolean): Promise<{ rule: QuietRule | null | false } | undefined> {
  let b: unknown;
  try {
    b = await c.req.json();
  } catch {
    return undefined;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length !== 1 || !('rule' in b)) return undefined;
  const v = (b as { rule: unknown }).rule;
  if (v === null) return { rule: null };
  if (v === false) return allowFalse ? { rule: false } : undefined;
  const rule = validRule(v);
  return rule ? { rule } : undefined;
}

const who = (c: Context<Env>) => ({ session: c.get('session')?.slice(0, 12) ?? '-', ip: clientIp(c) });

// An account's window (Settings → Quiet hours), or null for none.
quietRoutes.put('/quiet/account/:account', small, async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const accountID = c.req.param('account');
  const b = await ruleBody(c, false);
  if (!validAccount(accountID) || !b) return c.json({ error: 'bad_request' }, 400);
  const source = connectorForAccount(accountID);
  if (!source) return c.json({ error: 'not_found' }, 404);
  const now = load();
  const accounts = { ...now.accounts };
  if (b.rule) accounts[accountID] = b.rule;
  else delete accounts[accountID];
  if (Object.keys(accounts).length > MAX_ACCOUNTS) return c.json({ error: 'too_many' }, 409);
  if (!save({ ...now, accounts })) return c.json({ error: 'write_failed' }, 500);
  log('quiet', b.rule ? 'account rule set' : 'account rule removed', { source: source.id, ...who(c) });
  return c.json(await describe());
});

// A chat's own: a window, false (never quiet), or null (back to its account's).
quietRoutes.put('/quiet/chat/:chat', small, async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const chatID = c.req.param('chat');
  const b = await ruleBody(c, true);
  if (!validId(chatID) || !b) return c.json({ error: 'bad_request' }, 400);
  const source = connectorFor(chatID);
  if (!source) return c.json({ error: 'not_found' }, 404);
  const now = load();
  const chats = { ...now.chats };
  if (b.rule === null) delete chats[chatID];
  else chats[chatID] = b.rule;
  if (Object.keys(chats).length > MAX_CHAT_RULES) return c.json({ error: 'too_many' }, 409);
  if (!save({ ...now, chats })) return c.json({ error: 'write_failed' }, 500);
  log('quiet', b.rule === null ? 'chat rule reset' : b.rule === false ? 'chat never quiet' : 'chat rule set', { source: source.id, ...who(c) });
  return c.json(await describe());
});

// Every chat back to its account's (Settings).
quietRoutes.delete('/quiet/chats', async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const now = load();
  const n = Object.keys(now.chats).length;
  if (n && !save({ ...now, chats: {} })) return c.json({ error: 'write_failed' }, 500);
  log('quiet', 'chat rules reset', { chats: n, ...who(c) });
  return c.json(await describe());
});

// "Show them now": what is held goes back to the inbox; messages from now on are held again while windows are open.
quietRoutes.post('/quiet/release', async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const now = load();
  if (!save({ ...now, releasedAt: Date.now() })) return c.json({ error: 'write_failed' }, 500);
  log('quiet', 'released', who(c));
  return c.json(await describe());
});
