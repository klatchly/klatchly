import type { ProviderModule } from '#core/sdk.js';

// The transcribe package's public entry: what a package that requires or enhances it (`enhances: { transcribe: '^1.0' }`)
// may know of it. Types only; the provider itself comes from ModuleContext.provider<TranscribeProvider>('transcribe').
// A change here changes what other packages build on: bump transcribe's version (ext/contracts.test.ts says which).

/** A sound to transcribe: its bytes and type ('audio/ogg', 'audio/wav'…), its length in seconds when known. */
export interface TranscribeAudio {
  data: Uint8Array;
  mime: string;
  duration?: number;
}

export interface TranscribeOptions {
  /** A provider's id (Settings → Transcription); absent: the default one. */
  provider?: string;
  /** A language code instead of the provider's setting ('' : automatic, where the model can tell). */
  language?: string;
  /** Name in the logs (never any content), e.g. 'mypkg.notes'. */
  feature?: string;
  signal?: AbortSignal;
}

export interface Transcript {
  /** The text, trimmed; '' when nothing was said. */
  text: string;
  /** The language the model detected, when it says. */
  language?: string;
  /** The provider's id. */
  provider: string;
  ms: number;
}

/**
 * Why a transcription failed (TranscribeFailure.code): no provider ('unavailable'), a format the provider does not
 * take as is ('unsupported_format': convert it to 16 kHz mono 16-bit WAV first), too many bytes ('too_large') or
 * seconds ('too_long', over maxSeconds), the provider refused the request ('rejected'), or anything else ('failed').
 */
export type TranscribeErrorCode = 'unavailable' | 'unsupported_format' | 'too_large' | 'too_long' | 'rejected' | 'failed';

/** The error `transcribe` rejects with. */
export interface TranscribeFailure extends Error {
  code: TranscribeErrorCode;
}

export interface TranscribeProvider extends ProviderModule {
  /** The longest sound taken, in seconds. */
  readonly maxSeconds: number;
  /**
   * One sound to text, on the default provider (or `opts.provider`). WAV is cut into pieces when the provider needs
   * it. Rejects with a TranscribeFailure. Nothing is kept: the caller decides what to do with the text.
   */
  transcribe(audio: TranscribeAudio, opts?: TranscribeOptions): Promise<Transcript>;
  /** Whether a provider (absent: the default one) takes this type as is (else: 16 kHz mono 16-bit WAV). */
  accepts(mime: string, provider?: string): boolean;
  /** Who transcribes on the default provider (its name), for the users' privacy line; null when there is none. */
  label(): string | null;
}
