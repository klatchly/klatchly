import { augmentation, definePackage, lazyChunk } from '../../../client/src/sdk';
import { launch, type TranscribeLaunch } from '../locales/launch';
import { transcribeModule, transcribePackage } from '../package';

// Transcription's client half, on the launch path: its slots in the messages (the Transcribe button and the
// transcript under a voice note, the message menu's entry on a sound) and its Settings page, all lazy from the
// Transcribe chunk, and the page's title.

const load = () => import('./Transcribe');
const by = (f: (m: TranscribeLaunch) => string) => Object.fromEntries(Object.entries(launch).map(([lang, m]) => [lang, f(m)]));

export default definePackage({
  ...transcribePackage,
  modules: [
    augmentation({
      id: transcribeModule.id,
      Conversation: lazyChunk(load, 'TranscribeConversation'),
      message: {
        Below: lazyChunk(load, 'TranscribeBelow'),
        Menu: lazyChunk(load, 'TranscribeMenu'),
      },
      // Its entry also in the menu of a voice note without text (MessageMenuSlotProps.audio).
      audioMenu: true,
    }),
  ],
  settings: [{ id: 'transcription', title: by((m) => m.settingsTitle), Body: lazyChunk(load, 'TranscriptionSettings'), icon: TranscribeIcon }],
});

/** Its Settings entry: a microphone over lines of text. */
function TranscribeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M9 3a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 9 3zM4 9.5a5 5 0 0 0 10 0M9 14.5V17M14 19h6M4 21h16M16 7h4M16 11h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
