import { useEffect } from 'react';
import { useLang } from '../../../client/src/sdk';
import type { ConversationSlotProps, MessageMenuSlotProps, MessageSlotProps } from '../../../client/src/sdk';
import { langName } from '../langs';
import { loadNotes, removeNote, useLangPrefs, useNote, usePrefs } from './assist';
import { menuTargets, msgQuickFor } from './msgquick';
import { hideTranslation, loadTranslations, translateImage, translateMessage, useTranslation, type Target } from './translations';
import { useT } from './i18n';

// Writing in the messages: the translation under a bubble (asked from the message menu or the one-tap button),
// the original of a message we sent translated, and the menu entries. Translations are only ever asked by a tap:
// nothing here translates a message on its own. Into the user's languages for received messages (Settings).

/** Mounted while a chat is open: its kept translations and originals (server side, so on every device). */
export function WritingConversation({ chatID }: ConversationSlotProps) {
  useEffect(() => {
    loadTranslations(chatID);
    loadNotes(chatID);
  }, [chatID]);
  return null;
}

/** The text we wrote before translating it with the composer's writing help (only we see it). */
function SentOriginal({ chatID, text }: { chatID: string; text?: string }) {
  const t = useT();
  const note = useNote(chatID, text);
  if (!note || !text) return null;
  return (
    <div className="translation sent-original" data-testid="msg-sent-original">
      <div className="translation-head">
        <span>{t.writing.assist.sentOriginal}</span>
        <button type="button" className="translation-close" aria-label={t.writing.assist.hideOriginal} title={t.writing.assist.hideOriginal} onClick={() => removeNote(chatID, text)}>
          ✕
        </button>
      </div>
      <div className="translation-text">{note.original}</div>
    </div>
  );
}

/** Translation asked from the message menu, under the original text (never sent). */
function TranslationView({ chatID, id }: { chatID: string; id: string }) {
  const t = useT();
  const ui = useLang();
  const w = t.writing.translate;
  const tr = useTranslation(chatID, id);
  if (!tr) return null;
  return (
    <div className={`translation ${tr.status}`} data-testid="msg-translation" lang={tr.target} aria-live="polite">
      <div className="translation-head">
        <span>{w.label(langName(tr.target, ui))}</span>
        <button type="button" className="translation-close" aria-label={w.hide} title={w.hide} data-testid="translation-close" onClick={() => hideTranslation(chatID, id)}>
          ✕
        </button>
      </div>
      {tr.status === 'loading' ? (
        <div className="translation-text muted">{tr.image !== undefined ? w.reading : w.loading}</div>
      ) : tr.status === 'error' ? (
        <div className="translation-text muted" data-testid="msg-translation-error" data-error={tr.error}>
          {tr.error === 'tooLong' ? w.tooLong : tr.error === 'noText' ? w.noText : tr.error === 'tooLarge' ? w.imageTooLarge : tr.error === 'noImage' ? w.noImage : w.failed}{' '}
          {tr.error === 'failed' && (
            <button
              type="button"
              className="text-btn"
              onClick={() => (tr.image !== undefined ? translateImage(chatID, id, tr.image, tr.target) : translateMessage(chatID, id, tr.target))}
            >
              {t.common.retry}
            </button>
          )}
        </div>
      ) : (
        <div className="translation-text" data-testid="msg-translation-text">{tr.text}</div>
      )}
    </div>
  );
}

/** Under a message's text: its translation, and for our own messages the original we translated. */
export function WritingBelow({ chatID, m, own }: MessageSlotProps & { own: boolean }) {
  return (
    <>
      <TranslationView chatID={chatID} id={m.id} />
      {own && <SentOriginal chatID={chatID} text={m.text} />}
    </>
  );
}

/** The chat's one-tap translation for this message, if it gets one (✨ settings, default: the first language). */
function useQuickTarget(chatID: string, m: MessageSlotProps['m']): Target | undefined {
  const prefs = usePrefs(chatID);
  const { readLangs } = useLangPrefs();
  const shown = useTranslation(chatID, m.id);
  return msgQuickFor(m, prefs.msgQuick, shown, readLangs);
}

/** The one-tap action in the hover row of received messages. */
export function WritingActions({ chatID, m }: MessageSlotProps) {
  const t = useT();
  const ui = useLang();
  const target = useQuickTarget(chatID, m);
  if (!target) return null;
  const label = t.writing.menu.translateTo(langName(target, ui));
  return (
    <button type="button" className="icon-btn small msg-quick" aria-label={label} title={label} data-testid="msg-quick" onClick={() => translateMessage(chatID, m.id, target)}>
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path d="M4 5h9M8.5 3v2M11 5c-.8 3.6-3.2 6.4-6.5 8M6.5 8.5c1.2 2 3 3.6 5 4.5M13 21l4-9 4 9M14.4 18h5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{target.toUpperCase()}</span>
    </button>
  );
}

/**
 * Message menu entries: Translate to <each language for received messages> (see menuTargets); on a picture,
 * Translate the picture to <each language> (its text, and its caption with it).
 */
export function WritingMenuEntries({ chatID, m, place, anchored, media, image, close }: MessageMenuSlotProps) {
  const t = useT();
  const ui = useLang();
  const { readLangs } = useLangPrefs();
  const quick = useQuickTarget(chatID, m);
  if (image !== undefined) {
    if (place !== 'text') return null;
    return readLangs.map((target) => (
      <li key={target}>
        <button
          type="button"
          data-testid={`menu-translate-image-${target}`}
          onClick={() => {
            close();
            translateImage(chatID, m.id, image, target);
          }}
        >
          {t.writing.menu.translateImageTo(langName(target, ui))}
        </button>
      </li>
    ));
  }
  return menuTargets(place, anchored, media, quick, readLangs).map((target) => (
    <li key={target}>
      <button
        type="button"
        data-testid={`menu-translate-${target}`}
        className=""
        onClick={() => {
          close();
          translateMessage(chatID, m.id, target);
        }}
      >
        {t.writing.menu.translateTo(langName(target, ui))}
      </button>
    </li>
  ));
}
