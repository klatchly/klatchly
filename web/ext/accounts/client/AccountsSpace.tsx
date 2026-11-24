import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { dateTimeOf, fileSize, HttpError, localized, NetworkBadge, networkName, relativeTime, request, useLang } from '../../../client/src/sdk';
import type { SettingsBodyProps } from '../../../client/src/sdk';
import type { AccountReply, AccountStats, AccountView, Capability, Health, QrReply, RecentChat, SourceName, StatsResult } from '../shapes';
import { NETWORKS_SETTINGS } from '../package';
import { accountSlug, slugAccount } from '../slug';
import { useT, type T } from './i18n';
import { overview, overviewKey } from './launch';
import './accounts.css';

// The accounts package's chunk (index.tsx names its parts): every messaging account Klatchly reaches, read-only, as a
// page of Settings (Settings → Networks, since 1.2: the sidebar button is gone). The page lists the accounts (one
// card each: status, identity, figures); /settings/ext/accounts/networks/<account> is one account (status, identity,
// figures, capabilities in plain words, its recent chats, which open in the chat view). The space's old URLs
// (/networks, /networks/<account>) send on to the same places. Refreshed when shown and every 30 s while shown;
// nothing here changes anything.

const POLL = 30_000;

const accountsKeys = {
  overview: overviewKey,
  stats: ['networks', 'stats'] as const,
  account: (slug: string) => ['networks', 'account', slug] as const,
};

const api = {
  stats: () => request<StatsResult>('GET', '/networks/stats'),
  account: (slug: string) => request<AccountReply>('GET', `/networks/account/${slug}`),
  qr: (source: string) => request<QrReply>('GET', `/networks/qr/${encodeURIComponent(source)}`),
};

function useOverview() {
  return useQuery({ queryKey: accountsKeys.overview, queryFn: overview, staleTime: 10_000, refetchInterval: POLL });
}
function useStats() {
  return useQuery({ queryKey: accountsKeys.stats, queryFn: api.stats, staleTime: 30_000, refetchInterval: 2 * POLL });
}

const hrefOf = (a: { accountID: string }) => `${NETWORKS_SETTINGS}/${accountSlug(a.accountID)}`;

