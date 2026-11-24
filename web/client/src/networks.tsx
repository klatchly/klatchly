import {
  siBluesky,
  siDiscord,
  siFacebook,
  siGooglechat,
  siGooglemessages,
  siImessage,
  siInstagram,
  siLine,
  siMatrix,
  siMessenger,
  siSignal,
  siTelegram,
  siWechat,
  siWhatsapp,
  siX,
} from 'simple-icons';
import { networkConnector } from './connectors';
import type { ConnectorUI } from './extension';

type Icon = { title: string; hex: string; path: string; /** drawn in white on top of `path` */ fg?: string };

// simple-icons has no LinkedIn (removed for trademark reasons) and no Beeper: simple marks drawn here.
const linkedin: Icon = {
  title: 'LinkedIn',
  hex: '0A66C2',
  path: 'M4.5 2h15A2.5 2.5 0 0 1 22 4.5v15a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 19.5v-15A2.5 2.5 0 0 1 4.5 2z',
  fg:
    'M7.2 5.4a1.55 1.55 0 1 0 0 3.1a1.55 1.55 0 1 0 0-3.1zM5.85 9.7h2.7v8.7h-2.7zM10.25 9.7h2.6v1.2c.4-.7 1.35-1.45 2.75-1.45 ' +
    '2.75 0 3.25 1.8 3.25 4.15v4.8h-2.7v-4.25c0-1.05-.05-2.35-1.45-2.35-1.45 0-1.7 1.1-1.7 2.25v4.35h-2.75z',
};
const beeper: Icon = {
  title: 'Beeper',
  hex: '5B5BD6',
  path: 'M12 2.5c5.8 0 10.5 3.95 10.5 8.85s-4.7 8.85-10.5 8.85c-1.3 0-2.55-.2-3.7-.55L3.6 21.9l1.3-4.15C2.95 16.15 1.5 13.9 1.5 11.35 1.5 6.45 6.2 2.5 12 2.5z',
  fg: 'M7.4 9.9a1.45 1.45 0 1 0 0 2.9a1.45 1.45 0 1 0 0-2.9zM12 9.9a1.45 1.45 0 1 0 0 2.9a1.45 1.45 0 1 0 0-2.9zM16.6 9.9a1.45 1.45 0 1 0 0 2.9a1.45 1.45 0 1 0 0-2.9z',
};

// Logos are bundled (simple-icons, CC0); a connector package brings its networks' own (connectors.ts). Networks
// without a logo get a coloured letter badge.
const ICONS: Record<string, Icon> = {
  linkedin,
  beeper,
  whatsapp: siWhatsapp,
  telegram: siTelegram,
  line: siLine,
  discord: siDiscord,
  facebook: siFacebook,
  messenger: siMessenger,
  instagram: siInstagram,
  signal: siSignal,
  twitter: siX,
  x: siX,
  googlemessages: siGooglemessages,
  gmessages: siGooglemessages,
  googlechat: siGooglechat,
  imessage: siImessage,
  bluesky: siBluesky,
  matrix: siMatrix,
  wechat: siWechat,
};

const key = (network: string) => network.toLowerCase().replace(/[^a-z]/g, '');

/** Stable, readable colour per network name for letter badges. */
function letterColor(network: string): string {
  let h = 0;
  for (const ch of network) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return `hsl(${h} 45% 45%)`;
}

export const networkName = (network: string) => networkConnector(key(network))?.name ?? ICONS[key(network)]?.title ?? network;

export function NetworkBadge({ network, size = 16 }: { network: string; size?: number }) {
  const own = networkConnector(key(network));
  if (own?.icon) {
    // A connector's mark (ConnectorUI.icon, set by registry.ts).
    const Mark = own.icon as ConnectorUI['icon'];
    return (
      <span className="net-badge" title={network}>
        <Mark size={size} label={network} />
      </span>
    );
  }
  const icon = ICONS[key(network)];
  if (!icon) {
    return (
      <span className="net-badge net-letter" title={network} aria-label={network} role="img" style={{ backgroundColor: letterColor(network) }}>
        {network.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <span className="net-badge" title={network}>
      <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={network}>
        <path d={icon.path} fill={`#${icon.hex}`} />
        {icon.fg && <path d={icon.fg} fill="#fff" />}
      </svg>
    </span>
  );
}
