import { decodeEntities } from '../../server/richtext.js';

// Formatting in the composer, kept as the Markdown the rest of the chain already speaks: beeper-server renders it,
// connectors convert it for their networks, the ✨ rewrites shape it for the chat's network
// (ext/writing/server/assist.ts formatRule). The shortcuts and the formatting bar write the same marks as that rule
// (**bold**, _italic_, ~~strike~~, `code`, ``` blocks, "> " quotes, [text](url)), and only those the chat's network
// displays. Pasted rich text and the HTML of a message being edited come back as that Markdown too. Plain functions
// (tested without a browser): the composer applies their edits to the field.

export type Feature = 'bold' | 'italic' | 'strikethrough' | 'inline_code' | 'code_block' | 'blockquote' | 'headers' | 'inline_link';
/** A network's formatting (ComposerNetwork.formatting; 2 = displayed). Undefined: it displays all the Markdown. */
export type Formatting = Readonly<Record<string, number>> | undefined;

export const FEATURES: readonly Feature[] = ['bold', 'italic', 'strikethrough', 'inline_code', 'code_block', 'blockquote', 'headers', 'inline_link'];

/** Whether the network shows this formatting (the same test as formatRule: full support). */
export function shows(formatting: Formatting, f: Feature): boolean {
  return !formatting || (formatting[f] ?? 0) >= 2;
}

/** Whether it shows any of it (no formatting bar buttons but the lists otherwise). */
export function showsAny(formatting: Formatting): boolean {
  return FEATURES.some((f) => shows(formatting, f));
}

export const MARKS = { bold: '**', italic: '_', strikethrough: '~~', inline_code: '`' } as const;
export type InlineFeature = keyof typeof MARKS;

/** A change to the field: replace [from, to) with `insert`, then select [selStart, selEnd) (positions after it). */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

const WORDCH = /[\p{L}\p{N}]/u;
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
const lineStart = (v: string, i: number) => (i <= 0 ? 0 : v.lastIndexOf('\n', i - 1) + 1);
const lineEnd = (v: string, i: number) => {
  const n = v.indexOf('\n', i);
  return n < 0 ? v.length : n;
};

/** The edit that turns [from, to) into `next`, with the whole new text selected (or a caret at `caret`). */
function replace(from: number, to: number, next: string, sel?: [number, number]): TextEdit {
  const [a, b] = sel ?? [from, from + next.length];
  return { from, to, insert: next, selStart: a, selEnd: b };
}

/**
 * Bold, italic, strikethrough or code on the selection, or off when it already has it. No selection: the pair of
 * marks with the caret between. Spaces at the ends stay outside the marks ("**word **" shows the stars), and each
 * line of a selection over several lines gets its own (an inline mark never spans lines).
 */
export function toggleInline(value: string, start: number, end: number, f: InlineFeature): TextEdit {
  const mark = MARKS[f];
  const m = mark.length;
  if (start === end) {
    // Between an empty pair just typed: take it away again.
    if (value.slice(start - m, start) === mark && value.slice(start, start + m) === mark) return replace(start - m, start + m, '', [start - m, start - m]);
    return replace(start, end, mark + mark, [start + m, start + m]);
  }
  let s = start;
  let e = end;
  while (s < e && isSpace(value[s])) s++;
  while (e > s && isSpace(value[e - 1])) e--;
  if (s === e) return replace(start, end, value.slice(start, end), [start, end]);
  // "_" inside a word is no italic (snake_case): the whole words then.
  if (mark === '_') {
    const inWord = (c: string | undefined) => !!c && (WORDCH.test(c) || c === '_');
    if (inWord(value[s - 1]) && inWord(value[s])) while (s > 0 && inWord(value[s - 1])) s--;
    if (inWord(value[e]) && inWord(value[e - 1])) while (e < value.length && inWord(value[e])) e++;
  }
  const sel = value.slice(s, e);
  // Marks just around the selection, or the selection's own ends: only when they are this pair.
  if (!sel.includes('\n')) {
    if (pairAround(value, s, e, mark)) return replace(s - m, e + m, sel, [s - m, e - m]);
    if (ownPair(sel, mark)) return replace(s, e, sel.slice(m, -m));
    return replace(s, e, mark + sel + mark, [s + m, e + m]);
  }
  const lines = sel.split('\n');
  const marked = (l: string) => ownPair(l.trim(), mark);
  const filled = lines.filter((l) => l.trim());
  const off = filled.length > 0 && filled.every(marked);
  const out = lines
    .map((l) => {
      if (!l.trim()) return l;
      const lead = /^\s*/.exec(l)![0];
      const trail = /\s*$/.exec(l)![0];
      const core = l.slice(lead.length, l.length - trail.length);
      return lead + (off ? core.slice(m, -m) : mark + core + mark) + trail;
    })
    .join('\n');
  return replace(s, e, out);
}

