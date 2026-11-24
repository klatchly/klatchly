import { useConnBanner } from './conn';
import { useT } from './i18n';

/** "Reconnecting…" / "Offline" under a conversation header (the list's dot is hidden there on a phone). */
export function ConnBar() {
  const t = useT();
  const banner = useConnBanner();
  if (!banner) return null;
  return (
    <div className={`conn-bar ${banner}`} role="status" data-testid="conn-bar" data-state={banner}>
      {banner === 'offline' ? t.shell.offline : t.shell.connLost}
    </div>
  );
}
