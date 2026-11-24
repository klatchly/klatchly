// The browser sockets' keepalive (ws.ts): a protocol ping every PING_MS; a socket is dropped once MISSED_PONGS pings
// in a row went unanswered. One late pong is tolerated (a busy phone, a slow upstream): each drop costs the browser a
// reconnect and a refresh (2026-11-18: dropping on the first missed pong fed a request snowball).

export const PING_MS = 25_000;
/** Pings in a row left unanswered before a socket is dropped. */
export const MISSED_PONGS = 2;

/** One socket's pongs: `ping()` when a ping is due, `pong()` when one comes back. */
export class PongWatch {
  private missed = 0;

  pong(): void {
    this.missed = 0;
  }

  /** A ping is due: false when the socket is to be dropped instead, otherwise counts the ping about to go. */
  ping(): boolean {
    if (this.missed >= MISSED_PONGS) return false;
    this.missed++;
    return true;
  }
}
