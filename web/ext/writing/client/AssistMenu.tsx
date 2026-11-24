import { useCallback, useEffect, useRef, useState } from 'react';
import { lang as uiLang, useDismiss, useLang } from '../../../client/src/sdk';
import type { ComposerApi, ComposerMenuProps, ComposerToolsProps, ConversationSlotProps, RewriteNote } from '../../../client/src/sdk';
import { langName } from '../langs';
import type { AssistMode, AssistPrefs, AssistQuick, AssistTarget } from './api';
import { AssistError, addNote, formatOf, rememberLang, runAssist, savePrefs, useLangPrefs, usePrefs } from './assist';
import { DEFAULT_QUICK, defaultTarget, draftTargets, langChoices, quickAction, quickChoices } from './choices';
import { defaultMsgQuick, msgQuickChoices, msgQuickTarget, type MsgQuick } from './msgquick';
import { useT, writingT, type T } from './i18n';

// Writing help in the composer: its section of the core's ✨ menu (fix at three levels, translate, this chat's
// settings), the one-tap button and the shortcuts beside it, and the conversation header chip. Every action is a
// rewrite of the draft by the core composer (ComposerApi.rewrite: busy state, Undo bar, original kept on send).
// The languages offered are the user's (Settings → Translation languages, choices.ts), the chat's own first.

/** Where the text goes: writing help's model, or both features' (`all`: the chat's settings cover both). */
function PrivacyNote({ all = false }: { all?: boolean }) {
  const t = useT();
  const text = all ? t.privacyAll : t.privacy;
  return (
    <p className="assist-privacy" title={text} data-testid="assist-privacy">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path d="M7 18a4 4 0 0 1-.6-8 6 6 0 0 1 11.4 1.5A3.3 3.3 0 0 1 17.5 18z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
      {text}
    </p>
  );
}

/** "Spelling only", "Translate into Vietnamese"... */
export function quickLabel(t: T, q: Exclude<AssistQuick, 'none'>, ui: string): string {
  const { mode, target } = quickAction(q);
  const w = t.writing.assist;
  if (target) return w.quickTranslate(langName(target, ui));
  return mode === 'spelling' ? w.spelling : mode === 'grammar' ? w.grammar : w.rephrase;
}

/** "Translate to French"...: the message menu's own labels. */
export function msgQuickLabel(t: T, q: Exclude<MsgQuick, 'none'>, ui: string): string {
  return t.writing.menu.translateTo(langName(msgQuickTarget(q)!, ui));
}

/** Runs a fix or a translation of the draft as a rewrite of the composer. */
function runOn(api: ComposerApi, mode: AssistMode, target?: AssistTarget): void {
  const { chatID } = api;
  const keep = [...api.mentions];
  // The result shaped for what the chat's network displays (WhatsApp: no headings; LinkedIn: plain text).
  const format = formatOf(api.network);
  api.rewrite(
    async (draft) => {
      try {
        const out = await runAssist({ chatID, mode, text: draft, ...(target ? { target } : {}), ...(keep.length ? { keep } : {}), ...(format ? { format } : {}) });
        if (mode === 'translate' && target) rememberLang(chatID, target);
        return out;
      } catch (e) {
        const w = writingT().assist;
        throw new Error(e instanceof AssistError && e.status === 422 && e.lost.length ? w.lost(e.lost.join(' ')) : e instanceof AssistError && e.status === 413 ? w.tooLong : w.failed);
      }
    },
    writingT().assist.working,
    (before): RewriteNote => {
      const w = writingT().assist;
      // A translation's original stays under the field, then under the sent message (only for us).
      if (mode === 'translate' && target) return { label: w.translatedFrom(langName(target, uiLang())), detail: before, onSend: (sent) => addNote(chatID, sent, before.trim(), target) };
      // A fix's original stays under the field too (to compare), not under the sent message.
      return { label: w.fixed(mode === 'spelling' ? w.spelling : mode === 'grammar' ? w.grammar : w.rephrase), detail: before };
    },
  );
}

/** The composer's one-tap button, set per chat in the ✨ settings: runs that fix or translation. */
function QuickButton({ quick, disabled, onRun }: { quick: Exclude<AssistQuick, 'none'>; disabled: boolean; onRun: (mode: AssistMode, target?: AssistTarget) => void }) {
  const t = useT();
  const ui = useLang();
  const { mode, target } = quickAction(quick);
  const label = quickLabel(t, quick, ui);
  return (
    <button
      type="button"
      className="quick-btn"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid="assist-quick-btn"
      // Keep the focus (and the phone keyboard) in the field.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onRun(mode, target)}
    >
      {target ? `→${target.toUpperCase()}` : mode === 'spelling' ? 'abc' : mode === 'grammar' ? 'Aa✓' : '✎'}
    </button>
  );
}

