import { Hono } from 'hono';
import { clientIp, type Env } from './context.js';
import { RateLimiter } from './ratelimit.js';
import { noteRead } from './badgecount.js';
import { log } from './log.js';
import { discreetFor } from './reading.js';
import type { ConnectorModule } from './registry.js';
import { failureOf, lowPriorityReaders } from './sources.js';

// POST /api/inbox/low-priority/read-all: marks every low-priority chat with unread messages as read, not only
// the pages the browser has loaded: every connector on that can (its readAllLowPriority, in its receipts or not),
// one after the other; a chat that reads discreetly, by its own choice or its account's, is read in Klatchly only
// (reading.ts, by its own connector's rules). The badge drops each chat as it is marked. Answers with the counts
// added up; complete only when every connector finished.

const limiter = new RateLimiter(10 * 60 * 1000, 5, 10);
let running = false;

type ReadAll = { total: number; read: string[]; failed: number; complete: boolean };

/** One connector's whole low-priority inbox, its discreet chats and accounts kept quiet. */
function readAllOf(source: ConnectorModule): Promise<ReadAll> {
  // Discreet chats and accounts stay quiet (reading.ts): through the connector's receipts when it has them. Asked by
  // account only (before API 1.6), an account with a chat made discreet on its own is read quietly (fail closed).
  const byChat = source.receipts?.readAllLowPriorityByChat;
  const quietly = source.receipts?.readAllLowPriority;
  if (byChat) return byChat(noteRead, (chatID, accountID) => discreetFor(source, accountID, chatID));
  if (quietly) return quietly(noteRead, (accountID) => discreetFor(source, accountID));
  return source.readAllLowPriority!(noteRead);
}

export const readAllRoutes = new Hono<Env>();

readAllRoutes.post('/inbox/low-priority/read-all', async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const readers = lowPriorityReaders();
  if (!readers.length) return c.json({ error: 'unsupported' }, 409);
  if (running) return c.json({ error: 'busy' }, 429);
  running = true;
  try {
    const out = { total: 0, marked: 0, failed: 0, complete: true };
    let first: { e: unknown; source: ConnectorModule } | undefined;
    let done = 0;
    for (const source of readers) {
      try {
        const r = await readAllOf(source);
        for (const id of r.read) noteRead(id);
        out.total += r.total;
        out.marked += r.read.length;
        out.failed += r.failed;
        out.complete &&= r.complete;
        done++;
        log('readall', 'low priority', { source: source.id, total: r.total, marked: r.read.length, failed: r.failed });
      } catch (e) {
        first ??= { e, source };
        out.complete = false;
        log('readall', 'upstream error', { source: source.id, status: failureOf(e, source).status });
      }
    }
    if (!done && first) return c.json({ error: 'upstream' }, failureOf(first.e, first.source).status);
    return c.json(out);
  } finally {
    running = false;
  }
});
