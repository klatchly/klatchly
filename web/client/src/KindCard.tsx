import { toPlainText } from '../../server/richtext';
import { VOICE } from './CallCard';
import { useT } from './i18n';
import type { Message } from './types';

// A message of a kind with no body of its own (server/msgkind.ts) in its bubble, with the scheduled call card's
// head: a mark, its kind, its detail (a contact's name and number, one per line) and, for a call or a message the
// connector cannot show, where to act on it.

const CONTACT = 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0';
const PIN = 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z';
const INFO = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5v.5';
const MARK: Record<string, string> = { CALL: VOICE, CALL_MISSED: VOICE, CONTACT, LOCATION: PIN };

// The catalog's labels start with an emoji for one-line places; the card has its own mark.
const bare = (label: string) => label.replace(/^\p{Extended_Pictographic}️?\s*/u, '');

export function KindCard({ m }: { m: Message }) {
  const t = useT();
  const type = m.type ?? 'UNSUPPORTED';
  const label = (t.types as Record<string, string>)[type] ?? t.types.UNSUPPORTED;
  const detail = toPlainText(m.text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const hint = type === 'CALL' || type === 'CALL_MISSED' ? t.msg.callHint : type === 'UNSUPPORTED' ? t.msg.unsupportedHint : '';
  return (
    <div className={`call-card kind-card ${type.toLowerCase()}`} data-testid="kind-card" data-kind={type}>
      <div className="call-head">
        <span className="call-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d={MARK[type] ?? INFO} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="call-what">
          <div className="call-title">{bare(label)}</div>
          {detail.map((l, i) => (
            <div key={i} className="kind-detail">
              {l}
            </div>
          ))}
          {hint && <div className="kind-hint">{hint}</div>}
        </div>
      </div>
    </div>
  );
}
