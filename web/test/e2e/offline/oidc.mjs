// The fake OIDC provider for the offline instance (server.mjs), only when R_OIDC=1 (offline/run.mjs: oidc.e2e.js, on
// an instance of its own): test/fakeidp.ts (built by `npm test`) behind an HTTP server on 127.0.0.1, a host of its
// own, so that its return to the app (http://localhost:…) is a cross-site navigation as with a real provider (the
// Strict session cookie is not sent on it). Its /authorize page asks who signs in: the owner or someone else.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';

export async function start({ dir, index }) {
  if (process.env.R_OIDC !== '1') return { env: {} };
  const root = process.env.R_ROOT ?? process.cwd();
  const { FakeIdp } = await import(pathToFileURL(join(root, 'build-test/test/fakeidp.js')).href);
  const port = 4600 + index;
  const issuer = `http://127.0.0.1:${port}`;
  const idp = new FakeIdp(issuer, 'klatchly', 'offline-oidc-secret');
  const server = createServer(getRequestListener((req) => idp.fetch(req)));
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  writeFileSync(join(dir, 'oidc-secret'), 'offline-oidc-secret\n');
  return { env: { KLATCHLY_OIDC_ISSUER: issuer, KLATCHLY_OIDC_CLIENT_ID: 'klatchly', KLATCHLY_OIDC_CLIENT_SECRET_FILE: join(dir, 'oidc-secret'), KLATCHLY_OIDC_LABEL: 'Fake ID' } };
}
