import type { CallEvent } from '../../server/callevent';
import { callFull, callName, callWhen } from './format';
import { useT } from './i18n';
import { RichText } from './richtext';

// A scheduled call (server/callevent.ts) in its bubble: what and when (device time zone, interface
// language), the description as the bridge sent it, and a button that opens the call link.

const VIDEO = 'M4 7.5A1.5 1.5 0 0 1 5.5 6h8A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 16.5zM15 10.5l5-3v9l-5-3z';
export const VOICE =
  'M6.6 3.5h2.8l1.4 4-2 1.5a11 11 0 0 0 6.2 6.2l1.5-2 4 1.4v2.8a1.6 1.6 0 0 1-1.7 1.6A16.5 16.5 0 0 1 5 5.2a1.6 1.6 0 0 1 1.6-1.7z';

export function CallCard({ call }: { call: CallEvent }) {
  const t = useT();
  const kind = call.video ? t.call.video : t.call.voice;
  const when = callWhen(call.start);
  const full = callFull(call.start);
  return (
    <div className="call-card" data-testid="call-card">
      <div className="call-head">
        <span className="call-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d={call.video ? VIDEO : VOICE} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="call-what">
          <div className="call-title">{callName(call)}</div>
          <div className="call-when">
            {call.title ? `${kind} · ` : ''}
            <time dateTime={call.start.toISOString()} title={full} data-testid="call-when">
              {when}
            </time>
          </div>
          {call.location && <div className="call-where">{call.location}</div>}
        </div>
      </div>
      {call.description && (
        <div className={`text call-desc ${call.rich ? 'rich' : ''}`}>
          <RichText text={call.description} />
        </div>
      )}
      <a className="call-join" href={call.link} target="_blank" rel="noopener noreferrer nofollow" aria-label={t.call.joinLabel(callName(call), full)} data-testid="call-join">
        {t.call.join}
      </a>
    </div>
  );
}
