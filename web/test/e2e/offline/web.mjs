// The public web as the link previews see it (server/preview.ts), for the offline instance (server.mjs): a few made-up
// pages on example.com, example.org and github.com, over HTTP and HTTPS on their usual ports, on an address of this
// instance's own (127.0.1.<index+1>). The previews keep their whole SSRF guard (ports, redirects, sizes, signed
// images); only its name resolution is swapped for this one (other names do not resolve, as without a network) and
// this one address allowed among the private ones. The certificate is made for the run, and trusted by this
// process only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps, globalAgent } from 'node:https';
import { join } from 'node:path';
import { picture } from './media.mjs';

const HOSTS = ['example.com', 'www.example.com', 'example.org', 'github.com'];

const page = (title, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${extra}</head><body><h1>${title}</h1></body></html>`;
let image;
const PAGES = {
  'example.com/': () => page('Example Domain', '<meta name="description" content="This domain is for use in documentation examples.">'),
  'www.example.com/': () => page('Example Domain'),
  'example.org/x': () => page('Example page', '<meta property="og:description" content="A page with a query string.">'),
  'github.com/beeper/desktop-api-js': () =>
    page('GitHub - beeper/desktop-api-js', '<meta property="og:title" content="beeper/desktop-api-js"><meta property="og:description" content="The Desktop API client."><meta property="og:image" content="https://github.com/og/desktop-api-js.png"><meta property="og:site_name" content="GitHub">'),
};

let ip = '127.0.1.1';

function handler(req, res) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const path = (req.url ?? '/').split('?')[0];
  if (path.startsWith('/og/')) return res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(image.length) }).end(image);
  const make = PAGES[`${host}${path}`];
  if (!make) return res.writeHead(404, { 'content-type': 'text/html' }).end(page('Not found'));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(make());
}

export async function start({ dir, index }) {
  ip = `127.0.1.${index + 1}`;
  image = await picture(1200, 630, '#24292f', 'png');
  const key = join(dir, 'web.key');
  const cert = join(dir, 'web.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=offline web', '-addext', `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(',')}`], { stdio: 'ignore' });
  const tls = { key: readFileSync(key), cert: readFileSync(cert) };
  globalAgent.options.ca = [tls.cert];
  await Promise.all([
    new Promise((r) => createHttp(handler).listen(80, ip, r)),
    new Promise((r) => createHttps(tls, handler).listen(443, ip, r)),
  ]);
  return { env: {} };
}

/** The preview guard on this fake web: its names resolve here, its address is allowed (the rest unchanged). */
export async function patchApp(built) {
  const { defaultGuard } = await built('server/preview.js');
  const { allowIP } = defaultGuard;
  defaultGuard.resolve = async (host) => {
    if (HOSTS.includes(host)) return [ip];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  };
  defaultGuard.allowIP = (a) => a === ip || allowIP(a);
}
