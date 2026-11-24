import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode, type TouchEvent } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { backToList, ChatsSkeleton, fromListState, lang, phoneLayout, relativeTime, useSheetDrag, useToast } from '../../../client/src/sdk';
import { textIn } from '../locales/index';
import { api, type SpaceAgent, type SpaceJob, type SpaceSession, type LocalText } from './api';
import { activeFilterCount, applyFilter, cleanTitle, DEFAULT_HIDE, defaultFilter, OWN_SOURCE, parseFilter, presentSources, previewLine, sourceLabel, type ListFilter } from './listing';
import { useT, type T } from './strings';
import { agentKeys } from './launch';

// Agents space. Agents are Hermes profiles, named and described by the instance's manifest (server/manifest.ts). The left column
// lists the Klatchly conversations of every agent like the chat list (filter by agent, grouped by pinned / today /
// week / older); a row opens like a chat; a long press (touch) or right click opens its menu: rename, pin,
// delete. The right pane shows the agents home when no conversation is open (on a phone it opens from the
// "Your agents" row): one card per agent with what it does, its helpers, recent conversations and a start button.

export function useAgents() {
  return useQuery({ queryKey: agentKeys.agents, queryFn: api.spaceAgents, staleTime: 60_000 });
}
export function useSpaceSessions() {
  return useQuery({ queryKey: agentKeys.sessions, queryFn: api.spaceSessions, staleTime: 10_000 });
}

/** A manifest text (an agent's description…) in the language shown; "" when there is none. */
export const localText = (t: LocalText | null | undefined): string => textIn(t, lang()) ?? '';

/** Display name of an agent (its id until the list is loaded). */
export function agentLabel(agents: SpaceAgent[] | undefined, name: string): string {
  return agents?.find((a) => a.name === name)?.label ?? name;
}

// Agent colours: the manifest's (`color`), else one picked from the agent's id, so that adding or removing an agent
// never changes another's (two agents may then share one: give them colours in the manifest). Saturated enough
// for white initials, readable in both themes.
const PALETTE = ['#7a52c7', '#2f8a7a', '#c0662d', '#3d74b8', '#b4487a', '#6b8a2f', '#8a6a4f'];
export function agentColor(name: string, agents?: SpaceAgent[], main?: string | null): string {
  const own = agents?.find((a) => a.name === name)?.color;
  if (own) return own;
  // The space's main agent (a runtime's own: Hermes') keeps the first colour.
  if (name === main) return PALETTE[0]!;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[1 + (h % (PALETTE.length - 1))]!;
}

/** "Mail Helper" -> "MH", "Hermes" -> "H". */
export function agentInitials(label: string): string {
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0]?.[0] ?? '?')).toUpperCase();
}

export function AgentAvatar({ name, label, size = 44 }: { name: string; label: string; size?: number }) {
  const q = useAgents().data;
  const agents = q?.agents;
  const initials = agentInitials(label);
  return (
    <span className="avatar agent-avatar" style={{ width: size, height: size }} aria-hidden="true" data-agent={name}>
      <span className="avatar-fallback" style={{ background: agentColor(name, agents, q?.main), fontSize: Math.max(8, Math.round(size * (initials.length > 1 ? 0.36 : 0.44))) }}>
        {initials}
      </span>
    </span>
  );
}

/** "12 Nov." in the language shown. */
const shortDate = (ms: number) => new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short' }).format(new Date(ms));

/**
 * A conversation's title as shown (listing.ts cleanTitle: no leading emoji, no "· Nov 12 07:20", "#N" apart), else
 * "Conversation of <date>": never its preview again (the row shows the preview under it).
 */
export function titleParts(s: Pick<SpaceSession, 'title' | 'lastActive'>, t: T): { text: string; suffix: string | null } {
  return cleanTitle(s.title) ?? { text: s.lastActive ? t.agentSpace.conversationOn(shortDate(s.lastActive)) : t.agentSpace.untitled, suffix: null };
}
export function sessionTitle(s: Pick<SpaceSession, 'title' | 'lastActive'>, t: T): string {
  const p = titleParts(s, t);
  return p.suffix ? `${p.text} ${p.suffix}` : p.text;
}
/** The title with Hermes' "#N" in grey, outside the ellipsis. */
export function TitleText({ s }: { s: Pick<SpaceSession, 'title' | 'lastActive'> }) {
  const t = useT();
  const p = titleParts(s, t);
  return (
    <>
      <span className="agent-title-text">{p.text}</span>
      {p.suffix && <span className="agent-title-suffix">{p.suffix}</span>}
    </>
  );
}

// ── Menus and dialogs (shared with the conversation header) ─────────────────

export type MenuAt = { x: number; y: number } | { sheet: true };
type MenuItem = { id: string; label: ReactNode; danger?: boolean; run: () => void };

/** Popover at the pointer, or a bottom sheet on touch (same look as the chat menus). */
export function Menu({ at, title, label, items, onClose, testid }: { at: MenuAt; title?: ReactNode; label: string; items: MenuItem[]; onClose: () => void; testid: string }) {
  const sheet = 'sheet' in at;
  const ref = useSheetDrag(sheet, onClose);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (sheet || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)),
    });
  }, [at, sheet]);
  return (
    <div className={`menu-backdrop ${sheet ? 'sheet-backdrop' : ''}`} onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className={`msg-menu ${sheet ? 'sheet' : 'popover'}`}
        role="menu"
        aria-label={label}
        data-testid={testid}
        style={sheet ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
        onClick={(e) => e.stopPropagation()}
      >
        {sheet && <div className="sheet-grab" aria-hidden="true" />}
        {title && <div className="menu-title">{title}</div>}
        <ul className="menu-list">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                role="menuitem"
                className={it.danger ? 'danger' : undefined}
                data-testid={`${testid}-${it.id}`}
                onClick={() => {
                  onClose();
                  it.run();
                }}
              >
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && ref.current && !ref.current.open) ref.current.showModal();
  }, [open]);
  return ref;
}

