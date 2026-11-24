// The refusals a transcription shows (under a voice note, and as a provider Test's result in Settings), each with its
// own sentence in the locales' note.error. Pure: no imports (unit-tested in test/errors.test.ts).

export const NOTE_ERRORS = ['unavailable', 'undecodable', 'too_large', 'too_long', 'no_audio', 'rejected', 'rate_limited', 'busy', 'failed'] as const;
export type NoteError = (typeof NOTE_ERRORS)[number];

/** A code from the server (a refusal's `error`, a Test's) as one the page has a sentence for; 'failed' otherwise. */
export const noteError = (code: unknown): NoteError => ((NOTE_ERRORS as readonly unknown[]).includes(code) ? (code as NoteError) : 'failed');
