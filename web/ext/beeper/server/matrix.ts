import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { APIError } from '@beeper/desktop-api';
import { clientIp, jsonObject, log, RateLimiter, validId, type Chat, type Env } from '#core/sdk.js';
import { MATRIX_ACCOUNT, parseRoomTarget, type RoomTarget } from '../matrix.js';
import { isBeeperChatID } from '../package.js';
import { desktop } from './desktop.js';
import { dropScan } from './inbox.js';
import { api } from './upstream.js';

// Joining and leaving Matrix rooms with the Beeper account (its module's routes, /api/beeper/matrix/…, behind the
// core's session and origin checks like every package route):
//
//   POST /matrix/join   {target}  '#alias:server', '!id:server' or a matrix.to link (../matrix.ts) -> {chatID, joined, ready, muted}
//   POST /matrix/leave  {chatID}  a chat of type 'group' of the Matrix account only                   -> {left: true}
//                                 (409 not_matrix for a chat of another account, 409 not_group for a direct chat)
//
// UNDOCUMENTED UPSTREAM: both call the Matrix client-server endpoints beeper-server serves on its own API, with the
// same token (POST /_matrix/client/v3/join/{roomIdOrAlias}, POST /_matrix/client/v3/rooms/{roomId}/leave). They are
// in the OpenAPI document beeper-server serves (docs/desktop-api-openapi-4.3.229.json, tag "Matrix") but not in
// Beeper's public Desktop API reference nor its SDK: they may change or go with any beeper-server update. join was
// checked on 4.3.284 (the room then shows in /v1/chats as a chat of the 'matrix' account); leave was not. When
// either answers 404/405 without Matrix's M_NOT_FOUND (the endpoint is gone), the route says 'join_unavailable' /
// 'leave_unavailable' and the client tells the user to join from a Beeper app instead.
//
// A room joined here arrives muted (the owner's choice: public rooms are noisy), best effort: the mute is set once
// /v1/chats knows the room (a few seconds after the join), and retried in the background a little longer if the
// route stopped waiting or the first mute failed. A room one was already in is left as it is (no mute, joined: false).

const enc = encodeURIComponent;

// Join: 20 per address per 10 minutes (40 for everyone); leave: 30 (60), as the core's forward and new-chat writes.
const joinLimiter = new RateLimiter(10 * 60 * 1000, 20, 40);
const leaveLimiter = new RateLimiter(10 * 60 * 1000, 30, 60);
const small = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });

// How long the route waits for /v1/chats to know a joined room, and the background mute after it.
const WAIT_STEPS = [500, 750, 1000, 1250, 1500, 2000];
// A big federated room can take ~20 s more to show in /v1/chats after the join answers (#matrix:matrix.org, 2026-11-24).
const LATER_STEPS = [3000, 5000, 8000, 13_000, 21_000, 34_000];
// Joining over federation is slow (38 s measured for a 60k-member room): this call alone gets more than the client's 30 s.
const JOIN_TIMEOUT_MS = 120_000;
let timings = { wait: WAIT_STEPS, later: LATER_STEPS };
/** Tests: shorter waits. */
export const setMatrixTimingsForTests = (wait: number[], later: number[]) => (timings = { wait, later });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Matrix error code of an upstream error ('M_FORBIDDEN'…), when it has a plain one: it is logged, so anything
 * else (a CR/LF, a long string) is dropped, as upstreamFailure does (upstream.ts).
 */
function errcode(e: unknown): string | undefined {
  if (!(e instanceof APIError)) return undefined;
  const b = e.error as { errcode?: unknown } | undefined;
  const raw = b && typeof b === 'object' ? b.errcode : undefined;
  return typeof raw === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : undefined;
}

type Refusal = { status: 400 | 404 | 409 | 422 | 429 | 502 | 504; error: string };

/** An upstream error as the browser's answer (never 401/403: a 403 is the room's refusal, 409). */
function refusal(e: unknown, op: 'join' | 'leave'): Refusal {
  if (e instanceof APIError && typeof e.status === 'number') {
    const code = errcode(e);
    if (e.status === 403) return { status: 409, error: 'room_forbidden' };
    if (e.status === 429) return { status: 429, error: 'rate_limited' };
    if (e.status === 404 && code === 'M_NOT_FOUND') return { status: 404, error: 'room_not_found' };
    // The endpoint itself is unknown (removed from beeper-server, M_UNRECOGNIZED or a plain 404).
    if (e.status === 404 || e.status === 405) return { status: 502, error: `${op}_unavailable` };
    if (e.status === 400 || e.status === 422) return { status: 422, error: 'room_refused' };
    return { status: 502, error: 'upstream' };
  }
  if (e instanceof Error && e.name === 'APIConnectionTimeoutError') return { status: 504, error: 'upstream' };
  return { status: 502, error: 'upstream' };
}

/** The chat as /v1/chats has it, or null while it does not know it (404). Other errors throw. */
async function knownChat(id: string): Promise<Chat | null> {
  try {
    return (await api().chats.retrieve(id, { maxParticipantCount: 0 })) as unknown as Chat;
  } catch (e) {
    if (e instanceof APIError && e.status === 404) return null;
    throw e;
  }
}

/** Mutes a chat the way the chat menu does (desktop.update: the shared chat scan is dropped). */
async function mute(id: string): Promise<boolean> {
  try {
    await desktop.update(id, { isMuted: true });
    return true;
  } catch {
    return false;
  }
}

