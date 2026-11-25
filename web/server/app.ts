import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { config, siteOf } from './config.js';
import { clientIp, sessions, setSessionCookie, type Env } from './context.js';
import { oidcRoutes, oidcSessionRoutes } from './oidc.js';
import { signinSettingsRoutes } from './signin.js';
import { requireStepUp } from './stepup.js';
import { authRoutes, readSessionCookie } from './webauthn.js';
import { jsonObject, relay } from './relay.js';
import { dropShared } from './inflight.js';
import { RateLimiter } from './ratelimit.js';
import { newChatRoutes } from './newchat.js';
import { serveMedia } from './media.js';
import { exactly, thumbHandler, type ThumbResolver } from './thumbs.js';
import { connectors } from './sources.js';
import { wsHandler } from './ws.js';
import { handleUpload } from './upload.js';
import { pushRoutes } from './push.js';
import { previewRoutes } from './preview.js';
import { notifyRoutes } from './notify.js';
import { chatMediaRoutes } from './chatmedia.js';
import { forwardRoutes } from './forward.js';
import { readAllRoutes } from './readall.js';
import { quietRoutes } from './quiet.js';
import { readingRoutes } from './reading.js';
import { chatEventsRoutes } from './chatevents.js';
import { HTML_VIEW_PATH, htmlViewRoutes } from './htmlview.js';
import { log } from './log.js';
import { inlineStyleHashes, staticCache } from './shell.js';
import { ASSET_LIST_FILE, isPrivateAsset, PRIVATE_ASSET_CACHE, readAssetList } from './appassets.js';
import { Registry } from './registry.js';
import { isSettingsPath } from './settingspages.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  // pdf.js data (/pdfjs/: CMaps, standard fonts, ICC profiles)
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/vnd.iccprofile',
};

function indexStatic(dir: string): Map<string, { file: string; type: string; size: number }> {
  const out = new Map<string, { file: string; type: string; size: number }>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const type = TYPES[extname(e.name)];
        // The build's list of public files (appassets.ts) is read at start, never served.
        if (type && !(d === dir && e.name === ASSET_LIST_FILE)) out.set('/' + relative(dir, p).split(sep).join('/'), { file: p, type, size: statSync(p).size });
      }
    }
  };
  walk(dir);
  return out;
}

/** Route template for logs (no IDs, no query strings); the packages' modules remove their own ids. */
function apiRoute(method: string, path: string, registry: Registry): string {
  const p = registry.logPath(path)
    .replace(/^\/api\/chats\/(?!search$|start$)[^/]+/, '/api/chats/:id')
    .replace(/^\/api\/accounts\/[^/]+/, '/api/accounts/:id')
    .replace(/^\/api\/htmlview\/[a-f0-9]{32}$/, '/api/htmlview/:id')
    .replace(/^(\/api\/chats\/:id\/messages)\/[^/]+/, '$1/:mid')
    .replace(/^(\/api\/chats\/:id\/messages\/:mid\/reactions)\/[^/]+$/, '$1/:key');
  return `${method === 'GET' || method === 'HEAD' ? '' : method + ' '}${p.length > 64 ? p.slice(0, 64) + '…' : p}`;
}

// Media URLs end in a file name with a static extension (…/m.jpg?url=…): CrowdSec's http-crawl-non_statics
// counts extension-less GETs, and opening a chat loads dozens of avatars and pictures at once (2026-10-30 ban).
// The name is ignored; the type still comes from the server.
export const MEDIA_FILE = ':file{[a-z0-9]{1,16}\\.[a-z0-9]{2,5}}';
// The spaces' device APIs (ServerSpace.bearerRoutes): /api/bearer/<space id>/…
const BEARER_PREFIX = '/api/bearer/';
// The core's own media relays; the connectors' (ConnectorShape.mediaRoutes) are the registry's (isMediaRoute).
const MEDIA_PATH = /^\/api\/(media|preview-img|thumb)(\/[a-z0-9]{1,16}\.[a-z0-9]{2,5})?$/;

/** A thumbnail's source: a connector's media named by exactly its parameters. */
export const thumbSource: ThumbResolver = (query) => {
  for (const source of connectors()) {
    const media = source.media;
    if (!media || !exactly(query, media.params)) continue;
    const ref = media.parse(query);
    if (ref) return { ...ref, open: (signal) => media.fetch(ref, {}, signal) };
  }
  return null;
};

// Turning packages off and on (Settings → Extensions): a few clicks, never a stream.
const toggleLimiter = new RateLimiter(10 * 60 * 1000, 30, 60);

/**
 * `registry`: the packages of the build (server/index.ts); none by default, i.e. the core alone (whose chat
 * routes then find no connector: 404).
 */
