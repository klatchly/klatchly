import { augmentation, definePackage, provider } from '#core/sdk.js';
import type { TranscribeProvider } from '../api.js';
import { MAX_SECONDS, needsLanguage, validLanguage, validModel } from '../kinds.js';
import { transcribeAbout } from '../locales/index.js';
import { transcribeModule, transcribePackage } from '../package.js';
import { acceptsMime, transcribe } from './engine.js';
import { setReader, transcribeRoutes } from './routes.js';
import { defaultProvider, env, provider as providerById, providers, serverKey } from './store.js';

// The transcribe package's server half: the provider 'transcribe' (the TranscribeProvider of ../api.ts, for other
// packages), and the augmentation 'transcribe' (on-demand: the core's reader, to read the voice note the user taps)
// with the API at /api/transcribe (routes.ts: Settings → Transcription, and the transcripts under the voice notes).

/**
 * The server's configuration, when it names a key file (KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE): it must hold a key and the
 * model and language must be valid, so that a mistake there shows as the package off with its reason. Without the
 * variable the package is on with the providers added in Settings (none at first: no Transcribe button).
 */
function check(): string | null {
  const e = env();
  if (!e.keyFile) return null;
  if (!validModel('nvidia-riva', e.model)) return 'KLATCHLY_TRANSCRIBE_NVIDIA_MODEL is neither a known model nor an NVCF function id';
  if (!validLanguage(e.language)) return 'KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE is not a language code';
  if (needsLanguage('nvidia-riva', e.model) && !e.language) return `KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE is required by ${e.model}`;
  return serverKey() ? null : 'key file missing or empty (KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE)';
}

const transcribeProvider: TranscribeProvider = {
  ...provider({
    id: 'transcribe',
    check,
    status: () => ({ ready: providers().length > 0 }),
  }),
  maxSeconds: MAX_SECONDS,
  transcribe,
  accepts: (mime, id) => {
    const p = id ? providerById(id) : defaultProvider();
    return !!p && acceptsMime(p, mime);
  },
  label: () => defaultProvider()?.name ?? null,
};

export default definePackage({
  ...transcribePackage,
  about: transcribeAbout,
  modules: [
    transcribeProvider,
    augmentation({
      ...transcribeModule,
      routes: transcribeRoutes,
      start: (ctx) => {
        if (!ctx.chats) throw new Error('no chat reader');
        setReader(ctx.chats);
      },
      stop: () => setReader(undefined),
    }),
  ],
});
