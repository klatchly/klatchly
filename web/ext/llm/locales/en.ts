import type { Widen } from '#core/locales/en.js';

// LLM's English strings: the reference. Their shape is `LlmLocale` (index.ts); every other locale file of the
// package must match it (a language missing there falls back to English). Pure data, like the core catalogs.
// The titles of its Settings pages (shown before its chunk loads) are in launch.ts.

const messages = {
  providers: {
    hint: 'Where the language models are, and with which key. Keys are kept on the server and never shown again. Adding, changing or removing a provider asks you to confirm it is you.',
    kinds: { openai: 'OpenAI-compatible', openrouter: 'OpenRouter', '9router': '9router' } as Record<'openai' | 'openrouter' | '9router', string>,
    kindHints: {
      openai: 'Any server with the OpenAI API (…/v1/models, …/v1/chat/completions). A local one may need no key.',
      openrouter: 'openrouter.ai: one key for many models. The key is checked by Test, at no cost.',
      '9router': 'A self-hosted router in front of several accounts: the address on your network, a key from its dashboard.',
    } as Record<'openai' | 'openrouter' | '9router', string>,
    fromServer: 'server configuration',
    fromServerHint: 'Set in the server’s configuration (KLATCHLY_LLM_URL, key file): only its name and its models can be changed here.',
    keySet: 'Key set',
    noKey: 'No key',
    kind: 'Kind',
    name: 'Name',
    url: 'Address (base URL)',
    key: 'API key',
    keyReplace: 'Replace the key',
    keyClear: 'Clear the key',
    keyNew: 'New key',
    keyKept: 'The key is kept unless you replace it.',
    add: '+ Add a provider',
    edit: 'Edit',
    save: 'Save',
    cancel: 'Cancel',
    remove: 'Remove',
    removeConfirm: (name: string) => `Remove ${name}? Its key is deleted, and the features using its models go back to the default models.`,
    test: 'Test',
    testing: 'Testing…',
    testOk: (n: number, s: string) => `reached · ${n} models · ${s}`,
    testKeyOk: 'key accepted',
    testFail: (why: string) => `failed (${why})`,
    models: 'Models',
    modelsCount: (on: number, all: number) => `${on} of ${all} enabled`,
    modelsAll: (n: number) => `all ${n} enabled`,
    modelsPick: 'Choose',
    modelsClose: 'Close',
    modelsHint: 'Tick the models to offer in Default models.',
    modelsAllToggle: 'All the models it lists (including new ones)',
    modelsFilter: 'Filter',
    modelsRefresh: 'Reload the list',
    modelsUnreachable: 'The model list could not be loaded.',
    modelsNone: 'No model listed.',
    modelsByHand: 'added by hand',
    modelAdd: 'Model id',
    modelAddGo: 'Add',
    modelsShown: (n: number, all: number) => `${n} of ${all} shown`,
    saved: 'Saved.',
    error: {
      bad_request: 'Check the fields: name, an http(s) address, and the key as given.',
      key_required: 'This kind needs a key.',
      key_reentry: 'The address moved to another host: type the key again.',
      store_failed: 'Could not be saved on the server (nothing changed).',
      too_many: 'Too many providers.',
      not_found: 'This provider no longer exists.',
      server_provider: 'The server’s configuration cannot be changed here.',
      step_up: 'Confirm it is you first.',
      failed: 'Failed, try again.',
    } as Record<'bad_request' | 'key_required' | 'key_reentry' | 'store_failed' | 'too_many' | 'not_found' | 'server_provider' | 'step_up' | 'failed', string>,
  },
  routes: {
    hint: (s: number) =>
      `Model used by each feature, among the models enabled on your providers. If it has not answered after ${s} s, or fails, the fallback model is asked as well and the first answer wins. Chat agents use their own model (Hermes).`,
    model: 'Model',
    fallback: 'Fallback',
    none: 'None',
    default: 'default',
    test: 'Test',
    testing: 'Testing…',
    testOk: (s: string) => `answered in ${s}`,
    testFail: 'no answer',
    saved: 'Saved.',
    unreachable: (name: string) => `The models of ${name} could not be loaded.`,
    noUse: 'No feature uses a language model right now (Writing help is off).',
    noModel: 'No model enabled yet: add a provider and tick its models in Providers.',
    disabled: 'not enabled',
    pick: 'Choose a model',
    stat: { none: 'no recent call', slow: 'slow', errors: 'errors', fast: (s: string) => `~${s}` } as {
      none: string;
      slow: string;
      errors: string;
      fast: (s: string) => string;
    },
    failed: 'Failed, try again.',
  },
};

export type LlmMessages = Widen<typeof messages>;

/** The package's name and one-line description (Settings → Extensions; the server's). */
export const about = {
  name: 'Language models',
  description: 'Access to language models (OpenAI-compatible providers), for the packages that write or translate.',
};
export type LlmAbout = Widen<typeof about>;
export default messages satisfies LlmMessages;
