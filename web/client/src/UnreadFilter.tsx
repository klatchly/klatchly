import { useSyncExternalStore } from 'react';
import { useT } from './i18n';

// "Unread only" beside the search field: the chat lists (inbox, low priority, archive) keep the chats with unread
// messages, and the open one (read as it is opened, it would vanish under the reader). Kept per device.
const KEY = 'klatchly.unreadfilter.v1';
let on = false;
try {
  on = localStorage.getItem(KEY) === '1';
} catch {
  // no storage
}
const listeners = new Set<() => void>();

export function setUnreadFilter(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    // quota or private mode
  }
  listeners.forEach((l) => l());
}

export function useUnreadFilter(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => on,
  );
}

export function UnreadFilter() {
  const t = useT();
  const active = useUnreadFilter();
  const label = active ? t.list.unreadOnlyOff : t.list.unreadOnly;
  return (
    <button
      type="button"
      className={`net-filter-btn unread-filter-btn ${active ? 'on' : ''}`}
      aria-pressed={active}
      aria-label={label}
      title={label}
      data-testid="unread-filter"
      onClick={() => setUnreadFilter(!active)}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M20 12.5a7.5 7.5 0 0 1-11.2 6.5L4 20l1.1-4.3A7.5 7.5 0 1 1 20 12.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="18.5" cy="5.5" r="3.2" fill="currentColor" stroke="var(--bg)" strokeWidth="1.5" />
      </svg>
      {active && <span className="net-filter-name">{t.list.unreadShort}</span>}
    </button>
  );
}
