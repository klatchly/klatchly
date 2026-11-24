import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './endpoints';
import { chatsQuery, keys } from './cache';
import { useT } from './i18n';
import { NetworkBadge, networkName } from './networks';
import { NetworkPicker } from './NetworkPicker';
import type { Account } from './types';

// Selected accounts (network filter), kept per device. Empty = no filter.
const KEY = 'klatchly.netfilter.v1';
let selected: string[] = [];
try {
  const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  if (Array.isArray(v)) selected = v.filter((x): x is string => typeof x === 'string');
} catch {
  // no storage
}
const listeners = new Set<() => void>();

export function setNetworkFilter(next: string[]): void {
  selected = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // quota or private mode
  }
  listeners.forEach((l) => l());
}

export const toggleNetwork = (active: string[], a: Account) =>
  setNetworkFilter(active.includes(a.accountID) ? active.filter((id) => id !== a.accountID) : [...active, a.accountID]);

/**
 * The accounts (networks). Persisted with the chat list and never pushed by the server, so read again when the app
 * comes back to the foreground (after a minute) and every 5 minutes: an account connected meanwhile (in Beeper, or
 * on the Accounts page) shows in the filter without a reload.
 */
export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: api.accounts, staleTime: 60_000, refetchOnWindowFocus: true, refetchInterval: 5 * 60_000 });
}

/**
 * When the set of accounts changes, the chat lists are read again: a newly connected account's chats are older
 * than the list's top, so no live upsert ever brings them in. Mounted once (Shell).
 */
export function useAccountChanges(): void {
  const qc = useQueryClient();
  const ids = useAccounts()
    .data?.map((a) => a.accountID)
    .sort()
    .join('\n');
  const prev = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (ids === undefined) return;
    if (prev.current !== undefined && prev.current !== ids) {
      void qc.invalidateQueries({ queryKey: keys.chats });
      void qc.invalidateQueries({ queryKey: keys.lowPriority });
      void qc.invalidateQueries({ queryKey: ['chats-archived'] });
    }
    prev.current = ids;
  }, [qc, ids]);
}

/** Active filter: selected account IDs that still exist (stale ones are ignored). */
export function useNetworkFilter(): string[] {
  const sel = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selected,
  );
  const accounts = useAccounts().data;
  if (!accounts) return sel;
  const known = new Set(accounts.map((a) => a.accountID));
  const live = sel.filter((id) => known.has(id));
  return live.length === sel.length ? sel : live;
}

/**
 * Chats with unread messages per account, from the inbox chats already loaded (read only, never fetched from here),
 * by the page title's rule: muted, archived and low-priority ones left out.
 */
export function useUnreadByAccount(): Map<string, number> {
  const pages = useInfiniteQuery({ ...chatsQuery(), enabled: false }).data?.pages;
  return useMemo(() => {
    const out = new Map<string, number>();
    for (const p of pages ?? []) {
      for (const c of p.items) {
        if (c.unreadCount > 0 && !c.isMuted && !c.isArchived && !c.isLowPriority) out.set(c.accountID, (out.get(c.accountID) ?? 0) + 1);
      }
    }
    return out;
  }, [pages]);
}

/**
 * The network filter (0.17.5), at the end of the search field: a funnel opens every network (NetworkPicker); once
 * some are picked it shows them (the name when there is one, else their marks) and a cross clears them. A dot: unread
 * chats on the networks the filter hides. No row of its own, so nothing to reserve while the accounts load.
 */
export function NetworkFilter() {
  const t = useT();
  const accounts = useAccounts().data;
  const active = useNetworkFilter();
  const unread = useUnreadByAccount();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!accounts || accounts.length < 2) return null;
  const picked = accounts.filter((a) => active.includes(a.accountID));
  const elsewhere = picked.length > 0 && accounts.some((a) => !active.includes(a.accountID) && (unread.get(a.accountID) ?? 0) > 0);
  const label = picked.length ? t.list.filteredBy(picked.map((a) => networkName(a.network))) : t.list.networkFilter;
  return (
    <div className={`net-filter ${picked.length ? 'on' : ''}`} data-testid="net-filter">
      <button
        ref={btn}
        type="button"
        className="net-filter-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label + (elsewhere ? `, ${t.list.unreadElsewhere}` : '')}
        title={label}
        data-testid="net-open"
        onClick={() => setOpen((o) => !o)}
      >
        {picked.length === 0 ? (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <>
            <span className="net-stack">
              {picked.slice(0, 3).map((a) => (
                <span key={a.accountID} className="net-stack-disc">
                  <NetworkBadge network={a.network} size={16} />
                </span>
              ))}
            </span>
            {picked.length === 1 ? (
              <span className="net-filter-name">{networkName(picked[0]!.network)}</span>
            ) : (
              picked.length > 3 && <span className="net-filter-name">+{picked.length - 3}</span>
            )}
          </>
        )}
        {elsewhere && <span className="net-dot" aria-hidden="true" data-testid="net-elsewhere" />}
      </button>
      {picked.length > 0 && (
        <button type="button" className="net-filter-x" aria-label={t.list.clearNetworkFilter} title={t.list.clearNetworkFilter} data-testid="net-clear" onClick={() => setNetworkFilter([])}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {open && <NetworkPicker accounts={accounts} active={active} unread={unread} anchor={btn} onClose={close} />}
    </div>
  );
}
