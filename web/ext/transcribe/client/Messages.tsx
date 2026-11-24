import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationSlotProps, Message, MessageMenuSlotProps, MessageSlotProps } from '../../../client/src/sdk';
import { transcribeApi as api } from './api';
import { useT } from './i18n';
import { hideNote, loadTranscripts, transcribeNote, useNote } from './state';

// Transcription in the messages: a Transcribe button under each voice note (and other audio attachment) while a
// provider is set, the transcript under the bubble once asked, and the message menu's entry on a sound. Nothing is
// transcribed without a tap.

/** The indexes of a message's sounds. */
export const audioIndexes = (m: Message): number[] => (m.isDeleted ? [] : (m.attachments ?? []).flatMap((a, i) => (a.type === 'audio' && !a.isSticker ? [i] : [])));

/** Whether a provider is set, and its name (the button's privacy line). Refreshed by Settings → Transcription. */
export const useStatus = () => useQuery({ queryKey: ['transcribe', 'status'], queryFn: api.status, staleTime: 5 * 60_000 }).data;

/** Mounted while a chat is open: its kept transcripts (server side, so on every device). */
export function TranscribeConversation({ chatID }: ConversationSlotProps) {
  useEffect(() => loadTranscripts(chatID), [chatID]);
  return null;
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Note({ chatID, messageID, index, n }: { chatID: string; messageID: string; index: number; n?: number }) {
  const t = useT().note;
  const status = useStatus();
  const qc = useQueryClient();
  const s = useNote(chatID, messageID, index);
  const target = { chatID, messageID, index };
  const tid = `transcribe-${index}`;
  const privacyId = useId();
  const noteRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // What this note's own buttons asked (never a transcript loaded on opening): focus follows it, and the live region
  // speaks its progress.
  const [asked, setAsked] = useState<'transcribe' | 'hide' | null>(null);
  // Once, when the button gives way to the note (or back): never again as the note's status changes meanwhile.
  const shown = !!s;
  useEffect(() => {
    if (asked === 'transcribe' && shown) noteRef.current?.focus();
    if (asked === 'hide' && !shown) {
      btnRef.current?.focus();
      setAsked(null);
    }
  }, [asked, shown]);
  // No provider any more (removed elsewhere, or the server's): the status refreshes, the button goes.
  useEffect(() => {
    if (s?.status === 'error' && s.error === 'unavailable') void qc.invalidateQueries({ queryKey: ['transcribe', 'status'] });
  }, [s?.status, s?.error]);

  const transcribe = () => {
    setAsked('transcribe');
    transcribeNote(target);
  };
  const hide = () => {
    setAsked('hide');
    hideNote(target);
  };
  const spoken =
    asked !== 'transcribe' || !s
      ? ''
      : s.status === 'working'
        ? t.working
        : s.status === 'converting'
          ? t.converting
          : s.status === 'error'
            ? t.error[s.error ?? 'failed']
            : `${t.label}: ${s.text || t.empty}`;
  const label = n === undefined ? t.transcribe : t.transcribeN(n);

  return (
    <div className="transcribe-slot">
      {/* Always there before a tap, so its first words are spoken too. */}
      <span className="transcribe-sr" role="status" aria-live="polite">
        {spoken}
      </span>
      {!s ? (
        status?.ready ? (
          <>
            <button type="button" ref={btnRef} className="transcribe-btn" data-testid={tid} title={status.label ? t.sentTo(status.label) : undefined} aria-describedby={status.label ? privacyId : undefined} onClick={transcribe}>
              <MicIcon />
              <span>{label}</span>
            </button>
            {status.label && (
              <span id={privacyId} className="transcribe-sr">
                {t.sentTo(status.label)}
              </span>
            )}
          </>
        ) : null
      ) : (
        <div className={`transcribe-note ${s.status}`} data-testid={`${tid}-note`} ref={noteRef} tabIndex={-1}>
          <div className="transcribe-head">
            <span>{n === undefined ? t.label : `${t.label} ${n}`}</span>
            {(s.status === 'done' || s.status === 'error') && (
              <button type="button" className="transcribe-close" aria-label={t.hide} title={t.hide} data-testid={`${tid}-hide`} onClick={hide}>
                ✕
              </button>
            )}
          </div>
          {s.status === 'working' || s.status === 'converting' ? (
            <div className="transcribe-text transcribe-muted">{s.status === 'converting' ? t.converting : t.working}</div>
          ) : s.status === 'error' ? (
            <div className="transcribe-text transcribe-error" data-testid={`${tid}-error`} data-error={s.error}>
              {t.error[s.error ?? 'failed']}{' '}
              {s.error !== 'unavailable' && s.error !== 'too_long' && s.error !== 'too_large' && s.error !== 'undecodable' && (
                <button
                  type="button"
                  className="text-btn transcribe-retry"
                  onClick={() => {
                    // The button goes: focus stays in the note.
                    noteRef.current?.focus();
                    transcribe();
                  }}
                >
                  {t.retry}
                </button>
              )}
            </div>
          ) : (
            <div className={`transcribe-text ${s.text ? '' : 'transcribe-muted'}`} data-testid={`${tid}-text`} lang={s.text ? s.language?.split('-')[0] : undefined}>
              {s.text || t.empty}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Under a message: one button or transcript per sound. */
export function TranscribeBelow({ chatID, m }: MessageSlotProps & { own: boolean }) {
  const sounds = audioIndexes(m);
  if (!sounds.length) return null;
  return (
    <>
      {sounds.map((i, at) => (
        <Note key={i} chatID={chatID} messageID={m.id} index={i} n={sounds.length > 1 ? at + 1 : undefined} />
      ))}
    </>
  );
}

/**
 * The message menu's entry on a sound (MessageMenuSlotProps.audio): Transcribe until its transcript is there, then
 * Copy (a touch screen cannot select text in a bubble).
 */
export function TranscribeMenu({ chatID, m, place, audio, close }: MessageMenuSlotProps) {
  const t = useT().note;
  const status = useStatus();
  const s = useNote(chatID, m.id, audio ?? -1);
  if (audio === undefined || place !== 'text') return null;
  if (s?.status === 'done' && s.text) {
    const text = s.text;
    return (
      <li>
        <button
          type="button"
          data-testid="menu-transcript-copy"
          onClick={() => {
            close();
            void navigator.clipboard?.writeText(text).catch(() => {});
          }}
        >
          {t.copy}
        </button>
      </li>
    );
  }
  if (!status?.ready || (s && s.status !== 'error')) return null;
  return (
    <li>
      <button
        type="button"
        data-testid="menu-transcribe"
        onClick={() => {
          close();
          transcribeNote({ chatID, messageID: m.id, index: audio });
        }}
      >
        {t.transcribe}
      </button>
    </li>
  );
}
