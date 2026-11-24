import { HttpError, qs, request } from '../../../client/src/sdk';
import type { ProviderKind } from '../kinds';

// The transcribe package's calls (server/routes.ts, at /api/transcribe). No key ever comes back: `keySet` only.

export interface ProviderView {
  id: string;
  kind: ProviderKind;
  name: string;
  url: string;
  model: string;
  language: string;
  fromServer: boolean;
  keySet: boolean;
}
export interface ProvidersReply {
  providers: ProviderView[];
  /** The one chosen (null: the first). */
  default: string | null;
  /** The one used. */
  effective: string | null;
  transcripts: number;
}
export interface TranscriptReply {
  text: string;
  language?: string;
  cached: boolean;
}
export type Target = { chatID: string; messageID: string; index: number };

/** The code of a refusal (the JSON body's `error`), as request() reads it. */
async function refusal(res: Response): Promise<HttpError> {
  try {
    const j = (await res.json()) as { error?: unknown };
    return new HttpError(res.status, typeof j.error === 'string' && /^[a-z_]{1,40}$/.test(j.error) ? j.error : undefined);
  } catch {
    return new HttpError(res.status);
  }
}

/** A call with a binary body or answer (request() is JSON only): same cookie, same origin, no redirect followed. */
async function raw(method: 'GET' | 'POST', path: string, body?: Uint8Array): Promise<Response> {
  const res = await fetch(`/api${path}`, {
    method,
    redirect: 'manual',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'audio/wav' } : undefined,
    body: body as Uint8Array<ArrayBuffer> | undefined,
  });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new HttpError(302);
  if (!res.ok) throw await refusal(res);
  return res;
}

const id = encodeURIComponent;

export const transcribeApi = {
  status: () => request<{ ready: boolean; label?: string }>('GET', '/transcribe/status'),
  transcripts: (chatID: string) => request<{ items: Record<string, { text: string; language?: string }> }>('GET', `/transcribe/transcripts${qs({ chatID })}`),
  forget: (t: Target) => request<{ ok: true }>('POST', '/transcribe/transcripts/forget', t),
  message: (t: Target) => request<TranscriptReply>('POST', '/transcribe/message', t),
  /** The attachment's bytes, for the browser's conversion. */
  audio: async (t: Target) => (await raw('GET', `/transcribe/audio${qs({ ...t, index: String(t.index) })}`)).arrayBuffer(),
  wav: async (t: Target, wav: Uint8Array) => (await (await raw('POST', `/transcribe/wav${qs({ ...t, index: String(t.index) })}`, wav)).json()) as TranscriptReply,

  providers: () => request<ProvidersReply>('GET', '/transcribe/providers'),
  addProvider: (b: { kind: ProviderKind; name: string; url: string; key?: string; model: string; language: string }) => request<ProviderView>('POST', '/transcribe/providers', b),
  updateProvider: (pid: string, b: { name?: string; url?: string; key?: string | null }) => request<ProviderView>('PUT', `/transcribe/providers/${id(pid)}`, b),
  removeProvider: (pid: string) => request<{ ok: true }>('DELETE', `/transcribe/providers/${id(pid)}`),
  setModel: (pid: string, model: string, language: string) => request<ProviderView>('PUT', `/transcribe/providers/${id(pid)}/model`, { model, language }),
  test: (pid: string) => request<{ ok: boolean; ms: number; error?: string }>('POST', `/transcribe/providers/${id(pid)}/test`),
  setDefault: (pid: string | null) => request<{ ok: true }>('PUT', '/transcribe/default', { provider: pid }),
  clear: () => request<{ ok: true }>('DELETE', '/transcribe/transcripts'),
};
