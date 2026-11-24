import type { ReactNode } from 'react';
import { useLocation } from 'wouter';
import type { ListView } from './ChatList';
import type { SpaceModule } from './extension';
import { spaces, useLowPriorityShown } from './registry';
import { localized, useLang, useT } from './i18n';
import { MoonIcon } from './quiet';

/** A section of the core, or the id of a package's space. */
export type Section = 'chats' | 'lowPriority' | 'quiet' | 'archive' | (string & {});

/** What the tab bar needs from the shell: which optional sections exist, their counts, and how to show a list view. */
export interface SectionsState {
  /** The spaces of the packages that are on, after the chats. */
  spaces: readonly SpaceModule[];
  lowUnread: number;
  /** Quiet hours exist (their tab shows), and how many chats they hold now. */
  quiet: { on: boolean; held: number };
  /** Shows one of the chat lists (inbox, low priority, quiet hours, archives). */
  showList: (view: ListView) => void;
}

function ChatsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
function LowPriorityIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M4 13h4l1.5 2.5h5L16 13h4M4 13l2.5-7h11l2.5 7v6H4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 7.5v4M10.2 9.8l1.8 1.8 1.8-1.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ArchiveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M4 5h16v4H4zM5 9v10h14V9M10 13h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const count = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * The sections as a tab bar, shared by every sidebar header: the active one is larger and in its own colour,
 * the others grey. Each icon sits in a fixed slot, so switching never moves the bar.
 */
export function SectionTabs({ active, s }: { active: Section; s: SectionsState }) {
  const t = useT();
  const lowPriority = useLowPriorityShown();
  const lang = useLang();
  const [, navigate] = useLocation();
  // The packages' spaces have their own route; the other sections are views of the chat list. Every space of the
  // build counts here, on or not (yet): leaving one always goes back home.
  const routeOf = (id: Section) => spaces.find((x) => x.id === id)?.path;
  const go = (to: Section) => {
    if (to === active) return;
    const path = routeOf(to);
    if (path) {
      // Between spaces, replace: the back gesture leads out of the app's sections, not through each one.
      navigate(path, { replace: !!routeOf(active), state: { fromChats: true } });
      return;
    }
    s.showList(to === 'chats' ? 'inbox' : (to as ListView));
    if (routeOf(active)) navigate('/', { replace: true });
  };
  type Tab = { id: Section; label: string; icon: ReactNode; n?: number; testid: string };
  const chats: Tab = { id: 'chats', label: t.shell.chats, icon: <ChatsIcon />, testid: 'tab-chats' };
  const lists: Tab[] = [
    // Only while a connector that keeps a low-priority inbox is on (registry.ts useLowPriorityShown).
    ...(lowPriority || active === 'lowPriority'
      ? [{ id: 'lowPriority', label: s.lowUnread ? t.shell.lowPriorityUnread(s.lowUnread) : t.shell.lowPriority, icon: <LowPriorityIcon />, n: s.lowUnread, testid: 'open-lowpri' } satisfies Tab]
      : []),
    ...(s.quiet.on || active === 'quiet'
      ? [{ id: 'quiet', label: s.quiet.held ? t.quiet.tabHeld(s.quiet.held) : t.quiet.tab, icon: <MoonIcon />, n: s.quiet.held, testid: 'open-quiet' } satisfies Tab]
      : []),
    { id: 'archive', label: t.shell.archives, icon: <ArchiveIcon />, testid: 'open-archives' },
  ];
  const tab = (x: Tab) => (
    <button
      key={x.id}
      type="button"
      className={`section-tab sec-${x.id} ${x.id === active ? 'active' : ''}`}
      aria-label={x.label}
      aria-current={x.id === active ? 'page' : undefined}
      title={x.label}
      data-testid={x.testid}
      onClick={() => go(x.id)}
    >
      <span className="section-icon">{x.icon}</span>
      {/* The count shows on the active tab too (0.15.7): what is still unread there is worth seeing. */}
      {!!x.n && (
        <span className="icon-count" data-testid={x.id === 'quiet' ? 'quiet-count' : 'lowpri-count'} aria-hidden="true">
          {count(x.n)}
        </span>
      )}
    </button>
  );
  return (
    <nav className="section-tabs" aria-label={t.shell.sections}>
      {tab(chats)}
      {/* A space without a button (SpaceModule.button false: its pages moved to Settings) keeps its routes only. */}
      {s.spaces.filter((x) => x.button !== false).map((x) => (
        <SpaceTab key={x.id} x={x} use={x.useBadge} lang={lang} active={x.id === active} go={go} />
      ))}
      {lists.map(tab)}
    </nav>
  );
}

/** A space's button: its label, and its own count (its useBadge hook) when it has one. */
function SpaceTab({ x, use = noBadge, lang, active, go }: { x: SpaceModule; use?: () => number; lang: string; active: boolean; go: (to: Section) => void }) {
  const n = use();
  const label = n > 0 && x.badgeLabel ? localized(x.badgeLabel, lang)(n) : localized(x.label, lang);
  return (
    <button
      type="button"
      className={`section-tab sec-${x.id} ${active ? 'active' : ''}`}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={label}
      data-testid={`open-${x.id}`}
      onPointerDown={x.List.preload}
      onClick={() => go(x.id)}
    >
      <span className="section-icon">
        <x.icon />
      </span>
      {n > 0 && (
        <span className="icon-count" data-testid={`${x.id}-count`} aria-hidden="true">
          {count(n)}
        </span>
      )}
    </button>
  );
}
const noBadge = () => 0;
