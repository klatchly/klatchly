// The kinds of LLM provider (Settings → Providers): what both halves know of each. Every kind speaks the
// OpenAI-compatible API (GET <url>/models, POST <url>/chat/completions, `Authorization: Bearer <key>`); they differ
// in their usual address, whether a key is required, and how a key can be checked without spending tokens.
// - openai: any OpenAI-compatible server (a local one may take no key); its model list as it comes.
// - openrouter: openrouter.ai (key required). Its model list is public; GET <url>/key checks the key (free).
// - 9router: a self-hosted router in front of several accounts (key from its dashboard, required). Its model ids
//   are "<account alias>/<model>" and combos; it also lists search and fetch tools (left out: not chat models).
// Pure data: no imports.

export const KINDS = ['openai', 'openrouter', '9router'] as const;
export type ProviderKind = (typeof KINDS)[number];

export interface KindInfo {
  /** The address filled in when adding one (the user may change it); '' when there is no usual one. */
  url: string;
  keyRequired: boolean;
  /** A path under the URL that answers 200 for a valid key and costs nothing (the provider's Test). */
  keyCheck?: string;
}

export const KIND_INFO: Readonly<Record<ProviderKind, KindInfo>> = {
  openai: { url: '', keyRequired: false },
  openrouter: { url: 'https://openrouter.ai/api/v1', keyRequired: true, keyCheck: '/key' },
  '9router': { url: 'http://9router:20128/v1', keyRequired: true },
};

export const isKind = (v: unknown): v is ProviderKind => (KINDS as readonly unknown[]).includes(v);

/** The id of the provider of the server's configuration (KLATCHLY_LLM_URL…): always first, never removed. */
export const SERVER_PROVIDER = 'env';