function useOpen() {
  const [, navigate] = useLocation();
  return (to: string) => (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
}

/** The account's own name, then its handle (phone, email when it has nothing else). */
function identityOf(a: AccountView): { name: string; handle?: string } {
  const { fullName, username, phoneNumber, email } = a.user;
  const handle = username ? (username.startsWith('@') || username.includes(':') ? username : `@${username}`) : (phoneNumber ?? email);
  if (fullName) return { name: fullName, ...(handle ? { handle } : {}) };
  if (handle) return { name: handle };
  return { name: networkName(a.network) };
}

function statusLabel(t: T, a: AccountView): string {
  if (a.health === 'trouble' && (a.status === 'connecting' || a.status === 'unknown')) return t.accounts.stuck;
  return t.accounts.status[a.status];
}

function Pill({ a }: { a: AccountView }) {
  const t = useT();
  const cls: Record<Health, string> = { ok: 'on', busy: 'acc-busy', trouble: 'dead', off: '' };
  return (
    <span className={`space-pill ${cls[a.health]}`} data-testid="acc-pill" data-health={a.health}>
      {statusLabel(t, a)}
    </span>
  );
}

function Tile({ a, size = 22 }: { a: AccountView; size?: number }) {
  return (
    <span className={`acc-tile ${a.health}`} aria-hidden="true">
      <NetworkBadge network={a.network} size={size} />
      <span className={`acc-dot ${a.health}`} />
    </span>
  );
}

function RefreshButton() {
  const t = useT();
  const qc = useQueryClient();
  const q = useOverview();
  return (
    <button
      type="button"
      className={`icon-btn ${q.isFetching ? 'acc-spinning' : ''}`}
      aria-label={t.accounts.refresh}
      title={t.accounts.refresh}
      data-testid="acc-refresh"
      onClick={() => void qc.invalidateQueries({ queryKey: ['networks'] })}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function Skeleton() {
  return (
    <div className="space-skeleton" aria-hidden="true">
      <div className="skeleton-line" />
      <div className="skeleton-line short" />
      <div className="skeleton-line" />
    </div>
  );
}

// ── The Settings page, and the space's old URLs ──

/** Settings → Networks: every account (no sub), or one (its slug). */
export function AccountsSettings({ sub }: SettingsBodyProps) {
  const id = sub ? slugAccount(sub) : null;
  return sub ? <AccountPage key={sub} slug={sub} known={id !== null} /> : <Dashboard />;
}

/** The space's old pages (/networks, /networks/<account>): on to the same place in Settings. */
function useToSettings(place?: string) {
  const [, navigate] = useLocation();
  useEffect(() => navigate(place ? `${NETWORKS_SETTINGS}/${place}` : NETWORKS_SETTINGS, { replace: true }), [navigate, place]);
}
export function AccountsRedirectList() {
  useToSettings();
  return null;
}
export function AccountsRedirectMain({ place }: { place?: string }) {
  useToSettings(place);
  return null;
}

function BackLink() {
  const t = useT();
  const open = useOpen();
  return (
    <a href={NETWORKS_SETTINGS} className="acc-back" data-testid="acc-back" onClick={open(NETWORKS_SETTINGS)}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {t.accounts.allNetworks}
    </a>
  );
}

function useNumber() {
  const lang = useLang();
  const f = new Intl.NumberFormat(lang);
  return (n: number) => f.format(n);
}

/** The figures of an account, as tiles: chats, unread, low priority, archived. */
function Figures({ s, compact }: { s: AccountStats | undefined | null; compact?: boolean }) {
  const t = useT();
  const num = useNumber();
  if (!s) return <div className={`acc-figures ${compact ? 'compact' : ''} loading`} aria-hidden="true" />;
  const items: [string, number, string][] = [
    ['chats', s.chats, t.accounts.chats(s.chats)],
    ['unread', s.unreadChats, t.accounts.unread(s.unreadChats)],
    ['lowpri', s.lowPriority, t.accounts.lowPriority(s.lowPriority)],
    ['archived', s.archived, t.accounts.archived(s.archived)],
  ];
  return (
    <ul className={`acc-figures ${compact ? 'compact' : ''}`} data-testid="acc-figures">
      {items.map(([k, n, label]) => (
        <li key={k} className={`acc-figure ${k} ${n ? '' : 'zero'}`} aria-label={label}>
          <span className="acc-figure-n">{num(n)}</span>
          <span className="acc-figure-label">{label.replace(/^[\d\s.,  ]+/, '')}</span>
        </li>
      ))}
    </ul>
  );
}

function sinceText(t: T, a: AccountView): string {
  return t.accounts.since(relativeTime(a.since));
}

/** A source's name and its own reconnect hint in the user's language, when it has them. */
function useSourceName(source: SourceName | undefined): string | undefined {
  const lang = useLang();
  return source?.name ? localized(source.name, lang) : undefined;
}
function useSourceHint(source: SourceName | undefined): string | undefined {
  const lang = useLang();
  return source?.hint ? localized(source.hint, lang) : undefined;
}

/** Where an account runs: its bridge's place when the source says (Desktop API), else its source. */
function whereOf(t: T, a: AccountView, sourceName: string | undefined): string | undefined {
  return a.bridge?.provider ? t.accounts.provider[a.bridge.provider] : sourceName;
}

/** What to do for an account in trouble: its source's own words, else where (its source's name). */
function Trouble({ a, source }: { a: AccountView; source: SourceName | undefined }) {
  const t = useT();
  const name = useSourceName(source);
  const hint = useSourceHint(source);
  if (a.health !== 'trouble') return null;
  return (
    <p className="space-banner warn acc-hint" data-testid="acc-hint">
      {hint ?? (name ? t.accounts.hint(name) : t.accounts.hintAnywhere)}
    </p>
  );
}

/**
 * The QR code that signs a source's session in again (a bridge on the server, e.g. a chat connector's gateway), shown on demand while
 * the account is in trouble: refreshed every few seconds (a code expires within two minutes); once signed in, the
 * account's figures are read again.
 */
function LoginQr({ a, source }: { a: AccountView; source: SourceName | undefined }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // Once the code says signed in, the page keeps asking (every 2.5 s, 30 s at most) until the account shows it.
  const [signedAt, setSignedAt] = useState(0);
  const confirming = signedAt > 0 && a.health !== 'ok' && Date.now() - signedAt < 30_000;
  const q = useQuery({
    queryKey: ['networks', 'qr', source?.id],
    queryFn: async () => {
      const r = await api.qr(source!.id);
      // The account again (not this query: it would ask once more, and again).
      if (r.status === 'logged_in') {
        setSignedAt((t0) => t0 || Date.now());
        void qc.invalidateQueries({ queryKey: ['networks'], predicate: (x) => x.queryKey[1] !== 'qr' });
      }
      return r;
    },
    enabled: open && !!source?.qr,
    refetchInterval: (query) => (query.state.data?.status !== 'logged_in' || confirming ? 2500 : false),
    gcTime: 0,
  });
  if (!source?.qr || (a.health !== 'trouble' && !open)) return null;
  const qr = q.data;
  const note = q.isError
    ? t.accounts.qr.failed
    : !qr || qr.status === 'generating' || (qr.status === 'waiting' && !qr.image)
      ? t.accounts.qr.generating
      : qr.status === 'waiting'
        ? t.accounts.qr.howTo
        : qr.status === 'logged_in' && a.health !== 'ok'
          ? t.accounts.qr.confirming
          : t.accounts.qr[({ scanned: 'scanned', logged_in: 'loggedIn', expired: 'expired', declined: 'declined', none: 'none' } as const)[qr.status]];
  return (
    <div className="acc-qr" data-testid="acc-qr">
      <button type="button" className="text-btn primary" data-testid="acc-qr-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? t.accounts.qr.hide : t.accounts.qr.show}
      </button>
      {open && (
        <div className="acc-qr-body">
          {qr?.status === 'waiting' && qr.image && (
            <img className="acc-qr-img" src={`data:image/png;base64,${qr.image}`} alt={t.accounts.qr.alt} width={256} height={256} data-testid="acc-qr-img" />
          )}
          <p className="acc-qr-note" role="status" data-testid="acc-qr-note" data-status={q.isError ? 'error' : qr?.status === 'logged_in' && a.health !== 'ok' ? 'confirming' : (qr?.status ?? 'loading')}>
            {note}
          </p>
        </div>
      )}
    </div>
  );
}

/** The sources that did not answer (their accounts are missing from the list). */
function SourcesDown({ sources }: { sources: readonly SourceName[] }) {
  const t = useT();
  const lang = useLang();
  const down = sources.filter((x) => !x.ok);
  return (
    <>
      {down.map((x) => (
        <p key={x.id} className="space-banner warn" data-testid="acc-source-down">
          {t.accounts.sourceDown(x.name ? localized(x.name, lang) : t.accounts.sourceUnnamed)}
        </p>
      ))}
    </>
  );
}

function Card({ a, s, source }: { a: AccountView; s: AccountStats | undefined; source: SourceName | undefined }) {
  const t = useT();
  const open = useOpen();
  const id = identityOf(a);
  const sourceName = useSourceName(source);
  const where = whereOf(t, a, sourceName);
  return (
    <li className={`space-card acc-card ${a.health === 'trouble' ? 'is-dead' : ''}`} data-testid="acc-card" data-health={a.health}>
      <a className="acc-card-link" href={hrefOf(a)} onClick={open(hrefOf(a))} data-testid="acc-card-link">
        <span className="acc-card-head">
          <Tile a={a} size={26} />
          <span className="acc-card-title">
            <span className="acc-card-net">{networkName(a.network)}</span>
            <span className="acc-card-who">
              {id.name}
              {id.handle && <span className="acc-handle"> · {id.handle}</span>}
            </span>
          </span>
          <Pill a={a} />
        </span>
        {(a.statusText || a.health !== 'ok') && (
          <span className="acc-status-line">
            {a.statusText ?? statusLabel(t, a)} <span className="acc-since" title={t.accounts.sinceNote}>· {sinceText(t, a)}</span>
          </span>
        )}
        <Figures s={s} compact />
        <span className="acc-card-foot">
          <span>{s ? (s.lastActivity ? t.accounts.lastActivity(relativeTime(s.lastActivity)) : t.accounts.noActivity) : ' '}</span>
          {where && <span className="acc-where">{where}</span>}
        </span>
      </a>
      <Trouble a={a} source={source} />
    </li>
  );
}

function Dashboard() {
  const t = useT();
  const q = useOverview();
  const stats = useStats().data;
  const accounts = q.data?.accounts ?? [];
  const num = useNumber();
  const total = Object.values(stats?.byAccount ?? {}).reduce((n, s) => n + s.chats, 0);
  const unread = Object.values(stats?.byAccount ?? {}).reduce((n, s) => n + s.unreadChats, 0);

  return (
    <div className="acc-settings" data-testid="acc-dashboard">
      <div className="acc-settings-top">
        <p className="space-note">{t.accounts.subtitle}</p>
        <RefreshButton />
      </div>
      <div className="acc-settings-body">
        {!q.data ? (
          q.isError ? <p className="space-banner warn">{t.accounts.unavailable}</p> : <Skeleton />
        ) : (
          <>
            <div className="acc-summary" data-testid="acc-summary">
              <span className="acc-stat">
                <span className={`acc-dot ${q.data.trouble ? 'trouble' : 'ok'}`} aria-hidden="true" />
                {q.data.trouble ? t.accounts.troubleCount(q.data.trouble) : t.accounts.allFine}
              </span>
              <span className="acc-stat">{t.accounts.summary(accounts.length)}</span>
              {stats && <span className="acc-stat">{t.accounts.chats(total).replace(/^\d+/, num(total))}</span>}
              {stats && unread > 0 && <span className="acc-stat">{t.accounts.unread(unread)}</span>}
            </div>
            <SourcesDown sources={q.data.sources} />
            {stats && !stats.complete && <p className="space-note">{t.accounts.partial}</p>}
            {accounts.length === 0 ? (
              <p className="space-note">{t.accounts.empty}</p>
            ) : (
              <ul className="acc-grid" data-testid="acc-grid">
                {accounts.map((a) => (
                  <Card key={a.accountID} a={a} s={stats?.byAccount[a.accountID]} source={q.data.sources.find((x) => x.id === a.source)} />
                ))}
              </ul>
            )}
            <p className="space-note acc-readonly">{t.accounts.readOnly}</p>
          </>
        )}
      </div>
    </div>
  );
}

// ── One account ──

function capabilityText(t: T, c: Capability, lang: string): string | undefined {
  const num = (n: number) => new Intl.NumberFormat(lang).format(n);
  if (c.key === 'maxTextLength' && c.limit) return t.accounts.maxChars(num(c.limit));
  if (c.key === 'attachments' && c.kinds?.length) {
    const kinds = c.kinds.map((k) => t.accounts.kinds[k]).join(', ');
    return c.limit ? `${kinds} · ${t.accounts.upTo(fileSize(c.limit))}` : kinds;
  }
  return undefined;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="acc-kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ChatRow({ c }: { c: RecentChat }) {
  const t = useT();
  const [, navigate] = useLocation();
  const href = `/chat/${encodeURIComponent(c.id)}`;
  const title = c.title || t.accounts.untitled;
  return (
    <li>
      <a
        href={href}
        className={`chat-row acc-chat ${c.unreadCount ? 'unread' : ''}`}
        data-testid="acc-chat"
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          navigate(href);
        }}
      >
        <span className="chat-row-main">
          <span className="chat-row-top">
            <span className="chat-title">{title}</span>
            {c.lastActivity && <span className="chat-time">{relativeTime(c.lastActivity)}</span>}
          </span>
          <span className="chat-row-bottom">
            <span className="chat-preview">
              {[c.type === 'group' ? t.accounts.group : null, c.isArchived ? t.shell.archives : c.isLowPriority ? t.shell.lowPriority : null]
                .filter(Boolean)
                .join(' · ') || ' '}
            </span>
            {c.unreadCount > 0 && <span className={`badge ${c.isMuted ? 'badge-muted' : ''}`}>{c.unreadCount}</span>}
          </span>
        </span>
      </a>
    </li>
  );
}

function AccountPage({ slug, known }: { slug: string; known: boolean }) {
  const t = useT();
  const lang = useLang();
  const q = useQuery({
    queryKey: accountsKeys.account(slug),
    queryFn: () => api.account(slug),
    enabled: known,
    staleTime: 10_000,
    refetchInterval: POLL,
    retry: (n, e) => !(e instanceof HttpError && (e.status === 404 || e.status === 400)) && n < 2,
  });
  const gone = !known || (q.error instanceof HttpError && (q.error.status === 404 || q.error.status === 400));
  const sourceDown = q.error instanceof HttpError && q.error.code === 'source_down';
  const d = q.data;
  const sourceName = useSourceName(d?.source);

  if (!d) {
    return (
      <div className="acc-settings" data-testid="acc-detail">
        <BackLink />
        <div className="acc-settings-body">
          {gone ? (
            <p className="space-note" data-testid="acc-not-found">
              {t.accounts.notFound}
            </p>
          ) : sourceDown ? (
            <p className="space-banner warn" data-testid="acc-source-down">
              {t.accounts.accountSourceDown}
            </p>
          ) : q.isError ? (
            <p className="space-banner warn">{t.accounts.unavailable}</p>
          ) : (
            <Skeleton />
          )}
        </div>
      </div>
    );
  }

  const a = d.account;
  const id = identityOf(a);
  const where = whereOf(t, a, sourceName);
  return (
    <div className="acc-settings" data-testid="acc-detail" data-account={a.accountID}>
      <BackLink />
      <header className="acc-detail-head">
        <Tile a={a} size={24} />
        <div className="acc-card-title">
          <span className="acc-card-net">{networkName(a.network)}</span>
          <span className="acc-card-who">{id.name}</span>
        </div>
        <span className="acc-head-pill">
          <Pill a={a} />
        </span>
      </header>
      <div className="acc-settings-body">
        <section className="space-block" aria-labelledby="acc-status-h">
          <h2 id="acc-status-h" className="space-h">
            {t.accounts.identity}
          </h2>
          <div className="space-card">
            <p className="acc-status-big">
              <span className={`acc-dot ${a.health}`} aria-hidden="true" />
              <span>
                <strong>{statusLabel(t, a)}</strong>
                {a.statusText && a.statusText !== statusLabel(t, a) && <span className="acc-status-text"> · {a.statusText}</span>}
                <span className="acc-since" title={dateTimeOf(a.since)}>
                  {' '}
                  · {sinceText(t, a)}
                </span>
              </span>
            </p>
            <Trouble a={a} source={d.source} />
            <LoginQr a={a} source={d.source} />
            <dl className="acc-kvs">
              {a.user.fullName && <Row label={t.accounts.name}>{a.user.fullName}</Row>}
              {a.user.username && <Row label={t.accounts.handle}>{a.user.username}</Row>}
              {a.user.phoneNumber && <Row label={t.accounts.phone}>{a.user.phoneNumber}</Row>}
              {a.user.email && <Row label={t.accounts.email}>{a.user.email}</Row>}
              <Row label={t.accounts.network}>
                <span className="acc-net-inline">
                  <NetworkBadge network={a.network} size={14} /> {networkName(a.network)}
                </span>
              </Row>
              {where && <Row label={t.accounts.runsOn}>{where}</Row>}
            </dl>
            <p className="space-note">{t.accounts.sinceNote}</p>
          </div>
        </section>

        <section className="space-block" aria-labelledby="acc-figures-h">
          <h2 id="acc-figures-h" className="space-h">
            {t.accounts.figures}
          </h2>
          <Figures s={d.stats} />
          {d.stats && (
            <p className="space-note">
              {[t.accounts.groups(d.stats.groups), t.accounts.muted(d.stats.muted), d.stats.lastActivity ? t.accounts.lastActivity(relativeTime(d.stats.lastActivity)) : t.accounts.noActivity].join(' · ')}
            </p>
          )}
        </section>

        <section className="space-block" aria-labelledby="acc-recent-h">
          <h2 id="acc-recent-h" className="space-h">
            {t.accounts.recent} <span className="space-count">{d.recent.length}</span>
          </h2>
          {d.recent.length ? (
            <ul className="space-convs boxed acc-chats" data-testid="acc-recent">
              {d.recent.map((c) => (
                <ChatRow key={c.id} c={c} />
              ))}
            </ul>
          ) : (
            <p className="space-note">{t.accounts.noRecent}</p>
          )}
        </section>

        <section className="space-block" aria-labelledby="acc-caps-h">
          <h2 id="acc-caps-h" className="space-h">
            {t.accounts.capabilities}
          </h2>
          {d.capabilities.length ? (
            <ul className="space-card acc-caps" data-testid="acc-caps">
              {d.capabilities.map((c) => {
                const detail = capabilityText(t, c, lang);
                return (
                  <li key={c.key} className={`acc-cap ${c.supported ? 'yes' : 'no'}`} data-cap={c.key}>
                    <span className="acc-cap-mark" aria-hidden="true">
                      {c.supported ? '✓' : '–'}
                    </span>
                    <span className="acc-cap-name">
                      {t.accounts.cap[c.key]}
                      {detail && <span className="acc-cap-detail">{detail}</span>}
                    </span>
                    <span className="acc-cap-state">{c.supported ? t.accounts.supported : t.accounts.notSupported}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="space-note">{t.accounts.noCapabilities}</p>
          )}
        </section>
        <p className="space-note acc-readonly">{t.accounts.readOnly}</p>
      </div>
    </div>
  );
}
