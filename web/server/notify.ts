import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { clientIp, type Env } from './context.js';
import { RateLimiter } from './ratelimit.js';
import { fail, jsonObject, MAX_TEXT, validId } from './relay.js';
import { badgeCount, noteRead } from './pushwatch.js';
import { readAfterReply, readChat } from './reading.js';
import { connectorFor } from './sources.js';

// Actions taken from a notification by the service worker, without opening a window. Same session
// cookie and CSRF rules as every other route (a service worker fetch is same-origin: it carries Origin
// and Sec-Fetch-Site: same-origin). Both answer with the new badge count.

const limiter = new RateLimiter(10 * 60 * 1000, 60, 120);
const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

export const notifyRoutes = new Hono<Env>();

// Single source for the app icon badge (pages and the service worker show the same number).
notifyRoutes.get('/notify/badge', (c) => c.json({ badge: badgeCount() }));

notifyRoutes.post('/notify/read', small, async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const body = await jsonObject(c);
  if (!body || Object.keys(body).some((k) => k !== 'chatID') || typeof body.chatID !== 'string' || !validId(body.chatID)) {
    return c.json({ error: 'bad_request' }, 400);
  }
  const source = connectorFor(body.chatID);
  if (!source) return c.json({ error: 'not_found' }, 404);
  try {
    // As reading it in the app: discreet when the chat's account reads discreetly.
    await readChat(source, body.chatID, undefined, false);
    noteRead(body.chatID);
    return c.json({ ok: true, badge: badgeCount() });
  } catch (e) {
    return fail(c, e, 'POST /notify/read', source);
  }
});

notifyRoutes.post('/notify/reply', small, async (c) => {
  if (!limiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const body = await jsonObject(c);
  if (!body || Object.keys(body).some((k) => k !== 'chatID' && k !== 'text')) return c.json({ error: 'bad_request' }, 400);
  const { chatID, text } = body;
  if (typeof chatID !== 'string' || !validId(chatID) || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
    return c.json({ error: 'bad_request' }, 400);
  }
  const source = connectorFor(chatID);
  if (!source) return c.json({ error: 'not_found' }, 404);
  try {
    await source.send(chatID, { text });
    // Replying means the chat was read: for real where replying always tells (receipts.replyTells), else as its
    // setting says (the reply itself may tell the sender, but a discreet chat sends no receipt).
    if (!(await readAfterReply(source, chatID))) await readChat(source, chatID, undefined, false).catch(() => {});
    noteRead(chatID);
    return c.json({ ok: true, badge: badgeCount() });
  } catch (e) {
    return fail(c, e, 'POST /notify/reply', source);
  }
});
