import type { QueryClient } from '@tanstack/react-query';
import { dropLookups, findMessage, keys, patchMessage, refreshAfterReconnect, refreshConversationSoon, refreshListsSoon, refreshMessageSoon, refreshNewest, removeChat, upsertChat, upsertMessages } from './cache';
import { outgoing } from './pending';
import { ReconnectBackoff, RESUME_REFRESH_MS } from './refreshpolicy';
import type { Chat, Message } from './types';

type Status = 'connecting' | 'open' | 'closed';
type Event = { type: string; chatID?: string; ids?: string[]; entries?: Record<string, unknown>[]; messageID?: string; delivered?: Record<string, string> };

const STALL_MS = 70_000;
// Back from the background after this long: the socket may look open but be dead (iOS freezes suspended
// apps; NAT and proxies drop idle connections). Reconnect rather than wait for the stall timer.
const RESUME_RECONNECT_MS = 10_000;

/**
 * Browser side of /api/ws. Delivery upstream is at-most-once without replay, so every reconnect reads again what
 * may have changed and is on screen (cache.ts refreshAfterReconnect).
 */
export class Realtime {
  private ws?: WebSocket;
  // Starts over only once a connection has lasted (refreshpolicy.ts STABLE_MS).
  private backoff = new ReconnectBackoff();
  private retryTimer?: number;
  private stallTimer?: number;
  private resumeTimer?: number;
  private stopped = false;
  private connectedBefore = false;
  status: Status = 'closed';
  private listeners = new Set<(s: Status) => void>();

  constructor(
    private readonly qc: QueryClient,
    private readonly onSignedOut: () => void,
    private readonly onActivity: (chatID: string, msgs: Message[]) => void,
    private readonly viewChat: () => string | undefined = () => undefined,
    /** The package space this window shows (its id), if any. */
    private readonly viewSpace: () => string | undefined = () => undefined,
    /** Frames of the packages' server halves (registry.ts handleFrame). */
    private readonly onFrame: (ev: { type: string } & Record<string, unknown>) => void = () => {},
  ) {
    window.addEventListener('online', this.kick);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('visibilitychange', this.reportVisibility);
    window.addEventListener('focus', this.reportVisibility);
    window.addEventListener('blur', this.reportVisibility);
  }

  /**
   * What this window shows, so the server can spare this device notifications it does not need
   * (focused window: none; visible window: not for the chat on screen; a space's own pushes while it is on
   * screen). Other devices are unaffected.
   */
  private lastView?: string;
  reportVisibility = () => {
    const visible = document.visibilityState === 'visible';
    const view = JSON.stringify({ type: 'visibility', visible, focused: visible && document.hasFocus(), chatID: this.viewChat() ?? null, space: this.viewSpace() ?? null });
    if (this.ws?.readyState !== WebSocket.OPEN || view === this.lastView) return;
    this.lastView = view;
    this.ws.send(view);
  };

  subscribe(fn: (s: Status) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: Status) {
    this.status = s;
    this.listeners.forEach((l) => l(s));
  }

