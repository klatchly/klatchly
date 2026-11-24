import { useSyncExternalStore } from 'react';
import { HttpError } from '../../../client/src/sdk';
import { transcribeApi as api, type Target } from './api';
import { toWav } from './convert';
import { noteError, type NoteError } from './errors';

// Transcripts shown under voice notes. Asked only by a tap (Transcribe under the note, or the message menu): the
// server reads the note through the core and sends it to the default provider; when that provider cannot take its
// format, the page fetches the sound, converts it (convert.ts) and sends the WAV. The server keeps the text
// (data/transcripts.json): a conversation loads its own on opening, so they come back after a reload and on other
// devices, and a note is never sent twice.

export type { NoteError };
export interface NoteState {
  status: 'working' | 'converting' | 'done' | 'error';
  text?: string;
  language?: string;
  error?: NoteError;
}

let shown = new Map<string, NoteState>();
const listeners = new Set<() => void>();
const k = (chatID: string, messageID: string, index: number) => `${chatID}\n${messageID}\n${index}`;

function put(key: string, s: NoteState | undefined) {
  shown = new Map(shown);
  if (s) shown.set(key, s);
  else shown.delete(key);
  listeners.forEach((l) => l());
}

/** 'undecodable' is the page's own (its conversion), never a server's. */
const errorOf = (e: unknown): NoteError => {
  const code = e instanceof HttpError ? noteError(e.code) : 'failed';
  return code === 'undecodable' ? 'failed' : code;
};

/** Transcribes one sound of a message (its attachment `index`); a second tap while it runs does nothing. */
export function transcribeNote(t: Target): void {
  const key = k(t.chatID, t.messageID, t.index);
  const cur = shown.get(key);
  if (cur && cur.status !== 'error') return;
  put(key, { status: 'working' });
  void (async () => {
    try {
      let r;
      try {
        r = await api.message(t);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 415 && e.code === 'convert')) throw e;
        put(key, { status: 'converting' });
        const bytes = await api.audio(t);
        let wav: Uint8Array | 'too_long';
        try {
          wav = await toWav(bytes);
        } catch {
          return put(key, { status: 'error', error: 'undecodable' });
        }
        if (wav === 'too_long') return put(key, { status: 'error', error: 'too_long' });
        put(key, { status: 'working' });
        r = await api.wav(t, wav);
      }
      put(key, { status: 'done', text: r.text, ...(r.language ? { language: r.language } : {}) });
    } catch (e) {
      put(key, { status: 'error', error: errorOf(e) });
    }
  })();
}

/** ✕: hidden here and forgotten by the server (a later tap sends the sound again). */
export function hideNote(t: Target): void {
  put(k(t.chatID, t.messageID, t.index), undefined);
  api.forget(t).catch(() => {});
}

/** The transcripts the server kept for this chat (those not already on screen). */
export function loadTranscripts(chatID: string): void {
  api.transcripts(chatID).then(
    ({ items }) => {
      const missing = Object.entries(items).filter(([at]) => {
        const [messageID, index] = at.split('/');
        return messageID && index && !shown.has(k(chatID, messageID, Number(index)));
      });
      if (!missing.length) return;
      shown = new Map(shown);
      for (const [at, v] of missing) {
        const [messageID, index] = at.split('/');
        shown.set(k(chatID, messageID!, Number(index)), { status: 'done', text: v.text, ...(v.language ? { language: v.language } : {}) });
      }
      listeners.forEach((l) => l());
    },
    () => {},
  );
}

/** Settings → Transcription cleared them: none on screen either. */
export function forgetShown(): void {
  shown = new Map([...shown].filter(([, s]) => s.status !== 'done'));
  listeners.forEach((l) => l());
}

export function useNote(chatID: string, messageID: string, index: number): NoteState | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shown.get(k(chatID, messageID, index)),
  );
}