function RenameDialog({ session, agent, onDone }: { session: SpaceSession; agent: string; onDone: (title: string | null) => void }) {
  const t = useT();
  const ref = useModal(true);
  const [value, setValue] = useState(session.title ?? '');
  return (
    <dialog ref={ref} className="confirm" aria-label={t.agentSpace.renameTitle} data-testid="agents-rename-dialog" onCancel={() => onDone(null)} onClose={() => onDone(null)}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onDone(value);
        }}
      >
        <p>{t.agentSpace.renameTitle}</p>
        <input
          className="rename-input"
          value={value}
          maxLength={120}
          autoFocus
          enterKeyHint="done"
          aria-label={t.agentSpace.renameTitle}
          data-testid="agents-rename-input"
          placeholder={session.title ?? session.preview ?? ''}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="rename-hint">{t.agentSpace.renameHint(agent)}</div>
        <div className="confirm-actions">
          <button type="button" className="text-btn" onClick={() => onDone(null)}>
            {t.common.cancel}
          </button>
          <button type="submit" className="text-btn primary" data-testid="agents-rename-save">
            {t.agentSpace.save}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function DeleteDialog({ agent, onDone }: { agent: string; onDone: (yes: boolean) => void }) {
  const t = useT();
  const ref = useModal(true);
  return (
    <dialog ref={ref} className="confirm" aria-label={t.agentSpace.deleteConversation} data-testid="agents-confirm-delete" onCancel={() => onDone(false)} onClose={() => onDone(false)}>
      <p>{t.agentSpace.deleteConfirm(agent)}</p>
      <div className="confirm-actions">
        <button type="button" className="text-btn" onClick={() => onDone(false)} autoFocus>
          {t.common.cancel}
        </button>
        <button type="button" className="text-btn danger" data-testid="agents-confirm-delete-yes" onClick={() => onDone(true)}>
          {t.agentSpace.delete}
        </button>
      </div>
    </dialog>
  );
}

