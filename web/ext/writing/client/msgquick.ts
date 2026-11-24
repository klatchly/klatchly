import { DEFAULT_LANG_PREFS, type Lang } from '../langs.js';

// The one-tap action on received messages, set per chat in the ✨ settings (../server/assist.ts `msgQuick`):
// a translation shown under the bubble, the same one the message menu asks for. Unset = the first of the
// languages for received messages (Settings → Translation languages, `readLangs`).

export type MsgQuick = `translate:${Lang}` | 'none';
export type MsgTarget = Lang;
const READ = DEFAULT_LANG_PREFS.readLangs;

/** The default one-tap action: into the first language for received messages. */
export const defaultMsgQuick = (readLangs: readonly Lang[] = READ): MsgQuick => `translate:${readLangs[0] ?? 'fr'}`;

/** The choices in the ✨ settings: one per language for received messages, and the chat's own if it is another. */
export function msgQuickChoices(readLangs: readonly Lang[], current?: MsgQuick | ''): Exclude<MsgQuick, 'none'>[] {
  const out = readLangs.map((l) => `translate:${l}` as const);
  return current && current !== 'none' && !out.includes(current) ? [...out, current] : out;
}

/** The language the chat's setting translates into, or undefined when the action is off. */
export function msgQuickTarget(q: MsgQuick | '' | undefined, readLangs: readonly Lang[] = READ): MsgTarget | undefined {
  const v = q || defaultMsgQuick(readLangs);
  return v === 'none' ? undefined : (v.split(':')[1] as MsgTarget);
}

/**
 * Where the button goes: received messages with text (not ours, deleted or notices), and not once that
 * translation is already under the bubble (a failed one can be asked again).
 */
export function msgQuickFor(
  m: { text?: string; isSender?: boolean; isDeleted?: boolean; type?: string },
  q: MsgQuick | '' | undefined,
  shown?: { target: string; status: string },
  readLangs: readonly Lang[] = READ,
): MsgTarget | undefined {
  const target = msgQuickTarget(q, readLangs);
  if (!target || m.isSender || m.isDeleted || m.type === 'NOTICE' || !m.text?.trim()) return undefined;
  if (shown && shown.target === target && shown.status !== 'error') return undefined;
  return target;
}

/**
 * The message menu's translations at each place (MessageMenuSlotProps): one per language for received messages; in
 * the touch sheet (no hover row), the chat's one-tap target heads the list ('top', a message without media) and
 * leaves its usual place ('text').
 */
export function menuTargets(
  place: 'top' | 'text',
  anchored: boolean,
  media: boolean,
  quick: MsgTarget | undefined,
  readLangs: readonly Lang[] = READ,
): MsgTarget[] {
  const atTop = !anchored && !media ? quick : undefined;
  if (place === 'top') return atTop ? [atTop] : [];
  return readLangs.filter((x) => x !== atTop);
}
