import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { MAX_UPLOAD_BYTES, upload } from './endpoints';
import { attachmentPlan, canAttach } from './caps';
import { prepareFile } from './attachprep';
import { redraw } from './redraw';
import { fileSize } from './format';
import { localized, t as tr, useT } from './i18n';
import { drafts, type Draft } from './drafts';
import { canRecord, Recorder, recordType, type Recorded } from './recorder';
import { duration as fmtDuration } from './format';
import type { Participant } from './types';
import { fold, withMentions, type Mention } from './mentions';
import type { Chat, UploadResult } from './types';
import type { ComposerApi, ComposerNetwork, ComposerSlots, RewriteNote } from './extension';
import type { ModuleInfo } from '../../server/extension';
import { useDismiss } from './dismiss';
import { Lazy } from './lazy';

const PREVIEWABLE = /^image\/(jpeg|png|gif|webp|avif)$/;
const MAX_TRAY = 10;

export interface TrayItem {
  key: string;
  file: File;
  previewURL?: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
  result?: UploadResult;
  asFile?: boolean;
  caption: boolean;
  abort?: () => void;
}

let seq = 0;

/** Files attached in the composer; uploads start as soon as a file is added. */
export function useTray(chat: Chat | undefined) {
  const [items, setItems] = useState<TrayItem[]>([]);
  const live = useRef(items);
  live.current = items;
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const patch = (key: string, p: Partial<TrayItem>) =>
    setItems((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));

  // Items removed (or sent, or the tray gone) while their file was being prepared: never uploaded.
  const gone = useRef(new Set<string>());

  /** Readies the file for the chat's network (attachprep.ts), plans it, then uploads it to the chat's connector. */
  const start = useCallback(async (item: TrayItem) => {
    const { key, file: original } = item;
    const t = tr().composer;
    const chat = chatRef.current;
    const file = await prepareFile(original, chat?.capabilities, redraw).catch(() => null);
    if (gone.current.has(key)) return;
    if (!file) {
      patch(key, { status: 'error', error: t.uploadFailed });
      return;
    }
    const plan = attachmentPlan(chat, file.type, file.size);
    const ready: Partial<TrayItem> = { file, caption: plan.caption, asFile: plan.asFile };
    if (file !== original) {
      if (item.previewURL) URL.revokeObjectURL(item.previewURL);
      ready.previewURL = PREVIEWABLE.test(file.type) ? URL.createObjectURL(file) : undefined;
    }
    if (!plan.ok) {
      const error = plan.maxSize ? t.tooLargeNetwork(fileSize(plan.maxSize)) : t.typeUnsupported;
      patch(key, { ...ready, status: 'error', error });
      return;
    }
    const job = upload(file, (f) => patch(key, { progress: f }), chat?.id);
    patch(key, { ...ready, abort: job.abort });
    job.promise.then(
      (result) => patch(key, { status: 'done', progress: 1, result, abort: undefined }),
      (e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        const status = (e as { status?: number }).status;
        // 403 never comes from the app itself: it is the reverse proxy's WAF (body size limit).
        const error =
          status === 413 ? t.tooLargeShort : status === 403 ? t.blockedByProxy : status === 429 ? t.tooManyUploads : t.uploadFailed;
        patch(key, { status: 'error', error, abort: undefined });
      },
    );
  }, []);

  // Picked, dropped or pasted: one path for all three.
  const add = useCallback(
    (files: Iterable<File>) => {
      const added: TrayItem[] = [];
      const t = tr().composer;
      const accepts = canAttach(chatRef.current);
      for (const file of files) {
        if (live.current.length + added.length >= MAX_TRAY) break;
        const key = `att-${Date.now()}-${seq++}`;
        const base: TrayItem = { key, file, progress: 0, status: 'uploading', caption: false };
        if (PREVIEWABLE.test(file.type)) base.previewURL = URL.createObjectURL(file);
        if (file.size === 0) {
          added.push({ ...base, status: 'error', error: t.emptyFile });
          continue;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          added.push({ ...base, status: 'error', error: t.tooLarge(fileSize(MAX_UPLOAD_BYTES)) });
          continue;
        }
        if (!accepts) {
          added.push({ ...base, status: 'error', error: t.noFiles });
          continue;
        }
        added.push(base);
      }
      if (added.length) setItems((list) => [...list, ...added]);
      for (const it of added) if (it.status === 'uploading') void start(it);
    },
    [start],
  );

  const remove = useCallback((key: string) => {
    const it = live.current.find((x) => x.key === key);
    gone.current.add(key);
    it?.abort?.();
    if (it?.previewURL) URL.revokeObjectURL(it.previewURL);
    setItems((list) => list.filter((x) => x.key !== key));
  }, []);

  /** Empties the tray; preview URLs of sent items are handed over to the outgoing store. */
  const take = useCallback((): TrayItem[] => {
    const done = live.current.filter((x) => x.status === 'done');
    for (const x of live.current) if (x.status !== 'done') gone.current.add(x.key);
    for (const x of live.current) if (x.status !== 'done' && x.previewURL) URL.revokeObjectURL(x.previewURL);
    live.current.forEach((x) => x.abort?.());
    setItems([]);
    return done;
  }, []);

  useEffect(
    () => () => {
      for (const x of live.current) {
        gone.current.add(x.key);
        x.abort?.();
        if (x.previewURL) URL.revokeObjectURL(x.previewURL);
      }
    },
    [],
  );

  return { items, add, remove, take };
}

