import type { ChannelsShare } from '../../server/wechatshare';
import { useT } from './i18n';
import { linkify } from './richtext';

// A WeChat Channels video shared in a chat (server/wechatshare.ts), with the scheduled call card's head: who
// posted it, its description as the bridge sent it, and where to watch it (the bridge gives no video nor link).

const PLAY = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM10 8.5v7l5.5-3.5z';

export function ChannelsCard({ share }: { share: ChannelsShare }) {
  const t = useT();
  return (
    <div className="call-card kind-card channels-card" data-testid="channels-card">
      <div className="call-head">
        <span className="call-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d={PLAY} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="call-what">
          <div className="call-title">{share.author}</div>
          <div className="call-when">{t.msg.channels}</div>
        </div>
      </div>
      {share.description && <div className="text channels-desc">{linkify(share.description)}</div>}
      <div className="kind-hint">{t.msg.channelsHint}</div>
    </div>
  );
}