  private hiddenAt = 0;
  private onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = performance.now();
      return;
    }
    const away = this.hiddenAt ? performance.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    if (away > RESUME_RECONNECT_MS) this.reconnect();
    else this.kick();
  };

  /** Drop the current socket (open or not) and connect again; the open chat refreshes at once. */
  private reconnect() {
    if (this.stopped) return;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.stallTimer);
    const old = this.ws;
    this.ws = undefined;
    old?.close();
    this.backoff.reset();
    this.connect();
    // Whatever arrived while suspended: the socket's "ready" reads the chat on screen again (its newest page only,
    // not every page it holds). Should it be slow to come, the chat on screen does not wait for it.
    window.clearTimeout(this.resumeTimer);
    this.resumeTimer = window.setTimeout(() => {
      const chatID = this.viewChat();
      if (!chatID) return;
      void refreshNewest(this.qc, chatID);
      void this.qc.invalidateQueries({ queryKey: keys.chat(chatID) }, { cancelRefetch: false });
    }, RESUME_REFRESH_MS);
  }

  private kick = () => {
    if (this.stopped || document.visibilityState !== 'visible') return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      window.clearTimeout(this.retryTimer);
      this.connect();
    }
  };

  connect(): void {
    if (this.stopped) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
    this.setStatus('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ type: 'subscriptions.set', chatIDs: ['*'] }));
      this.lastView = undefined;
      this.reportVisibility();
      this.armStall();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.armStall();
      if (typeof e.data !== 'string') return;
      let ev: Event;
      try {
        ev = JSON.parse(e.data) as Event;
      } catch {
        return;
      }
      this.handle(ev);
    };
    ws.onclose = (e) => {
      // A socket replaced by reconnect(): its close must not touch the new one's timers.
      if (this.ws !== ws) return;
      window.clearTimeout(this.stallTimer);
      this.setStatus('closed');
      if (e.code === 4001) {
        this.stop();
        this.onSignedOut();
        return;
      }
      this.scheduleRetry();
    };
  }

  private armStall() {
    window.clearTimeout(this.stallTimer);
    this.stallTimer = window.setTimeout(() => this.ws?.close(), STALL_MS);
  }

  private scheduleRetry() {
    if (this.stopped) return;
    this.retryTimer = window.setTimeout(() => this.connect(), this.backoff.next(performance.now()));
  }

  private handle(ev: Event) {
    switch (ev.type) {
      case 'ready':
        this.backoff.ready(performance.now());
        this.setStatus('open');
        if (this.connectedBefore) {
          // It reads the chat on screen again itself: no second read of it from the resume.
          window.clearTimeout(this.resumeTimer);
          refreshAfterReconnect(this.qc, this.viewChat());
        }
        this.connectedBefore = true;
        return;
      case 'message.delivered':
        // A connector's delivery inferred by its server half (Beeper: delivery.ts) for one of our messages.
        if (typeof ev.chatID === 'string' && typeof ev.messageID === 'string' && ev.delivered && typeof ev.delivered === 'object') {
          const delivered = ev.delivered;
          patchMessage(this.qc, ev.chatID, ev.messageID, (m) => ({ ...m, delivered: { ...delivered, ...m.delivered } }));
        }
        return;
      case 'chat.upserted':
        for (const entry of ev.entries ?? []) {
          const chat = entry as unknown as Chat;
          if (typeof chat.id === 'string') upsertChat(this.qc, chat);
        }
        if (!ev.entries?.length) refreshListsSoon(this.qc);
        return;
      case 'chat.deleted':
        for (const id of ev.ids ?? []) removeChat(this.qc, id);
        if (ev.chatID) removeChat(this.qc, ev.chatID);
        return;
      case 'message.upserted': {
        if (!ev.chatID) return;
        const msgs = (ev.entries ?? []) as unknown as Message[];
        if (!msgs.length) {
          // "Something changed there": one reload for a burst (cache.ts refreshConversationSoon).
          refreshConversationSoon(this.qc, ev.chatID);
          return;
        }
        // Entries carry the canonical chat ID; the envelope's may be a local alias.
        const byChat = new Map<string, Message[]>();
        for (const m of msgs) {
          const id = typeof m.chatID === 'string' ? m.chatID : ev.chatID;
          byChat.set(id, [...(byChat.get(id) ?? []), m]);
        }
        for (const [chatID, list] of byChat) {
          this.reactionEvents(chatID, list);
          upsertMessages(this.qc, chatID, list);
          for (const m of list) if (m.isSender) outgoing.reconcile(chatID, m);
          this.onActivity(chatID, list);
        }
        return;
      }
      case 'message.deleted':
        // Removing a reaction also sends message.deleted (with the target's event ID) right after the
        // reaction event: that message is refreshed on its own, no need to reload every list.
        // The two arrive in either order: wait a moment for the reaction event before reloading.
        {
          // Reply quotes and reaction previews of these messages: read again when shown (they are kept long).
          dropLookups(this.qc, (ev.ids ?? []).filter((id) => typeof id === 'string'));
          const at = performance.now();
          if (at - this.lastReactionRemoval < 3000) return;
          // One reload for a burst of deletions (a bridge's redactions), not one per event: each would cancel the
          // previous in the browser only and pile the requests up on the server.
          this.deletedAt.push(at);
          if (this.deletedTimer) return;
          this.deletedTimer = window.setTimeout(() => {
            const times = this.deletedAt;
            this.deletedAt = [];
            this.deletedTimer = undefined;
            if (times.every((d) => Math.abs(this.lastReactionRemoval - d) < 3000)) return;
            // The envelope chat ID may be an alias: refresh whatever message lists are cached.
            void this.qc.invalidateQueries({ queryKey: ['messages'] }, { cancelRefetch: false });
          }, 700);
        }
        return;
      case 'extensions':
        // A package was turned off or on (Settings → Extensions, any device): spaces, slots and sections follow.
        void this.qc.invalidateQueries({ queryKey: ['extensions'] });
        // The worker's notification targets (/push-links.js, imported by sw.js) are checked with the worker: when
        // they changed (a space on or off), the browser installs it again (autoUpdate; appupdate.ts reloads the
        // page the next time it is out of sight).
        void navigator.serviceWorker
          ?.getRegistration()
          .then((r) => r?.update())
          .catch(() => {});
        return;
      default:
        // A package's frame ("this changed": its client half refetches).
        this.onFrame(ev);
    }
  }

  private lastReactionRemoval = -Infinity;
  private deletedAt: number[] = [];
  private deletedTimer: number | undefined;
  /**
   * Reaction events (type REACTION, hidden) point to their target through linkedMessageID. An added
   * reaction is followed by the updated target; a removed one is not (the event comes back without its
   * link, then a message.deleted): refresh that one message, found through the cached reaction event.
   */
  private reactionEvents(chatID: string, list: Message[]) {
    const targets = new Set(list.filter((m) => m.type !== 'REACTION').map((m) => m.id));
    const cached = !!this.qc.getQueryData(keys.messages(chatID));
    for (const m of list) {
      if (m.type !== 'REACTION') continue;
      const linked = m.linkedMessageID ?? findMessage(this.qc, chatID, m.id)?.linkedMessageID;
      if (!m.linkedMessageID) this.lastReactionRemoval = performance.now();
      if (cached && linked && !targets.has(linked)) refreshMessageSoon(this.qc, chatID, linked, m.linkedMessageID ? 1500 : 400);
    }
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.stallTimer);
    window.clearTimeout(this.resumeTimer);
    window.removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('visibilitychange', this.reportVisibility);
    window.removeEventListener('focus', this.reportVisibility);
    window.removeEventListener('blur', this.reportVisibility);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.setStatus('closed');
  }
}