export function createApp(registry = new Registry([])) {
  const cfg = config();
  const files = indexStatic(cfg.publicDir);
  const indexHtml = readFileSync(join(cfg.publicDir, 'index.html'));
  // The client's public and private halves (appassets.ts): without the build's list, every file is public (as before).
  const assets = readAssetList(cfg.publicDir);
  const publicAssets = new Set(assets?.public);
  if (!assets) log('http', 'no list of public assets: all of the client is served signed out', { file: ASSET_LIST_FILE });

  const app = new Hono<Env>();
  // Signed out, back to / (never 401/403). no-store: a cache in front (a CDN caching .js/.css by extension) must not
  // keep the redirect and hand it to a signed-in device asking for the same private chunk.
  const away = (c: Context) => {
    const r = c.redirect('/', 302);
    r.headers.set('Cache-Control', 'no-store');
    return r;
  };

  app.use('*', async (c, next) => {
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    if (c.req.path === '/healthz') return;
    const route = c.req.path.startsWith('/api/') ? apiRoute(c.req.method, c.req.path, registry) : files.has(c.req.path) ? 'static' : 'page';
    log('http', c.req.method, { route, status: c.res.status, ms, ip: clientIp(c) });
  });

  const headers = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", ...inlineStyleHashes(indexHtml.toString('utf8'))],
      imgSrc: ["'self'", 'blob:', 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      fontSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    },
    crossOriginOpenerPolicy: 'same-origin',
    crossOriginResourcePolicy: 'same-origin',
    referrerPolicy: 'no-referrer',
    xFrameOptions: 'DENY',
    permissionsPolicy: {
      camera: [],
      microphone: ['self'],
      geolocation: [],
      payment: [],
      usb: [],
      serial: [],
      browsingTopics: [],
    },
  });
  app.use('*', async (c, next) => {
    // Media routes set their own sandboxed headers (mediaSecurityHeaders), the HTML viewer its own (htmlview.ts).
    if (MEDIA_PATH.test(c.req.path) || HTML_VIEW_PATH.test(c.req.path) || registry.isMediaRoute(c.req.path)) return next();
    await headers(c, next);
    c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  });

  // Resolve the session (if any) and slide its expiry (never past its absolute end: sessions.ts SESSION_MAX_MS).
  // Not for the spaces' device APIs (/api/bearer/): a cookie is never a way in there, so it is not even read.
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith(BEARER_PREFIX)) return next();
    const v = sessions.validate(readSessionCookie(c));
    if (v) {
      c.set('session', v.hash);
      if (v.renewed) {
        const sid = readSessionCookie(c);
        if (sid) setSessionCookie(c, sid, v.expiresAt);
      }
    }
    await next();
  });

  app.get('/healthz', (c) => c.text('ok'));

  // WebSocket: rejected handshakes get a plain 400 (never 401/403, see deploy/Caddyfile.example).
  app.get('/api/ws', async (c) => {
    const session = c.get('session');
    if (!siteOf(c.req.header('origin')) || !session || c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.body(null, 400);
    }
    return (await wsHandler(c, session)) ?? c.body(null, 400);
  });

  // The spaces' device APIs (ServerSpace.bearerRoutes, API 1.24): for callers that are not a browser (an iOS
  // Shortcut), with a token of the space's own in an Authorization header, never a cookie. Before the origin check
  // (they carry no Origin; a token a page cannot read is not open to CSRF) and the session guard; anything else under
  // the prefix is a 404 here, so no request with a Bearer header ever reaches a cookie route, and the cookie routes
  // below never read that header. Refusals are 400/404/413/429, never 401/403 (deploy/Caddyfile.example).
  for (const [at, routes] of registry.bearerRoutes()) app.route(at, routes);
  app.all(`${BEARER_PREFIX}*`, (c) => c.json({ error: 'not_found' }, 404));

  // CSRF: state-changing API calls must come from our own origin.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const site = c.req.header('sec-fetch-site');
      if (!siteOf(c.req.header('origin')) || (site !== undefined && site !== 'same-origin')) {
        return c.json({ error: 'bad_origin' }, 400);
      }
      // A change (a read, a flag, a setting…): the reads kept a moment for identical requests (inflight.ts) are
      // forgotten, before it and once it is done.
      dropShared();
      try {
        await next();
      } finally {
        dropShared();
      }
      return;
    }
    await next();
  });

  app.route('/api', authRoutes);
  // The OIDC provider (oidc.ts; 404 unless KLATCHLY_OIDC_ISSUER is set): its return is a cross-site GET, without the
  // Strict session cookie, so before the session check (the flow it belongs to says which browser and session).
  app.route('/api', oidcRoutes);

  // Everything below requires a session. Unauthenticated callers are redirected, never 401/403.
  app.use('/api/*', async (c, next) => {
    if (!c.get('session')) return away(c);
    await next();
  });
  app.route('/api', signinSettingsRoutes);
  app.route('/api', oidcSessionRoutes);
  app.get('/api/media', serveMedia);
  app.get(`/api/media/${MEDIA_FILE}`, serveMedia);
  // Bubble-sized WebP copies (server/thumbs.ts): connectors' media, by the same validated parameters.
  app.get('/api/thumb/:file{w[0-9]{3}\\.webp}', thumbHandler(thumbSource));
  app.post('/api/upload', handleUpload);
  app.route('/api', htmlViewRoutes);
  app.route('/api', pushRoutes);
  app.route('/api', previewRoutes);
  app.route('/api', notifyRoutes);
  // Packages: what is on (the client shows only that). Their routes come after the core's, below.
  app.get('/api/extensions', (c) => c.json(registry.describe()));
  // Settings → Extensions: every package with its versions, dependencies and switches; turning one off or on,
  // server-wide (registry.setEnabled), logged with the device's session; after a recent sign-in or step-up (audit L2:
  // a stolen session must not quietly turn discreet reading off, or back on a package turned off on purpose).
  app.get('/api/extensions/details', (c) => c.json(registry.details()));
  // The private chunks of this build, for the service worker to fetch ahead once signed in (client/sw-app.js): the
  // next launch opens offline. Nothing without the build's list (every file is public then, and precached).
  app.get('/api/assets', (c) => c.json({ version: assets?.version ?? null, files: assets?.warm ?? [] }, 200, { 'Cache-Control': 'no-store' }));
  app.put('/api/extensions/:id{[a-z][a-z0-9-]{0,31}}', async (c, next) => (toggleLimiter.allow(clientIp(c)) ? next() : c.json({ error: 'rate_limited' }, 429)), requireStepUp, bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    const b = await jsonObject(c);
    if (!b || typeof b.enabled !== 'boolean' || (b.withRequired !== undefined && typeof b.withRequired !== 'boolean')) return c.json({ error: 'bad_request' }, 400);
    const id = c.req.param('id');
    const r = await registry.setEnabled(id, b.enabled, { withRequired: b.withRequired === true });
    if (!r.ok) {
      log('ext', 'toggle refused', { id, enabled: b.enabled, error: r.error });
      return c.json({ error: r.error, ...(r.needs ? { needs: r.needs } : {}), ...(r.cause ? { cause: r.cause } : {}) }, r.status);
    }
    log('ext', b.enabled ? 'enabled by user' : 'disabled by user', { id, changed: r.changed.join(',') || '-', session: c.get('session')!.slice(0, 12), ip: clientIp(c) });
    return c.json(registry.details());
  });
  app.route('/api', chatMediaRoutes);
  app.route('/api', forwardRoutes);
  app.route('/api', readAllRoutes);
  // Discreet reading (Settings → Discreet reading): per account, server-wide.
  app.route('/api', readingRoutes);
  app.route('/api', chatEventsRoutes);
  app.route('/api', quietRoutes);
  app.route('/api', newChatRoutes);
  app.route('/api', relay);
  // Each package module's API under /api/<its id>/ only: it can neither shadow a core route nor add middleware
  // anywhere else.
  for (const [at, routes] of registry.routes()) app.route(at, routes);
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  const spa = (c: Context) =>
    c.body(indexHtml, 200, { 'Content-Type': TYPES['.html']!, 'Cache-Control': 'no-cache' });

  app.on(['GET', 'HEAD'], '*', (c) => {
    const path = c.req.path;
    const f = files.get(path);
    if (f && path !== '/index.html') {
      // The app's private code (appassets.ts): a session only; anonymous, back to / like any other private page.
      const priv = isPrivateAsset(path, assets, publicAssets);
      if (priv && !c.get('session')) return away(c);
      const body = c.req.method === 'HEAD' ? null : (Readable.toWeb(createReadStream(f.file)) as ReadableStream);
      return new Response(body, {
        headers: { 'Content-Type': f.type, 'Content-Length': String(f.size), 'Cache-Control': priv ? PRIVATE_ASSET_CACHE : staticCache(path) },
      });
    }
    if (path === '/' || path === '/index.html' || path === '/enroll') return spa(c);
    // The spaces' notification targets for the service worker, imported before push-sw.js (no session: the
    // worker installs from the sign-in page too).
    if (path === '/push-links.js') {
      return new Response(c.req.method === 'HEAD' ? null : registry.pushLinksScript(), { headers: { 'Content-Type': TYPES['.js']!, 'Cache-Control': 'no-cache' } });
    }
    // Signed out, only the home of a space that asks for it (ServerSpace.signedOutPage: /share) opens the app's shell
    // (it holds no data, it signs in, then shows the page with its query: a link shared from another app is not lost).
    // A static check of the build's declarations: no module code runs for an anonymous visitor (never `shown`), and
    // the answer tells nothing of what is on. Every other page: back to /.
    if (!c.get('session')) return registry.isSignedOutPage(path) ? spa(c) : away(c);
    if (/^\/chat\/[^/]+(\/(media|files|links))?$/.test(path) || isSettingsPath(path) || registry.isPage(path)) return spa(c);
    return c.text('', 404);
  });
  app.all('*', (c) => (c.get('session') ? c.text('', 404) : away(c)));

  app.onError((err, c) => {
    log('http', 'unhandled error', { name: err.name });
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
