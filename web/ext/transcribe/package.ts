import type { AugmentationScope, PackageInfo } from '#core/extension.js';

// Transcription: voice notes and other audio attachments turned into text, on demand only (a tap on the note), by
// pluggable speech-to-text providers: NVIDIA Riva (hosted NIM over gRPC, or a self-hosted Riva) and any server with
// the OpenAI transcription API (OpenAI, Groq, a self-hosted Whisper server). One provider, 'transcribe' (api.ts), that
// other packages may use, and one 'on-demand' augmentation (the button under a voice note, the message menu's entry,
// the transcript shown under the bubble) with the Settings page Transcription. What both halves share.

export const transcribePackage = {
  id: 'transcribe',
  version: '1.0.0',
  // 1.23: ChatReader.readAudio and the message menu of an audio attachment (MessageMenuSlotProps.audio).
  klatchly: '^2.0',
  // The server's provider, all optional (Settings → Transcription adds others): NVIDIA's hosted Riva with the key in a
  // file (unset: no server provider), its model (a preset id or an NVCF function id) and language ('' : automatic).
  optionalConfig: ['KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE', 'KLATCHLY_TRANSCRIBE_NVIDIA_MODEL', 'KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE'],
  // Capabilities (1.16): NVIDIA's hosted endpoint for the server's provider, and any address added in Settings
  // ('*'); the server's key file and its own files in the data volume (settings, keys, transcripts).
  network: ['grpc.nvcf.nvidia.com', '*'],
  files: ['data', 'KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE'],
  // After writing help's chip and entries.
  order: 75,
} as const satisfies PackageInfo;

/** The augmentation: 'on-demand', it reads one message's sound when the user taps Transcribe, never the event stream. */
export const transcribeModule = { id: 'transcribe', scope: 'on-demand' } as const satisfies { id: string; scope: AugmentationScope };
