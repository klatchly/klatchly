import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { sessions, store, type Env } from '../server/context.js';
import { ConnectorError } from '../server/connector.js';
import { Registry } from '../server/registry.js';
import { fakeSource } from './fakesource.js';

// "Mark all read" in the low-priority inbox (server/readall.ts) over several connectors (API 1.25: no default
// connector): every connector on that can, one after the other, their answers added up. A file of its own: the
// route's rate limit (5 per address) is per process.

const sid = store.mutate((s) => sessions.create(s));
const send = (app: Hono<Env>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { cookie: `sid=${sid}`, origin: config().origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Two connectors that each claim their chats and accounts (no legacy catch-all), and an app on them. */
function owners(over: { a?: Parameters<typeof fakeSource>[0]; b?: Parameters<typeof fakeSource>[0] } = {}) {
  const a = fakeSource({ owns: (id) => id.startsWith('a:'), ownsAccount: (x) => x === 'a', ...over.a }, 'a');
  const b = fakeSource({ owns: (id) => id.startsWith('b:'), ownsAccount: (x) => x === 'b', ...over.b }, 'b');
  const registry = new Registry([a.pkg, b.pkg]);
  return { a, b, registry, app: createApp(registry) };
}

test('read all (low priority) merged: every reader added up, failures counted, none supports it: 409', async () => {
  const reader = (read: string[], complete = true) => async (onRead?: (chatID: string) => void) => {
    for (const c of read) onRead?.(c);
    return { total: read.length + 1, read, failed: 1, complete };
  };
  const fail502 = async () => Promise.reject(new ConnectorError(502, 'upstream'));
  let r = owners({ a: { readAllLowPriority: reader(['a:1']) }, b: { readAllLowPriority: reader(['b:1', 'b:2']) } });
  let res = await send(r.app, 'POST', '/api/inbox/low-priority/read-all');
  assert.deepEqual(await res.json(), { total: 5, marked: 3, failed: 2, complete: true });
  r = owners({ a: { readAllLowPriority: reader(['a:1']) }, b: { readAllLowPriority: fail502 } });
  res = await send(r.app, 'POST', '/api/inbox/low-priority/read-all');
  assert.deepEqual(await res.json(), { total: 2, marked: 1, failed: 1, complete: false });
  r = owners({ a: { readAllLowPriority: async () => Promise.reject(new ConnectorError(504, 'slow')) }, b: { readAllLowPriority: fail502 } });
  res = await send(r.app, 'POST', '/api/inbox/low-priority/read-all');
  assert.equal(res.status, 504, "all failing: the first one's status");
  r = owners();
  assert.equal((await send(r.app, 'POST', '/api/inbox/low-priority/read-all')).status, 409);
  // Discreet chats are read quietly by their own source's rules (receipts.readAllLowPriorityByChat).
  const asked: string[] = [];
  r = owners({
    a: {
      receipts: {
        readQuietly: async () => {},
        send: async () => {},
        readAllLowPriorityByChat: async (_onRead, quiet) => {
          asked.push(`a:1 ${quiet('a:1', 'a')}`);
          return { total: 1, read: ['a:1'], failed: 0, complete: true };
        },
      },
    },
    b: { readAllLowPriority: reader([]) },
  });
  assert.equal((await send(r.app, 'PUT', '/api/reading/chat/a%3A1', { discreet: true })).status, 200);
  res = await send(r.app, 'POST', '/api/inbox/low-priority/read-all');
  assert.deepEqual(await res.json(), { total: 2, marked: 1, failed: 1, complete: true });
  assert.deepEqual(asked, ['a:1 true']);
  await send(r.app, 'DELETE', '/api/reading/chats');
});
