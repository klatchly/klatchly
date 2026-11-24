// Which cached chat list a chat belongs to, and moving it in or out of one. Pure functions (unit-tested in
// test/chatplace.test.ts): structural copies of the types.ts shapes, no imports.

export interface ListChat {
  id: string;
  isPinned?: boolean;
  isArchived?: boolean;
  isLowPriority?: boolean;
  lastActivity?: string;
}
export interface Pages<C> {
  pages: { items: C[] }[];
}

const ts = (iso?: string) => (iso ? new Date(iso).getTime() || 0 : 0);

/** The list a chat belongs to: the inbox, the low-priority list, or neither (archived chats have their own view). */
export function chatPlace(c: { isArchived?: boolean; isLowPriority?: boolean }): 'inbox' | 'lowPriority' | null {
  if (c.isArchived) return null;
  return c.isLowPriority ? 'lowPriority' : 'inbox';
}

export function findIn<C extends ListChat>(data: Pages<C> | undefined, id: string): C | undefined {
  for (const p of data?.pages ?? []) {
    const c = p.items.find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

/**
 * Put a merged chat in one cached list, or take it out when it does not belong there. It moves to the top
 * (after pinned chats) when it is new to the list or its activity is newer.
 */
export function placeChat<C extends ListChat, D extends Pages<C>>(data: D, merged: C, belongs: boolean): D {
  const existing = findIn(data, merged.id);
  if (!belongs) {
    return existing ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== merged.id) })) } : data;
  }
  const moved = !existing || ts(merged.lastActivity) > ts(existing.lastActivity) || merged.isPinned !== existing.isPinned;
  if (!moved) {
    return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((c) => (c.id === merged.id ? merged : c)) })) };
  }
  const pages = data.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== merged.id) }));
  const first = pages[0];
  if (!first) return data;
  const items = [...first.items];
  let at = 0;
  if (!merged.isPinned) while (at < items.length && items[at]!.isPinned) at++;
  items.splice(at, 0, merged);
  pages[0] = { ...first, items };
  return { ...data, pages };
}

/**
 * Merge a chat's new fields into a list it is only shown in (search results), in place: never added, removed or
 * moved there, since the server chose that list's members and order. Unchanged data when the chat is not in it.
 */
export function patchIn<C extends ListChat, D extends Pages<C>>(data: D | undefined, patch: NoInfer<Partial<C>> & { id: string }): D | undefined {
  if (!data || !findIn(data, patch.id)) return data;
  return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((c) => (c.id === patch.id ? { ...c, ...patch } : c)) })) };
}
