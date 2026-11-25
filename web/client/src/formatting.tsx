import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useT } from './i18n';
import type { ComposerNetwork } from './extension';
import {
  activeAt,
  autoBullet,
  continueList,
  editFor,
  featureOf,
  pasteMarkdown,
  previewSpans,
  shortcutOf,
  shows,
  showsAny,
  SHORTCUTS,
  type FormatAction,
  type Formatting,
  type InlineFeature,
  type TextEdit,
} from './textformat';

// The composer's formatting (textformat.ts writes the Markdown): shortcuts, the bar, pastes, lists, the preview.
// Shared by the composer and the message editor; the field stays a plain textarea holding Markdown.

export const isApple = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * Applies an edit as typing would, so Ctrl+Z takes it back (execCommand keeps the field's undo history; React hears
 * the input event). Falls back to setting the value where the browser refuses.
 */
export function applyEdit(el: HTMLTextAreaElement, ed: TextEdit): boolean {
  const before = el.value;
  const next = before.slice(0, ed.from) + ed.insert + before.slice(ed.to);
  // Over the field's limit: refused whole, as typing past it would be (never a half-written mark).
  if (el.maxLength >= 0 && next.length > el.maxLength && next.length > before.length) return false;
  el.focus();
  el.setSelectionRange(ed.from, ed.to);
  let ok = false;
  try {
    ok = ed.insert ? document.execCommand('insertText', false, ed.insert) : ed.from === ed.to || document.execCommand('delete');
  } catch {
    ok = false;
  }
  if (!ok || el.value !== next) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(ed.selStart, ed.selEnd);
  return true;
}

export interface Formatter {
  formatting: Formatting;
  /** A key press: true when it was a formatting one (handled, default prevented). */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>, opts?: { enterSends?: boolean }) => boolean;
  /** A paste: true when rich text was converted (default prevented). */
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => boolean;
  run: (a: FormatAction) => void;
  help: boolean;
  setHelp: (on: boolean) => void;
}

/** Formatting for a field: what its chat's network displays decides what the shortcuts and the bar write. */
export function useFormatter(ref: RefObject<HTMLTextAreaElement | null>, network: ComposerNetwork | undefined, notify: (message: string) => void): Formatter {
  const t = useT();
  const formatting = network?.formatting;
  const [help, setHelp] = useState(false);
  const plainNext = useRef(false);
  const apple = useRef<boolean | null>(null);

  const run = useCallback(
    (a: FormatAction) => {
      const el = ref.current;
      if (a === 'help') return setHelp(true);
      if (!el || el.readOnly || el.disabled) return;
      const f = featureOf(a);
      if (f && !shows(formatting, f)) {
        const name = network?.name ?? '';
        notify(a === 'link' ? t.format.linkPlain(name) : t.format.unsupported(t.format.names[a as Exclude<FormatAction, 'help'>], name));
        return;
      }
      const ed = editFor(a, el.value, el.selectionStart, el.selectionEnd);
        if (ed && !applyEdit(el, ed)) notify(t.format.tooLong);
    },
    [ref, formatting, network?.name, notify, t],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, opts: { enterSends?: boolean } = {}): boolean => {
    const el = e.currentTarget;
    const n = e.nativeEvent;
    if (n.isComposing) return false;
    apple.current ??= isApple();
    const mod = apple.current ? e.metaKey : e.ctrlKey;
    if (mod && e.shiftKey && !e.altKey && (e.key === 'V' || e.key === 'v' || e.code === 'KeyV')) {
      plainNext.current = true;
      return false;
    }
    const action = shortcutOf(n, apple.current);
    if (action) {
      // Taken even while the field is read-only (a rewrite under way): the browser's own Ctrl+B etc. never run.
      e.preventDefault();
      run(action);
      return true;
    }
    if (el.readOnly) return false;
    const { selectionStart: s, selectionEnd: end, value } = el;
    if (e.key === ' ' && !mod && !e.altKey && s === end) {
      const ed = autoBullet(value, s);
      if (ed) {
        e.preventDefault();
        applyEdit(el, ed);
        return true;
      }
    }
    // A new line in a list: Shift+Enter where Enter sends, Enter where it is a new line (touch keyboards).
    if (e.key === 'Enter' && !mod && !e.altKey && (opts.enterSends ? e.shiftKey : !e.shiftKey)) {
      const ed = continueList(value, s, end);
      if (ed) {
        e.preventDefault();
        applyEdit(el, ed);
        return true;
      }
    }
    return false;
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): boolean => {
    const plain = plainNext.current;
    plainNext.current = false;
    const el = e.currentTarget;
    if (plain || el.readOnly) return false;
    const html = e.clipboardData.getData('text/html');
    if (!html) return false;
    const md = pasteMarkdown(html, e.clipboardData.getData('text/plain'), formatting);
    if (md === undefined) return false;
    e.preventDefault();
    const at = el.selectionStart;
    if (!applyEdit(el, { from: at, to: el.selectionEnd, insert: md, selStart: at + md.length, selEnd: at + md.length })) notify(t.format.tooLong);
    return true;
  };

  // A space about to be typed (touch keyboards send no key event for it, only beforeinput): "- " becomes "• ".
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = (e: InputEvent) => {
      if (e.inputType !== 'insertText' || e.data !== ' ' || el.readOnly || el.selectionStart !== el.selectionEnd) return;
      const ed = autoBullet(el.value, el.selectionStart);
      if (!ed) return;
      e.preventDefault();
      applyEdit(el, ed);
    };
    el.addEventListener('beforeinput', before);
    return () => el.removeEventListener('beforeinput', before);
  }, [ref]);

  return { formatting, onKeyDown, onPaste, run, help, setHelp };
}

