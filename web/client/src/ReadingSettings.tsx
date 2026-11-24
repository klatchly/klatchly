import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { api, type ReadingAccount, type ReadingReply } from './endpoints';
import { Avatar } from './Avatar';
import { chatsQuery, findChat, keys } from './cache';
import { localized, useCatalog, useLang, useT } from './i18n';
import type { ReadingMessages } from './locales/reading/en';
import { phoneLayout } from './nav';
import { NetworkBadge, networkName } from './networks';
import { chatReading, readingKey, useReading } from './reading';
import { Note } from './Settings';
import { useSheetDrag } from './sheet';
import type { Chat } from './types';
import './reading.css';

// Settings → Lecture discrète (server/reading.ts), a page of its own (0.18.4) and its own chunk (strings, styles):
// a short lead (what it does, the two levels); "Per account", one card per source (Beeper, another chat connector…) with a row per
// messaging account (its network's mark, network and account name, what the switch does now, the switch) and the
// source's note once at the card's foot; "Per conversation", the chats with their own choice (set here with "Add a
// conversation", or from a chat's menu): avatar, name (opens the chat), network and its account's setting, a
// Discrète / Normale segmented control and ×; a filter past 8 of them; "Put all back", confirmed. All server-wide.

const CATALOG: Readonly<Record<string, ReadingMessages>> = Object.fromEntries(
  Object.entries(import.meta.glob<{ default: ReadingMessages }>('./locales/reading/*.ts', { eager: true })).map(([f, m]) => [f.slice(f.lastIndexOf('/') + 1, -3), m.default]),
);

/** A filter field shows past this many conversations. */
const FILTER_FROM = 8;

/** Why an account's switch is disabled, if it is. */
function blocked(a: ReadingAccount, m: ReadingMessages, unavailable: string): string | undefined {
  if (!a.support) return m.unsupported;
  if (!a.support.send || !a.support.available) return unavailable;
  return undefined;
}

