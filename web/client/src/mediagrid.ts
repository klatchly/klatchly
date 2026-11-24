// Layout of the chat's media page (ChatMedia.tsx): month sections, grid rows, columns, selection limits. Pure
// functions, no imports (unit-tested in test/mediagrid.test.ts).

export const MAX_SELECT = 10;
/** Files shared together on iOS: the share sheet holds them all in memory. */
export const MAX_SHARE_BYTES = 100 * 1024 * 1024;

/** Local calendar month of a timestamp, as a sortable key ("2026-10"). */
export function monthKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '0000-00';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export type Section<T> = { key: string; items: T[] };

/** Items (newest first) cut into months, in the same order. */
export function byMonth<T extends { timestamp: string }>(items: readonly T[]): Section<T>[] {
  const out: Section<T>[] = [];
  for (const it of items) {
    const key = monthKey(it.timestamp);
    const last = out[out.length - 1];
    if (last?.key === key) last.items.push(it);
    else out.push({ key, items: [it] });
  }
  return out;
}

export type GridRow<T> = { kind: 'month'; key: string } | { kind: 'cells'; key: string; items: T[] };

/** Rows of a virtualized grid: a header per month, then its items `cols` per row (a month never shares a row). */
export function gridRows<T extends { timestamp: string; key: string }>(items: readonly T[], cols: number): GridRow<T>[] {
  const rows: GridRow<T>[] = [];
  const n = Math.max(1, Math.floor(cols));
  for (const s of byMonth(items)) {
    rows.push({ kind: 'month', key: `m:${s.key}` });
    for (let i = 0; i < s.items.length; i += n) rows.push({ kind: 'cells', key: `c:${s.items[i]!.key}`, items: s.items.slice(i, i + n) });
  }
  return rows;
}

/** 3 columns on a phone, 4 from 480 px, 5 on wide panes; cells of at least ~100 px. */
export function columnsFor(width: number): number {
  if (width >= 900) return 5;
  if (width >= 480) return 4;
  return 3;
}

/** Video length as m:ss (h:mm:ss beyond an hour). */
export function durationLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Toggles a key in a selection; refuses beyond `max` ('full'). */
export function toggleSelected(sel: readonly string[], key: string, max = MAX_SELECT): string[] | 'full' {
  if (sel.includes(key)) return sel.filter((k) => k !== key);
  if (sel.length >= max) return 'full';
  return [...sel, key];
}

/** Whether files of these sizes can go to the share sheet together (unknown sizes count as 0 here). */
export function shareable(sizes: readonly (number | undefined)[], max = MAX_SHARE_BYTES): boolean {
  return sizes.reduce<number>((a, b) => a + (b ?? 0), 0) <= max;
}
