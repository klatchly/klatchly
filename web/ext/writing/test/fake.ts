import type { ChatReader, ReadImage, ReadMessage } from '#core/sdk.js';
import type { ChatMessages, LlmProvider, LlmUse, PictureMessages, Route } from '#ext/llm/api.js';

/**
 * A stand-in for the llm provider (writing's tests never reach a model): records each call (`use`: the use it was
 * made for, completeFor) and the uses listed (and removed).
 */
export function fakeLlm(answer: (messages: PictureMessages, route: Route) => string | Promise<string>, models = ['model-a', 'model-b'], labels: Record<string, Record<string, string>> = {}) {
  const calls: { messages: PictureMessages; route: Route; feature?: string; use?: string }[] = [];
  const uses = new Map<string, LlmUse>();
  const route: Route = { model: 'model-a', fallback: 'model-b' };
  const p: LlmProvider = {
    type: 'provider',
    id: 'llm',
    status: () => ({ ready: true }),
    defaults: () => ({ model: 'model-a', fallback: 'model-b' }),
    patienceMs: 10_000,
    capMs: 45_000,
    complete: async (messages, route, opts) => {
      calls.push({ messages, route, feature: opts?.feature });
      return answer(messages, route);
    },
    models: async () => models,
    stats: () => ({ calls: 0, ok: 0, errors: 0, aborted: 0, medianMs: null, lastMs: null, lastOutcome: null, lastAt: null }),
    validModelId: (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(v),
    label: () => null,
    use: (u) => {
      uses.set(u.id, u);
      return () => void uses.delete(u.id);
    },
    completeFor: async (use, messages, opts) => {
      calls.push({ messages, route, feature: opts?.feature, use });
      return answer(messages, route);
    },
    completePicturesFor: async (use, messages, opts) => {
      calls.push({ messages, route, feature: opts?.feature, use });
      return answer(messages, route);
    },
    labelFor: (use) => labels[use] ?? null,
  };
  return { provider: p, calls, uses };
}

/** A stand-in for the core's chat reader: fixed messages, and the calls it got. */
export function fakeChats(messages: Record<string, ReadMessage> = {}, recent: ReadMessage[] = [], images: Record<string, ReadImage | 'too_large'> = {}) {
  const calls: string[] = [];
  const reader: ChatReader = {
    readMessage: async (chatID, id) => (calls.push(`message ${chatID} ${id}`), messages[id] ?? null),
    readImage: async (chatID, id, index) => (calls.push(`image ${chatID} ${id} ${index}`), images[`${id}/${index}`] ?? null),
    readAudio: async (chatID, id, index) => (calls.push(`audio ${chatID} ${id} ${index}`), null),
    recentMessages: async (chatID) => (calls.push(`recent ${chatID}`), recent),
    readRange: async (chatID) => (calls.push(`range ${chatID}`), { messages: [...recent].reverse(), truncated: false, reached: true }),
  };
  return { reader, calls };
}
