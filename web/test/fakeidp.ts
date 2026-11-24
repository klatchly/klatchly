import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

// A made-up OIDC provider for the tests (test/oidc.test.ts, in process through openid-client's customFetch) and the
// offline instance (test/e2e/offline/oidc.mjs, over HTTP on the loopback): discovery, JWKS, an authorization endpoint
// and a token endpoint that checks the code, the redirect URI, PKCE (S256) and the client's secret, then signs an ID
// token (RS256, a key of node:crypto). What it signs can be bent per grant (another audience, issuer, nonce, an
// expired token, an old auth_time, a signature by another key) to check that each is refused.

export interface Grant {
  sub: string;
  /** Claims added to or replacing the ID token's (aud, iss, nonce, exp, auth_time, email…); undefined drops one. */
  claims?: Record<string, unknown>;
  /** Signed by a key the JWKS does not have. */
  badSignature?: boolean;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeIdp {
  private readonly key: { publicKey: KeyObject; privateKey: KeyObject };
  private readonly otherKey: KeyObject;
  private readonly codes = new Map<string, { params: URLSearchParams; grant: Grant }>();
  /** The last authorization request's parameters (prompt, max_age, scope…). */
  lastAuthorize?: URLSearchParams;
  /** Token requests received, and the last one's form. */
  tokenRequests = 0;
  lastToken?: URLSearchParams;
  /** When true, every request fails as if the provider were down. */
  down = false;

  constructor(
    readonly issuer: string,
    readonly clientId: string,
    readonly clientSecret?: string,
  ) {
    this.key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  }

  private url(path: string): string {
    return this.issuer.replace(/\/$/, '') + path;
  }

  /** The provider's answer to an authorization request: the redirect URI with a code for `grant` (or an error). */
  approve(authorizationUrl: string, grant: Grant | { error: string }): string {
    const params = new URL(authorizationUrl).searchParams;
    this.lastAuthorize = params;
    const back = new URL(params.get('redirect_uri')!);
    if (params.get('state')) back.searchParams.set('state', params.get('state')!);
    if ('error' in grant) {
      back.searchParams.set('error', grant.error);
      return back.href;
    }
    const code = b64u(randomBytes(24));
    this.codes.set(code, { params, grant });
    back.searchParams.set('code', code);
    return back.href;
  }

  private sign(claims: Record<string, unknown>, bad?: boolean): string {
    const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const body = b64u(JSON.stringify(claims));
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(bad ? this.otherKey : this.key.privateKey);
    return `${head}.${body}.${b64u(sig)}`;
  }

  private token(form: URLSearchParams, auth: string | null): Response {
    this.tokenRequests++;
    this.lastToken = form;
    // The client: HTTP Basic (or the secret in the form), or a public client by its id.
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    if (auth?.startsWith('Basic ')) {
      const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':').map((x) => decodeURIComponent(x));
      id = u ?? null;
      secret = p ?? null;
    }
    if (id !== this.clientId || (this.clientSecret !== undefined && secret !== this.clientSecret)) return json({ error: 'invalid_client' }, 401);
    if (form.get('grant_type') !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400);
    const entry = this.codes.get(form.get('code') ?? '');
    this.codes.delete(form.get('code') ?? '');
    if (!entry) return json({ error: 'invalid_grant' }, 400);
    const { params, grant } = entry;
    if (form.get('redirect_uri') !== params.get('redirect_uri')) return json({ error: 'invalid_grant', error_description: 'redirect_uri' }, 400);
    const challenge = b64u(createHash('sha256').update(form.get('code_verifier') ?? '').digest());
    if (params.get('code_challenge_method') !== 'S256' || challenge !== params.get('code_challenge')) return json({ error: 'invalid_grant', error_description: 'pkce' }, 400);
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { iss: this.issuer, sub: grant.sub, aud: this.clientId, iat: now, exp: now + 300, auth_time: now, ...(params.get('nonce') ? { nonce: params.get('nonce') } : {}), ...grant.claims };
    for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
    return json({ access_token: b64u(randomBytes(24)), token_type: 'Bearer', expires_in: 300, id_token: this.sign(claims, grant.badSignature) });
  }

  /** A Fetch-style handler: openid-client's customFetch, or behind an HTTP server. */
  readonly fetch = async (input: string | URL | Request, init?: { method?: string; headers?: Record<string, string> | Headers; body?: unknown }): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init as RequestInit);
    if (this.down) throw new TypeError('fetch failed');
    const u = new URL(req.url);
    const base = new URL(this.issuer).pathname.replace(/\/$/, '');
    const path = u.pathname.slice(base.length);
    if (path === '/.well-known/openid-configuration')
      return json({
        issuer: this.issuer,
        authorization_endpoint: this.url('/authorize'),
        token_endpoint: this.url('/token'),
        jwks_uri: this.url('/jwks'),
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: this.clientSecret ? ['client_secret_basic', 'client_secret_post'] : ['none'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    if (path === '/jwks') return json({ keys: [{ ...(this.key.publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' }] });
    if (path === '/token' && req.method === 'POST') return this.token(new URLSearchParams(await req.text()), req.headers.get('authorization'));
    // A browser at the provider (offline instance): who to sign in as, then back to the app with a code.
    if (path === '/authorize') {
      this.lastAuthorize = u.searchParams;
      const as = (sub: string, label: string) => `<form method="get" action="${this.url('/approve')}"><input type="hidden" name="req" value="${b64u(u.search)}"><input type="hidden" name="sub" value="${sub}"><button type="submit" data-testid="idp-${sub}">${label}</button></form>`;
      const html = `<!doctype html><title>Fake provider</title><h1>Fake provider</h1><p data-testid="idp-prompt">${u.searchParams.get('prompt') ?? ''}</p>${as('owner', 'Sign in as the owner')}${as('stranger', 'Sign in as someone else')}`;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path === '/approve') {
      const search = Buffer.from(u.searchParams.get('req') ?? '', 'base64url').toString();
      const back = this.approve(this.url('/authorize') + search, { sub: u.searchParams.get('sub') ?? 'owner' });
      return new Response(null, { status: 302, headers: { location: back } });
    }
    return json({ error: 'not_found' }, 404);
  };
}
