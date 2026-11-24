import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, rangedRelay, RangeCache, type Upstream } from '../server/ranges.js';

test('parseRange: single ranges, suffixes, open ends, unsatisfiable and ignored forms', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-1', 1000), null);
  assert.equal(parseRange('bytes=0-1,5-9', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange(undefined, 1000), null);
});

const file = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const stream = (b: Buffer) => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new Uint8Array(b)), c.close()) });
const base = () => new Headers({ 'Cache-Control': 'private', 'Content-Security-Policy': "sandbox; default-src 'none'" });

/** A source like some photo CDNs: ignores Range, always 200 with the whole file. */
function noRanges(calls: Record<string, string>[]) {
  return async (fwd: Record<string, string>): Promise<Upstream> => {
    calls.push(fwd);
    return { status: 200, headers: { 'content-type': 'image/jpg', 'content-length': String(file.length) }, body: stream(file) };
  };
}

test('source without Range support: the file is read once, sliced and cached (206, Content-Range, ETag)', async () => {
  const cache = new RangeCache();
  const calls: Record<string, string>[] = [];
  const opts = { key: 'k1', base: base(), cache, fetch: noRanges(calls), type: (t?: string) => (t === 'image/jpg' ? 'image/jpeg' : t!) };
  const r = await rangedRelay({ ...opts, req: new Headers({ range: 'bytes=0-1' }) });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-1/1000');
  assert.equal(r.headers.get('content-length'), '2');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0, 1]);
  const etag = r.headers.get('etag')!;
  assert.match(etag, /^"z[A-Za-z0-9_-]{22}"$/);
  // next ranges come from memory: no new upstream call
  const r2 = await rangedRelay({ ...opts, req: new Headers({ range: 'bytes=998-' }) });
  assert.equal(r2.status, 206);
  assert.equal(r2.headers.get('content-range'), 'bytes 998-999/1000');
  assert.deepEqual([...new Uint8Array(await r2.arrayBuffer())], [998 % 256, 999 % 256]);
  const full = await rangedRelay({ ...opts, req: new Headers() });
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, 1000);
  const nm = await rangedRelay({ ...opts, req: new Headers({ 'if-none-match': etag }) });
  assert.equal(nm.status, 304);
  // If-Range with another version: the whole file instead of the range
  const ir = await rangedRelay({ ...opts, req: new Headers({ range: 'bytes=0-9', 'if-range': '"other"' }) });
  assert.equal(ir.status, 200);
  await ir.arrayBuffer();
  const bad = await rangedRelay({ ...opts, req: new Headers({ range: 'bytes=5000-' }) });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), 'bytes */1000');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { range: 'bytes=0-1' });
});

test('source with Range support: Range / If-Range forwarded, 206 passed through, nothing buffered', async () => {
  const cache = new RangeCache();
  const calls: Record<string, string>[] = [];
  const r = await rangedRelay({
    key: 'k2',
    req: new Headers({ range: 'bytes=100-199', 'if-range': 'Thu, 29 Oct 2026 01:03:41 GMT' }),
    base: base(),
    cache,
    type: (t) => t ?? 'application/octet-stream',
    fetch: async (fwd) => {
      calls.push(fwd);
      return {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'content-length': '100', 'content-range': 'bytes 100-199/44388708', 'accept-ranges': 'bytes', 'last-modified': 'Thu, 29 Oct 2026 01:03:41 GMT' },
        body: stream(file.subarray(100, 200)),
      };
    },
  });
  assert.deepEqual(calls[0], { range: 'bytes=100-199', 'if-range': 'Thu, 29 Oct 2026 01:03:41 GMT' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/44388708');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('last-modified'), 'Thu, 29 Oct 2026 01:03:41 GMT');
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  assert.equal(cache.size, 0);
});

test('plain GET is streamed as is; a file over the buffer limit is never read into memory', async () => {
  const cache = new RangeCache();
  const opts = { key: 'k3', base: base(), cache, type: (t?: string) => t!, maxBuffer: 500 };
  const plain = await rangedRelay({ ...opts, req: new Headers(), fetch: noRanges([]) });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('accept-ranges'), null, 'too big to slice here, and the source cannot');
  assert.equal((await plain.arrayBuffer()).byteLength, 1000);
  const ranged = await rangedRelay({ ...opts, req: new Headers({ range: 'bytes=0-9' }), fetch: noRanges([]) });
  assert.equal(ranged.status, 200, 'Range ignored: whole file');
  assert.equal((await ranged.arrayBuffer()).byteLength, 1000);
  assert.equal(cache.size, 0);
});

test('errors: 404 and 416 from the source', async () => {
  const cache = new RangeCache();
  const nf = await rangedRelay({ key: 'k4', req: new Headers(), base: base(), cache, type: (t) => t!, fetch: async () => ({ status: 404, headers: {}, body: null }) });
  assert.equal(nf.status, 404);
  assert.equal(nf.headers.get('content-type'), 'application/json');
  const r416 = await rangedRelay({
    key: 'k5',
    req: new Headers({ range: 'bytes=99999999-' }),
    base: base(),
    cache,
    type: (t) => t!,
    fetch: async () => ({ status: 416, headers: { 'content-range': 'bytes */160697' }, body: null }),
  });
  assert.equal(r416.status, 416);
  assert.equal(r416.headers.get('content-range'), 'bytes */160697');
});

test('RangeCache drops the least recently used beyond its budget', () => {
  const c = new RangeCache(25);
  const e = (n: number) => ({ body: Buffer.alloc(n), type: 'x', etag: '"e"' });
  c.set('a', e(10));
  c.set('b', e(10));
  c.get('a');
  c.set('c', e(10));
  assert.ok(c.get('a') && c.get('c'));
  assert.equal(c.get('b'), undefined);
  c.set('huge', e(30));
  assert.equal(c.get('huge'), undefined);
  assert.equal(c.size, 20);
});
