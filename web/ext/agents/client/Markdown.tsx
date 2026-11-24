import { Fragment, type ReactNode } from 'react';

// Hermes answers in Markdown. Small, safe subset rendered to React elements (never injected as HTML):
// fenced code blocks, headings (bold line), `code`, **bold**, *italic* / _italic_, [text](http(s) link) and
// bare links. Everything else stays literal text, line breaks kept.

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]{1,300}\]\((?:https?:\/\/|mailto:)[^\s)]{1,2000}\))|(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]])|((?<![\w*])\*[^*\n]+\*(?![\w*]))|((?<![\w])_[^_\n]+_(?![\w]))/g;

const link = (href: string, text: ReactNode, key: number) => (
  <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
    {text}
  </a>
);

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(<Fragment key={k++}>{text.slice(last, i)}</Fragment>);
    const s = m[0];
    if (m[1]) out.push(<code key={k++}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{inline(s.slice(2, -2))}</strong>);
    else if (m[3]) {
      const j = s.indexOf('](');
      out.push(link(s.slice(j + 2, -1), s.slice(1, j), k++));
    } else if (m[4]) out.push(link(s, s, k++));
    else out.push(<em key={k++}>{s.slice(1, -1)}</em>);
    last = i + s.length;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return out;
}

export function Markdown({ text }: { text: string }) {
  const parts = text.split(/^```[^\n`]*\n?/m);
  // Odd parts are inside a fence (an unclosed fence runs to the end, as while streaming).
  return (
    <div className="md">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="md-code">
            <code>{p.replace(/\n$/, '')}</code>
          </pre>
        ) : (
          <div key={i} className="md-text">
            {p
              .replace(/^\n+|\n+$/g, '')
              .split('\n')
              .map((line, j, all) => {
                const h = /^#{1,6}\s+(.*)$/.exec(line);
                const body = h ? <strong>{inline(h[1]!)}</strong> : inline(line.replace(/^(\s*)[*-]\s+/, '$1• '));
                return (
                  <Fragment key={j}>
                    {body}
                    {j < all.length - 1 ? '\n' : null}
                  </Fragment>
                );
              })}
          </div>
        ),
      )}
    </div>
  );
}
