import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { dataPath } from './config.js';
import { clientIp, type Env } from './context.js';
import { log } from './log.js';
import { DEFAULT_MEMBERSHIP_MODE, MEMBERSHIP_MODES, type ChatEventsReply, type MembershipMode } from './membership.js';
import { RateLimiter } from './ratelimit.js';
import { validId } from './relay.js';

// How arrivals and departures show in conversations (membership.ts): a choice for all chats (Settings → Reading)
// and a chat's own (its menu), server-wide like the reading choices (one owner, several devices). Kept in the data
// volume (chatevents.json: chat ids and modes, nothing else).

const MAX_CHATS = 5000;
const file = () => dataPath('chatevents.json');
let state: ChatEventsReply | undefined;
const isMode = (v: unknown): v is MembershipMode => typeof v === 'string' && (MEMBERSHIP_MODES as readonly string[]).includes(v);

function load(): ChatEventsReply {
  if (state) return state;
  state = { membership: DEFAULT_MEMBERSHIP_MODE, chats: {} };
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { membership?: unknown; chats?: unknown };
    const chats: Record<string, MembershipMode> = {};
    if (raw.chats && typeof raw.chats === 'object' && !Array.isArray(raw.chats))
      for (const [id, v] of Object.entries(raw.chats as Record<string, unknown>).slice(0, MAX_CHATS)) if (validId(id) && isMode(v)) chats[id] = v;
    state = { membership: isMode(raw.membership) ? raw.membership : DEFAULT_MEMBERSHIP_MODE, chats };
  } catch {
    // first run, or unreadable: the default
  }
  return state;
}

function save(next: ChatEventsReply): boolean {
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, ...next })}\n`, { mode: 0o600 });
    renameSync(tmp, file());
    state = next;
    return true;
  } catch {
    log('chatevents', 'state write failed');
    return false;
  }
}

/** For tests: forget the cached state. */
export function resetChatEvents(): void {
  state = undefined;
}

const limiter = new RateLimiter(10 * 60 * 1000, 60, 120);
const small = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

export const chatEventsRoutes = new Hono<Env>();

chatEventsRoutes.get('/chat-events', (c) => c.json(load()));

// {membership} for all chats, or {chat, membership} for one (membership null: back to the choice for all chats).
chatEventsRoutes.put('/chat-events', small, async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  let b: unknown;
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request' }, 400);
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return c.json({ error: 'bad_request' }, 400);
  const { chat, membership, ...rest } = b as Record<string, unknown>;
  if (Object.keys(rest).length) return c.json({ error: 'bad_request' }, 400);
  const now = load();
  if (chat === undefined) {
    if (!isMode(membership)) return c.json({ error: 'bad_request' }, 400);
    if (!save({ ...now, membership })) return c.json({ error: 'write_failed' }, 500);
    log('chatevents', 'membership mode', { mode: membership });
    return c.json(load());
  }
  if (typeof chat !== 'string' || !validId(chat) || (membership !== null && !isMode(membership))) return c.json({ error: 'bad_request' }, 400);
  const chats = { ...now.chats };
  if (membership === null) delete chats[chat];
  else chats[chat] = membership;
  if (Object.keys(chats).length > MAX_CHATS) return c.json({ error: 'too_many' }, 409);
  if (!save({ ...now, chats })) return c.json({ error: 'write_failed' }, 500);
  log('chatevents', membership === null ? 'chat membership reset' : 'chat membership mode', membership === null ? {} : { mode: membership });
  return c.json(load());
});