const EyeOff = ({ size = 20 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <path
      d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13 13 0 0 1-2.6 3.8M6.6 6.6C4.6 8 3.2 10 2.5 12c1 2.5 4.5 7 9.5 7 1.9 0 3.6-.6 5-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function ReadingSettings() {
  const t = useT();
  const m = useCatalog(CATALOG);
  const lang = useLang();
  const qc = useQueryClient();
  const q = useReading();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const accounts = q.data?.accounts ?? [];
  /** Runs a change (`key`: what is busy meanwhile); the reply updates every view. `done`: the line to say after. */
  const change = async (key: string, run: () => Promise<ReadingReply>, done?: string) => {
    setBusy(key);
    setNote(undefined);
    try {
      qc.setQueryData(readingKey, await run());
      if (done) setNote(done);
    } catch {
      setNote(m.failed);
    } finally {
      setBusy(undefined);
    }
  };
  // The accounts by source, in the server's order: a source's note is said once, under its accounts.
  const sources = useMemo(() => {
    const by = new Map<string, ReadingAccount[]>();
    for (const a of accounts) by.set(a.source, [...(by.get(a.source) ?? []), a]);
    return [...by];
  }, [accounts]);
  let index = 0;
  return (
    <>
      <div className="reading-lead" data-testid="reading-lead">
        <span className="reading-lead-mark">
          <EyeOff size={22} />
        </span>
        <div className="reading-lead-text">
          <p>{m.intro}</p>
          <p className="settings-hint">{m.levels}</p>
        </div>
      </div>

      <h2 className="set-group-title" id="reading-accounts-title">
        {m.perAccount}
      </h2>
      <div className="reading-accounts" data-testid="reading-accounts" role="group" aria-labelledby="reading-accounts-title">
        {q.data && !accounts.length && (
          <div className="set-group">
            <p className="settings-hint reading-empty-line">{m.none}</p>
          </div>
        )}
        {sources.map(([source, list]) => {
          const sourceNote = list[0]?.support?.note;
          return (
            <div key={source} className="set-group reading-source" data-source={source}>
              {list.map((a) => {
                const block = `reading-${index++}`;
                const network = a.network ? networkName(a.network) : a.accountID;
                const label = a.name ? `${network} · ${a.name}` : network;
                const why = blocked(a, m, t.reading.unavailable);
                const state = why ? 'blocked' : a.discreet ? 'on' : 'off';
                return (
                  <div key={a.accountID} className="set-row reading-account" data-block={block} data-testid={`settings-${block}`} role="group" aria-labelledby={`set-l-${block}`}>
                    <span className="reading-net" aria-hidden="true">
                      {a.network ? <NetworkBadge network={a.network} size={20} /> : <EyeOff size={18} />}
                    </span>
                    <div className="set-text">
                      <h3 className="set-label" id={`set-l-${block}`}>
                        {network}
                        {a.name && <span className="reading-who"> {a.name}</span>}
                      </h3>
                      <p className="settings-hint reading-state" id={`${block}-state`} data-state={state} data-testid={`reading-state-${a.accountID}`}>
                        {why ?? (a.discreet ? m.stateOn : m.stateOff)}
                      </p>
                    </div>
                    <div className="set-control">
                      <button
                        type="button"
                        role="switch"
                        className="ext-switch"
                        aria-checked={a.discreet}
                        aria-label={m.toggle(label)}
                        aria-describedby={`${block}-state`}
                        data-testid={`reading-toggle-${a.accountID}`}
                        data-source={a.source}
                        disabled={!!why || busy !== undefined}
                        onClick={() => void change(a.accountID, () => api.setDiscreet(a.accountID, !a.discreet))}
                      >
                        <span aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {sourceNote && (
                <p className="settings-hint reading-source-note" data-testid={`reading-note-${source}`}>
                  {localized(sourceNote, lang)}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <ChatChoices reading={q.data} busy={busy !== undefined} change={change} m={m} />
      <Note text={note} />
    </>
  );
}

type Change = (key: string, run: () => Promise<ReadingReply>, done?: string) => Promise<void>;

/** "Per conversation": the chats with their own choice, the filter, Add, Put all back. */
function ChatChoices({ reading, busy, change, m }: { reading: ReadingReply | undefined; busy: boolean; change: Change; m: ReadingMessages }) {
  const t = useT();
  const qc = useQueryClient();
  const ids = Object.keys(reading?.chats ?? {});
  // Each chat from the lists when there, else asked once (its name and network, for the row and the filter).
  const chats = useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.chat(id),
      queryFn: () => api.chat(id),
      initialData: () => findChat(qc, id),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const byId = new Map(ids.map((id, i) => [id, chats[i]?.data]));
  const [filter, setFilter] = useState('');
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const needle = filter.trim().toLocaleLowerCase();
  const shown = needle ? ids.filter((id) => (byId.get(id)?.title ?? '').toLocaleLowerCase().includes(needle)) : ids;
  useEffect(() => {
    if (!ids.length) setConfirm(false);
  }, [ids.length]);
  const closePicker = () => {
    setPicking(false);
    addRef.current?.focus();
  };
  return (
    <>
      <div className="reading-chats-head">
        <h2 className="set-group-title" id="reading-chats-title">
          {m.perChat}
          {ids.length > 0 && (
            <span className="reading-count" role="img" aria-label={m.count(ids.length)} data-testid="reading-chats-count">
              {ids.length}
            </span>
          )}
        </h2>
        <button ref={addRef} type="button" className="text-btn reading-add" data-testid="reading-add" disabled={busy || !reading} onClick={() => setPicking(true)}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {m.add}
        </button>
      </div>
      <div className="set-group reading-chats" data-testid="reading-chats" role="group" aria-labelledby="reading-chats-title">
        {reading && !ids.length && (
          <div className="reading-empty" data-testid="reading-chats-none">
            <p className="reading-empty-title">{m.empty}</p>
            <p className="settings-hint">{m.emptyHow}</p>
          </div>
        )}
        {ids.length > FILTER_FROM && (
          <div className="reading-filter">
            <input type="search" value={filter} placeholder={m.filter} aria-label={m.filter} data-testid="reading-chats-filter" maxLength={100} onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
        {needle && !shown.length && <p className="settings-hint reading-empty-line">{m.filterNone}</p>}
        {shown.map((id) => (
          <ChatChoice key={id} chatID={id} chat={byId.get(id)} reading={reading} busy={busy} m={m} onSet={(discreet) => void change(`chat:${id}`, () => api.setChatDiscreet(id, discreet))} />
        ))}
        {ids.length > 0 && (
          <div className="reading-reset" data-testid="reading-reset-row">
            {confirm ? (
              <>
                <span className="settings-confirm" role="status">
                  {m.resetConfirm(ids.length)}
                </span>
                <span className="settings-actions">
                  <button type="button" className="text-btn" data-testid="reading-chats-reset-cancel" onClick={() => setConfirm(false)}>
                    {t.common.cancel}
                  </button>
                  <button
                    type="button"
                    className="text-btn danger"
                    data-testid="reading-chats-reset-confirm"
                    disabled={busy}
                    onClick={() => void change('chats', api.resetChatDiscreet).then(() => setConfirm(false))}
                  >
                    {m.resetDo}
                  </button>
                </span>
              </>
            ) : (
              <button type="button" className="text-btn danger reading-reset-btn" data-testid="reading-chats-reset" disabled={busy} onClick={() => setConfirm(true)}>
                {m.resetAll}
              </button>
            )}
          </div>
        )}
      </div>
      {picking && reading && (
        <ChatPicker
          reading={reading}
          m={m}
          onClose={closePicker}
          onPick={(c, discreet) => {
            closePicker();
            void change(`chat:${c.id}`, () => api.setChatDiscreet(c.id, discreet), m.added(c.title || m.unknownChat, discreet));
          }}
        />
      )}
    </>
  );
}

/**
 * One chat with its own choice: its avatar (network badge), name (a link to the chat), network and its account's
 * setting; Discrète / Normale; × back to its account's. A chat whose network takes no receipt from Klatchly now reads
 * quietly anyway: the control shows what applies, disabled.
 */
function ChatChoice({ chatID, chat, reading, busy, m, onSet }: { chatID: string; chat: Chat | undefined; reading: ReadingReply | undefined; busy: boolean; m: ReadingMessages; onSet: (discreet: boolean | null) => void }) {
  const t = useT();
  const [, navigate] = useLocation();
  const own = reading?.chats?.[chatID] === true;
  const r = chatReading(reading, chat ? { id: chatID, accountID: chat.accountID } : undefined);
  const fixed = !!chat && !r.choosable;
  const value = fixed ? r.discreet : own;
  const name = chat?.title || m.unknownChat;
  const account = chat && reading?.accounts.find((a) => a.accountID === chat.accountID);
  const href = `/chat/${encodeURIComponent(chatID)}`;
  const open = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  const sub = chat ? (fixed ? t.reading.unavailable : m.chatSub(networkName(chat.network), !!account?.discreet)) : undefined;
  return (
    <div className="reading-chat" data-testid="reading-chat" data-chat-id={chatID}>
      <span className="reading-chat-avatar">{chat ? <Avatar chat={chat} size={36} /> : <span className="reading-chat-blank" aria-hidden="true" />}</span>
      <span className="reading-chat-name">
        {chat ? (
          <a className="set-label reading-chat-link" href={href} onClick={open} aria-label={m.open(name)} data-testid="reading-chat-open">
            {name}
          </a>
        ) : (
          <span className="set-label">{name}</span>
        )}
        {sub && <span className="settings-hint">{sub}</span>}
      </span>
      <span className="reading-seg" role="radiogroup" aria-label={m.stateLabel(name)} data-testid="reading-chat-state" data-value={value ? 'discreet' : 'normal'}>
        {([true, false] as const).map((d) => (
          <button
            key={String(d)}
            type="button"
            role="radio"
            aria-checked={value === d}
            data-testid={d ? 'reading-chat-discreet' : 'reading-chat-normal'}
            disabled={busy || fixed}
            onClick={() => value !== d && onSet(d)}
          >
            {d ? m.discreet : m.normal}
          </button>
        ))}
      </span>
      <button type="button" className="icon-btn reading-chat-remove" aria-label={m.remove(name)} title={t.reading.useAccount} data-testid="reading-chat-remove" disabled={busy} onClick={() => onSet(null)}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = window.setTimeout(() => setD(v), ms);
    return () => window.clearTimeout(id);
  }, [v, ms]);
  return d;
}

/**
 * "Add a conversation": the recent chats, or a search (the forward picker's, Forward.tsx); picking one gives it the
 * opposite of what applies to it now (its account's, as it has no choice of its own yet). A chat already in the list,
 * or whose network takes no receipt from Klatchly now, is shown disabled with why. A dialog centred, a sheet on a phone.
 */
function ChatPicker({ reading, m, onClose, onPick }: { reading: ReadingReply; m: ReadingMessages; onClose: () => void; onPick: (c: Chat, discreet: boolean) => void }) {
  const t = useT();
  const sheet = phoneLayout();
  const ref = useSheetDrag(sheet, onClose);
  const [input, setInput] = useState('');
  const query = useDebounced(input.trim(), 250);
  const recent = useInfiniteQuery(chatsQuery());
  const search = useQuery({ queryKey: ['reading-search', query], queryFn: () => api.searchChats(query), enabled: !!query, staleTime: 30_000 });
  const list = useMemo(() => {
    if (query) return search.data?.items ?? [];
    const seen = new Set<string>();
    const out: Chat[] = [];
    for (const p of recent.data?.pages ?? []) for (const c of p.items) if (!seen.has(c.id) && !c.isArchived && out.length < 40) (seen.add(c.id), out.push(c));
    return out;
  }, [query, search.data, recent.data]);
  // Escape closes the picker, not Settings (Shell.tsx leaves on an Escape nobody took).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className={`menu-backdrop newchat-backdrop ${sheet ? 'sheet-backdrop' : 'center-backdrop'}`} onClick={onClose}>
      <div
        ref={ref}
        className={`msg-menu newchat reading-picker ${sheet ? 'sheet' : 'centered'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reading-picker-title"
        data-testid="reading-picker"
        onClick={(e) => e.stopPropagation()}
      >
        {sheet && <div className="sheet-grab" aria-hidden="true" />}
        <div className="newchat-head">
          <span className="menu-title" id="reading-picker-title">
            {m.pickTitle}
          </span>
          <button type="button" className="icon-btn small" aria-label={t.common.close} data-testid="reading-picker-close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="newchat-hint reading-picker-hint">{m.pickHint}</p>
        <div className="newchat-search">
          <input
            type="search"
            value={input}
            placeholder={m.pickSearch}
            aria-label={m.pickSearch}
            data-testid="reading-picker-search"
            enterKeyHint="search"
            maxLength={200}
            autoFocus={!sheet}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <h3 className="picker-title">{query ? m.pickResults : m.pickRecent}</h3>
        {query && search.isSuccess && !list.length && <p className="newchat-note">{m.pickNoResults}</p>}
        <ul className="newchat-results">
          {list.map((c) => {
            const r = chatReading(reading, c);
            const account = reading.accounts.find((a) => a.accountID === c.accountID);
            const why = c.id in (reading.chats ?? {}) ? m.pickAlready : !account?.support ? m.unsupported : !r.choosable ? t.reading.unavailable : undefined;
            return (
              <li key={c.id}>
                <button type="button" className="contact-row" data-testid="reading-pick" data-chat-id={c.id} disabled={!!why} onClick={() => onPick(c, !r.discreet)}>
                  <Avatar chat={c} size={36} />
                  <span className="contact-main">
                    <span className="contact-name">{c.title || '…'}</span>
                    <span className="contact-sub">{why ?? m.pickNow(networkName(c.network), r.discreet)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