/** Patch a conversation in the cached list right away (the server's answer follows). */
function patchCached(qc: QueryClient, id: string, patch: Partial<SpaceSession>) {
  qc.setQueryData<Awaited<ReturnType<typeof api.spaceSessions>>>(agentKeys.sessions, (d) => (d ? { ...d, sessions: d.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : d));
}

export async function renameSession(qc: QueryClient, id: string, title: string): Promise<void> {
  const r = await api.spacePatch(id, { title });
  patchCached(qc, id, { title: r.session.title });
  void qc.invalidateQueries({ queryKey: agentKeys.sessions });
}

/**
 * Menu + rename/delete dialogs of a conversation. `open(session, at)` shows the menu; `extra` adds entries
 * (the conversation header adds its own).
 */
export function useConversationActions(onDeleted: (id: string) => void, onError: (msg: string) => void) {
  const t = useT();
  const qc = useQueryClient();
  const [menu, setMenu] = useState<{ s: SpaceSession; at: MenuAt; extra: MenuItem[] } | null>(null);
  const [rename, setRename] = useState<SpaceSession | null>(null);
  const [del, setDel] = useState<SpaceSession | null>(null);
  const agents = useAgents().data?.agents;
  const canOrganize = (agent: string) => agents?.find((a) => a.name === agent)?.features.organize !== false;

  const element = (
    <>
      {menu && (
        <Menu
          at={menu.at}
          testid="agents-menu"
          label={t.agentSpace.actions(sessionTitle(menu.s, t))}
          title={sessionTitle(menu.s, t)}
          onClose={() => setMenu(null)}
          items={[
            // Rename and pin only where the agent's runtime can (feature `organize`).
            ...(canOrganize(menu.s.agent) ? [{ id: 'rename', label: t.agentSpace.rename, run: () => setRename(menu.s) }] : []),
            ...menu.extra,
            ...(canOrganize(menu.s.agent) ? [{
              id: 'pin',
              label: menu.s.pinned ? t.agentSpace.unpin : t.agentSpace.pin,
              run: () => {
                const s = menu.s;
                patchCached(qc, s.id, { pinned: !s.pinned });
                api.spacePatch(s.id, { pinned: !s.pinned }).then(
                  () => void qc.invalidateQueries({ queryKey: agentKeys.sessions }),
                  () => {
                    patchCached(qc, s.id, { pinned: s.pinned });
                    onError(t.agentSpace.actionFailed);
                  },
                );
              },
            }] : []),
            { id: 'delete', label: t.agentSpace.delete, danger: true, run: () => setDel(menu.s) },
          ]}
        />
      )}
      {rename && (
        <RenameDialog
          session={rename}
          agent={agentLabel(agents, rename.agent)}
          onDone={(title) => {
            const s = rename;
            setRename(null);
            if (title === null || title.trim() === (s.title ?? '')) return;
            renameSession(qc, s.id, title).catch(() => onError(t.agentSpace.actionFailed));
          }}
        />
      )}
      {del && (
        <DeleteDialog
          agent={agentLabel(agents, del.agent)}
          onDone={(yes) => {
            const s = del;
            setDel(null);
            if (!yes) return;
            api.spaceDelete(s.id).then(
              async () => {
                qc.removeQueries({ queryKey: ['agents-space', 'messages', s.id] });
                await qc.refetchQueries({ queryKey: agentKeys.sessions });
                onDeleted(s.id);
              },
              () => onError(t.agentSpace.actionFailed),
            );
          }}
        />
      )}
    </>
  );
  return {
    open: (s: SpaceSession, at: MenuAt, extra: MenuItem[] = []) => setMenu({ s, at, extra }),
    rename: (s: SpaceSession) => setRename(s),
    element,
    agents,
  };
}

/** Choose the agent of a new conversation (straight to it when only one is available). */
export function useAgentPicker() {
  const t = useT();
  const [, navigate] = useLocation();
  const agents = useAgents().data?.agents ?? [];
  const [at, setAt] = useState<MenuAt | null>(null);
  const start = (name: string) => navigate(`/agents/new?agent=${encodeURIComponent(name)}`, { state: fromListState() });
  const usable = agents.filter((a) => a.available);
  return {
    open: (where: MenuAt) => (usable.length === 1 ? start(usable[0]!.name) : setAt(where)),
    start,
    element: at && (
      <Menu
        at={at}
        testid="agent-picker"
        label={t.agentSpace.pickAgent}
        title={t.agentSpace.pickAgent}
        onClose={() => setAt(null)}
        items={agents.map((a) => ({
          id: a.name,
          label: (
            <span className={`agent-pick ${a.available ? '' : 'off'}`}>
              <AgentAvatar name={a.name} label={a.label} size={28} />
              <span className="agent-pick-text">
                <span className="agent-pick-name">{a.label}</span>
                <span className="agent-pick-desc">{a.available ? localText(a.description) : t.agentSpace.agentUnavailable}</span>
              </span>
            </span>
          ),
          run: () => a.available && start(a.name),
        }))}
      />
    ),
  };
}

/** Long press (touch) opens the menu as a sheet; right click opens it at the pointer. */
function useRowPress(onMenu: (at: MenuAt) => void) {
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  return {
    fired: () => press.current?.fired === true,
    reset: () => (press.current = null),
    handlers: {
      onTouchStart: (e: TouchEvent) => {
        const t = e.touches[0];
        if (!t) return;
        const p = { x: t.clientX, y: t.clientY, fired: false, timer: 0 };
        p.timer = window.setTimeout(() => {
          p.fired = true;
          window.getSelection()?.removeAllRanges();
          onMenu({ sheet: true });
        }, 500);
        press.current = p;
      },
      onTouchMove: (e: TouchEvent) => {
        const p = press.current;
        const t = e.touches[0];
        if (p && t && (Math.abs(t.clientX - p.x) > 8 || Math.abs(t.clientY - p.y) > 8)) window.clearTimeout(p.timer);
      },
      onTouchEnd: (e: TouchEvent) => {
        const p = press.current;
        if (!p) return;
        window.clearTimeout(p.timer);
        if (p.fired && e.cancelable) e.preventDefault();
      },
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        if (press.current?.fired) return;
        onMenu({ x: e.clientX, y: e.clientY });
      },
    },
  };
}


// ── The list's filter (agent, sources, unread only), kept for the tab; the search is the pane's own ────────────

