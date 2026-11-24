// The JSON call to /api, its error, qs, and the calls of the session check and the sign-in screens: shared by the
// public boot entry (boot.tsx, Auth.tsx), the packages (sdk.ts) and the app (endpoints.ts, the rest of the API,
// re-exports it). Nothing here names the app's other routes.

export class HttpError extends Error {
  /** Machine-readable code of an upstream refusal, when the server passed one on. */
  constructor(public status: number, public code?: string) {
    super(`http ${status}`);
  }
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.json()) as { code?: unknown; error?: unknown };
    const c = typeof j.code === 'string' ? j.code : typeof j.error === 'string' ? j.error : undefined;
    return c && /^[A-Za-z0-9_.-]{1,64}$/.test(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Called when the server answers with a redirect, i.e. the session is gone. */
let onSignedOut: () => void = () => {};
export function setSignedOutHandler(fn: () => void): void {
  onSignedOut = fn;
}
export const notifySignedOut = (): void => onSignedOut();

/** One JSON call to /api (packages call their own routes with it). */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    redirect: 'manual',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    onSignedOut();
    throw new HttpError(302);
  }
  if (!res.ok) throw new HttpError(res.status, await errorCode(res));
  return (await res.json()) as T;
}

/** A query string ('' when empty): undefined values left out. */
export const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** GET /api/session (server/auth.ts): signed in or not, and what the sign-in page offers. */
export interface SessionReply {
  authenticated: boolean;
  login?: { passkey: boolean; oidc?: { label: string } };
}

/** The calls of the session check and the sign-in screens (Auth.tsx); part of endpoints.ts `api`. */
export const authApi = {
  session: () => request<SessionReply>('GET', '/session'),
  oidcStart: () => request<{ url: string }>('POST', '/auth/oidc/start', {}),
  oidcLink: (code: string) => request<{ url: string }>('POST', '/enroll/oidc', { code }),
  loginOptions: () => request<Record<string, unknown>>('POST', '/auth/options'),
  loginVerify: (response: unknown) => request<{ ok: true }>('POST', '/auth/verify', { response }),
  enrollOptions: (code: string) => request<Record<string, unknown>>('POST', '/enroll/options', { code }),
  enrollVerify: (code: string, response: unknown, label: string) => request<{ ok: true }>('POST', '/enroll/verify', { code, response, label }),
};

// The boot entry's session check, handed to the app once (App.tsx's first session query) so a launch asks once.
let pending: Promise<SessionReply> | undefined;
export function startSessionCheck(): Promise<SessionReply> {
  pending = authApi.session();
  return pending;
}
/** Signed in on the boot's own screen: what the app's first session query answers (no stale "signed out"). */
export function setSessionKnown(s: SessionReply): void {
  pending = Promise.resolve(s);
}
/** The boot's check the first time (if any), a new one after. */
export function sessionOnce(): Promise<SessionReply> {
  const p = pending;
  pending = undefined;
  return p ?? authApi.session();
}
