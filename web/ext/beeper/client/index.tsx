import { connector, definePackage, lazyChunk, NetworkBadge } from '../../../client/src/sdk';
import { beeperMatrix } from '../locales/index';
import { isRoomLink, MATRIX_ACCOUNT } from '../matrix';
import { beeperPackage } from '../package';
import { beeperTraits } from './traits';

// Beeper's client half, on the launch path: what its chats and media are like (traits.ts), and its Matrix rooms
// (joining one from New chat or from a room's matrix.to link, leaving one from the chat menu), whose components are
// in their own chunk (Matrix.tsx). No `networks`: the networks it bridges keep the core's marks. Its chats use the
// core's conversation.

function BeeperIcon({ size = 16 }: { size?: number; label?: string }) {
  return <NetworkBadge network="Beeper" size={size} />;
}

const load = () => import('./Matrix');
const LEAVE = 'matrix-leave';

export default definePackage({
  ...beeperPackage,
  modules: [
    connector({
      ...beeperTraits,
      icon: BeeperIcon,
      newChat: { available: (a) => a.accountID === MATRIX_ACCOUNT, Entry: lazyChunk(load, 'JoinEntry') },
      links: { handles: isRoomLink, Dialog: lazyChunk(load, 'RoomLinkDialog') },
      chatActions: {
        list: (chat) => (chat.accountID === MATRIX_ACCOUNT && chat.type === 'group' ? [{ id: LEAVE, label: Object.fromEntries(Object.entries(beeperMatrix).map(([code, m]) => [code, m.leave])) }] : []),
        Dialog: lazyChunk(load, 'LeaveDialog'),
      },
    }),
  ],
});
