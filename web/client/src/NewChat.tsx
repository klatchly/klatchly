import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { api, HttpError, mediaUrl } from './endpoints';
import { keys, upsertChat } from './cache';
import { useAccounts } from './NetworkFilter';
import { NetworkBadge, networkName } from './networks';
import { useSheetDrag } from './sheet';
import { fromListState, phoneLayout } from './nav';
import { hue, initials } from './format';
import { useT } from './i18n';
import { classifyIdentifier, type Identifier } from '../../server/identifier';
import type { Account, Chat, Contact, NewChatCaps } from './types';
import type { Messages } from '../../server/locales/en';

// "New conversation": pick an account, search a contact on it (or several, for a group), then open the
// chat. Direct chats go through chats/start, which reuses an existing chat with that person.

const LAST_KEY = 'klatchly.newchat.account.v1';

function lastAccount(): string | undefined {
  try {
    return localStorage.getItem(LAST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberAccount(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // private mode: remembered for this page only
  }
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = window.setTimeout(() => setD(v), ms);
    return () => window.clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function NewChatPanel({ sheet, anchor, onClose }: { sheet: boolean; anchor?: DOMRect; onClose: (opened: boolean) => void }) {
  const t = useT();
  const accounts = useAccounts().data;
  const [chosen, setChosen] = useState<string | undefined>(lastAccount);
  const account = accounts?.find((a) => a.accountID === chosen);
  const close = () => onClose(false);
  const ref = useSheetDrag(sheet, close);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // Desktop: under the button, kept on screen.
  useLayoutEffect(() => {
    if (sheet || !ref.current) return;
    const w = ref.current.offsetWidth;
    const right = anchor ? anchor.right : window.innerWidth / 2 + w / 2;
    const top = anchor ? anchor.bottom + 6 : 60;
    setPos({ left: Math.max(8, Math.min(right - w, window.innerWidth - w - 8)), top, maxHeight: window.innerHeight - top - 12 });
  }, [sheet, anchor]);

  return (
    <div className={`menu-backdrop newchat-backdrop ${sheet ? 'sheet-backdrop' : ''}`} onClick={close}>
      <div
        ref={ref}
        className={`msg-menu newchat ${sheet ? 'sheet' : 'popover'}`}
        role="dialog"
        aria-modal="true"
        aria-label={t.newChat.title}
        data-testid="new-chat-panel"
        style={sheet ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight }}
        onClick={(e) => e.stopPropagation()}
      >
        {sheet && <div className="sheet-grab" aria-hidden="true" />}
        <div className="newchat-head">
          <span className="menu-title">{t.newChat.title}</span>
          <button type="button" className="icon-btn small" aria-label={t.common.close} data-testid="new-chat-close" onClick={close}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="account-chips newchat-accounts" role="radiogroup" aria-label={t.newChat.accounts}>
          {(accounts ?? []).map((a) => {
            const on = a.accountID === account?.accountID;
            const name = networkName(a.network);
            return (
              <button
                key={a.accountID}
                type="button"
                role="radio"
                aria-checked={on}
                className={`account-chip ${on ? 'on' : ''}`}
                aria-label={name}
                title={name}
                data-testid="newchat-account"
                data-account={a.accountID}
                onClick={() => {
                  setChosen(a.accountID);
                  rememberAccount(a.accountID);
                }}
              >
                <NetworkBadge network={a.network} size={18} />
              </button>
            );
          })}
        </div>
        {account ? (
          <AccountStep key={account.accountID} account={account} focusSearch={!sheet} onOpened={() => onClose(true)} />
        ) : (
          <p className="newchat-note" data-testid="newchat-choose">{accounts ? t.newChat.chooseAccount : t.common.loading}</p>
        )}
      </div>
    </div>
  );
}

const display = (c: Contact) => c.fullName || c.username || c.phoneNumber || c.email || c.id;

/** A network's internal id given as a handle (LinkedIn's "ACoAA…"): long, no dot, no space; not shown. */
const opaque = (h: string) => h.length >= 30 && /^[A-Za-z0-9_-]+$/.test(h);

/** Networks where starting a conversation sends a first message ("New chat") to the person (their bridge does). */
const SENDS_FIRST = new Set(['LinkedIn']);

function subline(c: Contact): string {
  const name = display(c);
  const user = c.username && !opaque(c.username) ? c.username : undefined;
  const handle = user && !user.includes(':') && !user.startsWith('@') ? `@${user}` : user;
  return [handle, c.phoneNumber, c.email].filter((x): x is string => !!x && x !== name).join(' · ');
}

function errorText(t: Messages, e: unknown, network: string): string {
  if (!(e instanceof HttpError)) return t.newChat.errGeneric;
  if (e.status === 404) return t.newChat.errNotFound;
  if (e.status === 409) return t.newChat.errUnsupported(network);
  if (e.status === 400 || e.status === 422) return t.newChat.errRefused(network);
  if (e.status === 429) return t.newChat.errRate;
  if (e.status === 504) return t.newChat.errTimeout;
  if (e.status === 502 && e.code === 'CREATE_CHAT_FAILED') return t.newChat.errStartFailed(network);
  return t.newChat.errGeneric;
}

function lookupLine(t: Messages, id: Identifier, caps: NewChatCaps, network: string): { text: string; exact: boolean } {
  if (id.kind === 'phone') return caps.lookup.phone ? { text: t.newChat.exactPhone(id.value, network), exact: true } : { text: t.newChat.noPhoneLookup(network), exact: false };
  if (id.kind === 'email') return caps.lookup.email ? { text: t.newChat.exactEmail(id.value, network), exact: true } : { text: t.newChat.noEmailLookup(network), exact: false };
  return caps.lookup.username ? { text: t.newChat.exactUsername(id.value, network), exact: true } : { text: t.newChat.noUsernameLookup(network), exact: false };
}

function AccountStep({ account, focusSearch, onOpened }: { account: Account; focusSearch: boolean; onOpened: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const network = networkName(account.network);
  const caps = useQuery({ queryKey: ['newchat-caps', account.accountID], queryFn: () => api.newChatCaps(account.accountID), staleTime: 10 * 60_000, retry: 1 });
  const c = caps.data;
  const [input, setInput] = useState('');
  const query = useDebounced(input.trim().slice(0, 200), 350);
  const [group, setGroup] = useState(false);
  const [picked, setPicked] = useState<Contact[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  // A new conversation on a network that sends a first message to open it: asked before (SENDS_FIRST).
  const [confirm, setConfirm] = useState<Contact | null>(null);

  const search = useQuery({
    queryKey: ['contacts', account.accountID, query],
    queryFn: () => api.contacts(account.accountID, query),
    enabled: !!c && !!query,
    staleTime: 60_000,
    retry: false,
  });
  const list = useInfiniteQuery({
    queryKey: ['contact-list', account.accountID],
    queryFn: ({ pageParam }) => api.contactList(account.accountID, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? (last.oldestCursor ?? undefined) : undefined),
    enabled: !!c?.contactList && !query,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const ident = query ? classifyIdentifier(query) : null;
  const lookup = ident && c && !c.existingOnly ? lookupLine(t, ident, c, network) : null;
  const items = useMemo(() => {
    const src = query ? (search.data?.items ?? []) : (list.data?.pages ?? []).flatMap((p) => p.items);
    const seen = new Set<string>();
    return src.filter((x) => !x.isSelf && !seen.has(x.id) && !!seen.add(x.id));
  }, [query, search.data, list.data]);
  const loading = query ? search.isFetching : list.isFetching && !list.isFetchingNextPage;
  const failed = query ? search.isError : list.isError;
  const canGroup = !!c?.group && !c.existingOnly;
  const canDirect = !!c && (c.start || !!c.existingOnly);

  const opened = (id: string, chat?: Chat) => {
    rememberAccount(account.accountID);
    if (chat) {
      qc.setQueryData(keys.chat(id), chat);
      if (chat.title) upsertChat(qc, chat);
    }
    onOpened();
    navigate(`/chat/${encodeURIComponent(id)}?compose=1`, { state: fromListState() });
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorText(t, e, network));
      setBusy(null);
    }
  };

  const start = (user: Parameters<typeof api.startChat>[1], key: string) =>
    run(key, async () => {
      const chat = await api.startChat(account.accountID, user);
      opened(chat.id, chat);
    });

  const pick = (x: Contact) => {
    if (group) {
      setPicked((p) => (p.some((y) => y.id === x.id) ? p.filter((y) => y.id !== x.id) : [...p, x]));
      return;
    }
    // An account of existing conversations only: the "contact" is the conversation itself; nothing is created.
    if (c?.existingOnly) return opened(x.id);
    // Someone one already talks with: their chat, as it is (chats/start could send a message on some networks).
    if (x.chatID) return opened(x.chatID);
    if (SENDS_FIRST.has(network) && confirm?.id !== x.id) return setConfirm(x);
    setConfirm(null);
    void start({ id: x.id, ...(x.username ? { username: x.username } : {}), ...(x.phoneNumber ? { phoneNumber: x.phoneNumber } : {}), ...(x.email ? { email: x.email } : {}), ...(x.fullName ? { fullName: x.fullName } : {}) }, x.id);
  };

  const g = c?.group;
  const groupProblem = !g
    ? undefined
    : picked.length < g.min
      ? t.newChat.needAtLeast(g.min)
      : picked.length > g.max
        ? t.newChat.atMost(g.max)
        : g.nameRequired && !title.trim()
          ? t.newChat.nameRequired
          : undefined;
  const createGroup = () =>
    run('group', async () => {
      const chat = await api.createChat({
        accountID: account.accountID,
        type: 'group',
        participantIDs: picked.map((p) => p.id),
        ...(g?.nameAllowed && title.trim() ? { title: title.trim() } : {}),
      });
      opened(chat.id, chat);
    });

  if (caps.isPending) return <p className="newchat-note">{t.common.loading}</p>;
  if (!c) {
    return (
      <p className="newchat-note newchat-error" role="alert">
        {t.newChat.errGeneric}{' '}
        <button type="button" className="text-btn" onClick={() => void caps.refetch()}>
          {t.common.retry}
        </button>
      </p>
    );
  }

  const startExact = (id: Identifier) =>
    start(id.kind === 'phone' ? { phoneNumber: id.value } : id.kind === 'email' ? { email: id.value } : { username: id.value }, 'exact');

  return (
    <div className="newchat-step" data-testid="newchat-step" data-account={account.accountID}>
      {!c.connected && <p className="newchat-note">{t.newChat.disconnected}</p>}
      {c.existingOnly && <p className="newchat-note">{t.newChat.existingOnly(network)}</p>}
      {!canDirect && !canGroup && <p className="newchat-note">{t.newChat.cannotStart(network)}</p>}
      <div className="newchat-search">
        <input
          type="search"
          value={input}
          placeholder={t.newChat.search(network)}
          aria-label={t.newChat.search(network)}
          data-testid="newchat-search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={200}
          autoFocus={focusSearch}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>
      <div className="newchat-hintrow">
        <p className={`newchat-hint ${lookup?.exact ? 'exact' : ''}`} data-testid="newchat-hint">
          {lookup ? lookup.text : !query ? t.newChat.searchHint : ' '}
        </p>
        {canGroup && (
          <button
            type="button"
            className={`text-btn newchat-mode ${group ? 'on' : ''}`}
            aria-pressed={group}
            data-testid="newchat-group-toggle"
            onClick={() => {
              setGroup(!group);
              setError(undefined);
            }}
          >
            {group ? t.newChat.directChat : t.newChat.newGroup}
          </button>
        )}
      </div>

      {group && g && (
        <div className="newchat-group" data-testid="newchat-group">
          {g.nameAllowed && (
            <input
              type="text"
              className="newchat-title"
              value={title}
              maxLength={g.nameMax}
              placeholder={g.nameRequired ? t.newChat.groupName : t.newChat.groupNameOptional}
              aria-label={g.nameRequired ? t.newChat.groupName : t.newChat.groupNameOptional}
              data-testid="newchat-title"
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
          {picked.length > 0 && (
            <ul className="newchat-picked" aria-label={t.newChat.selected(picked.length)}>
              {picked.map((p) => (
                <li key={p.id}>
                  <button type="button" className="newchat-pill" aria-label={t.newChat.removePerson(display(p))} onClick={() => pick(p)}>
                    <span className="newchat-pill-name">{display(p)}</span>
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="newchat-group-foot">
            <span className="newchat-count" data-testid="newchat-count">{groupProblem ?? t.newChat.selected(picked.length)}</span>
            <button type="button" className="text-btn primary" data-testid="newchat-create" disabled={!!groupProblem || !!busy} onClick={() => void createGroup()}>
              {busy === 'group' ? t.newChat.creating : t.newChat.createGroup}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="newchat-error" role="alert" data-testid="newchat-error">
          {error}
        </p>
      )}
      {confirm && (
        <div className="newchat-confirm" role="alert" data-testid="newchat-confirm">
          <p>{t.newChat.firstMessage(network, display(confirm))}</p>
          <div className="newchat-confirm-actions">
            <button type="button" className="text-btn" data-testid="newchat-confirm-cancel" onClick={() => setConfirm(null)}>
              {t.common.cancel}
            </button>
            <button type="button" className="text-btn primary" data-testid="newchat-confirm-go" onClick={() => pick(confirm)}>
              {t.newChat.firstMessageGo}
            </button>
          </div>
        </div>
      )}

      {(query || c.contactList) && <h3 className="search-h">{query ? t.newChat.results : t.newChat.contacts}</h3>}
      {!query && !c.contactList && !c.existingOnly && <p className="newchat-note">{t.newChat.noContactList}</p>}
      {loading && !items.length ? (
        <p className="newchat-note" data-testid="newchat-loading">
          {t.newChat.searching} <span className="newchat-slow">{t.newChat.slowNetwork}</span>
        </p>
      ) : failed && !items.length ? (
        <p className="newchat-note newchat-error">{t.newChat.errSearch}</p>
      ) : (
        <ul className="newchat-results" data-testid="newchat-results">
          {items.map((x) => {
            const on = picked.some((y) => y.id === x.id);
            const off = (!group && !canDirect) || (x.cannotMessage === true && !group);
            return (
              <li key={x.id}>
                <button
                  type="button"
                  className={`contact-row ${on ? 'on' : ''}`}
                  role={group ? 'checkbox' : undefined}
                  aria-checked={group ? on : undefined}
                  disabled={off || (!!busy && busy !== x.id)}
                  data-testid="contact-row"
                  data-contact-id={x.id}
                  onClick={() => pick(x)}
                >
                  <ContactAvatar c={x} />
                  <span className="contact-main">
                    <span className="contact-name">
                      {display(x)}
                      {x.inChats && (
                        <span className="contact-known" data-testid="contact-known">
                          {t.newChat.inChats}
                        </span>
                      )}
                    </span>
                    <span className="contact-sub">{x.cannotMessage ? t.newChat.cannotMessage : subline(x)}</span>
                  </span>
                  {busy === x.id && <span className="contact-busy">{t.newChat.opening}</span>}
                  {group && <span className={`contact-check ${on ? 'on' : ''}`} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {query && search.isSuccess && !items.length && (
        <div className="newchat-empty" data-testid="newchat-empty">
          <p className="newchat-note">{t.newChat.noResults}</p>
          {ident && lookup?.exact && c.start && !group && (
            <button type="button" className="text-btn" data-testid="newchat-start-exact" disabled={!!busy} onClick={() => void startExact(ident)}>
              {busy === 'exact' ? t.newChat.opening : t.newChat.startWith(ident.value)}
            </button>
          )}
        </div>
      )}
      {!query && list.hasNextPage && (
        <button type="button" className="text-btn newchat-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {list.isFetchingNextPage ? t.common.loading : t.newChat.moreContacts}
        </button>
      )}
    </div>
  );
}

function ContactAvatar({ c }: { c: Contact }) {
  const src = mediaUrl(c.imgURL);
  const [failed, setFailed] = useState(false);
  return (
    <span className="avatar" style={{ width: 40, height: 40 }}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" width={40} height={40} onError={() => setFailed(true)} />
      ) : (
        <span className="avatar-fallback" style={{ backgroundColor: `hsl(${hue(c.id)} 35% 45%)`, fontSize: 15 }}>
          {initials(display(c))}
        </span>
      )}
    </span>
  );
}
