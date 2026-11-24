import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from './i18n';
import { NetworkBadge, networkName } from './networks';
import { setNetworkFilter, toggleNetwork } from './NetworkFilter';
import type { Account } from './types';

/**
 * Every network with its name and its chats with unread messages, as a panel under the search bar (NetworkFilter).
 * Several can be picked; it stays open until Escape, a click outside or the button again. Over the list, out of its
 * layout: opening it moves nothing.
 */
export function NetworkPicker({ accounts, active, unread, anchor, onClose }: { accounts: Account[]; active: string[]; unread: Map<string, number>; anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    const col = (a.closest('.chat-list-wrap') ?? a).getBoundingClientRect();
    const r = a.getBoundingClientRect();
    setAt({ top: r.bottom + 6, left: col.left + 8, width: col.width - 16 });
  }, [anchor]);
  useEffect(() => {
    if (!at) return;
    panel.current?.querySelector<HTMLButtonElement>('.net-item')?.focus();
  }, [at]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
      anchor.current?.focus();
    };
    const down = (e: PointerEvent) => {
      const el = e.target as Node;
      if (!panel.current?.contains(el) && !anchor.current?.contains(el)) onClose();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', down);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', down);
    };
  }, [anchor, onClose]);
  if (!at) return null;
  return createPortal(
    <div ref={panel} className="net-picker" role="dialog" aria-label={t.list.networkFilter} data-testid="net-picker" style={{ top: at.top, left: at.left, width: at.width }}>
      <div className="net-picker-head">
        <span className="net-picker-title">{t.list.networks}</span>
        <button type="button" className="net-picker-all" disabled={!active.length} onClick={() => setNetworkFilter([])} data-testid="net-picker-all">
          {t.list.showAllNetworks}
        </button>
      </div>
      <div className="net-picker-grid">
        {accounts.map((a) => {
          const on = active.includes(a.accountID);
          const n = unread.get(a.accountID) ?? 0;
          const name = networkName(a.network);
          return (
            <button
              key={a.accountID}
              type="button"
              className={`net-item ${on ? 'on' : ''}`}
              aria-pressed={on}
              aria-label={t.list.networkItem(name, n)}
              data-testid="net-item"
              data-account={a.accountID}
              onClick={() => toggleNetwork(active, a)}
            >
              <NetworkBadge network={a.network} size={22} />
              <span className="net-item-name">{name}</span>
              {n > 0 && <span className="badge">{n > 99 ? '99+' : n}</span>}
              <svg className="net-check" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
