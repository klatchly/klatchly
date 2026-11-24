import type { Context } from 'hono';
import { upgradeWebSocket } from '@hono/node-server';
import WebSocket from 'ws';
import { sessions } from './context.js';
import { onBrowserFrame } from './broadcast.js';
import { SOURCE_FRAMES, type LiveSession } from './connector.js';
import { connectors } from './sources.js';
import { PING_MS, PongWatch } from './keepalive.js';

// One live feed per browser socket from each connector that keeps one (openLive; Beeper: one upstream socket
// per browser socket, single user), plus the frames every browser gets (broadcast.ts: the connectors' and the
// packages'). Only domain events flow down (SOURCE_FRAMES); the browser may only send a
// validated subscriptions.set and its visibility.

// Frame types of a live feed that reach the browser (connector.ts; message.delivered comes by broadcast only).
const FORWARD_TYPES = new Set([...SOURCE_FRAMES].filter((t) => t !== 'message.delivered'));
const MAX_CLIENT_MSG = 1024;
const MAX_IDS = 20;
const SESSION_CHECK_MS = 30_000;
const MAX_SOCKETS = 20;

type Closer = (code: number) => void;
const bySession = new Map<string, Set<Closer>>();
let socketCount = 0;

// What each open window shows, per session (= per device): used to suppress that device's pushes.
export interface ViewState {
  visible: boolean;
  focused: boolean;
  chatID: string | null;
  /** The package space shown (its id), if any. */
  space?: string | null;
}
const views = new Map<object, ViewState & { session: string }>();

export function setView(socket: object, session: string, v: ViewState | null): void {
  if (v) views.set(socket, { ...v, session });
  else views.delete(socket);
}

/**
 * Whether a push about `chatID` should be withheld from the device of `session`: one of its windows is
 * visible and focused (the user is in the app on that device), or visible and showing that very chat.
 * Other devices are not affected. Pure; exported for tests.
 */
export function suppressed(states: Iterable<ViewState>, chatID: string): boolean {
  for (const v of states) {
    if (!v.visible) continue;
    if (v.focused || v.chatID === chatID) return true;
  }
  return false;
}

export function suppressedFor(session: string, chatID: string): boolean {
  return suppressed([...views.values()].filter((v) => v.session === session), chatID);
}

/**
 * Whether the device of `session` is looking at a package's space right now (a visible, focused window showing
 * it): the space's own pushes are then withheld from that device (e.g. replies inside the space).
 */
export function spaceViewedBy(session: string, space: string): boolean {
  for (const v of views.values()) if (v.session === session && v.visible && v.focused && v.space === space) return true;
  return false;
}

export function closeSocketsForSession(hash: string): void {
  for (const close of bySession.get(hash) ?? []) close(4001);
  bySession.delete(hash);
}

type ClientMessage = { kind: 'subscriptions'; chatIDs: string[] } | ({ kind: 'visibility' } & ViewState);

export function parseClientMessage(data: unknown): ClientMessage | null {
  if (typeof data !== 'string' || data.length > MAX_CLIENT_MSG) return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (o.type === 'visibility') {
    if (Object.keys(o).some((k) => k !== 'type' && k !== 'visible' && k !== 'focused' && k !== 'chatID' && k !== 'space')) return null;
    if (typeof o.visible !== 'boolean' || (o.focused !== undefined && typeof o.focused !== 'boolean')) return null;
    const chatID = o.chatID ?? null;
    if (chatID !== null && (typeof chatID !== 'string' || !chatID || chatID.length > 512 || /[\u0000-\u001f\s]/.test(chatID))) return null;
    const space = o.space ?? null;
    if (space !== null && (typeof space !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(space))) return null;
    // Older clients only sent "visible", meaning visible and focused.
    return { kind: 'visibility', visible: o.visible, focused: typeof o.focused === 'boolean' ? o.focused : o.visible, chatID, space };
  }
  if (o.type !== 'subscriptions.set' || Object.keys(o).some((k) => k !== 'type' && k !== 'chatIDs')) return null;
  const ids = o.chatIDs;
  if (!Array.isArray(ids) || ids.length > MAX_IDS) return null;
  if (!ids.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 255 && !/[\u0000-\u001f]/.test(x))) {
    return null;
  }
  if (ids.includes('*') && ids.length !== 1) return null;
  return { kind: 'subscriptions', chatIDs: ids as string[] };
}