const FILTER_KEY = 'klatchly.agents.filter';
let filterValue: ListFilter = (() => {
  try {
    return parseFilter(sessionStorage.getItem(FILTER_KEY));
  } catch {
    return defaultFilter();
  }
})();
const filterSubs = new Set<() => void>();
export function setListFilter(next: ListFilter): void {
  filterValue = next;
  try {
    sessionStorage.setItem(FILTER_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the filter just isn't kept */
  }
  for (const f of filterSubs) f();
}
/** The home pane's "see all": one agent's conversations (the other choices stay). */
export const setAgentFilter = (agent: string | null) => setListFilter({ ...filterValue, agent });
function useListFilter(): ListFilter {
  return useSyncExternalStore(
    (f) => {
      filterSubs.add(f);
      return () => filterSubs.delete(f);
    },
    () => filterValue,
  );
}

type Group = 'pinned' | 'today' | 'week' | 'older';
function groupOf(s: SpaceSession, today: number): Group {
  if (s.pinned) return 'pinned';
  if (s.lastActive >= today) return 'today';
  if (s.lastActive >= today - 6 * 86_400_000) return 'week';
  return 'older';
}
const startOfToday = () => new Date().setHours(0, 0, 0, 0);
export const when = (ms: number) => (ms ? relativeTime(new Date(ms).toISOString()) : '');

/** A source's shown name in the language shown. */
export const useSourceLabel = () => {
  const t = useT();
  return (source: string) => sourceLabel(source, t.agentSpace.cli);
};

/** The small mark of a conversation started elsewhere ("Telegram"), on its row and in its header. */
export function SourceBadge({ source }: { source: string }) {
  const t = useT();
  const label = useSourceLabel()(source);
  return (
    <span className="agent-src" title={t.agentSpace.fromSource(label)} aria-label={t.agentSpace.fromSource(label)} data-testid="agent-conv-source" data-source={source}>
      {label}
    </span>
  );
}

function ConversationRow({ s, active, running, agents, showAgent, onMenu }: { s: SpaceSession; active: boolean; running: boolean; agents?: SpaceAgent[]; showAgent: boolean; onMenu: (s: SpaceSession, at: MenuAt) => void }) {
  const t = useT();
  const [, navigate] = useLocation();
  const label = agentLabel(agents, s.agent);
  const press = useRowPress((at) => onMenu(s, at));
  const unread = s.unread > 0 && !active;
  const href = `/agents/${s.id}`;
  const preview = previewLine(s.preview);
  return (
    <a
      href={href}
      className={`chat-row agent-conv ${active ? 'active' : ''} ${unread ? 'unread' : ''}`}
      aria-current={active ? 'page' : undefined}
      data-testid="agent-conv-row"
      data-session-id={s.id}
      data-agent={s.agent}
      data-source={s.source ?? OWN_SOURCE}
      {...(s.readOnly ? {} : press.handlers)}
      onClick={(e) => {
        e.preventDefault();
        if (press.fired()) {
          press.reset();
          return;
        }
        navigate(href, { state: fromListState() });
      }}
    >
      <AgentAvatar name={s.agent} label={label} size={40} />
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className="chat-title" data-testid="agent-conv-title">
            <TitleText s={s} />
          </span>
          <span className="chat-time">{when(s.lastActive)}</span>
        </span>
        <span className="chat-row-bottom">
          {s.source && <SourceBadge source={s.source} />}
          {(showAgent || s.helpers.length > 0) && (
            <span className="agent-chip" style={{ color: `color-mix(in srgb, ${agentColor(s.agent, agents)} 78%, var(--text))` }} data-testid="agent-conv-agents">
              {s.helpers.length ? t.agentSpace.withHelpers(label, s.helpers.map((h) => agentLabel(agents, h)).join(', ')) : label}
            </span>
          )}
          <span className="chat-preview" data-testid="agent-conv-preview">
            {running ? <em className="agent-running">{t.agentSpace.running}</em> : preview ? (s.own ? t.list.youPrefix(preview) : preview) : ''}
          </span>
          {s.inbox && (
            <span className="pin" aria-label={t.agentSpace.inboxOf(label)} title={t.agentSpace.inboxOf(label)} data-testid="agent-conv-inbox">
              📬
            </span>
          )}
          {s.pinned && (
            <span className="pin" aria-label={t.agentSpace.pinned} title={t.agentSpace.pinned}>
              📌
            </span>
          )}
          {unread && (
            <span className="badge" aria-label={t.agentSpace.unreadCount(s.unread)} data-testid="agent-conv-unread">
              {s.unread > 99 ? '99+' : s.unread}
            </span>
          )}
        </span>
      </span>
    </a>
  );
}

function PlusIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** Same pencil-in-a-box as the chat list's « new conversation » button. */
function ComposeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.6 3.4a2 2 0 0 1 2.9 2.9L12 14.8l-3.8 1 1-3.8z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path d="M4 6h16M7 12h10M10 18h4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** The scheduled tasks of the space's agents (GET /agents/jobs): the Automations entry and page. */
export function useJobs() {
  return useQuery({ queryKey: [...agentKeys.agents.slice(0, 1), 'jobs'], queryFn: api.spaceJobs, staleTime: 60_000 });
}

/**
 * The Filter sheet (bottom sheet on touch, popover under the button otherwise): which agent, which sources (only
 * those in the list; shown only when there is more than one), unread only. Choices apply at once.
 */
function FilterSheet({ at, agents, sources, unreadOf, onClose }: { at: MenuAt; agents: SpaceAgent[]; sources: string[]; unreadOf: (agent: string) => number; onClose: () => void }) {
  const t = useT();
  const f = useListFilter();
  const label = useSourceLabel();
  const sheet = 'sheet' in at;
  const ref = useSheetDrag(sheet, onClose);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (sheet || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at, sheet]);
  const toggleSource = (s: string) => setListFilter({ ...f, hide: f.hide.includes(s) ? f.hide.filter((x) => x !== s) : [...f.hide, s] });
  return (
    <div className={`menu-backdrop ${sheet ? 'sheet-backdrop' : ''}`} onClick={onClose}>
      <div
        ref={ref}
        className={`msg-menu agents-filter-sheet ${sheet ? 'sheet' : 'popover'}`}
        role="dialog"
        aria-label={t.agentSpace.filterTitle}
        data-testid="agents-filter-sheet"
        style={sheet ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
        onClick={(e) => e.stopPropagation()}
      >
        {sheet && <div className="sheet-grab" aria-hidden="true" />}
        {agents.length > 1 && (
          <section className="agents-filter-sec">
            <h3 className="agents-filter-h">{t.agentSpace.filterAgents}</h3>
            <div className="agent-filter" role="radiogroup" aria-label={t.agentSpace.filterLabel}>
              <button type="button" role="radio" className={`agent-fchip ${f.agent ? '' : 'on'}`} aria-checked={!f.agent} data-testid="agent-filter-all" onClick={() => setListFilter({ ...f, agent: null })}>
                {t.agentSpace.filterAll}
              </button>
              {agents.map((a) => {
                const n = unreadOf(a.name);
                return (
                  <button
                    key={a.name}
                    type="button"
                    role="radio"
                    className={`agent-fchip ${f.agent === a.name ? 'on' : ''}`}
                    aria-checked={f.agent === a.name}
                    data-testid="agent-filter"
                    data-agent={a.name}
                    onClick={() => setListFilter({ ...f, agent: f.agent === a.name ? null : a.name })}
                  >
                    <span className="agent-dot" style={{ background: agentColor(a.name, agents) }} aria-hidden="true" />
                    {a.label}
                    {n > 0 && (
                      <span className="agent-fchip-n" aria-label={t.agentSpace.unreadCount(n)}>
                        {n}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}
        {sources.length > 1 && (
          <section className="agents-filter-sec">
            <h3 className="agents-filter-h">{t.agentSpace.filterSources}</h3>
            <div className="agent-filter" role="group" aria-label={t.agentSpace.filterSources}>
              {sources.map((s) => {
                const on = !f.hide.includes(s);
                return (
                  <button key={s} type="button" role="checkbox" className={`agent-fchip ${on ? 'on' : ''}`} aria-checked={on} data-testid="source-filter" data-source={s} onClick={() => toggleSource(s)}>
                    {on && (
                      <span className="agent-fchip-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                    {label(s)}
                  </button>
                );
              })}
            </div>
          </section>
        )}
        <label className="agents-filter-unread">
          <input type="checkbox" checked={f.unread} data-testid="unread-only" onChange={(e) => setListFilter({ ...f, unread: e.target.checked })} />
          <span>{t.agentSpace.unreadOnly}</span>
        </label>
        <div className="confirm-actions agents-filter-foot">
          <button type="button" className="text-btn" data-testid="agents-filter-reset" onClick={() => setListFilter(defaultFilter())}>
            {t.agentSpace.filterReset}
          </button>
          <button type="button" className="text-btn primary" data-testid="agents-filter-done" onClick={onClose}>
            {t.agentSpace.filterDone}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Left column of the agents space: one control row (search, Filter: agents, sources, unread only), the "Your
 * agents" entry (the home pane; on a phone the only way to it) and "Automations" (when an agent has scheduled
 * tasks), then the conversations of every agent like the chat list, grouped by pinned / today / week / older.
 */
export function AgentsPane({ activeID, homeActive, automationsActive, online, onSettings, settingsIcon, tabs }: { activeID?: string; homeActive: boolean; automationsActive: boolean; online: boolean; onSettings: () => void; settingsIcon: ReactNode; tabs: ReactNode }) {
  const t = useT();
  const [location, navigate] = useLocation();
  const agentsQ = useAgents();
  const sessionsQ = useSpaceSessions();
  const jobsQ = useJobs();
  const agents = agentsQ.data?.agents;
  const picker = useAgentPicker();
  const [toast, flash] = useToast(3500);
  const qc = useQueryClient();
  const [readingAll, setReadingAll] = useState(false);
  const [query, setQuery] = useState('');
  const [filterAt, setFilterAt] = useState<MenuAt | null>(null);
  const actions = useConversationActions((id) => {
    if (location === `/agents/${id}`) navigate('/agents', { replace: true });
  }, flash);
  const sourceName = useSourceLabel();
  const stored = useListFilter();
  const f: ListFilter = stored.agent && !agents?.some((a) => a.name === stored.agent) ? { ...stored, agent: null } : stored;
  const filter = f.agent;
  const all = sessionsQ.data?.sessions ?? [];
  const sources = presentSources(all);
  const sessions = applyFilter(all, f, query, { agent: (id) => agentLabel(agents, id), source: sourceName }, activeID);
  const filterCount = activeFilterCount(f, sources);
  const active = new Set(sessionsQ.data?.active ?? []);
  const multi = (agents?.length ?? 1) > 1;
  const jobs = jobsQ.data?.jobs ?? [];
  const today = startOfToday();
  const groups: { id: Group; label: string; rows: SpaceSession[] }[] = [
    { id: 'pinned', label: t.agentSpace.groupPinned, rows: [] },
    { id: 'today', label: t.agentSpace.groupToday, rows: [] },
    { id: 'week', label: t.agentSpace.groupWeek, rows: [] },
    { id: 'older', label: t.agentSpace.groupOlder, rows: [] },
  ];
  for (const s of sessions) groups.find((g) => g.id === groupOf(s, today))!.rows.push(s);
  const unreadOf = (name: string) => all.filter((s) => s.agent === name && s.unread > 0 && s.id !== activeID).length;
  const filterLabel = filter ? agentLabel(agents, filter) : '';
  const filterAgent = agents?.find((a) => a.name === filter);
  // Something hides conversations (search, a filter): an empty list says "no match", not "no conversations yet".
  const narrowed = !!query.trim() || filterCount > 0 || (f.hide.length > 0 && all.some((s) => f.hide.includes(s.source ?? OWN_SOURCE)));
  const openPlace = (href: string, here: boolean) => (e: MouseEvent) => {
    e.preventDefault();
    if (!here) navigate(href, { state: fromListState() });
  };

  return (
    <>
      <header className="list-header space-header sections-header">
        <span className={`conn-dot ${online ? 'on' : 'off'}`} title={online ? t.shell.connected : t.shell.reconnecting} data-testid="conn-dot" />
        {tabs}
        <span className="header-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label={filterAgent?.available ? t.agentSpace.newWith(filterAgent.label) : t.agentSpace.newConversation}
            title={filterAgent?.available ? t.agentSpace.newWith(filterAgent.label) : t.agentSpace.newConversation}
            data-testid="agents-new"
            onClick={(e) => {
              if (filterAgent?.available) return picker.start(filterAgent.name);
              const r = e.currentTarget.getBoundingClientRect();
              picker.open(window.matchMedia('(pointer: coarse)').matches ? { sheet: true } : { x: r.left, y: r.bottom + 4 });
            }}
          >
            <ComposeIcon />
          </button>
          <button type="button" className="icon-btn" aria-label={t.shell.settings} title={t.shell.settings} data-testid="open-settings" onClick={onSettings}>
            {settingsIcon}
          </button>
        </span>
      </header>
      <div className="search-bar agents-controls" data-testid="agents-controls">
        <input
          type="search"
          value={query}
          placeholder={t.agentSpace.search}
          aria-label={t.agentSpace.searchLabel}
          enterKeyHint="search"
          data-testid="agents-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        />
        <button
          type="button"
          className={`agents-filter-btn ${filterCount ? 'on' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={!!filterAt}
          data-testid="agents-filter-btn"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setFilterAt(window.matchMedia('(pointer: coarse)').matches ? { sheet: true } : { x: r.right - 300, y: r.bottom + 4 });
          }}
        >
          <FilterIcon />
          <span>{filterCount ? t.agentSpace.filterCount(filterCount) : t.agentSpace.filter}</span>
        </button>
      </div>
      <div className="space-scroll" data-testid="agents-pane">
        {agents && agents.length > 0 && (
          <a href="/agents/overview" className={`chat-row agents-home-row ${homeActive ? 'active' : ''}`} aria-current={homeActive ? 'page' : undefined} data-testid="agents-home-row" onClick={openPlace('/agents/overview', location === '/agents/overview' || (location === '/agents' && !phoneLayout()))}>
            <span className="agents-stack" aria-hidden="true">
              {agents.slice(0, 3).map((a) => (
                <AgentAvatar key={a.name} name={a.name} label={a.label} size={agents.length > 1 ? 26 : 40} />
              ))}
            </span>
            <span className="chat-row-main">
              <span className="chat-title">{t.agentSpace.yourAgents}</span>
              <span className="chat-preview">{agents.map((a) => a.label).join(' · ')}</span>
            </span>
            <svg className="agents-home-chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        )}
        {jobs.length > 0 && (
          <a href="/agents/automations" className={`chat-row agents-home-row ${automationsActive ? 'active' : ''}`} aria-current={automationsActive ? 'page' : undefined} data-testid="agents-automations-row" onClick={openPlace('/agents/automations', location === '/agents/automations')}>
            <span className="agents-auto-mark" aria-hidden="true">
              <ClockIcon />
            </span>
            <span className="chat-row-main">
              <span className="chat-title">{t.agentSpace.automations}</span>
              <span className="chat-preview">{t.agentSpace.automationsCount(jobs.length)}</span>
            </span>
            <svg className="agents-home-chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        )}
        {sessions.some((s) => s.unread > 0) && (
          <div className="list-actions agent-read-all">
            <button
              type="button"
              className="text-btn"
              data-testid="agents-read-all"
              disabled={readingAll}
              aria-busy={readingAll}
              onClick={() => {
                setReadingAll(true);
                api
                  .spaceReadAll(filter ?? undefined)
                  .then(
                    (r) => flash(t.agentSpace.markedAllRead(r.marked)),
                    () => flash(t.agentSpace.markAllReadFailed),
                  )
                  .finally(() => {
                    setReadingAll(false);
                    void qc.invalidateQueries({ queryKey: agentKeys.sessions });
                  });
              }}
            >
              {t.agentSpace.markAllRead}
            </button>
          </div>
        )}
        {sessionsQ.isPending ? (
          <ChatsSkeleton />
        ) : sessionsQ.isError ? (
          <div className="list-status">
            {t.agentSpace.unavailable}{' '}
            <button type="button" className="text-btn" onClick={() => void sessionsQ.refetch()}>
              {t.common.retry}
            </button>
          </div>
        ) : !sessions.length && narrowed && all.length > 0 && !(filter && !all.some((s) => s.agent === filter)) ? (
          <div className="list-status agents-empty" data-testid="agents-no-match">
            <p>{t.agentSpace.noMatch}</p>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                setQuery('');
                setListFilter(defaultFilter());
              }}
            >
              {t.agentSpace.filterReset}
            </button>
          </div>
        ) : !sessions.length ? (
          <div className="list-status agents-empty" data-testid="agents-empty">
            <p>{filter ? t.agentSpace.noConversationsWith(filterLabel) : t.agentSpace.noConversations}</p>
            {(filter ? filterAgent?.available : agents?.some((a) => a.available)) && (
              <button
                type="button"
                className="space-btn primary"
                onClick={(e) => {
                  if (filter) return picker.start(filter);
                  const r = e.currentTarget.getBoundingClientRect();
                  picker.open(window.matchMedia('(pointer: coarse)').matches ? { sheet: true } : { x: r.left, y: r.bottom + 4 });
                }}
              >
                <PlusIcon size={18} /> {filter ? t.agentSpace.newWith(filterLabel) : t.agentSpace.newConversation}
              </button>
            )}
          </div>
        ) : (
          <div role="list" aria-label={t.agentSpace.conversations}>
            {groups
              .filter((g) => g.rows.length)
              .map((g) => (
                <section key={g.id} className="agent-group" data-group={g.id}>
                  <h2 className="space-group">{g.label}</h2>
                  {g.rows.map((s) => (
                    <ConversationRow key={s.id} s={s} active={s.id === activeID} running={active.has(s.id)} agents={agents} showAgent={multi && !filter} onMenu={(x, at) => actions.open(x, at)} />
                  ))}
                </section>
              ))}
          </div>
        )}
      </div>
      {filterAt && agents && <FilterSheet at={filterAt} agents={agents} sources={sources} unreadOf={unreadOf} onClose={() => setFilterAt(null)} />}
      {picker.element}
      {actions.element}
      {toast && (
        <div className="toast" role="status" data-testid="toast">
          {toast}
        </div>
      )}
    </>
  );
}

function ClockIcon({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A coming time: its hour today, else its weekday and hour. */
function nextLabel(ms: number): string {
  const d = new Date(ms);
  const today = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(lang(), today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}

// ── Right pane: Automations (the agents' scheduled tasks; paused and resumed when the runtime allows it) ──────

/**
 * Pause / resume of a task (capability jobsControl): confirmed first (the task's name and what changes), shown at
 * once in the list, put back if the server refuses, then a toast.
 */
function useJobControl(flash: (text: string) => void) {
  const t = useT();
  const qc = useQueryClient();
  const key = [...agentKeys.agents.slice(0, 1), 'jobs'];
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (j: SpaceJob) => {
    const action = j.state === 'paused' ? 'resume' : 'pause';
    if (busy || !window.confirm(action === 'pause' ? t.agentSpace.jobPauseConfirm(j.name) : t.agentSpace.jobResumeConfirm(j.name))) return;
    const same = (x: SpaceJob) => x.agent === j.agent && x.id === j.id;
    const set = (state: SpaceJob['state']) => qc.setQueryData<{ jobs: SpaceJob[] }>(key, (d) => (d ? { jobs: d.jobs.map((x) => (same(x) ? { ...x, state } : x)) } : d));
    setBusy(`${j.agent}/${j.id}`);
    await qc.cancelQueries({ queryKey: key });
    set(action === 'pause' ? 'paused' : 'scheduled');
    try {
      const r = await api.spaceJobControl(j.agent, j.id, action);
      qc.setQueryData<{ jobs: SpaceJob[] }>(key, (d) => (d ? { jobs: d.jobs.map((x) => (same(x) ? { ...x, ...r.job } : x)) } : d));
      flash(action === 'pause' ? t.agentSpace.jobPausedToast(j.name) : t.agentSpace.jobResumedToast(j.name));
    } catch {
      set(j.state);
      flash(t.agentSpace.jobControlFailed);
    } finally {
      setBusy(null);
    }
  };
  return { toggle, busy };
}

export function AutomationsView() {
  const t = useT();
  const [, navigate] = useLocation();
  const jobsQ = useJobs();
  const agents = useAgents().data?.agents;
  const jobs = jobsQ.data?.jobs ?? [];
  const [toast, flash] = useToast(3500);
  const control = useJobControl(flash);
  const stateText = (j: SpaceJob) => (j.state === 'paused' ? t.agentSpace.jobPaused : j.state === 'completed' ? t.agentSpace.jobCompleted : j.state === 'error' ? t.agentSpace.jobError : null);
  return (
    <div className="conversation space-main" data-testid="agents-automations">
      <header className="conv-header">
        <button type="button" className="icon-btn back" aria-label={t.common.back} data-testid="agents-automations-back" onClick={() => backToList(navigate)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="conv-title">
          <span className="conv-name">{t.agentSpace.automations}</span>
          <span className="conv-sub">{jobsQ.data ? t.agentSpace.automationsCount(jobs.length) : ''}</span>
        </div>
      </header>
      <div className="space-board agents-board">
        <p className="space-note agents-auto-hint">{jobs.some((j) => j.controllable) ? t.agentSpace.automationsHintControl : t.agentSpace.automationsHint}</p>
        {jobsQ.isError ? (
          <p className="space-banner warn">{t.agentSpace.unavailable}</p>
        ) : !jobsQ.data ? (
          <div className="space-skeleton" aria-hidden="true">
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        ) : !jobs.length ? (
          <p className="space-note">{t.agentSpace.noAutomations}</p>
        ) : (
          <ul className="space-convs boxed agents-jobs" data-testid="agents-jobs">
            {jobs.map((j) => {
              const st = stateText(j);
              const paused = j.state === 'paused';
              return (
                <li key={`${j.agent}/${j.id}`} className={`agents-job ${j.state}`} data-testid="agents-job" data-agent={j.agent} data-id={j.id} data-state={j.state}>
                  <AgentAvatar name={j.agent} label={agentLabel(agents, j.agent)} size={32} />
                  <span className="agents-job-main">
                    <span className="agents-job-top">
                      <span className="agents-job-name">{j.name}</span>
                      {st && <span className={`space-pill ${paused ? '' : 'dead'}`}>{st}</span>}
                    </span>
                    <span className="agents-job-meta">
                      {agentLabel(agents, j.agent)}
                      {j.schedule && ` · ${j.schedule}`}
                    </span>
                    <span className="agents-job-meta">
                      {j.lastRun ? t.agentSpace.jobLast(when(j.lastRun)) : t.agentSpace.jobNever}
                      {j.lastStatus === 'failed' && <span className="agents-job-failed"> · {t.agentSpace.jobFailed}</span>}
                      {j.nextRun && j.state === 'scheduled' ? ` · ${t.agentSpace.jobNext(nextLabel(j.nextRun))}` : ''}
                    </span>
                  </span>
                  {j.controllable && j.state !== 'completed' && (
                    <button
                      type="button"
                      className={`text-btn agents-job-toggle ${paused ? 'primary' : ''}`}
                      data-testid="agents-job-toggle"
                      aria-label={`${paused ? t.agentSpace.jobResume : t.agentSpace.jobPause} · ${j.name}`}
                      disabled={control.busy !== null}
                      onClick={() => void control.toggle(j)}
                    >
                      {paused ? t.agentSpace.jobResume : t.agentSpace.jobPause}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {toast && (
        <div className="toast" role="status" data-testid="toast">
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Right pane: the agents home (what each agent does, its recent conversations, start one) ─────────────

function AgentCard({ a, agents, sessions, running }: { a: SpaceAgent; agents: SpaceAgent[]; sessions: SpaceSession[]; running: Set<string> }) {
  const t = useT();
  const [, navigate] = useLocation();
  const mine = sessions.filter((s) => s.agent === a.name).sort((x, y) => y.lastActive - x.lastActive);
  const unread = mine.filter((s) => s.unread > 0).length;
  const helpers = a.helpers.filter((h) => agents.some((x) => x.name === h));
  const open = (href: string) => (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href, { state: fromListState() });
  };
  return (
    <li className={`space-card agent-home-card ${a.available ? '' : 'off'}`} data-testid="agent-card" data-agent={a.name} data-available={a.available ? '1' : '0'}>
      <div className="agent-home-head">
        <AgentAvatar name={a.name} label={a.label} size={44} />
        <div className="agent-home-id">
          <h3 className="agent-home-name">{a.label}</h3>
          <span className="agent-home-meta">
            {mine.length ? `${t.agentSpace.conversationCount(mine.length)} · ${t.agentSpace.lastActivity(when(mine[0]!.lastActive))}` : t.agentSpace.conversationCount(0)}
          </span>
        </div>
        {!a.available ? (
          <span className="space-pill dead">{t.agentSpace.unavailablePill}</span>
        ) : (
          unread > 0 && (
            <span className="badge" aria-label={t.agentSpace.unreadCount(unread)}>
              {unread}
            </span>
          )
        )}
      </div>
      {a.description && <p className="agent-home-desc">{localText(a.description)}</p>}
      {helpers.length > 0 && (
        <p className="agent-home-helpers">
          <span className="agent-home-helper-avatars" aria-hidden="true">
            {helpers.map((h) => (
              <AgentAvatar key={h} name={h} label={agentLabel(agents, h)} size={18} />
            ))}
          </span>
          {t.agentSpace.canDelegate(helpers.map((h) => agentLabel(agents, h)).join(', '))}
        </p>
      )}
      {mine.length > 0 ? (
        <ul className="space-convs boxed agent-home-convs" aria-label={t.agentSpace.recentWith(a.label)}>
          {mine.slice(0, 3).map((s) => (
            <li key={s.id}>
              <a className={`agent-home-conv ${s.unread > 0 ? 'unread' : ''}`} href={`/agents/${s.id}`} data-testid="agent-home-conv" data-session-id={s.id} onClick={open(`/agents/${s.id}`)}>
                <span className="agent-home-conv-title">
                  <TitleText s={s} />
                </span>
                {running.has(s.id) ? <em className="agent-running">{t.agentSpace.running}</em> : <span className="chat-time">{when(s.lastActive)}</span>}
                {s.unread > 0 && <span className="badge">{s.unread > 99 ? '99+' : s.unread}</span>}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="space-note agent-home-none">{a.available ? t.agentSpace.noConversationsWith(a.label) : t.agentSpace.agentDown}</p>
      )}
      <div className="agent-home-foot">
        <button
          type="button"
          className="space-btn primary"
          data-testid="agent-start"
          data-agent={a.name}
          disabled={!a.available}
          aria-label={t.agentSpace.newWith(a.label)}
          onClick={() => navigate(`/agents/new?agent=${encodeURIComponent(a.name)}`, { state: fromListState() })}
        >
          <PlusIcon size={18} />
          {t.agentSpace.newConversation}
        </button>
        {mine.length > 0 && (
          <button
            type="button"
            className="space-quiet space-accent"
            data-testid="agent-see-all"
            data-agent={a.name}
            onClick={() => {
              setAgentFilter(a.name);
              if (phoneLayout()) backToList(navigate);
            }}
          >
            {t.agentSpace.seeAll(mine.length)}
          </button>
        )}
      </div>
    </li>
  );
}

export function AgentsHome() {
  const t = useT();
  const [, navigate] = useLocation();
  const agentsQ = useAgents();
  const sessionsQ = useSpaceSessions();
  const agents = agentsQ.data?.agents;
  // The cards count what the list shows by default (no terminal sessions).
  const sessions = (sessionsQ.data?.sessions ?? []).filter((s) => !DEFAULT_HIDE.includes(s.source ?? OWN_SOURCE));
  const running = new Set(sessionsQ.data?.active ?? []);
  return (
    <div className="conversation space-main" data-testid="agents-home">
      <header className="conv-header">
        <button type="button" className="icon-btn back" aria-label={t.common.back} data-testid="agents-home-back" onClick={() => backToList(navigate)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="conv-title">
          <span className="conv-name">{t.agentSpace.agents}</span>
          <span className="conv-sub">{agents ? t.agentSpace.homeSub(agents.length, sessions.length) : ''}</span>
        </div>
      </header>
      <div className="space-board agents-board">
        {agentsQ.isError ? (
          <p className="space-banner warn">{t.agentSpace.unavailable}</p>
        ) : !agents ? (
          <div className="space-skeleton" aria-hidden="true">
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        ) : (
          <section className="space-block" aria-labelledby="agents-home-h">
            <h2 id="agents-home-h" className="space-h">
              {t.agentSpace.yourAgents} <span className="space-count">{agents.length}</span>
            </h2>
            <ul className="agent-grid" data-testid="agent-cards">
              {agents.map((a) => (
                <AgentCard key={a.name} a={a} agents={agents} sessions={sessions} running={running} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
