// The kinds of speech-to-text provider (Settings → Transcription), what both halves know of each. Pure data: no
// imports.
// - nvidia-riva: NVIDIA Riva's offline Recognize RPC over gRPC (HTTP/2): NVIDIA's hosted NIM functions
//   (grpc.nvcf.nvidia.com:443, TLS, an NVCF function id per model, `authorization: Bearer <key>`), or a self-hosted
//   Riva server. Takes WAV (16-bit PCM), FLAC and Ogg Opus as they are.
// - openai: any server with the OpenAI transcription API (POST <base>/audio/transcriptions, multipart: file, model,
//   language): OpenAI, Groq, a self-hosted Whisper server. Takes the usual containers (ogg, mp3, m4a/mp4, wav, webm,
//   flac).
// Anything else (AAC in CAF, AMR…) is converted by the browser to 16 kHz mono 16-bit WAV first.

export const KINDS = ['nvidia-riva', 'openai'] as const;
export type ProviderKind = (typeof KINDS)[number];
export const isKind = (v: unknown): v is ProviderKind => (KINDS as readonly unknown[]).includes(v);

/** The id of the provider of the server's configuration (KLATCHLY_TRANSCRIBE_NVIDIA_*): always first, never removed. */
export const SERVER_PROVIDER = 'env';

/** NVIDIA's hosted gRPC endpoint (NVCF), the address filled in for a new Riva provider. */
export const RIVA_HOSTED = 'https://grpc.nvcf.nvidia.com:443';

/**
 * Riva models hosted by NVIDIA (build.nvidia.com), by NVCF function id. `auto`: the model detects the language by
 * itself (Riva language code "multi"); otherwise a language must be chosen (`lang` its usual one).
 */
export interface RivaPreset {
  id: string;
  functionId: string;
  auto: boolean;
  lang?: string;
}
export const RIVA_PRESETS: readonly RivaPreset[] = [
  // Best text, automatic language. The default.
  { id: 'whisper-large-v3', functionId: 'b702f636-f60c-4a3d-a6f4-f3568c13bd7d', auto: true },
  { id: 'parakeet-1.1b-rnnt-multilingual', functionId: '71203149-d3b7-4460-8231-1be2543a1fca', auto: true },
  { id: 'canary-1b', functionId: 'b0e8b4a5-217c-40b7-9b96-17d84e666317', auto: false, lang: 'en-US' },
  { id: 'parakeet-ctc-0.6b-vi', functionId: 'f3dff2bb-99f9-403d-a5f1-f574a757deb0', auto: false, lang: 'vi-VN' },
];
export const RIVA_DEFAULT_MODEL = 'whisper-large-v3';
export const OPENAI_DEFAULT_MODEL = 'whisper-1';

export const rivaPreset = (model: string): RivaPreset | undefined => RIVA_PRESETS.find((p) => p.id === model);

/** An NVCF function id (a UUID, lower case). */
export const validFunctionId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

/** A model as a provider stores it: a Riva preset id or function id, or an OpenAI-compatible model id. */
export const validModel = (kind: ProviderKind, v: unknown): v is string =>
  kind === 'nvidia-riva' ? !!rivaPreset(v as string) || validFunctionId(v) : typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(v);

/**
 * A language as a provider stores it: '' (automatic), or a code: Riva wants a BCP-47 tag ('fr-FR', 'en-US'), the
 * OpenAI API an ISO-639-1 code ('fr'); both shapes pass here, the provider decides.
 */
export const validLanguage = (v: unknown): v is string => typeof v === 'string' && (v === '' || /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v));

/** Whether a model needs a language (a Riva preset without automatic detection). */
export const needsLanguage = (kind: ProviderKind, model: string): boolean => kind === 'nvidia-riva' && rivaPreset(model)?.auto === false;

/** The longest sound transcribed, in seconds (a longer one is refused before anything is sent). */
export const MAX_SECONDS = 600;

/** The kinds' default model. */
export const defaultModel = (kind: ProviderKind): string => (kind === 'nvidia-riva' ? RIVA_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL);