/** The selection starts and ends with the mark, and those are one pair ("**a** b **c**" is two). */
function ownPair(sel: string, mark: string): boolean {
  const m = mark.length;
  return sel.length > 2 * m && sel.startsWith(mark) && sel.endsWith(mark) && !sel.slice(m, -m).includes(mark) && (m > 1 || (sel[m] !== mark && sel[sel.length - m - 1] !== mark));
}

/** The mark just before and just after [s, e) is a pair of its own (not half of "**", not inside a word). */
function pairAround(v: string, s: number, e: number, mark: string): boolean {
  const m = mark.length;
  if (v.slice(s - m, s) !== mark || v.slice(e, e + m) !== mark || v.slice(s, e).includes(mark)) return false;
  if (m === 1 && (v[s - m - 1] === mark || v[e + m] === mark)) return false;
  if (mark === '_' && (WORDCH.test(v[s - m - 1] ?? '') || WORDCH.test(v[e + m] ?? ''))) return false;
  return true;
}

export type LineFeature = 'blockquote' | 'bullet' | 'numbered';
const BULLET = '• ';
const NUMBERED = /^(\s*)(\d{1,3})[.)] /;
const BULLETED = /^(\s*)[•◦▪‣·] /;

/** Quote, bulleted or numbered lines on the selected lines (whole lines), or off when they all have it. */
export function toggleLines(value: string, start: number, end: number, f: LineFeature): TextEdit {
  const from = lineStart(value, start);
  const to = lineEnd(value, end > start && value[end - 1] === '\n' ? end - 1 : end);
  const lines = value.slice(from, to).split('\n');
  const filled = lines.filter((l) => l.trim());
  const has = (l: string) => (f === 'blockquote' ? /^\s*>/.test(l) : f === 'bullet' ? BULLETED.test(l) : NUMBERED.test(l));
  const off = filled.length > 0 && filled.every(has);
  let n = 0;
  const out = lines.map((l) => {
    if (off) {
      if (f === 'blockquote') return l.replace(/^(\s*)> ?/, '$1');
      return l.replace(f === 'bullet' ? BULLETED : NUMBERED, '$1');
    }
    // A quote keeps its blank lines inside it; a list skips them.
    if (!l.trim() && lines.length > 1) return f === 'blockquote' ? '>' : l;
    if (f === 'blockquote') return `> ${l}`;
    const bare = l.replace(BULLETED, '$1').replace(NUMBERED, '$1');
    const lead = /^\s*/.exec(bare)![0];
    return lead + (f === 'bullet' ? BULLET : `${++n}. `) + bare.slice(lead.length);
  });
  // A line right after a quote or a numbered list is taken into it: a blank line before the text that follows.
  const following = value.slice(to + 1, lineEnd(value, to + 1));
  const post = !off && f !== 'bullet' && to < value.length && following.trim() ? '\n' : '';
  const next = out.join('\n') + post;
  if (start === end && !off && !lines.join('').trim()) {
    // An empty line: the marker, then the caret after it.
    return replace(from, to, next, [from + next.length - post.length, from + next.length - post.length]);
  }
  return replace(from, to, next, [from, from + next.length - post.length]);
}

