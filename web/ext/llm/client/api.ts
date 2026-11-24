import { request } from '../../../client/src/sdk';
import type { ProviderKind } from '../kinds';

// The llm package's calls (server/routes.ts, at /api/llm). No key ever comes back: `keySet` only.

export interface ProviderView {
  id: string;
  kind: ProviderKind;
  name: string;
  url: string;
  fromServer: boolean;
  keySet: boolean;
  /** Every model it lists is enabled (the server's provider, until models are picked). */
  all: boolean;
}
export interface ModelItem {
  id: string;
  name?: string;
  /** In the provider's list (false: added by hand). */
  listed: boolean;
  enabled: boolean;
}
export interface ProviderTest {
  ok: boolean;
  ms: number;
  models?: number;
  keyChecked: boolean;
  error?: string;
}
export interface Ref {
  provider: string;
  model: string;
}
export interface ModelStats {
  calls: number;
  ok: number;
  errors: number;
  aborted: number;
  medianMs: number | null;
  lastMs: number | null;
  lastOutcome: 'ok' | 'error' | 'aborted' | null;
  lastAt: number | null;
}
export interface RoutesView {
  patienceMs: number;
  defaults: { model: Ref; fallback: Ref | null } | null;
  providers: { id: string; name: string }[];
  uses: { id: string; label: Readonly<Record<string, string>>; model: Ref | null; fallback: Ref | null; isDefault: boolean }[];
  choices: { items: (Ref & { enabled: boolean; stats: ModelStats })[]; reachable: Record<string, boolean> };
}

export const llmApi = {
  providers: () => request<{ providers: ProviderView[] }>('GET', '/llm/providers'),
  addProvider: (b: { kind: ProviderKind; name: string; url: string; key?: string }) => request<ProviderView>('POST', '/llm/providers', b),
  updateProvider: (id: string, b: { name?: string; url?: string; key?: string | null }) => request<ProviderView>('PUT', `/llm/providers/${encodeURIComponent(id)}`, b),
  removeProvider: (id: string) => request<{ ok: true }>('DELETE', `/llm/providers/${encodeURIComponent(id)}`),
  models: (id: string, refresh = false) => request<{ reachable: boolean; all: boolean; items: ModelItem[] }>('GET', `/llm/providers/${encodeURIComponent(id)}/models${refresh ? '?refresh=1' : ''}`),
  setModels: (id: string, models: string[] | null) => request<{ ok: true }>('PUT', `/llm/providers/${encodeURIComponent(id)}/models`, { models }),
  testProvider: (id: string) => request<ProviderTest>('POST', `/llm/providers/${encodeURIComponent(id)}/test`),
  routes: () => request<RoutesView>('GET', '/llm/routes'),
  setRoutes: (b: Record<string, { model: Ref; fallback: Ref | 'none' } | null>) => request<RoutesView>('PUT', '/llm/routes', b),
  test: (r: Ref) => request<{ ok: boolean; ms: number; error?: string; stats: ModelStats }>('POST', '/llm/test', r),
};
