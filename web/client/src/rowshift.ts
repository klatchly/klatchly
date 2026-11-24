// How far the top of a list of rows moved between two renders: what Virtuoso's firstItemIndex has to move by.

/**
 * The rows added above the rows already listed, from `prev` to `next` (negative: rows removed from the top): the place
 * in `next` of the topmost row of `prev` still listed, less its place in `prev`. A row is followed by the ids it
 * holds (`ids`: an album holds several messages), so a top row that became an album, or an album that took older
 * photos in, is still the same row. 0 when no row of `prev` is left (another list: nothing to keep in place).
 */
export function prependedRows<T>(prev: readonly T[], next: readonly T[], ids: (row: T) => readonly string[]): number {
  if (!prev.length || !next.length) return 0;
  // The usual case (a new message, an edit, a reaction): the same top row.
  const top = new Set(ids(next[0]!));
  if (ids(prev[0]!).some((id) => top.has(id))) return 0;
  const place = new Map<string, number>();
  next.forEach((row, i) => {
    for (const id of ids(row)) if (!place.has(id)) place.set(id, i);
  });
  for (let q = 0; q < prev.length; q++) {
    for (const id of ids(prev[q]!)) {
      const p = place.get(id);
      if (p !== undefined) return p - q;
    }
  }
  return 0;
}
