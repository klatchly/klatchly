import { toSpeechWav } from '../audio';
import { MAX_SECONDS } from '../kinds';

// The browser's part of a transcription the provider cannot take as is (AAC in m4a or CAF, AMR…): the Web Audio
// API decodes the sound at 16 kHz (an OfflineAudioContext's decodeAudioData resamples to the context's rate), then
// ../audio.ts mixes it down to one channel and writes a 16-bit WAV, which the server forwards. Nothing leaves the
// page but that WAV, to this app's server.

type Ctx = typeof OfflineAudioContext;

/** The sound as 16 kHz mono 16-bit WAV; 'too_long' past MAX_SECONDS; rejects when the browser cannot decode it. */
export async function toWav(bytes: ArrayBuffer): Promise<Uint8Array | 'too_long'> {
  const C: Ctx | undefined = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: Ctx }).webkitOfflineAudioContext;
  if (!C) throw new Error('no web audio');
  const ctx = new C(1, 1, 16_000);
  const decoded = await ctx.decodeAudioData(bytes);
  if (decoded.duration > MAX_SECONDS + 1) return 'too_long';
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  return toSpeechWav(channels, decoded.sampleRate);
}
