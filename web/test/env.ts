// Loaded before the tests (node --import): the server modules read their config at import time.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'klatchly-test-'));
writeFileSync(join(dir, 'token'), 'test-token\n');
// The canned upstream (test/mock.ts) listens where KLATCHLY_UPSTREAM points: a free port of this process's own, so
// the test files run in parallel (one process each, node --test) without stepping on each other's upstream.
const port = await new Promise<number>((ok) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => ok(port));
  });
});
process.env.KLATCHLY_ORIGIN = 'http://localhost:3095';
process.env.KLATCHLY_RP_ID = 'localhost';
process.env.KLATCHLY_UPSTREAM = `http://127.0.0.1:${process.env.MOCK_PORT ?? port}`;
process.env.KLATCHLY_TOKEN_FILE = join(dir, 'token');
process.env.KLATCHLY_DATA_DIR = dir;
// A stand-in for the built client (createApp reads index.html at start).
mkdirSync(join(dir, 'public'));
writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><title>test</title>');
// …and its list of public assets (server/appassets.ts): none under /assets/ here (test/appassets.test.ts writes its own).
writeFileSync(join(dir, 'public', 'public-assets.json'), JSON.stringify({ version: 'test', public: [], warm: [] }));
process.env.KLATCHLY_PUBLIC_DIR = join(dir, 'public');
