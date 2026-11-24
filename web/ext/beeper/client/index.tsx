import { connector, definePackage, NetworkBadge } from '../../../client/src/sdk';
import { beeperPackage } from '../package';
import { beeperTraits } from './traits';

// Beeper's client half, on the launch path: what its chats and media are like (traits.ts). No `networks`: the
// networks it bridges keep the core's marks. No chunk of its own: Beeper chats use the core's conversation.

function BeeperIcon({ size = 16 }: { size?: number; label?: string }) {
  return <NetworkBadge network="Beeper" size={size} />;
}

export default definePackage({
  ...beeperPackage,
  modules: [connector({ ...beeperTraits, icon: BeeperIcon })],
});
