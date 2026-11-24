import { rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';

// A fake HTTP server on a Unix socket for the packages' tests (a door or a gateway a package long-polls): each
// request is answered by `answer` (which may hold it); the requests seen and those still open are counted by path
// (`?wait` appended when the query holds a non-zero `wait`).

export interface SocketServer {
  open(key: string): number;
  seen(key: string): number;
  close(): Promise<void>;
}

export async function socketServer(path: string, answer: (url: URL, res: ServerResponse) => void): Promise<SocketServer> {
  rmSync(path, { force: true });
  const open = new Map<string, number>();
  const seen = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = url.pathname + (url.searchParams.get('wait') && url.searchParams.get('wait') !== '0' ? '?wait' : '');
    seen.set(key, (seen.get(key) ?? 0) + 1);
    open.set(key, (open.get(key) ?? 0) + 1);
    res.on('close', () => open.set(key, open.get(key)! - 1));
    answer(url, res);
  });
  await new Promise<void>((ok) => server.listen(path, ok));
  return {
    open: (k) => open.get(k) ?? 0,
    seen: (k) => seen.get(k) ?? 0,
    close: () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))),
  };
}

/** A JSON answer, unless the client went away. */
export function json(res: ServerResponse, body: unknown): void {
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Polls `cond` every 20 ms for up to `ms`; its last value. */
export async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms; ) await new Promise((ok) => setTimeout(ok, 20));
  return cond();
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
