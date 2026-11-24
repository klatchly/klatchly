import { useEffect, useRef, useState, type ComponentType, type MouseEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import type { ExtensionsDetails } from '../../server/extension';
import { api, request } from './endpoints';
import { refreshApp } from './appupdate';
import { viewportReport } from './viewport';
import { LOCALES } from './catalogs';
import { localized, setLang, useLang, useT } from './i18n';
import type { SettingsBodyProps } from './extension';
import { Lazy, lazyChunk } from './lazy';
import { goBack, openSettingsPage, phoneLayout } from './nav';
import { useSettingsSections } from './registry';
import { samePlace, settingsAt, settingsHref, type CorePage, type SettingsPlace } from './settingsroute';
import { disablePush, enablePush, isIOS, isStandalone, pushState, resyncPush, type PushState } from './push';
import './settings.css';

// Settings: its menu in the list column (SettingsMenu, like a space's list) and one page at a time in the pane
// (SettingsMain); their headers, with Back, are Shell.tsx's, outside this chunk. The core's five pages first
// (Général, Lecture discrète, Heures calmes, Application, Extensions); then the pages of the packages that are on, under each package's name. A page
// is a centred column of groups (cards) of rows, the label and its help on the left, the control on the right
// (stacked on a phone); what a row opens (a form) goes under both, full width.

// Settings → Extensions: its own chunk (strings, styles), fetched when that page opens.
const ExtensionsSettings = lazyChunk(() => import('./Extensions'), 'ExtensionsSettings');
// Général → Connexion (how one signs in: passkey, password and its second factor, none): its own chunk too.
const SignInRow = lazyChunk(() => import('./SignInSettings'), 'SignInRow');
// Lecture discrète (read without telling the sender: per account, per conversation): its own page and chunk.
const ReadingSettings = lazyChunk(() => import('./ReadingSettings'), 'ReadingSettings');
// Heures calmes (quiet hours: per network, per conversation): its own page and chunk.
const QuietSettings = lazyChunk(() => import('./QuietSettings'), 'QuietSettings');

type T = ReturnType<typeof useT>;

// ── Marks of the core's entries (20 px, currentColor) ──

const icon = (d: string) =>
  function Icon() {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  };
const SlidersIcon = icon('M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5');
const AppIcon = icon('M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM10.5 18h3');
// An eye struck through, as the conversation header's mark of a chat read discreetly (reading.tsx DiscreetMark).
const EyeOffIcon = icon(
  'M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c5 0 8.5 4.5 9.5 7a13 13 0 0 1-2.6 3.8M6.6 6.6C4.6 8 3.2 10 2.5 12c1 2.5 4.5 7 9.5 7 1.9 0 3.6-.6 5-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
);
const QuietIcon = icon('M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z');
const PuzzleIcon = icon(
  'M9 4.5a2 2 0 1 1 4 0V6h3.5a1 1 0 0 1 1 1v3.5H19a2 2 0 1 1 0 4h-1.5V18a1 1 0 0 1-1 1H13v-1.5a2 2 0 1 0-4 0V19H5.5a1 1 0 0 1-1-1v-3.5H6a2 2 0 1 0 0-4H4.5V7a1 1 0 0 1 1-1H9z',
);

/** The core's entries, in menu order (settingsroute.ts CORE_PAGES has the same ids). */
const CORE: { id: CorePage; label: (t: T) => string; Icon: ComponentType }[] = [
  { id: 'general', label: (t) => t.settings.general, Icon: SlidersIcon },
  { id: 'reading', label: (t) => t.reading.title, Icon: EyeOffIcon },
  { id: 'quiet', label: (t) => t.quiet.title, Icon: QuietIcon },
  { id: 'app', label: (t) => t.settings.app, Icon: AppIcon },
  { id: 'extensions', label: (t) => t.settings.extensions, Icon: PuzzleIcon },
];

/** The page beside the menu on /settings (wide screen). */
const FIRST: SettingsPlace = { core: 'general' };

/** The page the pane shows: the URL's, else (on /settings, wide screen) the first one. */
function useShown(): { place: SettingsPlace | undefined; shown: SettingsPlace } {
  const [path] = useLocation();
  const place = settingsAt(path)?.place;
  return { place, shown: place ?? FIRST };
}

// ── Left column: the menu ──

/** The menu (its header, with Close out of Settings, is Shell.tsx's). */
export function SettingsMenu() {
  const t = useT();
  const lang = useLang();
  const [, navigate] = useLocation();
  const { place, shown } = useShown();
  const sections = useSettingsSections();
  // The packages' names (their about, server side): the headers of their entries.
  const details = useQuery({ queryKey: ['extensions', 'details'], queryFn: () => request<ExtensionsDetails>('GET', '/extensions/details'), staleTime: 60_000 }).data;
  // Wide screen on /settings: the first page shows beside the menu, so its entry is the current one.
  const current = place ?? (phoneLayout() ? undefined : shown);

  const open = (href: string, shown: boolean) => (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    // Not while a page slides back to the menu (phone): the tap would race its Back.
    if (document.querySelector('.shell.swiping')) return;
    openSettingsPage(navigate, href, shown);
  };
  const row = (p: SettingsPlace, label: string, Icon: ComponentType, testid: string, useBadge?: () => number) => {
    const href = settingsHref(p);
    const on = samePlace(p, current);
    return (
      <li key={href}>
        <a href={href} className={`chat-row settings-item ${on ? 'active' : ''}`} aria-current={on ? 'page' : undefined} data-testid={`settings-item-${testid}`} onClick={open(href, on)}>
          <span className="settings-item-icon" aria-hidden="true">
            <Icon />
          </span>
          <span className="settings-item-label">{label}</span>
          {useBadge && <EntryCount use={useBadge} />}
          <svg className="settings-item-go" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      </li>
    );
  };

  // The packages that are on, each with its pages, in the packages' order (registry.ts).
  const byPkg = new Map<string, NonNullable<typeof sections>[number][]>();
  for (const x of sections ?? []) if (x.active) byPkg.set(x.pkg, [...(byPkg.get(x.pkg) ?? []), x]);
  const nameOf = (pkg: string) => {
    const about = details?.packages.find((p) => p.id === pkg)?.about;
    return about ? localized(about.name, lang) : pkg;
  };

  return (
    <div className="space-scroll settings-menu-scroll">
      <nav aria-label={t.settings.title} data-testid="settings-menu">
        <ul className="settings-items settings-core" data-testid="settings-core">
          {CORE.map((p) => row({ core: p.id }, p.label(t), p.Icon, p.id))}
        </ul>
        {[...byPkg].map(([pkg, list]) => (
          <div key={pkg} className="settings-pkg" role="group" aria-labelledby={`settings-p-${pkg}`} data-testid={`settings-pkg-${pkg}`}>
            <h2 className="space-group" id={`settings-p-${pkg}`}>
              {nameOf(pkg)}
            </h2>
            <ul className="settings-items">
              {list.map(({ section: s }) => row({ pkg, section: s.id }, localized(s.title, lang), s.icon ?? PuzzleIcon, `${pkg}-${s.id}`, s.useBadge))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}

/** A package page's count on its menu entry (SettingsSection.useBadge). */
function EntryCount({ use }: { use: () => number }) {
  const n = use();
  return n > 0 ? (
    <span className="badge settings-item-count" data-testid="settings-item-count">
      {n > 99 ? '99+' : n}
    </span>
  ) : null;
}

// ── Right pane: one page ──

/**
 * One page's body, labelled by the pane's title (Shell.tsx): its groups of rows (Group, Row) or a package's body,
 * centred in a readable width; `wide` for a grid of cards (Extensions). Opened with an anchor (a former page's URL, settingsroute.ts
 * MOVED_PAGES), it scrolls to that block.
 */
function Page({ id, children, wide = false }: { id: string; children: ReactNode; wide?: boolean }) {
  const [path] = useLocation();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const block = location.hash.slice(1);
    if (!/^[a-z]+$/.test(block)) return;
    body.current?.querySelector(`[data-block=${block}]`)?.scrollIntoView({ block: 'start' });
  }, [path]);
  return (
    <div ref={body} className="settings-body settings" data-testid="settings">
      <section className={`settings-content ${wide ? 'wide' : ''}`} aria-labelledby="settings-page-title" data-testid={`settings-${id}`}>
        {children}
      </section>
    </div>
  );
}

/** A card of rows, under its title when it has one. */
export function Group({ title, children, testid }: { title?: string; children: ReactNode; testid?: string }) {
  return (
    <>
      {title && <h2 className="set-group-title">{title}</h2>}
      <div className="set-group" data-testid={testid}>
        {children}
      </div>
    </>
  );
}

/**
 * One setting: its label and short help on the left, its control on the right (under them on a phone), and what
 * it opens (`detail`: a form, a confirmation) under both. `block` is its anchor and test id (a 0.15.7 page id for
 * the core's blocks).
 */
export function Row({ block, label, help, children, detail }: { block: string; label: string; help?: ReactNode; children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="set-row" data-block={block} data-testid={`settings-${block}`} role="group" aria-labelledby={`set-l-${block}`}>
      <div className="set-text">
        <h3 className="set-label" id={`set-l-${block}`}>
          {label}
        </h3>
        {help}
      </div>
      <div className="set-control">{children}</div>
      {detail && <div className="set-detail">{detail}</div>}
    </div>
  );
}

/** The pane on a Settings URL (on /settings itself, wide screen: the first page). */
export function SettingsMain({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const t = useT();
  const { shown } = useShown();
  if ('pkg' in shown) return <PackagePage key={settingsHref(shown)} pkg={shown.pkg} id={shown.section} sub={shown.sub} />;
  switch (shown.core) {
    case 'general':
      return (
        <Page id="general">
          <Group title={t.settings.groupDevice}>
            <LanguageRow />
            <NotificationsRow />
            <SessionRow onSignOut={onSignOut} />
          </Group>
          {/* Last, in its own group (Sécurité): loaded after the page, it must not push down a block opened by its anchor. */}
          <Lazy>
            <SignInRow />
          </Lazy>
        </Page>
      );
    case 'reading':
      return (
        <Page id="reading">
          <Lazy>
            <ReadingSettings />
          </Lazy>
        </Page>
      );
    case 'quiet':
      return (
        <Page id="quiet">
          <Lazy>
            <QuietSettings />
          </Lazy>
        </Page>
      );
    case 'app':
      return (
        <Page id="app">
          <Group>
            <StorageRow />
            <AboutRow />
          </Group>
        </Page>
      );
    case 'extensions':
      return (
        <Page id="extensions" wide>
          {/* Every package of the build, its versions and needs, turned off or on for the whole server. */}
          <Lazy>
            <ExtensionsSettings />
          </Lazy>
        </Page>
      );
  }
}

/** A result or failure line under a row's control. */
export function Note({ text }: { text: string | undefined }) {
  return text ? (
    <p className="settings-note" data-testid="settings-note">
      {text}
    </p>
  ) : null;
}

/** Runs an action of a row: busy meanwhile, the failure line if it throws. */
function useRun() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(undefined);
    try {
      await fn();
    } catch {
      setNote(t.settings.failed);
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, setNote, run };
}

function LanguageRow() {
  const t = useT();
  const lang = useLang();
  const changeLang = (code: string) => {
    setLang(code);
    // Server-generated notification texts follow the device language.
    void pushState().then(
      (s) => {
        if (s === 'on') void resyncPush().catch(() => {});
      },
      () => {},
    );
  };
  return (
    <Row block="language" label={t.settings.language}>
      <div className="lang-picker" role="radiogroup" aria-labelledby="set-l-language">
        {LOCALES.map((l) => (
          <button
            key={l.code}
            type="button"
            role="radio"
            lang={l.code}
            aria-checked={l.code === lang}
            className={`text-btn ${l.code === lang ? 'primary' : ''}`}
            data-testid={`lang-${l.code}`}
            onClick={() => changeLang(l.code)}
          >
            {l.name}
          </button>
        ))}
      </div>
    </Row>
  );
}

function NotificationsRow() {
  const t = useT();
  const [state, setState] = useState<PushState | null>(null);
  const { busy, note, setNote, run } = useRun();
  useEffect(() => {
    pushState().then(setState, () => setState('unsupported'));
  }, []);
  const label: Record<PushState, string> = {
    unsupported: t.settings.unsupported,
    'ios-install': t.settings.iosInstall,
    denied: t.settings.denied,
    off: t.settings.off,
    on: t.settings.on,
  };
  const help = (
    <>
      <p className="settings-state" data-testid="push-state" data-state={state ?? ''}>
        {state ? label[state] : '…'}
      </p>
      <p className="settings-hint">{t.settings.hint}</p>
      {isIOS() && !isStandalone() && <p className="settings-hint">{t.settings.iosHint}</p>}
    </>
  );
  return (
    <Row block="notifications" label={t.settings.notifications} help={help}>
      {(state === 'on' || state === 'off') && (
        <div className="settings-actions">
          {state === 'on' ? (
            <>
              <button
                type="button"
                className="text-btn"
                data-testid="push-test"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const r = await api.pushTest();
                    setNote(r.sent ? t.settings.testSent : t.settings.testNone);
                  })
                }
              >
                {t.settings.test}
              </button>
              <button
                type="button"
                className="text-btn"
                data-testid="push-disable"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await disablePush();
                    setState(await pushState());
                  })
                }
              >
                {t.settings.disable}
              </button>
            </>
          ) : (
            <button type="button" className="text-btn primary" data-testid="push-enable" disabled={busy} onClick={() => run(async () => setState(await enablePush()))}>
              {t.settings.enable}
            </button>
          )}
        </div>
      )}
      <Note text={note} />
    </Row>
  );
}

