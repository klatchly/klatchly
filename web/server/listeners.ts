import { createServer, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { log } from './log.js';

// Listeners of the providers (ModuleContext.listen): a provider that another service calls back (posting
// its messages) gets its own HTTP server on an address of this container, e.g. on a network shared with that
// service only. The app itself is never served there: the main server drops every connection made to one of
// these addresses. The core owns them: closed after the modules stop, within a bounded time.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CLOSE_MS = 1000;

/** Why host:port cannot be a provider's listener (null: it can). A specific IPv4 address only, never 0.0.0.0. */
export function listenProblem(host: string, port: number): string | null {
  const m = IPV4.exec(host);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return 'host must be an IPv4 address';
  if (host === '0.0.0.0') return 'host must be a specific address';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'bad port';
  return null;
}

export class Listeners {
  private readonly servers: { pkg: string; addr: string; server: Server }[] = [];
  private readonly hosts = new Set<string>();
  private guarded = false;

  /**
   * `main`: the app's server, which then refuses connections made to the listeners' addresses, and at once to
   * `reserved` (the hosts the providers' configuration names, whether they listen or not).
   */
  constructor(
    private readonly main?: Server,
    reserved: readonly string[] = [],
  ) {
    for (const h of reserved) this.hosts.add(h);
    if (this.hosts.size) this.guard();
  }

  private guard(): void {
    if (!this.main || this.guarded) return;
    this.guarded = true;
    this.main.on('connection', (s: Socket) => {
      if (this.hosts.has(s.localAddress?.replace(/^::ffff:/, '') ?? '')) s.destroy();
    });
  }

  /** Serves `handler` at host:port for package `pkg`; resolves once listening. */
  listen(pkg: string, host: string, port: number, handler: RequestListener): Promise<void> {
    const why = listenProblem(host, port);
    if (why) return Promise.reject(new Error(why));
    // Before the listener is up: the app must never answer on that address, whatever happens next.
    this.hosts.add(host);
    this.guard();
    const addr = `${host}:${port}`;
    const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, handler);
    this.servers.push({ pkg, addr, server });
    return new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        server.on('error', (e) => log('ext', 'listener error', { id: pkg, name: e.name }));
        log('ext', 'listening', { id: pkg, addr });
        resolve();
      });
    });
  }

  /**
   * Closes the listeners of package `pkg` (a package turned off), or every one, open connections cut, within
   * CLOSE_MS. The addresses stay refused by the app; the package may listen there again when it comes back.
   */
  async close(pkg?: string): Promise<void> {
    const list = this.servers.filter((x) => pkg === undefined || x.pkg === pkg);
    for (const x of list) this.servers.splice(this.servers.indexOf(x), 1);
    await Promise.all(
      list.map(
        ({ server }) =>
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, CLOSE_MS);
            t.unref();
            server.close(() => {
              clearTimeout(t);
              resolve();
            });
            server.closeAllConnections();
          }),
      ),
    );
  }
}
