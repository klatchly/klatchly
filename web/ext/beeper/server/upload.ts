import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isMime, log, MAX_UPLOAD_BYTES, sanitizeFileName, type UploadOutcome } from '#core/sdk.js';
import { upstreamToken, upstreamUrl } from './upstream.js';

// Uploads to /v1/assets/upload (moved from the core's upload.ts, which keeps POST /api/upload: its rate limit,
// length checks and concurrency): the file is streamed into a multipart request, never buffered.

const MAX_RESPONSE = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
const asciiName = (s: string) => s.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'file';

function field(boundary: string, name: string, value: string): string {
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${value}\r\n`;
}

type Result = UploadOutcome;

function readJson(res: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    res.on('data', (d: Buffer) => {
      n += d.length;
      if (n > MAX_RESPONSE) {
        res.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(d);
    });
    res.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    res.on('error', () => resolve(undefined));
  });
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Keeps only what the browser needs (never the upstream file:// path). */
function mapUpload(o: unknown): Record<string, unknown> | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.uploadID !== 'string' || !r.uploadID || r.uploadID.length > 512 || r.error) return null;
  return {
    uploadID: r.uploadID,
    fileName: typeof r.fileName === 'string' ? sanitizeFileName(r.fileName) : undefined,
    mimeType: isMime(r.mimeType) ? r.mimeType : undefined,
    fileSize: num(r.fileSize),
    width: num(r.width),
    height: num(r.height),
    duration: num(r.duration),
  };
}

/** The connector's `upload`. */
export function streamUpload(
  { body, size, name, mime }: { body: ReadableStream<Uint8Array>; size: number; name?: string; mime?: string },
  signal: AbortSignal,
): Promise<Result> {
  const boundary = `----klatchly${randomBytes(18).toString('hex')}`;
  let head = '';
  if (name) head += field(boundary, 'fileName', name);
  if (mime) head += field(boundary, 'mimeType', mime);
  head +=
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${asciiName(name ?? 'file')}"` +
    (name ? `; filename*=UTF-8''${rfc5987(name)}` : '') +
    '\r\n' +
    `Content-Type: ${mime ?? 'application/octet-stream'}\r\n\r\n`;
  const headBuf = Buffer.from(head, 'utf8');
  const tailBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const url = new URL(`${upstreamUrl()}/v1/assets/upload`);
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<Result>((resolve) => {
    let settled = false;
    const done = (r: Result) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = doRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstreamToken()}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(headBuf.length + size + tailBuf.length),
      },
      timeout: UPSTREAM_TIMEOUT_MS,
    });
    const reader = body.getReader();
    const abort = (r: Result) => {
      req.destroy();
      reader.cancel().catch(() => {});
      done(r);
    };
    const onAbort = () => abort({ status: 499, body: { error: 'aborted' } });
    signal.addEventListener('abort', onAbort, { once: true });

    req.on('timeout', () => abort({ status: 504, body: { error: 'upstream' } }));
    req.on('error', () => done({ status: 502, body: { error: 'upstream' } }));
    req.on('response', async (res) => {
      const json = await readJson(res);
      signal.removeEventListener('abort', onAbort);
      const status = res.statusCode ?? 502;
      if (status === 200) {
        const mapped = mapUpload(json);
        if (mapped) return done({ status: 200, body: mapped });
        log('upload', 'upstream rejected file');
        return done({ status: 422, body: { error: 'rejected' } });
      }
      log('upload', 'upstream error', { status });
      done({ status: status === 400 || status === 413 || status === 422 ? 422 : 502, body: { error: 'upstream' } });
    });

    (async () => {
      const write = (b: Uint8Array) =>
        req.write(b) ? Promise.resolve() : new Promise<void>((r) => req.once('drain', () => r()));
      try {
        await write(headBuf);
        let n = 0;
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          n += value.byteLength;
          // Hard cap, independent of the announced length.
          if (n > size || n > MAX_UPLOAD_BYTES) return abort({ status: 413, body: { error: 'too_large' } });
          if (settled) return;
          await write(value);
        }
        if (n !== size) return abort({ status: 400, body: { error: 'bad_length' } });
        req.end(tailBuf);
      } catch {
        abort({ status: 499, body: { error: 'aborted' } });
      }
    })();
  });
}