/** A code block around the selected lines (or an empty one with the caret inside), or off when fenced already. */
export function toggleCodeBlock(value: string, start: number, end: number): TextEdit {
  const from = lineStart(value, start);
  const to = lineEnd(value, end > start && value[end - 1] === '\n' ? end - 1 : end);
  const body = value.slice(from, to);
  const fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(body);
  if (fenced && !/^```/m.test(fenced[1]!)) return replace(from, to, fenced[1]!);
  const before = value.slice(Math.max(0, from - 4), from);
  const after = value.slice(to, to + 4);
  if (before === '```\n' && after === '\n```') return replace(from - 4, to + 4, body);
  // A line right after a block is taken into it: blank lines around (formatRule says the same to the model).
  const pre = from > 0 && value[from - 2] !== '\n' && value.slice(0, from).trim() ? '\n' : '';
  const post = to < value.length && value[to + 1] !== '\n' && value.slice(to).trim() ? '\n' : '';
  if (!body.trim()) {
    const next = `${pre}\`\`\`\n${body}\n\`\`\`${post}`;
    const caret = from + pre.length + 4 + body.length;
    return replace(from, to, next, [caret, caret]);
  }
  const next = `${pre}\`\`\`\n${body}\n\`\`\`${post}`;
  return replace(from, to, next, [from + pre.length + 4, from + pre.length + 4 + body.length]);
}

const URL_RE = /^(https?:\/\/|mailto:)\S+$/i;

/**
 * A link: [text](url), with the caret where the missing part goes (the URL after a text, the text before a pasted
 * URL). Where the network shows no link on a text, a bare URL is what works: the caller says so instead.
 */
export function insertLink(value: string, start: number, end: number): TextEdit {
  let s = start;
  let e = end;
  while (s < e && isSpace(value[s])) s++;
  while (e > s && isSpace(value[e - 1])) e--;
  const sel = value.slice(s, e);
  if (sel && URL_RE.test(sel)) return replace(s, e, `[](${sel})`, [s + 1, s + 1]);
  const next = `[${sel}]()`;
  const caret = s + sel.length + 3;
  return replace(s, e, next, [caret, caret]);
}

