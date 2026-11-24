import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dataPath, log } from '#core/sdk.js';

// Moving a chat into Beeper's low-priority inbox also mutes it. The chats muted by such a move are kept here
// (data/lowpri.json, shared by every device) so that moving them back unmutes them, while a chat the user had
// muted before keeps its mute. An explicit mute/unmute takes the decision back from us (forgetMutedByMove).
const MAX = 5000;
let ids: Set<string> | undefined;
const file = () => dataPath('lowpri.json');

function set(): Set<string> {
  if (!ids) {
    ids = new Set();
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as unknown;
      for (const id of Array.isArray(raw) ? raw : []) if (typeof id === 'string') ids.add(id);
    } catch {
      // first run
    }
  }
  return ids;
}

function save(): void {
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify([...set()]) + '\n', { mode: 0o600 });
    renameSync(tmp, file());
  } catch {
    log('lowpri', 'store write failed');
  }
}

export const mutedByMove = (chatID: string): boolean => set().has(chatID);

export function setMutedByMove(chatID: string, on: boolean): void {
  const s = set();
  if (s.has(chatID) === on) return;
  if (on) {
    s.add(chatID);
    while (s.size > MAX) s.delete(s.values().next().value!);
  } else s.delete(chatID);
  save();
}

export const forgetMutedByMove = (chatID: string): void => setMutedByMove(chatID, false);

/**
 * The upstream patch for a move into (lowPriority=true) or out of the low-priority inbox, and whether the chat
 * is then muted by the move. Pure; exported for tests.
 */
export function lowPriorityPlan(
  lowPriority: boolean,
  isMuted: boolean,
  recorded: boolean,
): { patch: { isLowPriority: boolean; isMuted?: boolean }; mutedByMove: boolean } {
  if (lowPriority) {
    // Already muted: by the user (not recorded) or by an earlier move (recorded, kept).
    return isMuted ? { patch: { isLowPriority: true }, mutedByMove: recorded } : { patch: { isLowPriority: true, isMuted: true }, mutedByMove: true };
  }
  return recorded ? { patch: { isLowPriority: false, isMuted: false }, mutedByMove: false } : { patch: { isLowPriority: false }, mutedByMove: false };
}
