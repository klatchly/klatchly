import { definePackage, provider } from '#core/sdk.js';
import type { LlmProvider } from '../api.js';
import { llmPackage } from '../package.js';
import { llmAbout } from '../locales/index.js';
import { availableModels, CAP_MS, complete, completeFor, completePicturesFor, defaultRoute, labelFor, llmLabel, modelStats, PATIENCE_MS, use, validModelId } from './llm.js';
import { llmRoutes } from './routes.js';
import { cleanUrl, env, providers, serverKey } from './store.js';

// The llm package's server half: one provider, 'llm' (the LlmProvider of ../api.ts), with its Settings API at
// /api/llm (routes.ts: Settings → Providers and Default models).

/**
 * The server's configuration, when it names an endpoint (KLATCHLY_LLM_URL): it must be complete (a model, a key), as
 * before 1.1, so that a mistake there shows as the package off with its reason. Without KLATCHLY_LLM_URL the package
 * is on with the providers added in Settings (none at first: the features that use it then fail with 'disabled').
 */
function check(): string | null {
  const e = env();
  if (!e.url) return null;
  if (!cleanUrl(e.url)) return 'KLATCHLY_LLM_URL is not an http(s) URL';
  if (!validModelId(e.model)) return 'missing config KLATCHLY_LLM_MODEL';
  return serverKey() ? null : 'key file missing or empty (KLATCHLY_LLM_KEY_FILE)';
}

const llm: LlmProvider = {
  ...provider({
    id: 'llm',
    check,
    status: () => ({ ready: providers().length > 0 }),
    routes: llmRoutes,
  }),
  defaults: defaultRoute,
  patienceMs: PATIENCE_MS,
  capMs: CAP_MS,
  complete,
  models: availableModels,
  stats: modelStats,
  validModelId,
  label: llmLabel,
  use,
  completeFor,
  completePicturesFor,
  labelFor,
};

export default definePackage({ ...llmPackage, about: llmAbout, modules: [llm] });