/** Inside a ``` block at this position (no auto-bullets, lists or preview marks there). */
export function inCodeBlock(value: string, pos: number): boolean {
  const fences = value.slice(0, lineStart(value, pos)).match(/^```/gm);
  return !!fences && fences.length % 2 === 1;
}

/** "- " or "* " typed at the start of a line becomes "• " (Markdown lists show badly on most networks, formatRule). */
export function autoBullet(value: string, caret: number): TextEdit | undefined {
  const from = lineStart(value, caret);
  const m = /^(\s*)[-*]$/.exec(value.slice(from, caret));
  if (!m || inCodeBlock(value, caret)) return undefined;
  const next = `${m[1]}${BULLET}`;
  return replace(from, caret, next, [from + next.length, from + next.length]);
}

/**
 * A new line in a list: the next item's marker (same indent; the next number); on an empty item, the marker goes and
 * the list ends. Undefined: not in a list item, a plain new line.
 */
export function continueList(value: string, start: number, end: number): TextEdit | undefined {
  if (start !== end || inCodeBlock(value, start)) return undefined;
  const from = lineStart(value, start);
  const to = lineEnd(value, start);
  const line = value.slice(from, to);
  const bullet = BULLETED.exec(line);
  const num = NUMBERED.exec(line);
  const marker = bullet?.[0] ?? num?.[0];
  if (!marker || start < from + marker.length) return undefined;
  if (!line.slice(marker.length).trim()) return replace(from, to, '', [from, from]);
  const lead = (bullet ?? num)![1]!;
  const next = bullet ? `${lead}${bullet[0].slice(lead.length)}` : `${lead}${Number(num![2]) + 1}. `;
  const insert = `\n${next}`;
  return replace(start, start, insert, [start + insert.length, start + insert.length]);
}

// --- Keyboard ----------------------------------------------------------------------------------------------------

export type FormatAction = InlineFeature | 'code_block' | 'blockquote' | 'link' | 'bullet' | 'numbered' | 'help';

export interface KeyLike {
  code: string;
  key?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The shortcuts (Ctrl, or ⌘ on Apple), by physical key so they stay put on any layout. */
export const SHORTCUTS: readonly { action: FormatAction; code: string; shift: boolean; label: string }[] = [
  { action: 'bold', code: 'KeyB', shift: false, label: 'B' },
  { action: 'italic', code: 'KeyI', shift: false, label: 'I' },
  { action: 'strikethrough', code: 'KeyX', shift: true, label: 'X' },
  { action: 'inline_code', code: 'KeyE', shift: false, label: 'E' },
  { action: 'code_block', code: 'KeyE', shift: true, label: 'E' },
  { action: 'blockquote', code: 'Digit9', shift: true, label: '9' },
  { action: 'link', code: 'KeyK', shift: false, label: 'K' },
  { action: 'bullet', code: 'Digit8', shift: true, label: '8' },
  { action: 'numbered', code: 'Digit7', shift: true, label: '7' },
  { action: 'help', code: 'Slash', shift: false, label: '/' },
];

/** The formatting action of a key press, if it is one of the shortcuts (Ctrl on Windows/Linux, ⌘ on Apple). */
export function shortcutOf(e: KeyLike, apple: boolean): FormatAction | undefined {
  const mod = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return undefined;
  // "/" wherever the layout puts it (Shift+: on AZERTY, Shift+7 on QWERTZ), and the keypad's.
  if (e.key === '/' || e.code === 'NumpadDivide') return 'help';
  // Letters by the letter typed (Ctrl+C stays copy on Dvorak, where C is on the I key); by key position only
  // where the layout types no Latin letter (Cyrillic, Greek…).
  const latin = !!e.key && /^[a-z]$/i.test(e.key);
  return SHORTCUTS.find((s) => {
    if (s.shift !== e.shiftKey || s.action === 'help') return false;
    if (s.code.startsWith('Key')) return latin ? e.key!.toLowerCase() === s.label.toLowerCase() : s.code === e.code;
    return s.code === e.code;
  })?.action;
}

/** The feature an action needs the network to display (lists need none: "• " lines show everywhere). */
export function featureOf(a: FormatAction): Feature | undefined {
  if (a === 'link') return 'inline_link';
  if (a === 'bullet' || a === 'numbered' || a === 'help') return undefined;
  return a;
}

/** The edit of an action on the field's text and selection (help: none). */
export function editFor(a: FormatAction, value: string, start: number, end: number): TextEdit | undefined {
  switch (a) {
    case 'bold':
    case 'italic':
    case 'strikethrough':
    case 'inline_code':
      return toggleInline(value, start, end, a);
    case 'code_block':
      return toggleCodeBlock(value, start, end);
    case 'blockquote':
      return toggleLines(value, start, end, 'blockquote');
    case 'bullet':
    case 'numbered':
      return toggleLines(value, start, end, a);
    case 'link':
      return insertLink(value, start, end);
    default:
      return undefined;
  }
}

/** Which inline formatting the selection sits in (the bar's pressed buttons). */
export function activeAt(value: string, start: number, end: number): Set<InlineFeature> {
  const on = new Set<InlineFeature>();
  for (const f of Object.keys(MARKS) as InlineFeature[]) {
    const mark = MARKS[f];
    if (start < end && (pairAround(value, start, end, mark) || ownPair(value.slice(start, end), mark))) on.add(f);
  }
  return on;
}

// --- Live preview -----------------------------------------------------------------------------------------------

export type Span = { text: string; cls?: string };

/**
 * The field's text cut into styled pieces for the preview drawn behind it (desktop): marks dimmed, the formatting
 * shown without changing any width (the field's own text gives the caret its place). Only what the network displays;
 * the rest stays plain. Matches the usual Markdown cases, not every corner of it.
 */
export function previewSpans(value: string, formatting: Formatting): Span[] {
  const out: Span[] = [];
  const lines = value.split('\n');
  let fence = false;
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : '';
    if (/^```/.test(line)) {
      if (shows(formatting, 'code_block')) {
        out.push({ text: line, cls: 'md-mark' }, { text: nl });
        fence = !fence;
        return;
      }
    }
    if (fence) {
      out.push({ text: line, cls: 'md-pre' }, { text: nl });
      return;
    }
    let rest = line;
    let lineCls: string | undefined;
    const quote = /^(\s*>\s?)/.exec(rest);
    if (quote && shows(formatting, 'blockquote')) {
      out.push({ text: quote[1]!, cls: 'md-mark' });
      rest = rest.slice(quote[1]!.length);
      lineCls = 'md-quote';
    }
    const head = /^(#{1,6} )/.exec(rest);
    if (head && shows(formatting, 'headers')) {
      out.push({ text: head[1]!, cls: 'md-mark' });
      rest = rest.slice(head[1]!.length);
      lineCls = 'md-bold';
    }
    for (const s of inlineSpans(rest, formatting)) out.push(lineCls ? { text: s.text, cls: [lineCls, s.cls].filter(Boolean).join(' ') } : s);
    if (nl) out.push({ text: nl });
  });
  return out;
}

