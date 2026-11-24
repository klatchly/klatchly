import WebSocket from 'ws';
import { log, type Chat, type LiveSession, type LiveSink, type Message, type SourceFeed } from '#core/sdk.js';
import { upstreamToken, upstreamWs } from './upstream.js';
import { enrichFrame, onDeliveryEvent, trackDelivery } from './delivery.js';
import { localChats, localFrame } from './localread.js';
import { accountsPending } from './accounts.js';
import { desktop } from './desktop.js';
import { dropScan, patchScan } from './inbox.js';

// The Desktop API's WebSocket, twice over (moved from the core's pushwatch.ts and ws.ts):
// - one persistent socket subscribed to every chat, independent of the browsers: its chat and message upserts go
//   to the core (badge, push notifications, the 'events' augmentations), and our own messages' upserts feed the
//   delivered-tick inference first (delivery.ts);
// - one socket per browser socket (openLive), with that browser's own chat subscriptions: its frames go to that
//   browser, our messages with the delivered ticks inferred so far (upstream copies never carry them).

const PING_MS = 25_000;
// Pings in a row left unanswered before an upstream socket counts as dead: one late pong (beeper-server busy) is
// tolerated, since each drop costs a reconnect, a badge recount and the browsers' refresh.
const MISSED_PONGS = 2;
// The reconnect backoff starts over only once a connection has lasted this long, not on each 'ready': beeper-server
// accepting the socket then missing its pongs (overloaded) would otherwise be reconnected to every second.
export const STABLE_MS = 2 * 60_000;

/** The attempt count to go on from once a socket closed that was up `upFor` ms (undefined: never ready). */
export const attemptAfter = (attempt: number, upFor: number | undefined): number => (upFor !== undefined && upFor >= STABLE_MS ? 0 : attempt);

const connect = () =>
  new WebSocket(upstreamWs(), {
    headers: { Authorization: `Bearer ${upstreamToken()}` },
    maxPayload: 32 * 1024 * 1024,
    handshakeTimeout: 10_000,
  });

export class BeeperEvents {
  private ws?: WebSocket;
  private timer?: NodeJS.Timeout;
  private ping?: NodeJS.Timeout;
  private attempt = 0;
  private readyAt?: number;
  private stopped = false;
  private offDelivery?: () => void;

  constructor(private readonly feed: SourceFeed) {}

  start(): void {
    if (this.stopped) return;
    // Delivered ticks inferred by delivery.ts: a patch for one cached message, to every browser.
    this.offDelivery ??= onDeliveryEvent((ev) => this.feed.toBrowsers(ev));
    const ws = connect();
    this.ws = ws;
    let missed = 0;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscriptions.set', chatIDs: ['*'] }));
      this.ping = setInterval(() => {
        if (missed >= MISSED_PONGS) return ws.terminate();
        missed++;
        ws.ping();
      }, PING_MS);
      this.ping.unref();
    });
    ws.on('pong', () => (missed = 0));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let ev: { type?: unknown; entries?: unknown };
      try {
        ev = JSON.parse(data.toString()) as typeof ev;
      } catch {
        return;
      }
      if (ev.type === 'ready') {
        this.readyAt = Date.now();
        // Events may have been missed while it was away: the shared chat scan is read again (inbox.ts).
        dropScan();
        log('pushwatch', 'connected');
        // First start: learns the accounts now that beeper-server answers (accounts.ts), without waiting for a list.
        if (accountsPending()) desktop.accounts().catch(() => log('beeper', 'accounts listing failed'));
        this.feed.event({ type: 'ready' });
        return;
      }
      if (!Array.isArray(ev.entries)) return;
      if (ev.type === 'chat.upserted') {
        // The shared chat scan takes them as upstream gives them (discreet reads are applied on the way out).
        patchScan(ev.entries as Chat[]);
        this.feed.event({ type: 'chat.upserted', entries: localChats(ev.entries as Chat[]) });
      }
      else if (ev.type === 'message.upserted') {
        // Delivered ticks inferred from the upsert sequence of our own messages (delivery.ts).
        try {
          void trackDelivery(ev.entries);
        } catch {
          log('pushwatch', 'delivery tracker error');
        }
        this.feed.event({ type: 'message.upserted', entries: ev.entries as Message[] });
      }
    });
    ws.on('close', () => {
      clearInterval(this.ping);
      dropScan();
      this.feed.event({ type: 'closed' });
      this.attempt = attemptAfter(this.attempt, this.readyAt === undefined ? undefined : Date.now() - this.readyAt);
      this.readyAt = undefined;
      if (this.stopped) return;
      const delay = Math.min(60_000, 1000 * 2 ** this.attempt++);
      // Unref'd: the app's server keeps the process; a stopped or test registry does not wait for it.
      this.timer = setTimeout(() => this.start(), delay).unref();
    });
    ws.on('error', () => log('pushwatch', 'upstream error'));
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.offDelivery?.();
    this.ws?.close();
  }
}

/** The connector's `openLive`: one upstream socket for one browser socket. */
export function openLive(sink: LiveSink): LiveSession {
  const upstream = connect();
  const queue: string[] = [];
  let missed = 0;
  let closed = false;
  upstream.on('open', () => {
    for (const m of queue.splice(0)) upstream.send(m);
  });
  upstream.on('message', (data, isBinary) => {
    if (isBinary) return;
    // Our messages keep the delivered ticks inferred so far; chats, their unread counts as Klatchly shows them.
    sink.frame(localFrame(enrichFrame(data.toString())));
  });
  upstream.on('close', () => {
    if (!closed) sink.closed();
  });
  upstream.on('error', () => {
    log('ws', 'upstream error');
  });
  upstream.on('pong', () => (missed = 0));
  return {
    subscribe(chatIDs) {
      const text = JSON.stringify({ type: 'subscriptions.set', chatIDs });
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else if (queue.length < 4) queue.push(text);
    },
    ping() {
      if (missed >= MISSED_PONGS) return false;
      if (upstream.readyState === WebSocket.OPEN) {
        missed++;
        upstream.ping();
      }
      return true;
    },
    close() {
      closed = true;
      if (upstream.readyState <= WebSocket.OPEN) upstream.terminate();
    },
  };
}
