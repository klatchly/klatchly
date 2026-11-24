// "N new messages" divider of a conversation. Pure functions (unit-tested in test/unread.test.ts), no imports.

/**
 * Index of the first unread message: the `unread`-th incoming message counted from the end of the list
 * (oldest first). -1 when the loaded rows do not reach that far back (or nothing is unread).
 */
export function firstUnreadIndex(incoming: readonly boolean[], unread: number): number {
  if (unread <= 0) return -1;
  let n = 0;
  for (let i = incoming.length - 1; i >= 0; i--) {
    if (incoming[i] && ++n === unread) return i;
  }
  return -1;
}

/** Fallback when the history ends before that many incoming messages: the oldest incoming one loaded. */
export function oldestIncoming(incoming: readonly boolean[]): number {
  return incoming.indexOf(true);
}

/**
 * Open at the divider (top of the screen) rather than at the bottom: only when the unread part is taller than
 * a screen, otherwise the bottom already shows the divider.
 */
export function openAtDivider(total: number, index: number, screenRows: number): boolean {
  return index >= 0 && total - index > screenRows;
}

/**
 * Rows a list's preview draws while the list is placed (Conversation ListPreview): from just above the divider
 * when the list opens there (`at`), else the last `n` rows. `[lo, hi)` of `count` rows.
 */
export function previewRange(count: number, n: number, at?: number): { lo: number; hi: number } {
  if (at !== undefined && at >= 0 && at < count) return { lo: Math.max(0, at - 2), hi: Math.min(count, at + n) };
  return { lo: Math.max(0, count - n), hi: count };
}