function inlineSpans(s: string, formatting: Formatting): Span[] {
  const marks: [Feature, string, string][] = [
    ['inline_code', '`', 'md-code'],
    ['bold', '**', 'md-bold'],
    ['bold', '__', 'md-bold'],
    ['strikethrough', '~~', 'md-strike'],
    ['italic', '_', 'md-italic'],
    ['italic', '*', 'md-italic'],
  ];
  const out: Span[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ text: plain });
    plain = '';
  };
  let i = 0;
  outer: while (i < s.length) {
    // [text](url)
    if (s[i] === '[' && shows(formatting, 'inline_link')) {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ text: '[', cls: 'md-mark' }, { text: m[1]!, cls: 'md-link' }, { text: `](${m[2]})`, cls: 'md-mark' });
        i += m[0].length;
        continue;
      }
    }
    for (const [f, mark, cls] of marks) {
      if (!s.startsWith(mark, i) || !shows(formatting, f)) continue;
      const after = s[i + mark.length];
      if (!after || isSpace(after) || (mark.length === 1 && after === mark)) continue;
      if (f !== 'inline_code' && i > 0 && WORDCH.test(s[i - 1]!) && mark[0] === '_') continue;
      let j = s.indexOf(mark, i + mark.length + 1);
      while (j > 0 && (isSpace(s[j - 1]) || (mark.length === 1 && f !== 'inline_code' && s[j + 1] === mark) || (mark[0] === '_' && WORDCH.test(s[j + mark.length] ?? '')))) j = s.indexOf(mark, j + 1);
      if (j < 0) continue;
      flush();
      const inner = s.slice(i + mark.length, j);
      out.push({ text: mark, cls: 'md-mark' });
      if (f === 'inline_code') out.push({ text: inner, cls: cls });
      else for (const sp of inlineSpans(inner, formatting)) out.push({ text: sp.text, cls: [cls, sp.cls].filter(Boolean).join(' ') });
      out.push({ text: mark, cls: 'md-mark' });
      i = j + mark.length;
      continue outer;
    }
    plain += s[i];
    i++;
  }
  flush();
  return out;
}

