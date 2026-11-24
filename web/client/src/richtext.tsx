import { Fragment, useState, type ReactNode } from 'react';
import { decodeBody, isHtmlBody, isRichText } from '../../server/richtext';
import { useT } from './i18n';

// Safe rendering of message bodies. Rich text (HTML, the canonical model's: server/richtext.ts) is parsed with DOMParser into an
// inert document (no script runs, nothing loads) and mapped through an allowlist to React elements; it is
// never injected as HTML. Plain text is shown literally, with URLs linkified.

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const MATRIX_USER = /^https:\/\/matrix\.to\/#\/@/i;
const DROP = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'noscript', 'mx-reply', 'img', 'video', 'audio', 'input', 'select', 'textarea', 'button']);

export function linkify(text: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function Spoiler({ children }: { children: ReactNode }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <span
      className={`spoiler ${shown ? 'shown' : ''}`}
      role={shown ? undefined : 'button'}
      tabIndex={shown ? undefined : 0}
      aria-label={shown ? undefined : t.msg.spoiler}
      onClick={() => setShown(true)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setShown(true)}
    >
      {children}
    </span>
  );
}

function walk(nodes: NodeListOf<ChildNode>, plain: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((n, i) => {
    if (n.nodeType === Node.TEXT_NODE) {
      let s = n.textContent ?? '';
      // The indent of a line (sub-items written "   • "): kept, where white-space: normal would drop it.
      if (n.previousSibling?.nodeName === 'BR') s = s.replace(/^ +/, (sp) => '\u00a0'.repeat(sp.length));
      out.push(plain ? s : <Fragment key={i}>{linkify(s)}</Fragment>);
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return;
    const kids = () => walk(el.childNodes, plain);
    switch (tag) {
      case 'a': {
        const href = el.getAttribute('href') ?? '';
        if (MATRIX_USER.test(href)) {
          out.push(<span key={i} className="mention">{walk(el.childNodes, true)}</span>);
        } else if (SAFE_HREF.test(href)) {
          out.push(<a key={i} href={href} target="_blank" rel="noopener noreferrer nofollow">{walk(el.childNodes, true)}</a>);
        } else out.push(<Fragment key={i}>{kids()}</Fragment>);
        return;
      }
      case 'b':
      case 'strong':
        out.push(<strong key={i}>{kids()}</strong>);
        return;
      case 'i':
      case 'em':
        out.push(<em key={i}>{kids()}</em>);
        return;
      case 'u':
        out.push(<u key={i}>{kids()}</u>);
        return;
      case 's':
      case 'del':
      case 'strike':
        out.push(<s key={i}>{kids()}</s>);
        return;
      case 'code':
        out.push(<code key={i}>{walk(el.childNodes, true)}</code>);
        return;
      case 'pre':
        out.push(<pre key={i}>{walk(el.childNodes, true)}</pre>);
        return;
      case 'br':
        out.push(<br key={i} />);
        return;
      case 'hr':
        out.push(<hr key={i} />);
        return;
      case 'p':
      case 'div':
        out.push(<p key={i}>{kids()}</p>);
        return;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        out.push(<p key={i} className="rich-h"><strong>{kids()}</strong></p>);
        return;
      case 'blockquote':
        out.push(<blockquote key={i}>{kids()}</blockquote>);
        return;
      case 'ul':
        out.push(<ul key={i}>{kids()}</ul>);
        return;
      case 'ol':
        out.push(<ol key={i}>{kids()}</ol>);
        return;
      case 'li':
        out.push(<li key={i}>{kids()}</li>);
        return;
      case 'sup':
        out.push(<sup key={i}>{kids()}</sup>);
        return;
      case 'sub':
        out.push(<sub key={i}>{kids()}</sub>);
        return;
      case 'span':
        if (el.hasAttribute('data-mx-spoiler')) {
          out.push(<Spoiler key={i}>{kids()}</Spoiler>);
          return;
        }
        out.push(<Fragment key={i}>{kids()}</Fragment>);
        return;
      default:
        // Anything else (font, table, unknown tags): its content only.
        out.push(<Fragment key={i}>{kids()}</Fragment>);
    }
  });
  return out;
}

const cache = new Map<string, ReactNode[]>();

/** Plain text with "@Name" of mentioned users highlighted (Message.mentions), URLs linkified. */
function withMentions(text: string, names: string[]): ReactNode[] {
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(@(?:${esc.join('|')}))`, 'g');
  return text.split(re).map((part, i) => (i % 2 === 1 ? <span key={i} className="mention">{part}</span> : <Fragment key={i}>{linkify(part)}</Fragment>));
}

/** Message body as React nodes (memoized per text: parsing is not free in long chats). */
export function RichText({ text, mentions }: { text: string; mentions?: string[] }): ReactNode {
  if (!isHtmlBody(text)) {
    // Plain text, possibly escaped by the API (and by the bridge before it): decoded, shown literally.
    const plain = isRichText(text) ? decodeBody(text) : text;
    return mentions?.length ? withMentions(plain, mentions) : linkify(plain);
  }
  let nodes = cache.get(text);
  if (!nodes) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    nodes = walk(doc.body.childNodes, false);
    cache.set(text, nodes);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return nodes;
}