function SessionRow({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const t = useT();
  const { busy, note, setNote, run } = useRun();
  // Sign-out asks once more: one tap must not end the session by accident.
  const [confirmOut, setConfirmOut] = useState(false);
  return (
    <Row block="account" label={t.settings.session} help={<p className="settings-hint">{t.settings.signOutHint}</p>}>
      <div className="settings-actions" data-testid="signout-row">
        {confirmOut ? (
          <>
            <span className="settings-confirm">{t.settings.signOutConfirm}</span>
            <button type="button" className="text-btn" data-testid="logout-cancel" onClick={() => setConfirmOut(false)}>
              {t.common.cancel}
            </button>
            <button type="button" className="text-btn danger" data-testid="logout-confirm" disabled={busy} onClick={() => run(() => onSignOut().catch(() => setNote(t.settings.signOutFailed)))}>
              {busy ? t.settings.signingOut : t.settings.signOut}
            </button>
          </>
        ) : (
          <button type="button" className="text-btn danger" data-testid="logout" onClick={() => setConfirmOut(true)}>
            {t.settings.signOut}
          </button>
        )}
      </div>
      <Note text={note} />
    </Row>
  );
}

function StorageRow() {
  const t = useT();
  const { busy, note, run } = useRun();
  return (
    <Row block="storage" label={t.settings.storage} help={<p className="settings-hint">{t.settings.refreshHint}</p>}>
      <div className="settings-actions">
        <button type="button" className="text-btn" data-testid="app-refresh" disabled={busy} onClick={() => run(refreshApp)}>
          {t.settings.refresh}
        </button>
      </div>
      <Note text={note} />
    </Row>
  );
}

function AboutRow() {
  const t = useT();
  return (
    <Row block="about" label={t.settings.about} help={<p className="settings-hint settings-diag">{viewportReport()}</p>}>
      <p className="settings-state" data-testid="app-version">
        {t.settings.version(__APP_VERSION__)}
      </p>
    </Row>
  );
}

/**
 * A package's page (extension.ts SettingsSection): its body while its package is on. Before the server has said,
 * a wait; a package off (turned off meanwhile, maybe on another device) or a page this build does not have: the menu.
 */
function PackagePage({ pkg, id, sub }: { pkg: string; id: string; sub?: string }) {
  const [, navigate] = useLocation();
  const sections = useSettingsSections();
  const entry = sections?.find((x) => x.pkg === pkg && x.section.id === id);
  const gone = !!sections && !entry?.active;
  // A place the page does not declare (no segment, or one it does not match): the page itself.
  const known = sub !== undefined && !!entry?.section.segment && new RegExp(`^(?:${entry.section.segment})$`).test(sub);
  const stray = sub !== undefined && !!entry?.active && !known;
  useEffect(() => {
    if (gone) goBack(navigate);
    else if (stray) navigate(settingsHref({ pkg, section: id }), { replace: true });
  }, [gone, stray, navigate, pkg, id]);
  if (!entry?.active || stray) return <Page id={id}>{null}</Page>;
  // SettingsSection.Body gets SettingsBodyProps (API 1.14; a page without places ignores them).
  const Body = entry.section.Body as unknown as ComponentType<SettingsBodyProps>;
  return (
    <Page id={id}>
      <Lazy>
        <Body {...(known ? { sub } : {})} />
      </Lazy>
    </Page>
  );
}