// --- HTML → Markdown ----------------------------------------------------------------------------------------------

type HNode = { tag: string; attrs: Record<string, string>; kids: HNode[] } | string;

const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'wbr', 'col', 'source', 'base', 'area']);
const SKIP = new Set(['style', 'script', 'head', 'title', 'template', 'mx-reply', 'noscript', 'svg', 'math']);
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+|</;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** A forgiving HTML parse (what clipboards and bridges give): unknown tags kept, unclosed ones closed by their parent. */
function parseHtml(html: string): HNode[] {
  const root: HNode = { tag: '#root', attrs: {}, kids: [] };
  const stack: Exclude<HNode, string>[] = [root];
  let skip = 0;
  const re = new RegExp(TOKEN.source, 'gy');
  let m: RegExpExecArray | null;
  while (re.lastIndex < html.length && (m = re.exec(html))) {
    const tok = m[0];
    const top = stack[stack.length - 1]!;
    if (m[2]) {
      const tag = m[2].toLowerCase();
      if (m[1]) {
        const at = stack.map((n) => n.tag).lastIndexOf(tag);
        if (at > 0) {
          for (let k = stack.length - 1; k >= at; k--) if (SKIP.has(stack[k]!.tag)) skip--;
          stack.length = at;
        }
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? '').matchAll(ATTR)) attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      // A new <li>/<p> closes the one still open (HTML's implied ends).
      if ((tag === 'li' || tag === 'p') && top.tag === tag) stack.pop();
      const node = { tag, attrs, kids: [] };
      stack[stack.length - 1]!.kids.push(node);
      if (VOID.has(tag) || tok.endsWith('/>')) continue;
      stack.push(node);
      if (SKIP.has(tag)) skip++;
      continue;
    }
    if (tok.startsWith('<!') || tok.startsWith('<?')) continue;
    if (!skip) top.kids.push(tok);
  }
  return root.kids;
}

interface Ctx {
  formatting: Formatting;
  /** Whitespace in text is layout (a web page) rather than content (a chat message's HTML). */
  collapse: boolean;
  /** A message being edited: what the network does not show comes back as its text, with nothing added. */
  edit: boolean;
  decode: (s: string) => string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  pre: boolean;
  depth: number;
}

const style = (n: Exclude<HNode, string>, prop: string): string | undefined => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(n.attrs.style ?? '');
  return m?.[1]?.trim().toLowerCase();
};
const boldWeight = (w: string | undefined) => (w === undefined ? undefined : w === 'bold' || w === 'bolder' || (/^\d+$/.test(w) && Number(w) >= 600));

/** Marks around inline content, the spaces at its ends left outside, per line. */
function wrapMark(s: string, mark: string): string {
  return s
    .split('\n')
    .map((l) => {
      const core = l.trim();
      if (!core) return l;
      const lead = /^\s*/.exec(l)![0];
      const trail = /\s*$/.exec(l)![0];
      return `${lead}${mark}${core}${mark}${trail}`;
    })
    .join('\n');
}

const BLOCK = '\u0001';
const PARA = '\u0002';

function render(nodes: HNode[], ctx: Ctx): string {
  let out = '';
  let afterBr = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      let text = ctx.decode(node);
      // "<br>\n" (Markdown renderers write both): one line break.
      if (afterBr && !ctx.collapse) text = text.replace(/^\r?\n/, '');
      out += ctx.pre || !ctx.collapse ? text.replace(/\r\n?/g, '\n') : text.replace(/[ \t\r\n\f]+/g, ' ');
      afterBr = false;
      continue;
    }
    out += renderEl(node, ctx);
    afterBr = node.tag === 'br';
  }
  return out;
}