// Background mutes of rooms the route stopped waiting for (cleared when the connector stops).
const later = new Set<ReturnType<typeof setTimeout>>();

function muteLater(id: string, step = 0): void {
  const ms = timings.later[step];
  if (ms === undefined) {
    log('beeper', 'matrix join: not muted (the room never showed, or the mute kept failing)');
    return;
  }
  const t = setTimeout(async () => {
    later.delete(t);
    const chat = await knownChat(id).catch(() => null);
    if (chat ? !(await mute(id)) : true) muteLater(id, step + 1);
  }, ms);
  later.add(t);
}

/** Connector stop: no background mute left running. */
export function stopMatrix(): void {
  for (const t of later) clearTimeout(t);
  later.clear();
}

export interface JoinResult {
  chatID: string;
  /** false: the account was already in the room (nothing joined, nothing muted). */
  joined: boolean;
  /** /v1/chats knows the room: the conversation can open. */
  ready: boolean;
  muted: boolean;
}

/** Joins a room (or finds it, already joined), mutes it when new, waits a little for /v1/chats to know it. */
export async function joinRoom(t: RoomTarget): Promise<JoinResult> {
  // A room id one is already in: opened as it is.
  if (t.kind === 'id') {
    const chat = await knownChat(t.room).catch(() => null);
    if (chat) return { chatID: t.room, joined: false, ready: true, muted: !!chat.isMuted };
  }
  const via = t.via.length ? { server_name: t.via, via: t.via } : undefined;
  const r = (await api().post(`/_matrix/client/v3/join/${enc(t.room)}`, { ...(via ? { query: via } : {}), body: {}, timeout: JOIN_TIMEOUT_MS })) as { room_id?: unknown };
  const id = r?.room_id;
  if (typeof id !== 'string' || !isBeeperChatID(id) || !validId(id)) throw new Error('join: no room id');
  // An alias of a room one was already in: /v1/chats knows it at once (a new room takes a few seconds).
  if (t.kind === 'alias') {
    const chat = await knownChat(id).catch(() => null);
    if (chat) return { chatID: id, joined: false, ready: true, muted: !!chat.isMuted };
  }
  for (const ms of timings.wait) {
    await sleep(ms);
    const chat = await knownChat(id).catch(() => null);
    if (!chat) continue;
    const muted = await mute(id);
    // A mute that failed: tried again in the background, like a room the route stopped waiting for.
    if (!muted) muteLater(id);
    return { chatID: id, joined: true, ready: true, muted: muted || !!chat.isMuted };
  }
  muteLater(id);
  return { chatID: id, joined: true, ready: false, muted: false };
}

/**
 * Leaves a group room of the Matrix account; refused for a chat of another account, a direct chat (owner's choice:
 * groups only, so a private conversation is never left by mistake), or one /v1/chats does not know.
 */
export async function leaveRoom(id: string): Promise<'left' | 'not_found' | 'not_matrix' | 'not_group'> {
  const chat = await knownChat(id);
  if (!chat) return 'not_found';
  if (chat.accountID !== MATRIX_ACCOUNT) return 'not_matrix';
  if (chat.type !== 'group') return 'not_group';
  await api().post(`/_matrix/client/v3/rooms/${enc(id)}/leave`, { body: {} });
  // The shared chat scan (inbox.ts) still counts it.
  dropScan();
  return 'left';
}

const limited = (limiter: RateLimiter) => async (c: Context<Env>, next: () => Promise<void>) =>
  limiter.allow(clientIp(c)) ? next() : c.json({ error: 'rate_limited' }, 429);

export const matrixRoutes = new Hono<Env>();

matrixRoutes.post('/matrix/join', limited(joinLimiter), small, async (c) => {
  const b = await jsonObject(c);
  if (!b || Object.keys(b).some((k) => k !== 'target')) return c.json({ error: 'bad_request' }, 400);
  const target = parseRoomTarget(b.target);
  if (!target) return c.json({ error: 'bad_target' }, 400);
  try {
    const r = await joinRoom(target);
    // The room, never the alias or link typed (what one joins is one's own business; the id is in the chat list).
    log('beeper', 'matrix join', { kind: target.kind, via: target.via.length, joined: r.joined, ready: r.ready, muted: r.muted });
    return c.json(r);
  } catch (e) {
    const f = refusal(e, 'join');
    const code = errcode(e);
    log('beeper', 'matrix join refused', { kind: target.kind, status: f.status, error: f.error, ...(code ? { errcode: code } : {}) });
    return c.json({ error: f.error }, f.status);
  }
});

matrixRoutes.post('/matrix/leave', limited(leaveLimiter), small, async (c) => {
  const b = await jsonObject(c);
  if (!b || Object.keys(b).some((k) => k !== 'chatID')) return c.json({ error: 'bad_request' }, 400);
  const id = b.chatID;
  if (typeof id !== 'string' || !validId(id) || !isBeeperChatID(id)) return c.json({ error: 'bad_request' }, 400);
  try {
    const r = await leaveRoom(id);
    if (r === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (r === 'not_matrix') return c.json({ error: 'not_matrix' }, 409);
    if (r === 'not_group') return c.json({ error: 'not_group' }, 409);
    log('beeper', 'matrix leave');
    return c.json({ left: true });
  } catch (e) {
    const f = refusal(e, 'leave');
    const code = errcode(e);
    log('beeper', 'matrix leave refused', { status: f.status, error: f.error, ...(code ? { errcode: code } : {}) });
    return c.json({ error: f.error }, f.status);
  }
});