/**
 * Beside ✨: the chat's quick button, and Ctrl+Shift+K (grammar) / Ctrl+Shift+L (translate: the chat's language,
 * else the first of the user's).
 */
export function WritingTools({ api, onKey }: ComposerToolsProps) {
  const prefs = usePrefs(api.chatID);
  const { draftLangs } = useLangPrefs();
  const quick = prefs.quick || DEFAULT_QUICK;
  const live = useRef({ api, prefs, draftLangs });
  live.current = { api, prefs, draftLangs };
  useEffect(
    () =>
      onKey((e) => {
        if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || (e.code !== 'KeyK' && e.code !== 'KeyL')) return false;
        const { api: a, prefs: p, draftLangs: d } = live.current;
        if (e.code === 'KeyK') runOn(a, 'grammar');
        else runOn(a, 'translate', defaultTarget(p.lang, d));
        return true;
      }),
    [onKey],
  );
  if (quick === 'none') return null;
  return <QuickButton quick={quick} disabled={api.busy || !api.text} onRun={(m, l) => runOn(api, m, l)} />;
}

/** This chat's writing-help settings: default translation language, how the user addresses the person. */
function AssistSettings({ chatID, prefs, onDone }: { chatID: string; prefs: AssistPrefs; onDone: () => void }) {
  const t = useT();
  const ui = useLang();
  const w = t.writing.assist;
  const { draftLangs, readLangs } = useLangPrefs();
  // '' = "Default": follow the user's lists (Settings → Translation languages). A translation sets the chat's
  // language (the last one used here); choosing "Default" again clears it.
  const [lang, setLang] = useState<AssistTarget | ''>(prefs.lang || '');
  const [address, setAddress] = useState(prefs.address ?? '');
  const [quick, setQuick] = useState<AssistQuick>(prefs.quick || DEFAULT_QUICK);
  const [msgQuick, setMsgQuick] = useState<MsgQuick | ''>(prefs.msgQuick || '');
  // Only what the user changed is sent: an untouched select keeps what the chat has.
  const [touched, setTouched] = useState({ lang: false, msgQuick: false });
  const [saving, setSaving] = useState(false);
  // Not a <form>: in the composer this sits inside the message form, and forms cannot nest.
  const save = () => {
    setSaving(true);
    savePrefs(chatID, { ...(touched.lang ? { lang } : {}), address: address.trim(), quick, ...(touched.msgQuick ? { msgQuick } : {}) }).then(onDone, () => setSaving(false));
  };
  return (
    <div className="assist-settings" role="group" aria-label={w.chatSettings} data-testid="assist-settings">
      <label htmlFor="assist-lang">{w.defaultLang}</label>
      <select
        id="assist-lang"
        value={lang}
        data-testid="assist-lang"
        onChange={(e) => {
          setLang(e.target.value as AssistTarget | '');
          setTouched((x) => ({ ...x, lang: true }));
        }}
      >
        <option value="">{w.defaultChoice(langName(defaultTarget(undefined, draftLangs), ui))}</option>
        {langChoices(draftLangs, prefs.lang || undefined).map((l) => (
          <option key={l} value={l}>
            {langName(l, ui)}
          </option>
        ))}
      </select>
      <label htmlFor="assist-address">{w.address}</label>
      <textarea
        id="assist-address"
        rows={3}
        maxLength={300}
        value={address}
        placeholder={w.addressHint}
        data-testid="assist-address"
        onChange={(e) => setAddress(e.target.value)}
        onKeyDown={(e) => {
          // Enter must not send the message underneath; Ctrl+Enter saves.
          e.stopPropagation();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <label htmlFor="assist-quick">{w.quick}</label>
      <select id="assist-quick" value={quick} data-testid="assist-quick" onChange={(e) => setQuick(e.target.value as AssistQuick)}>
        <option value="none">{w.quickNone}</option>
        {quickChoices(draftLangs, quick).map((q) => (
          <option key={q} value={q}>
            {quickLabel(t, q, ui)}
          </option>
        ))}
      </select>
      <label htmlFor="assist-msg-quick">{w.msgQuick}</label>
      <select
        id="assist-msg-quick"
        value={msgQuick}
        data-testid="assist-msg-quick"
        onChange={(e) => {
          setMsgQuick(e.target.value as MsgQuick | '');
          setTouched((x) => ({ ...x, msgQuick: true }));
        }}
      >
        <option value="">{w.defaultChoice(msgQuickLabel(t, defaultMsgQuick(readLangs) as Exclude<MsgQuick, 'none'>, ui))}</option>
        <option value="none">{w.quickNone}</option>
        {msgQuickChoices(readLangs, prefs.msgQuick).map((q) => (
          <option key={q} value={q}>
            {msgQuickLabel(t, q, ui)}
          </option>
        ))}
      </select>
      <button type="button" className="text-btn" disabled={saving} data-testid="assist-save" onClick={save}>
        {w.save}
      </button>
    </div>
  );
}

/** Writing's section of the ✨ menu: fix (three levels), translate, and this chat's settings (always reachable). */
export function WritingMenu({ api, close, solo }: ComposerMenuProps) {
  const t = useT();
  const ui = useLang();
  const w = t.writing.assist;
  const prefs = usePrefs(api.chatID);
  const { draftLangs } = useLangPrefs();
  const [editing, setEditing] = useState(false);
  const hasText = !!api.text;
  // The settings form takes the whole menu (the agent's entry hides meanwhile).
  useEffect(() => {
    solo(editing);
  }, [editing]);

  const run = (mode: AssistMode, target?: AssistTarget) => {
    close();
    runOn(api, mode, target);
  };

  return (
    <>
      <PrivacyNote />
      {editing ? (
        <AssistSettings chatID={api.chatID} prefs={prefs} onDone={close} />
      ) : (
        <>
          <p className="assist-h">{w.fix}</p>
          <button type="button" role="menuitem" disabled={!hasText} data-testid="assist-spelling" onClick={() => run('spelling')}>
            {w.spelling}
          </button>
          <button type="button" role="menuitem" disabled={!hasText} data-testid="assist-grammar" onClick={() => run('grammar')}>
            {w.grammar} <kbd>Ctrl+⇧+K</kbd>
          </button>
          <button type="button" role="menuitem" disabled={!hasText} data-testid="assist-rephrase" onClick={() => run('rephrase')}>
            {w.rephrase}
          </button>
          <p className="assist-h">{w.translateTo}</p>
          {draftTargets(prefs.lang, draftLangs).map((l, i) => (
            <button key={l} type="button" role="menuitem" disabled={!hasText} data-testid={`assist-translate-${l}`} onClick={() => run('translate', l)}>
              {langName(l, ui)} {i === 0 && <kbd>Ctrl+⇧+L</kbd>}
            </button>
          ))}
          {!hasText && <p className="assist-note">{w.typeFirst}</p>}
          {prefs.address && <p className="assist-note">{prefs.address}</p>}
          <button type="button" role="menuitem" className="assist-more" data-testid="assist-open-settings" onClick={() => setEditing(true)}>
            {w.settings}
          </button>
        </>
      )}
    </>
  );
}

/**
 * Conversation header shortcut: shows this chat's settings at a glance (its language's code, a mark when how the
 * user addresses the person is set; the full summary in its tooltip) and opens them (not in read-only chats).
 */
export function WritingHeader({ chatID, readOnly }: ConversationSlotProps) {
  if (readOnly) return null;
  return <HeaderChip chatID={chatID} />;
}

function HeaderChip({ chatID }: { chatID: string }) {
  const t = useT();
  const ui = useLang();
  const w = t.writing.assist;
  const prefs = usePrefs(chatID);
  const { draftLangs } = useLangPrefs();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const set = !!(prefs.address || prefs.lang);
  const lang = defaultTarget(prefs.lang, draftLangs);
  const summary = set ? w.headSummary(langName(lang, ui), prefs.address) : w.chatSettings;
  return (
    <div className="assist-head">
      <button
        type="button"
        className={`assist-chip ${set ? 'set' : ''}`}
        aria-label={summary}
        title={summary}
        aria-expanded={open}
        data-testid="assist-head-btn"
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M10 3l1.8 4.9L17 10l-5.2 2.1L10 17l-1.8-4.9L3 10l5.2-2.1zM18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
        {set && (
          <span className="assist-chip-lang" data-testid="assist-head-lang">
            {lang.toUpperCase()}
          </span>
        )}
        {prefs.address && (
          // A person with a speech line: how the user addresses them is set.
          <svg className="assist-chip-ctx" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" data-testid="assist-head-context">
            <circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M16 6.5h5M16 10h3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
      </button>
      {open && <HeaderPopover chatID={chatID} prefs={prefs} onClose={close} />}
    </div>
  );
}

function HeaderPopover({ chatID, prefs, onClose }: { chatID: string; prefs: AssistPrefs; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, '[data-testid=assist-head-btn]', onClose);
  return (
    <div ref={ref} className="assist-menu assist-head-menu" role="dialog" aria-label={t.writing.assist.chatSettings} data-testid="assist-head-menu">
      <PrivacyNote all />
      <p className="assist-h">{t.writing.assist.chatSettings}</p>
      <AssistSettings chatID={chatID} prefs={prefs} onDone={onClose} />
    </div>
  );
}
