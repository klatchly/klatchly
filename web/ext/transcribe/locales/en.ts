import type { Widen } from '#core/locales/en.js';

// Transcription's English strings: the reference. Every other locale file of the package must match its shape (a
// language missing there falls back to English). Pure data. The title of its Settings page is in launch.ts.

type Kind = 'nvidia-riva' | 'openai';
type ErrorCode =
  | 'bad_request'
  | 'key_required'
  | 'key_reentry'
  | 'language_required'
  | 'store_failed'
  | 'too_many'
  | 'not_found'
  | 'server_provider'
  | 'step_up'
  | 'failed';

const messages = {
  note: {
    transcribe: 'Transcribe',
    /** A message with several sounds: which one. */
    transcribeN: (n: number) => `Transcribe sound ${n}`,
    sentTo: (name: string) => `The sound is sent to ${name}`,
    working: 'Transcribing…',
    converting: 'Preparing the sound…',
    label: 'Transcript',
    hide: 'Hide the transcript',
    retry: 'Try again',
    empty: 'Nothing was heard.',
    copy: 'Copy the transcript',
    error: {
      unavailable: 'No transcription provider: add one in Settings, Transcription.',
      undecodable: 'This browser cannot read this sound.',
      too_large: 'The sound is too big.',
      too_long: 'The sound is too long (10 minutes at most).',
      no_audio: 'The sound could not be read.',
      rejected: 'The provider refused it (key, model or format).',
      rate_limited: 'Too many transcriptions: wait a few minutes.',
      busy: 'Other sounds are being transcribed: try again in a moment.',
      failed: 'Failed, try again.',
    } as Record<'unavailable' | 'undecodable' | 'too_large' | 'too_long' | 'no_audio' | 'rejected' | 'rate_limited' | 'busy' | 'failed', string>,
  },
  settings: {
    hint: 'Voice notes are transcribed only when you tap Transcribe under one: the sound is then sent to the default provider, and the text is kept on the server so it is never sent twice. Keys are kept on the server and never shown again. Adding, changing or removing a provider asks you to confirm it is you.',
    kinds: { 'nvidia-riva': 'NVIDIA Riva', openai: 'OpenAI-compatible' } as Record<Kind, string>,
    kindHints: {
      'nvidia-riva': 'NVIDIA’s hosted speech models (build.nvidia.com, key from there), or your own Riva server (its gRPC address, e.g. http://riva:50051).',
      openai: 'Any server with the OpenAI transcription API (…/v1/audio/transcriptions): OpenAI, Groq, a self-hosted Whisper server.',
    } as Record<Kind, string>,
    fromServer: 'server configuration',
    fromServerHint: 'Set in the server’s configuration (KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE): only its name, model and language can be changed here.',
    keySet: 'Key set',
    noKey: 'No key',
    kind: 'Kind',
    name: 'Name',
    url: { 'nvidia-riva': 'Address (gRPC)', openai: 'Address (base URL)' } as Record<Kind, string>,
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
    removeConfirm: (name: string) => `Remove ${name}? Its key is deleted.`,
    test: 'Test',
    testing: 'Testing…',
    testHint: 'Test sends one second of silence.',
    testOk: (s: string) => `answered in ${s}`,
    testFail: (why: string) => `failed: ${why}`,
    model: 'Model',
    modelOther: 'Other (NVCF function id)',
    functionId: 'Function id',
    modelHint: 'The model’s name on that server (e.g. whisper-1 on OpenAI, whisper-large-v3 on Groq).',
    presets: {
      'whisper-large-v3': 'Whisper large v3: the best text, any language',
      'parakeet-1.1b-rnnt-multilingual': 'Parakeet 1.1b RNNT: many languages, fast',
      'canary-1b': 'Canary 1b: a few languages, choose one',
      'parakeet-ctc-0.6b-vi': 'Parakeet CTC 0.6b: Vietnamese',
    } as Record<string, string>,
    language: 'Language',
    languageAuto: 'Automatic',
    languageHint: 'Empty: the model tells the language itself (where it can). Otherwise a code: fr-FR, en-US, vi-VN… (fr, en for OpenAI-compatible servers).',
    defaultTitle: 'Default provider',
    defaultHint: 'The one the Transcribe button uses.',
    defaultFirst: (name: string) => `The first one (${name})`,
    none: 'No provider yet: add one below.',
    transcriptsTitle: 'Transcripts',
    transcripts: (n: number) => (n === 0 ? 'None kept.' : n === 1 ? 'One transcript kept on the server.' : `${n} transcripts kept on the server.`),
    clear: 'Clear',
    clearConfirm: 'Forget every transcript? They can be asked again (the sound is then sent again).',
    cleared: 'Cleared.',
    saved: 'Saved.',
    error: {
      bad_request: 'Check the fields: name, the address, the model and the language as given.',
      key_required: 'NVIDIA’s hosted endpoint needs a key.',
      key_reentry: 'The address moved to another host: type the key again.',
      language_required: 'This model needs a language.',
      store_failed: 'Could not be saved on the server (nothing changed).',
      too_many: 'Too many providers.',
      not_found: 'This provider no longer exists.',
      server_provider: 'The server’s configuration cannot be changed here.',
      step_up: 'Confirm it is you first.',
      failed: 'Failed, try again.',
    } as Record<ErrorCode, string>,
  },
};

export type TranscribeMessages = Widen<typeof messages>;

/** The package's name and one-line description (Settings → Extensions; the server's). */
export const about = {
  name: 'Transcription',
  description: 'Voice notes to text on demand, with NVIDIA Riva or an OpenAI-compatible speech-to-text provider.',
};
export type TranscribeAbout = Widen<typeof about>;
export default messages satisfies TranscribeMessages;
