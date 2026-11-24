import { useState } from 'react';
import { mediaUrl } from './endpoints';
import { hue, initials } from './format';
import { NetworkBadge } from './networks';
import type { Chat } from './types';
import { AVATAR_WIDTH, smallImage } from './thumbs';

export function avatarUrl(chat: Chat): string | undefined {
  if (chat.imgURL) return chat.imgURL;
  if (chat.type === 'single') return chat.participants?.items.find((p) => !p.isSelf && mediaUrl(p.imgURL))?.imgURL;
  return undefined;
}

export function Avatar({ chat, size = 44 }: { chat: Chat; size?: number }) {
  const orig = mediaUrl(avatarUrl(chat));
  // A small thumbnail (relayed avatars are often 640 px or more); the original if it fails, then the initials.
  const thumb = smallImage(orig, AVATAR_WIDTH);
  const [failed, setFailed] = useState<string[]>([]);
  const src = thumb && !failed.includes(thumb) ? thumb : orig;
  const showImg = src && !failed.includes(src);
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      {showImg ? (
        <img src={src} alt="" loading="lazy" width={size} height={size} onError={() => setFailed((f) => [...f, src])} />
      ) : (
        <span className="avatar-fallback" style={{ backgroundColor: `hsl(${hue(chat.id)} 35% 45%)`, fontSize: size * 0.38 }}>
          {initials(chat.title || '?')}
        </span>
      )}
      <NetworkBadge network={chat.network} size={Math.round(size * 0.32)} />
    </span>
  );
}
