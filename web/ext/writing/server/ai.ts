import { readFileSync } from 'node:fs';
import { dataPath } from '#core/sdk.js';
import type { ChatMessages, LlmProvider, PictureMessages, Route } from '#ext/llm/api.js';
import { writingUses } from '../locales/index.js';

// Writing's two uses of the llm provider, whose models are chosen in Settings → Default models (the llm package's
// page, since llm 1.1):
//   writing.translate: translation of received messages
//   writing.assist:    composer writing help (spelling, grammar, phrasing, translation of the draft)
//   writing.image:     translation of the text in a received picture (a model that reads images)
// Before llm 1.1 writing kept that choice itself, in data/ai.json (bare model ids of the server's endpoint): it is
// handed to llm once, as each use's legacy route, and the file is no longer written.

export const FEATURES = ['translate', 'assist', 'image'] as const;
export type Feature = (typeof FEATURES)[number];
const useId = (f: Feature) => `writing.${f}`;

let llm: LlmProvider | undefined;
let unregister: (() => void)[] = [];

/** The choice of ai.json (from before llm 1.1) for a feature, if it holds a valid one. */
export function legacyRoute(f: Feature, valid: (v: unknown) => v is string): Route | null {
  try {
    const v = (JSON.parse(readFileSync(dataPath('ai.json'), 'utf8')) as Record<string, { model?: unknown; fallback?: unknown } | undefined>)?.[f];
    if (v && valid(v.model) && (v.fallback === null || valid(v.fallback))) return { model: v.model, fallback: v.fallback };
  } catch {
    // none
  }
  return null;
}

/**
 * The llm provider (at start: its uses listed on Default models; undefined at stop: they leave the page). Tests set
 * a fake one.
 */
export function setLlm(p: LlmProvider | undefined): void {
  for (const off of unregister) off();
  unregister = [];
  llm = p;
  if (p) unregister = FEATURES.map((f) => p.use({ id: useId(f), label: writingUses[f], legacy: legacyRoute(f, p.validModelId) }));
}

/** Whether completions can run (the provider is there: between start and stop). */
export const llmReady = (): boolean => !!llm;

/** Who answers a feature, by language (the privacy lines of the client: ModuleInfo `llmLabel`, `llmLabelTranslate`). */
export const llmLabel = (f: Feature = 'assist') => llm?.labelFor(useId(f)) ?? null;

/** One completion for a feature, on its models from Settings (primary, then fallback when slow or failing). */
export function complete(messages: ChatMessages, feature: Feature): Promise<string> {
  if (!llm) return Promise.reject(new Error('disabled'));
  return llm.completeFor(useId(feature), messages, { feature });
}

/** One completion with pictures in it, on the image use's models (a model that reads images). */
export function completePictures(messages: PictureMessages): Promise<string> {
  if (!llm) return Promise.reject(new Error('disabled'));
  // A picture takes a model longer than a text: the fallback (the same big request again) only after 25 s.
  return llm.completePicturesFor(useId('image'), messages, { feature: 'image', patienceMs: 25_000, capMs: 90_000 });
}
