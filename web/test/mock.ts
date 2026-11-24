import { createServer, type IncomingMessage, type Server } from 'node:http';

export type Call = { method: string; url: string; body: string; auth?: string };

/** Minimal stand-in for beeper-server: canned responses per "METHOD path", records every call. */
export function mockUpstream(routes: Record<string, (req: IncomingMessage, body: string) => [number, unknown?]>) {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '').split('?')[0]!;
      calls.push({ method: req.method ?? '', url: req.url ?? '', body, auth: req.headers.authorization });
      const h = routes[`${req.method} ${path}`];
      const [status, json] = h ? h(req, body) : [404, { message: 'not found' }];
      res.writeHead(status, json === undefined ? {} : { 'Content-Type': 'application/json' });
      res.end(json === undefined ? undefined : JSON.stringify(json));
    });
  });
  const port = Number(new URL(process.env.KLATCHLY_UPSTREAM!).port);
  return {
    calls,
    start: () => new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r())),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
