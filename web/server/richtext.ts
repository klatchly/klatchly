// Message text in the canonical model (the Desktop API's shapes, which every connector converts to) is plain text,
// or "rich text" (HTML, as Beeper gives it) when the body had formatting, links or mentions (outgoing Markdown is
// converted that way too). Pure functions shared by
// the server (push bodies) and the client (previews, quotes, search); the client renders the HTML itself
// with a DOM allowlist (client/src/richtext.tsx).

/** Tags we render; their presence is what marks a body as HTML (plain "a < b" stays literal). */
export const RICH_TAGS = ['a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'code', 'pre', 'br', 'p', 'blockquote', 'ul', 'ol', 'li', 'span', 'sup', 'sub', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'font', 'div'];
// Well-formed tags only (attributes as name="value"), so code like "if (a<b && c>d)" is not HTML.
const TAG = `<(?:${RICH_TAGS.join('|')})(?:\\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\\s*=\\s*"[^"<>]*")?)*\\s*\\/?>|</(?:${RICH_TAGS.join('|')})\\s*>`;
const RICH_RE = new RegExp(TAG, 'i');
// Any well-formed tag (custom emoji <img>, <mx-reply>, tables...) for the stray "<" check.
const ANY_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*"[^"<>]*")?)*\s*\/?>/g;

// The server returns sent text HTML-escaped even without any tag ("a &lt; b").
const ENTITY_RE = /&(?:lt|gt|amp|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/i;

/** HTML from the API escapes "<" in text: a body is HTML only if every "<" opens a well-formed tag. */
export function isRichText(s: string | null | undefined): boolean {
  return !!s && (RICH_RE.test(s) || ENTITY_RE.test(s)) && !s.replace(ANY_TAG, '').includes('<');
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', bdquo: '„', euro: '€', trade: '™', bull: '•', laquo: '«', raquo: '»',
};
// Latin-1 named entities (U+00A0..U+00FF), in code point order.
'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
  .split(' ')
  .forEach((n, i) => (NAMED[n] ??= String.fromCharCode(0xa0 + i)));

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

/**
 * Whether a body is markup to render as HTML. A rich body without any tag is plain text the API escaped
 * ("Tom &amp; Jerry"): its line breaks are "\n", which HTML rendering would collapse.
 */
export function isHtmlBody(s: string | null | undefined): boolean {
  return isRichText(s) && s!.includes('<');
}

// An entity whose "&" is itself escaped: the bridge escaped the text before the API did (WeChat Channels shares
// arrive as "F&amp;amp;S").
const DOUBLE_ESCAPED = /&amp;(?:lt|gt|amp|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/i;

/** Entities of a body decoded, twice when the body was escaped twice. */
export function decodeBody(s: string): string {
  const once = decodeEntities(s);
  return DOUBLE_ESCAPED.test(s) ? decodeEntities(once) : once;
}

/** Plain text of a message body (HTML tags removed, line breaks kept, entities decoded). */
export function toPlainText(s: string | null | undefined): string {
  if (!s) return '';
  if (!isRichText(s)) return s;
  if (!s.includes('<')) return decodeBody(s).trim();
  const text = s
    .replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|pre|h[1-6])>/gi, '\n')
    .replace(/<li(\s[^<>]*)?>/gi, '• ')
    .replace(/<[^<>]*>/g, '');
  return decodeBody(text).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * One-line summary of a body (list previews, quotes, push): plain text, and Markdown heading marks dropped (list
 * previews come as Markdown) unless the body has code, where a leading "#" is content.
 */
export function oneLine(s: string | null | undefined): string {
  const text = toPlainText(s);
  const code = !!s && (/<(pre|code)[\s>]/i.test(s) || s.includes('```'));
  return (code ? text : text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')).replace(/\s+/g, ' ').trim();
}
