// Shared by server and client. A convention of the canonical model (the Desktop API's shapes, which every connector
// converts to): a senderName that is missing or a raw `@local:server` user ID means "unknown". Beeper puts the raw
// Matrix user ID there when it does not know a member's name (typical in big bridged groups), e.g.
// "@telegram_1000000042:beeper.local" (`@<network>_<numeric network id>:<server>`; a made-up ID). A connector that
// never produces that shape is not affected.
const RAW_USER_ID = /^@[^:\s]+:\S+$/;

export const isRawUserID = (s: string | null | undefined): boolean => !!s && RAW_USER_ID.test(s.trim());

/**
 * Human name for a sender: the real name when known, otherwise `member(tail)` built from the last 4
 * characters of the ID's local part, so different unknown members stay distinguishable.
 */
export function senderLabel(
  name: string | null | undefined,
  id: string | null | undefined,
  member: (tail: string) => string,
): string | undefined {
  const n = name?.trim();
  if (n && !isRawUserID(n)) return n;
  const raw = n || id?.trim();
  if (!raw) return undefined;
  const local = raw.startsWith('@') ? raw.slice(1).split(':')[0]! : raw;
  return member(local.slice(-4));
}
