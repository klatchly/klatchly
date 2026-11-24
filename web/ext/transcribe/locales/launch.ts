// Transcription's strings on the launch path (client/index.tsx): the title of its Settings page, shown in the menu
// before its chunk loads. By language code, English the fallback; fr has the keys of en.

export interface TranscribeLaunch {
  /** Settings → Transcription (the providers, the default one, the transcripts kept). */
  settingsTitle: string;
}

export const launch: Readonly<Record<string, TranscribeLaunch>> = {
  en: { settingsTitle: 'Transcription' },
  fr: { settingsTitle: 'Transcription' },
};