function renderEl(el: Exclude<HNode, string>, ctx: Ctx): string {
  const f = ctx.formatting;
  const tag = el.tag;
  const kids = (c: Partial<Ctx> = {}) => render(el.kids, { ...ctx, ...c });
  if (SKIP.has(tag)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'img') return el.attrs.alt ?? '';
  if (tag === 'hr') return PARA;
  // Word's list bullets ("·" in a mso-list:Ignore span): the item gets "• " from its paragraph instead.
  if ((el.attrs.style ?? '').toLowerCase().includes('mso-list:ignore')) return '';
  if (ctx.pre) return kids();
  if (tag === 'pre') {
    const body = render(el.kids, { ...ctx, pre: true }).replace(/\n+$/, '');
    const code = el.kids.find((k): k is Exclude<HNode, string> => typeof k !== 'string' && k.tag === 'code');
    const lang = /(?:^|\s)language-([\w+#-]{1,20})/.exec(code?.attrs.class ?? '')?.[1] ?? '';
    return PARA + (shows(f, 'code_block') ? `\`\`\`${lang}\n${body}\n\`\`\`` : body) + PARA;
  }
  if (tag === 'code') {
    const body = kids({ code: true });
    if (!shows(f, 'inline_code') || ctx.code || !body.trim()) return body;
    // A backtick inside: a longer fence, with spaces (CommonMark).
    return body.includes('`') ? `\`\` ${body} \`\`` : wrapMark(body, '`');
  }
  if (tag === 'a') {
    const text = kids();
    const href = el.attrs.href ?? '';
    // A mention pill (Matrix): its name, as the composer shows mentions.
    if (/^https:\/\/matrix\.to\/#\/[@!#]/i.test(href) || !/^(https?:|mailto:)/i.test(href) || !text.trim()) return text;
    const bare = href.replace(/^mailto:/i, '');
    if (text.trim() === href || text.trim() === bare) return text;
    if (shows(f, 'inline_link')) return `[${text.trim()}](${href})`;
    return ctx.edit ? text : `${text.trim()} (${bare})`;
  }
  if (/^h[1-6]$/.test(tag)) {
    const body = kids({ bold: true }).trim();
    const line = shows(f, 'headers') ? `${'#'.repeat(Number(tag[1]))} ${body}` : shows(f, 'bold') && !ctx.bold ? wrapMark(body, '**') : body;
    return PARA + line + PARA;
  }
  if (tag === 'blockquote') {
    const body = tidy(kids());
    if (!body) return '';
    const q = shows(f, 'blockquote')
      ? body
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n')
      : ctx.edit
        ? body
        : `“${body}”`;
    return PARA + q + PARA;
  }
  if (tag === 'ul' || tag === 'ol') {
    const start = Number(el.attrs.start) || 1;
    let i = 0;
    const items = el.kids
      .filter((k) => typeof k !== 'string' || !!k.trim())
      .map((k) => {
        if (typeof k === 'string') return k.trim();
        const isItem = k.tag === 'li';
        const body = tidy(render(isItem ? k.kids : [k], { ...ctx, depth: ctx.depth + 1 })).replace(/\n{2,}(?=\s*(?:• |\d+\. ))/g, '\n');
        if (!isItem) return body;
        const marker = tag === 'ol' ? `${start + i++}. ` : BULLET;
        const pad = ' '.repeat(marker.length);
        return marker + body.split('\n').map((l, j) => (j && l && !/^\s*(?:• |\d+\. )/.test(l) ? pad + l : l)).join('\n');
      })
      .filter(Boolean);
    const indent = '   '.repeat(ctx.depth);
    const list = items.map((it) => it.split('\n').map((l) => (l ? indent + l : l)).join('\n')).join('\n');
    // A nested list: on the line after its item's text, with no blank line.
    return ctx.depth ? `\n${list}` : PARA + list + PARA;
  }
  if (tag === 'li') return BLOCK + BULLET + tidy(kids()) + BLOCK;

  // Inline formatting, by tag or style (Google Docs: <span style="font-weight:700">, and a whole paste wrapped in
  // <b style="font-weight:normal">).
  const weight = boldWeight(style(el, 'font-weight'));
  const fstyle = style(el, 'font-style');
  const deco = `${style(el, 'text-decoration') ?? ''} ${style(el, 'text-decoration-line') ?? ''}`;
  const bold = weight ?? (tag === 'b' || tag === 'strong');
  const italic = fstyle ? fstyle === 'italic' || fstyle === 'oblique' : tag === 'i' || tag === 'em';
  const strike = deco.includes('line-through') || tag === 's' || tag === 'del' || tag === 'strike';
  let body = kids({ bold: ctx.bold || bold, italic: ctx.italic || italic, strike: ctx.strike || strike });
  if (strike && !ctx.strike && shows(f, 'strikethrough')) body = wrapMark(body, '~~');
  if (italic && !ctx.italic && shows(f, 'italic')) body = wrapMark(body, '_');
  if (bold && !ctx.bold && shows(f, 'bold')) body = wrapMark(body, '**');

  if (tag === 'p') {
    const tight = /margin-bottom:\s*0(?:pt|px|em)?(?:;|\s|$)/i.test(el.attrs.style ?? '');
    const cls = el.attrs.class ?? '';
    // Word's list paragraphs.
    if (/MsoListParagraph/i.test(cls)) return BLOCK + BULLET + tidy(body) + BLOCK;
    return (tight ? BLOCK : PARA) + body + (tight ? BLOCK : PARA);
  }
  if (tag === 'tr') return BLOCK + body.trim() + BLOCK;
  if (tag === 'td' || tag === 'th') return `${body.trim()} `;
  if (/^(div|section|article|header|footer|main|aside|nav|figure|figcaption|table|tbody|thead|tfoot|dl|dt|dd|address|center|details|summary)$/.test(tag)) return BLOCK + body + BLOCK;
  return body;
}

/** Block breaks resolved: a paragraph is a blank line, a block one line break; spaces at line ends dropped. */
function tidy(s: string): string {
  return s
    .replace(/[ \t]*([\u0001\u0002])[ \t]*/g, '$1')
    .replace(/^[\u0001\u0002\n]+|[\u0001\u0002\n]+$/g, '')
    .replace(/(?:\n*[\u0001\u0002]\n*)+/g, (run) => (run.includes(PARA) || /\n\n/.test(run) ? '\n\n' : '\n'))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * HTML as Markdown for the field: a message's body (edit) or a paste. Only what the network displays comes as
 * Markdown, the rest as text the way formatRule tells the model (a heading a line in bold, a list "• " lines, a quote
 * in quotation marks, a link "text (url)"). `collapse`: HTML whitespace is layout (pastes from the web), not content.
 */
export function htmlToMarkdown(html: string, formatting: Formatting, opts: { collapse?: boolean; edit?: boolean } = {}): string {
  // Entities decoded as the message itself shows them (twice when a bridge escaped the text twice).
  const double = !opts.collapse && /&amp;(?:lt|gt|amp|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/i.test(html);
  const decode = (t: string) => (double ? decodeEntities(decodeEntities(t)) : decodeEntities(t));
  const ctx: Ctx = { formatting, collapse: !!opts.collapse, edit: !!opts.edit, decode, bold: false, italic: false, strike: false, code: false, pre: false, depth: 0 };
  return tidy(render(parseHtml(html), ctx)).trim();
}

/** Whether a paste's HTML brings any formatting the field would keep (else the browser's own plain paste is fine). */
export function pasteMarkdown(html: string, plain: string, formatting: Formatting): string | undefined {
  if (!html.trim()) return undefined;
  // Code from an editor (VS Code: lines of colored spans in a white-space: pre box): the plain text is the right paste.
  if (/white-space\s*:\s*pre/i.test(html)) return undefined;
  const md = htmlToMarkdown(html, formatting, { collapse: true });
  if (!md) return undefined;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(md) === norm(plain) ? undefined : md;
}
