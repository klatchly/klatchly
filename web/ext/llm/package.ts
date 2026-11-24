import type { PackageInfo } from '#core/extension.js';

// LLM: chat completions on OpenAI-compatible providers, as a provider other packages use (writing help today),
// and its Settings pages: Providers (where the models are, with which key) and Default models (which model each
// use calls). What both halves share.

export const llmPackage = {
  id: 'llm',
  // 1.1: providers set in Settings, uses (use, completeFor, labelFor). 1.2: pictures in a turn (ContentPart).
  version: '1.2.0',
  // 1.3: the step-up of sensitive changes (sdk requireStepUp).
  // 1.16: its capability declarations (network / listen / files / spawns, below).
  klatchly: '^2.0',
  // The server's provider, all optional since 1.1 (Settings → Providers adds others): its endpoint (…/v1), its
  // default model and fallback, who answers (the privacy line), its key file. With KLATCHLY_LLM_URL set, the model
  // and the key are checked (server/index.ts).
  optionalConfig: ['KLATCHLY_LLM_URL', 'KLATCHLY_LLM_MODEL', 'KLATCHLY_LLM_KEY_FILE', 'KLATCHLY_LLM_FALLBACK', 'KLATCHLY_LLM_LABEL'],
  // Capabilities (1.16): the server's provider (KLATCHLY_LLM_URL) and any address added in Settings, Providers ('*');
  // the server's key file and its own files in the data volume (settings, the keys added there).
  network: ['KLATCHLY_LLM_URL', '*'],
  files: ['data', 'KLATCHLY_LLM_KEY_FILE'],
  order: 60,
} as const satisfies PackageInfo;