export type Tray = ReturnType<typeof useTray>;

const finePointer = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

const COMPOSER_MAX_HEIGHT = 160;
/**
 * Auto-grow: border-box height = content (scrollHeight, padding included) + borders, rounded up.
 * The scrollbar only appears once the text is taller than the maximum (no ▲▼ arrows for one line).
 */
export function autosize(el: HTMLTextAreaElement): void {
  const cs = getComputedStyle(el);
  const borders = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  el.style.overflowY = 'hidden';
  el.style.height = 'auto';
  const needed = Math.ceil(el.scrollHeight + (cs.boxSizing === 'border-box' ? borders : 0));
  const max = parseFloat(cs.maxHeight) || COMPOSER_MAX_HEIGHT;
  el.style.height = `${Math.min(needed, max)}px`;
  el.style.overflowY = needed > max + 1 ? 'auto' : 'hidden';
}

function Progress({ value }: { value: number }) {
  const t = useT();
  const r = 14;
  const c = 2 * Math.PI * r;
  return (
    <svg className="tray-progress" viewBox="0 0 36 36" width="36" height="36" aria-label={t.composer.progress(Math.round(value * 100))} role="img">
      <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <circle
        cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - value)} transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

function TrayView({ tray }: { tray: Tray }) {
  const t = useT();
  if (!tray.items.length) return null;
  return (
    <div className="tray" aria-label={t.composer.attachments} data-testid="tray">
      {tray.items.map((it) => (
        <div key={it.key} className={`tray-item ${it.status}`} title={it.error ?? it.file.name} data-testid="tray-item" data-status={it.status}>
          {it.previewURL ? (
            <img src={it.previewURL} alt="" className="tray-thumb" />
          ) : (
            <span className="tray-file">
              <span aria-hidden="true">📎</span>
              <span className="tray-name">{it.file.name || t.common.file}</span>
              <span className="tray-size">{fileSize(it.file.size)}</span>
            </span>
          )}
          {it.status === 'uploading' && (
            <span className="tray-overlay">
              <Progress value={it.progress} />
            </span>
          )}
          {it.status === 'error' && <span className="tray-overlay tray-error">{it.error}</span>}
          <button type="button" className="tray-remove" aria-label={it.status === 'uploading' ? t.composer.cancelUpload : t.composer.remove} data-testid="tray-remove" onClick={() => tray.remove(it.key)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function MentionPicker({ items, active, onPick }: { items: Participant[]; active: number; onPick: (p: Participant) => void }) {
  const t = useT();
  return (
    <ul className="mention-picker" role="listbox" aria-label={t.composer.mentions} data-testid="mention-picker">
      {items.map((p, i) => (
        <li key={p.id} role="option" aria-selected={i === active}>
          <button
            type="button"
            className={i === active ? 'active' : ''}
            data-testid="mention-option"
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(p);
            }}
          >
            <span className="mention-name">{p.fullName || p.id}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

type RecState = { phase: 'idle' } | { phase: 'starting' | 'recording'; hold: boolean; seconds: number; levels: number[]; dx: number };

function VoiceBar({ st, onCancel, onSend }: { st: Extract<RecState, { phase: 'starting' | 'recording' }>; onCancel: () => void; onSend: () => void }) {
  const t = useT();
  return (
    <div className="voice-bar" data-testid="voice-bar" style={st.dx ? { transform: `translateX(${Math.max(-120, st.dx)}px)` } : undefined}>
      <button type="button" className="icon-btn" aria-label={t.composer.cancelRecording} data-testid="voice-cancel" onClick={onCancel}>
        ✕
      </button>
      <span className="rec-dot" aria-hidden="true" />
      <span className="rec-time" aria-label={t.composer.recording} data-testid="voice-time">
        {fmtDuration(st.seconds)}
      </span>
      <span className="rec-levels" aria-hidden="true">
        {st.levels.map((l, i) => (
          <span key={i} style={{ height: `${Math.max(8, Math.round(l * 100))}%` }} />
        ))}
      </span>
      {st.hold && <span className="rec-hint">{t.composer.slideToCancel}</span>}
      {/* Always there, held or not: a release iOS never delivers must not leave the recording without a way to send. */}
      <button type="button" className="send-btn" aria-label={t.composer.sendVoice} data-testid="voice-send" onClick={onSend}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 12l16-8-6 16-2.5-6.5L4 12z" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

export function Composer({
  disabled,
  tray,
  onSend,
  top,
  focusKey,
  onEscape,
  onEditLast,
  maxLength = 20_000,
  draftKey,
  participants,
  onNeedParticipants,
  onVoice,
  voiceChat,
  onError,
  noFiles,
  augmentations,
  fill,
  network,
}: {
  focusKey?: string;
  onEscape?: () => void;
  /** ↑ in the empty field (keyboard): edit our last message; false when there is none to edit. */
  onEditLast?: () => boolean;
  disabled: boolean;
  tray: Tray;
  /** `wire` is the text for the API (mentions as Matrix pills); `text` is what the user typed. */
  onSend: (text: string, attachments: TrayItem[], wire?: string) => void;
  top?: ReactNode;
  maxLength?: number;
  /** Chat ID: the unsent text is kept as a draft for it. */
  draftKey?: string;
  /** Group participants for @mentions (undefined: no mention picker). */
  participants?: Participant[];
  onNeedParticipants?: () => void;
  onVoice?: (r: Recorded) => void;
  voiceChat?: Parameters<Recorder['stop']>[0];
  onError?: (message: string) => void;
  /** The network takes no files: no attach / camera buttons. */
  noFiles?: boolean;
  /** The ✨ parts (extension.ts ComposerSlots): the augmentations'; their info for the tooltip (needs draftKey). */
  augmentations?: readonly ComposerPart[];
  /** Puts this text into the field (a draft to edit, from an augmentation's card), once per key. */
  fill?: { key: number; text: string };
  /** The chat's network and the formatting it displays (ComposerApi.network). */
  network?: ComposerNetwork;
}) {
  const t = useT();
  const initial = useRef<Draft | undefined>(draftKey ? drafts.get(draftKey) : undefined);
  const [text, setText] = useState(initial.current?.text ?? '');
  const [mentions, setMentions] = useState<Mention[]>(initial.current?.mentions ?? []);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [touch] = useState(coarsePointer);
  // Narrow screens (styles.css): while the field has text, 📎 folds into a chevron; tapping it shows 📎 and 📷
  // again until the text changes or the field takes the focus back.
  const [tools, setTools] = useState(false);
  const toolsBtn = useRef<HTMLButtonElement>(null);
  const attachBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => setTools(false), [text]);
  // Long press on 📎 (touch): straight to the camera. Opened on pointerup, which still counts as a user gesture.
  const press = useRef({ at: 0, camera: false });
  const attachHandlers = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      press.current = { at: e.pointerType === 'mouse' ? 0 : performance.now(), camera: false };
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      const { at } = press.current;
      if (e.pointerType === 'mouse' || !at || performance.now() - at < 450) return;
      press.current = { at: 0, camera: true };
      setTools(false);
      cameraRef.current?.click();
    },
    onPointerCancel: () => {
      press.current = { at: 0, camera: false };
    },
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick: () => {
      const longPress = press.current.camera;
      press.current = { at: 0, camera: false };
      if (longPress) return;
      setTools(false);
      fileRef.current?.click();
    },
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    autosize(el);
  }, [text]);
  // The field's width changes with the buttons around it (typing, chevron, rotation): fit its height again.
  useEffect(() => {
    const el = ref.current;
    if (!el || !('ResizeObserver' in window)) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      autosize(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draft: saved as the user types (per chat, this device).
  useEffect(() => {
    if (draftKey) drafts.set(draftKey, text, mentions.filter((m) => text.includes(`@${m.name}`)));
  }, [draftKey, text, mentions]);

  const uploading = tray.items.some((x) => x.status === 'uploading');
  const ready = tray.items.some((x) => x.status === 'done');
  const canSend = !disabled && !uploading && (!!text.trim() || ready) && text.length <= maxLength;

  // --- Mentions --------------------------------------------------------------------------------
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const updateQuery = (value: string, caret: number) => {
    if (!participants) return setQuery(null);
    const m = /(?:^|\s)@([^\s@]{0,40})$/u.exec(value.slice(0, caret));
    setQuery(m ? m[1]! : null);
    setActive(0);
  };
  const matches = useMemo(() => {
    if (query === null || !participants) return [];
    const q = fold(query);
    return participants.filter((p) => !p.isSelf && fold(`${p.fullName ?? ''} ${p.username ?? ''}`).includes(q)).slice(0, 8);
  }, [query, participants]);
  useEffect(() => {
    if (query !== null) onNeedParticipants?.();
  }, [query, onNeedParticipants]);
  const pickMention = (p: Participant) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,40})$/u, '');
    const name = (p.fullName || p.username || p.id).replace(/\s+/g, ' ').trim();
    const next = `${before}@${name} ${text.slice(caret)}`;
    setText(next);
    setMentions((list) => [...list.filter((m) => m.name !== name), { name, id: p.id }]);
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = before.length + name.length + 2;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  // A text to edit put into the field (ComposerApi.fill; a card's draft through the `fill` prop).
  const fillField = useCallback((next: string) => {
    setText(next);
    setMentions([]);
    requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(next.length, next.length);
    });
  }, []);
  useEffect(() => {
    if (fill) fillField(fill.text);
  }, [fill, fillField]);

  // --- ✨: the composer parts (extension.ts ComposerSlots) of the augmentations ------------------------
  const parts = useMemo(() => (draftKey ? (augmentations ?? []).filter((a) => a.composer) : []), [augmentations, draftKey]);
  // Each part says whether it is there in this chat (useAvailable, a hook: called by <Available>, one per part).
  const [available, setAvailable] = useState<Readonly<Record<string, boolean>>>({});
  const report = useCallback((id: string, ok: boolean) => setAvailable((a) => (a[id] === ok ? a : { ...a, [id]: ok })), []);
  const augs = parts.filter((a) => !a.composer!.useAvailable || available[a.id]);
  const [aiMenu, setAiMenu] = useState(false);
  // A rewrite under way (the field is read-only), or a task (it stays editable): its line under the field.
  const [working, setWorking] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const aiBusy = working !== null;
  const busy = aiBusy || running !== null;
  // What the last rewrite replaced: Undo puts it back; its note says what it was, and hears about the send.
  const [aiUndo, setAiUndo] = useState<{ before: string; result: string; note: RewriteNote } | null>(null);
  // Rewrites start from key handlers registered once (onKey): they read the state of now.
  const live = useRef({ text, aiUndo, busy });
  live.current = { text, aiUndo, busy };
  const rewrite: ComposerApi['rewrite'] = async (work, label, done) => {
    const { text: cur, aiUndo: undo, busy: b } = live.current;
    const draft = cur.trim();
    if (b || !draft) return;
    setWorking(label);
    try {
      const out = await work(draft);
      // A rewrite of a rewrite keeps the very first text.
      const before = undo && cur === undo.result ? undo.before : cur;
      setText(out);
      setAiUndo({ before, result: out, note: done(before) });
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
      ref.current?.focus();
    }
  };
  const run: ComposerApi['run'] = async (task, label) => {
    if (live.current.busy) return;
    const input = live.current.text.trim();
    setRunning(label);
    try {
      // E.g. an instruction to an agent: not a message, it leaves the field once handed over (if unchanged).
      if (await task(input)) setText((cur) => (cur.trim() === input ? '' : cur));
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };
  const closeAiMenu = useCallback(() => setAiMenu(false), []);
  const undoAi = () => {
    if (!aiUndo) return;
    setText(aiUndo.before);
    setAiUndo(null);
    ref.current?.focus();
  };
  const keyHandlers = useRef(new Set<(e: globalThis.KeyboardEvent) => boolean>());
  const onKey = useCallback((h: (e: globalThis.KeyboardEvent) => boolean) => {
    keyHandlers.current.add(h);
    return () => void keyHandlers.current.delete(h);
  }, []);
  const composerApi: ComposerApi | undefined = draftKey
    ? {
        chatID: draftKey,
        text: text.trim(),
        mentions: mentions.filter((m) => text.includes(`@${m.name}`)).map((m) => m.name),
        network,
        busy,
        rewrite,
        run,
        fill: fillField,
        notify: (message) => onError?.(message),
      }
    : undefined;

  const submit = () => {
    if (!canSend) return;
    const display = text.trim();
    const wire = withMentions(display, mentions);
    if (aiUndo?.note.onSend && display) aiUndo.note.onSend(display);
    setAiUndo(null);
    onSend(display, tray.take(), wire !== display ? wire : undefined);
    setText('');
    setMentions([]);
    setQuery(null);
    ref.current?.focus();
  };

  useEffect(() => {
    if (focusKey) ref.current?.focus();
  }, [focusKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(matches[active] ?? matches[0]!);
        return;
      }
      if (e.key === 'Escape') {
        setQuery(null);
        return;
      }
    }
    // The ✨ menu keeps the focus in the field: Escape closes the menu first.
    if (e.key === 'Escape' && aiMenu) {
      setAiMenu(false);
      return;
    }
    // The augmentations' shortcuts (ComposerToolsProps.onKey).
    for (const h of keyHandlers.current) {
      if (h(e.nativeEvent)) {
        e.preventDefault();
        return;
      }
    }
    if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && aiUndo && text === aiUndo.result) {
      e.preventDefault();
      undoAi();
      return;
    }
    if (e.key === 'Escape' && onEscape) {
      onEscape();
      return;
    }
    if (e.key === 'ArrowUp' && !text && !tray.items.length && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && onEditLast?.()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && finePointer()) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (!files.length || disabled) return;
    e.preventDefault();
    tray.add(files);
  };

  const pick = (input: HTMLInputElement | null) => {
    if (!input?.files) return;
    tray.add([...input.files]);
    input.value = '';
  };

  // --- Voice -----------------------------------------------------------------------------------
  const [rec, setRec] = useState<RecState>({ phase: 'idle' });
  const recorder = useRef<Recorder | null>(null);
  const released = useRef(false);
  const startX = useRef(0);
  const lastPointer = useRef('');
  const lastPaint = useRef(0);
  const voiceType = useMemo(() => (onVoice && canRecord() ? recordType() : undefined), [onVoice]);
  const maxSeconds = 15 * 60;

  const finish = async (send: boolean) => {
    const r = recorder.current;
    recorder.current = null;
    setRec({ phase: 'idle' });
    if (!r) return;
    if (!send) return r.cancel();
    const out = await r.stop(voiceChat).catch(() => null);
    if (out) onVoice?.(out);
  };

  const startRecording = async (hold: boolean) => {
    if (!voiceType || recorder.current) return;
    const r = new Recorder(voiceType);
    recorder.current = r;
    released.current = false;
    setRec({ phase: 'starting', hold, seconds: 0, levels: [], dx: 0 });
    try {
      await r.start((level, seconds) => {
        const now = performance.now();
        if (now - lastPaint.current < 100) return;
        lastPaint.current = now;
        setRec((st) => (st.phase === 'idle' ? st : { ...st, phase: 'recording', seconds, levels: [...st.levels, level].slice(-28) }));
        if (seconds >= maxSeconds) void finish(true);
      });
      // Released while the permission prompt was up: nothing to send.
      if (hold && released.current) {
        recorder.current = null;
        r.cancel();
        setRec({ phase: 'idle' });
        onError?.(t.composer.holdToRecord);
        return;
      }
      setRec((st) => (st.phase === 'idle' ? st : { ...st, phase: 'recording' }));
    } catch (e) {
      recorder.current = null;
      r.cancel();
      setRec({ phase: 'idle' });
      onError?.(e instanceof DOMException && e.name === 'NotAllowedError' ? t.composer.micDenied : t.composer.micUnavailable);
    }
  };

  useEffect(() => () => recorder.current?.cancel(), []);

  // A held recording ends when the finger lifts anywhere: iOS does not always deliver pointerup to the mic button (the
  // voice bar appears over the row, the audio session starts), which left the recording running with no way to send.
  const held = rec.phase !== 'idle' && rec.hold;
  const recPhase = rec.phase;
  useEffect(() => {
    if (!held) return;
    const up = () => {
      if (released.current || !recorder.current) return;
      released.current = true;
      void finish(recPhase === 'recording');
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('touchend', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('touchend', up);
    };
    // finish reads refs and setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, recPhase]);

  const micHandlers = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      lastPointer.current = e.pointerType;
      if (e.pointerType === 'mouse' || e.button !== 0) return; // mouse (and keyboard): click toggles
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      startX.current = e.clientX;
      void startRecording(true);
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      if (rec.phase === 'idle' || !rec.hold) return;
      const dx = Math.min(0, e.clientX - startX.current);
      if (dx < -100) void finish(false);
      else setRec((st) => (st.phase === 'idle' ? st : { ...st, dx }));
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === 'mouse' || released.current) return;
      released.current = true;
      if (recorder.current && rec.phase !== 'idle' && rec.hold) void finish(rec.phase === 'recording');
    },
    // The browser took the touch away without a release (a system gesture, an alert): keep the recording, unheld,
    // with its Send and ✕ buttons, rather than leaving it stuck in "hold" mode.
    onLostPointerCapture: () => {
      if (released.current || rec.phase === 'idle' || !rec.hold) return;
      setRec((st) => (st.phase === 'idle' ? st : { ...st, hold: false, dx: 0 }));
    },
    onPointerCancel: () => {
      released.current = true;
      if (rec.phase !== 'idle' && rec.hold) void finish(false);
    },
    onClick: () => {
      const p = lastPointer.current;
      lastPointer.current = '';
      if ((p === 'mouse' || p === '') && rec.phase === 'idle') void startRecording(false);
    },
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
  const hasText = !!text.trim();
  // ✨ and the parts' tools beside it (a quick button) show together, once those chunks are in: the row never
  // gains a button a moment after it was drawn.
  const toolChunks = augs.flatMap((a) => (a.composer?.Tools ? [a.composer.Tools] : []));
  const toolsIn = toolChunks.every((c) => c.ready());
  const [, setToolsLoaded] = useState(0);
  const toolsKey = augs.map((a) => a.id).join(',');
  useEffect(() => {
    if (toolsIn) return;
    let on = true;
    void Promise.all(toolChunks.map((c) => c.whenReady())).then(() => on && setToolsLoaded((n) => n + 1));
    return () => {
      on = false;
    };
    // toolChunks follows toolsKey (the parts on in this chat).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolsKey, toolsIn]);
  const showAssist = augs.length > 0 && toolsIn && !!draftKey && !disabled;
  const showMic = !!voiceType && !disabled && !text.trim() && !ready && !uploading;

  return (
    <form
      className="composer"
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {top}
      <TrayView tray={tray} />
      {matches.length > 0 && <MentionPicker items={matches} active={active} onPick={pickMention} />}
      <div className={`composer-row${hasText ? ' typing' : ''}${tools ? ' tools' : ''}${touch ? ' touch' : ''}`}>
        {rec.phase !== 'idle' && <VoiceBar st={rec} onCancel={() => void finish(false)} onSend={() => void finish(true)} />}
        {!noFiles && (
          <button
            ref={toolsBtn}
            type="button"
            className="icon-btn tools-toggle"
            aria-label={t.composer.moreTools}
            title={t.composer.moreTools}
            aria-expanded={tools}
            data-testid="composer-tools"
            disabled={disabled}
            // Keep the focus (and the phone keyboard) in the field.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              // From the keyboard the chevron had the focus and is about to go: hand it to 📎.
              const focused = document.activeElement === toolsBtn.current;
              setTools(true);
              if (focused) requestAnimationFrame(() => attachBtn.current?.focus());
            }}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {!noFiles && (
          <button ref={attachBtn} type="button" className="icon-btn attach-btn" aria-label={t.composer.attach} title={t.composer.attach} data-testid="attach" disabled={disabled} {...attachHandlers}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {!noFiles && (
          <button
            type="button"
            className="icon-btn attach-btn camera-btn"
            aria-label={t.composer.camera}
            title={t.composer.camera}
            data-testid="camera"
            disabled={disabled}
            onClick={() => {
              setTools(false);
              cameraRef.current?.click();
            }}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              <circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        )}
        <input ref={fileRef} type="file" multiple hidden data-testid="file-input" onChange={(e) => pick(e.currentTarget)} />
        <input ref={cameraRef} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => pick(e.currentTarget)} />
        <div className={`field-wrap${showAssist ? ' with-assist' : ''}`}>
          <textarea
            ref={ref}
            rows={1}
            value={text}
            disabled={disabled}
            readOnly={aiBusy}
            aria-busy={aiBusy}
            maxLength={maxLength}
            placeholder={disabled ? t.composer.readOnly : t.composer.message}
            aria-label={t.composer.message}
            aria-autocomplete={participants ? 'list' : undefined}
            aria-expanded={participants ? matches.length > 0 : undefined}
            data-testid="composer-input"
            onChange={(e) => {
              setText(e.target.value);
              updateQuery(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => updateQuery(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
            onFocus={() => setTools(false)}
            onBlur={() => window.setTimeout(() => setQuery(null), 150)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {showAssist && (
            <span className="assist-wrap">
              <button
                type="button"
                className={`icon-btn assist-btn ${busy ? 'busy' : ''}`}
                aria-label={t.assist.button}
                title={[t.assist.button, ...augs.flatMap((a) => (a.composer?.hint ? [localized(a.composer.hint(a.info ?? {}))] : []))].join(' · ')}
                aria-haspopup="menu"
                aria-expanded={aiMenu}
                data-testid="assist-btn"
                disabled={busy}
                // Keep the focus (and the phone keyboard) in the field.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setAiMenu((v) => !v)}
              >
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                  <path d="M10 3l1.8 4.9L17 10l-5.2 2.1L10 17l-1.8-4.9L3 10l5.2-2.1zM18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                </svg>
              </button>
            </span>
          )}
        </div>
        {composerApi &&
          parts.map((a) => {
            const use = a.composer!.useAvailable;
            return use && <Available key={a.id} id={a.id} chatID={composerApi.chatID} use={use} report={report} />;
          })}
        {showAssist && aiMenu && composerApi && <AiMenu api={composerApi} parts={augs} onClose={closeAiMenu} />}
        {showAssist &&
          composerApi &&
          augs.map((a) => {
            const Tools = a.composer?.Tools;
            return (
              Tools && (
                <Lazy key={a.id} failed={null}>
                  <Tools api={composerApi} onKey={onKey} />
                </Lazy>
              )
            );
          })}
        {showMic ? (
          <button
            type="button"
            className={`send-btn mic-btn ${rec.phase !== 'idle' ? 'live' : ''}`}
            aria-label={t.composer.record}
            title={touch ? t.composer.holdToRecord : t.composer.record}
            data-testid="mic"
            {...micHandlers}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        ) : (
          <button type="submit" className="send-btn" aria-label={t.composer.send} data-testid="send" disabled={!canSend}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M4 12l16-8-6 16-2.5-6.5L4 12z" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
      {aiBusy && <div className="assist-bar" data-testid="assist-busy">{working}</div>}
      {running !== null && (
        <div className="assist-bar" data-testid="composer-running">
          {running}
        </div>
      )}
      {aiUndo && !aiBusy && (
        <div className="assist-bar" data-testid="assist-bar">
          <span className="assist-bar-main">
            <span className="assist-bar-label">{aiUndo.note.label}</span>
            {aiUndo.note.detail !== undefined && (
              <span className="assist-bar-original" data-testid="assist-original">
                {aiUndo.note.detail}
              </span>
            )}
          </span>
          <button type="button" className="text-btn" data-testid="assist-undo" onClick={undoAi}>
            {t.assist.undo}
          </button>
        </div>
      )}
    </form>
  );
}

/** A part of the ✨ menu: an augmentation's composer slots. */
export type ComposerPart = { id: string; composer?: ComposerSlots; info?: ModuleInfo };

/** Calls a part's useAvailable for this chat and reports it (a component, so the parts can come and go). */
function Available({ id, chatID, use, report }: { id: string; chatID: string; use: (chatID: string) => boolean; report: (id: string, ok: boolean) => void }) {
  const ok = use(chatID);
  useEffect(() => report(id, ok), [id, ok, report]);
  return null;
}

/**
 * The ✨ menu: the parts' sections in order, one alone while it asks to (a form taking the whole menu). `toggle`:
 * the button that opens it (a click there is its own, not a dismissal).
 */
export function AiMenu({ api, parts, onClose, toggle = '[data-testid=assist-btn]' }: { api: ComposerApi; parts: readonly ComposerPart[]; onClose: () => void; toggle?: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [solo, setSolo] = useState<string>();
  useDismiss(ref, toggle, onClose);
  return (
    <div ref={ref} className="assist-menu" role="menu" aria-label={t.assist.button} data-testid="assist-menu">
      {parts
        .filter((p) => !solo || p.id === solo)
        .map((p) => {
          const Menu = p.composer!.Menu;
          return (
            <Lazy key={p.id} failed={null}>
              <Menu api={api} close={onClose} solo={(on) => setSolo(on ? p.id : undefined)} />
            </Lazy>
          );
        })}
    </div>
  );
}