/** Where a position of the field's text is drawn, relative to the field's box (a mirror element measures it). */
export function caretPoint(el: HTMLTextAreaElement, pos: number): { left: number; top: number; height: number } {
  const cs = getComputedStyle(el);
  const m = document.createElement('div');
  const copy = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'] as const;
  for (const p of copy) m.style[p] = cs[p];
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', borderStyle: 'solid', overflow: 'hidden' });
  m.style.width = `${el.clientWidth + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0)}px`;
  m.textContent = el.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = el.value.slice(pos, pos + 1) || '.';
  m.appendChild(mark);
  document.body.appendChild(m);
  const out = { left: mark.offsetLeft, top: mark.offsetTop - el.scrollTop, height: mark.offsetHeight };
  m.remove();
  return out;
}

const ICONS: Record<Exclude<FormatAction, 'help'>, ReactNode> = {
  bold: <b>B</b>,
  italic: <i style={{ fontFamily: 'Georgia, serif' }}>I</i>,
  strikethrough: <s>S</s>,
  inline_code: <span className="fmt-mono">{'<>'}</span>,
  code_block: <span className="fmt-mono">{'{}'}</span>,
  blockquote: (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M5 6v12M10 8h9M10 12h9M10 16h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  link: (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  bullet: (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="5" cy="7" r="1.6" fill="currentColor" />
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="5" cy="17" r="1.6" fill="currentColor" />
      <path d="M10 7h10M10 12h10M10 17h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  numbered: (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <text x="2" y="9.5" fontSize="7" fill="currentColor">1</text>
      <text x="2" y="19.5" fontSize="7" fill="currentColor">2</text>
      <path d="M10 7h10M10 12h10M10 17h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

const BAR: readonly Exclude<FormatAction, 'help'>[] = ['bold', 'italic', 'strikethrough', 'inline_code', 'code_block', 'blockquote', 'link', 'bullet', 'numbered'];

/** The actions the bar offers in this chat: what its network displays, and the lists (plain "• " lines). */
export function barActions(formatting: Formatting): Exclude<FormatAction, 'help'>[] {
  return BAR.filter((a) => {
    const f = featureOf(a);
    return !f || shows(formatting, f);
  });
}

export const shortcutLabel = (a: FormatAction, apple: boolean): string | undefined => {
  const s = SHORTCUTS.find((x) => x.action === a);
  if (!s) return undefined;
  return apple ? `⌘${s.shift ? '⇧' : ''}${s.label}` : `Ctrl+${s.shift ? 'Shift+' : ''}${s.label}`;
};

/**
 * The formatting bar: floating over the selection (desktop), or docked above the field (phones, or opened with Aa).
 * Its buttons never take the focus, so the selection and the phone keyboard stay.
 */
export function FormatBar({
  field,
  fmt,
  network,
  docked,
  onClose,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  fmt: Formatter;
  network?: ComposerNetwork;
  docked: boolean;
  onClose?: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Set<InlineFeature>>(new Set());
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const apple = isApple();
  const actions = barActions(fmt.formatting);

  const measure = useCallback(() => {
    const el = field.current;
    if (!el) return;
    setActive(activeAt(el.value, el.selectionStart, el.selectionEnd));
    if (docked) return;
    const p = caretPoint(el, el.selectionStart);
    const w = ref.current?.offsetWidth ?? 240;
    const left = Math.max(0, Math.min(p.left - 12, el.clientWidth - w));
    // Above the selection's first line, inside the field's wrapper (its bottom edge as the reference); a start
    // scrolled out of the field puts the bar at the field's edge.
    const top = Math.min(Math.max(0, p.top), el.clientHeight);
    setPos({ left, bottom: el.offsetHeight - top + 6 });
  }, [field, docked]);

  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    document.addEventListener('selectionchange', measure);
    const el = field.current;
    el?.addEventListener('scroll', measure);
    return () => {
      document.removeEventListener('selectionchange', measure);
      el?.removeEventListener('scroll', measure);
    };
  }, [measure, field]);

  const none = !showsAny(fmt.formatting);
  return (
    <div
      ref={ref}
      className={`format-bar${docked ? ' docked' : ' floating'}`}
      role="toolbar"
      aria-label={t.format.bar}
      data-testid="format-bar"
      style={!docked && pos ? { left: pos.left, bottom: pos.bottom } : undefined}
      onMouseDown={(e) => e.preventDefault()}
    >
      {actions.map((a) => {
        const key = shortcutLabel(a, apple);
        const label = t.format.names[a];
        return (
          <button
            key={a}
            type="button"
            className={`icon-btn fmt-btn${active.has(a as InlineFeature) ? ' on' : ''}`}
            aria-label={label}
            aria-pressed={a in { bold: 1, italic: 1, strikethrough: 1, inline_code: 1 } ? active.has(a as InlineFeature) : undefined}
            title={key ? `${label} (${key})` : label}
            data-testid={`fmt-${a}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              fmt.run(a);
              requestAnimationFrame(measure);
            }}
          >
            {ICONS[a]}
          </button>
        );
      })}
      {none && docked && network && <span className="fmt-note">{t.format.none(network.name)}</span>}
      {!coarsePointer() && (
        <button type="button" className="icon-btn fmt-btn" aria-label={t.format.names.help} title={`${t.format.names.help} (${shortcutLabel('help', apple)})`} data-testid="fmt-help" onClick={() => fmt.setHelp(true)}>
          ?
        </button>
      )}
      {docked && onClose && (
        <button type="button" className="icon-btn fmt-btn fmt-close" aria-label={t.common.close} data-testid="fmt-close" onClick={onClose}>
          ✕
        </button>
      )}
    </div>
  );
}

/** The shortcuts, those this chat's network does not display marked so (Ctrl+/). */
export function FormatHelp({ fmt, network }: { fmt: Formatter; network?: ComposerNetwork }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const apple = isApple();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const rows: { label: string; key: string; off: boolean }[] = SHORTCUTS.filter((s) => s.action !== 'help').map((s) => {
    const f = featureOf(s.action);
    return { label: t.format.names[s.action as Exclude<FormatAction, 'help'>], key: shortcutLabel(s.action, apple)!, off: !!f && !shows(fmt.formatting, f) };
  });
  rows.push({ label: t.format.pastePlain, key: apple ? '⌘⇧V' : 'Ctrl+Shift+V', off: false });
  rows.push({ label: t.format.nextItem, key: apple ? '⇧↩' : 'Shift+Enter', off: false });
  return (
    <dialog ref={ref} className="format-help" data-testid="format-help" onClose={() => fmt.setHelp(false)} onCancel={() => fmt.setHelp(false)}>
      <h2>{t.format.helpTitle}</h2>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.off ? 'off' : undefined}>
              <td>
                {r.label}
                {r.off && network && <span className="fmt-off"> · {t.format.notShownOn(network.name)}</span>}
              </td>
              <td>
                <kbd>{r.key}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fmt-tip">{t.format.markdownTip}</p>
      <form method="dialog">
        <button type="submit" className="text-btn primary" data-testid="format-help-close" autoFocus>
          {t.common.close}
        </button>
      </form>
    </dialog>
  );
}

/**
 * The preview drawn behind the field (desktop): the same text, its marks dimmed and the formatting shown without
 * changing any width, so the field's own (transparent) text keeps the caret and the selection in place.
 */
export function MarkdownPreview({ field, text, formatting }: { field: RefObject<HTMLTextAreaElement | null>; text: string; formatting: Formatting }) {
  const ref = useRef<HTMLDivElement>(null);
  const sync = useCallback(() => {
    const el = field.current;
    const p = ref.current;
    if (!el || !p) return;
    p.style.overflowY = el.style.overflowY || 'hidden';
    p.style.height = `${el.offsetHeight}px`;
    p.scrollTop = el.scrollTop;
  }, [field]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.addEventListener('scroll', sync);
    const ro = 'ResizeObserver' in window ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', sync);
      ro?.disconnect();
    };
  }, [field, sync]);
  // After each change of the text (the field's autosize may change its scrolling without changing its size). An
  // effect, so it runs after the composer's own autosize effect.
  useEffect(sync, [sync, text]);
  return (
    <div ref={ref} className="md-preview" aria-hidden="true">
      {previewSpans(text, formatting).map((s, i) => (s.cls ? <span key={i} className={s.cls}>{s.text}</span> : s.text))}
      {/* A last empty line still takes its height (as in the field). */}
      {text.endsWith('\n') && '​'}
    </div>
  );
}

/** Whether the preview is on for this field: no touch screen as the main pointer, and a network that displays some formatting. */
export const previewOn = (formatting: Formatting): boolean => !coarsePointer() && showsAny(formatting);