// Every browser socket's live session, with its connector: a connector whose package goes off closes its own.
const liveOf = new Map<LiveSession, { source: object; drop: () => void }>();

/** Closes the live sessions of a connector whose package went off (registry.ts); the browsers' sockets stay. */
export function closeLiveOf(source: object): void {
  for (const [session, x] of liveOf) {
    if (x.source !== source) continue;
    liveOf.delete(session);
    x.drop();
    session.close();
  }
}

export function wsHandler(c: Context, sessionHash: string) {
  return upgradeWebSocket(() => {
    let live: LiveSession[] = [];
    const timers: NodeJS.Timeout[] = [];
    let closed = false;
    let counted = false;
    let closer: Closer | undefined;
    let offFrames: (() => void) | undefined;
    const token = {};

    const cleanup = () => {
      if (closed) return;
      closed = true;
      views.delete(token);
      offFrames?.();
      if (counted) socketCount--;
      timers.forEach(clearInterval);
      if (closer) bySession.get(sessionHash)?.delete(closer);
      for (const l of live.splice(0)) {
        liveOf.delete(l);
        l.close();
      }
    };

    return {
      onOpen(_evt, ws) {
        const raw = ws.raw as unknown as WebSocket;
        if (socketCount >= MAX_SOCKETS) {
          raw.close(1013);
          return;
        }
        socketCount++;
        counted = true;
        closer = (code) => ws.close(code);
        let set = bySession.get(sessionHash);
        if (!set) bySession.set(sessionHash, (set = new Set()));
        set.add(closer);

        const send = (text: string) => {
          if (raw.readyState === WebSocket.OPEN) raw.send(text);
        };
        live = connectors().flatMap((k) => {
          if (!k.openLive) return [];
          const session = k.openLive({
            frame: (text) => {
              let type: unknown;
              try {
                type = (JSON.parse(text) as { type?: unknown }).type;
              } catch {
                return;
              }
              if (typeof type === 'string' && FORWARD_TYPES.has(type)) send(text);
            },
            closed: () => {
              if (!closed) ws.close(1011);
            },
          });
          // Its connector's package may go off while this socket is open (closeLiveOf).
          liveOf.set(session, { source: k, drop: () => (live = live.filter((l) => l !== session)) });
          return [session];
        });
        // The frames for every browser (broadcast.ts): the connectors' (Beeper's delivered ticks: a patch for
        // one cached message; the upserts of a source without a live feed per browser) and the packages'
        // "something changed" pings, no content.
        offFrames = onBrowserFrame((ev) => {
          if (raw.readyState === WebSocket.OPEN) raw.send(JSON.stringify(ev));
        });

        // Keepalive: protocol pings both ways (the live feeds' own), plus an app-level frame so the browser can
        // detect stalls. One pong late is tolerated (a busy phone, a slow upstream): the socket goes after two in a
        // row, as do the live feeds (LiveSession.ping), since each drop costs the browser a reconnect and a refresh.
        const pongs = new PongWatch();
        raw.on('pong', () => pongs.pong());
        timers.push(
          setInterval(() => {
            if (!pongs.ping() || !live.every((l) => l.ping())) {
              raw.terminate();
              return;
            }
            raw.ping();
            if (raw.readyState === WebSocket.OPEN) raw.send('{"type":"keepalive"}');
          }, PING_MS),
          setInterval(() => {
            if (!sessions.validateHash(sessionHash)) ws.close(4001);
          }, SESSION_CHECK_MS),
        );
      },
      onMessage(evt, ws) {
        const msg = parseClientMessage(evt.data);
        if (!msg) {
          ws.close(1008);
          return;
        }
        if (msg.kind === 'visibility') {
          setView(token, sessionHash, { visible: msg.visible, focused: msg.focused, chatID: msg.chatID, space: msg.space });
          return;
        }
        for (const l of live) l.subscribe(msg.chatIDs);
      },
      onClose: cleanup,
      onError: cleanup,
    };
  })(c, async () => {});
}
