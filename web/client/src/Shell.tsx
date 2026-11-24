import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useRoute, useSearch } from 'wouter';
import { api, HttpError } from './endpoints';
import { ChatList, type ListView } from './ChatList';
import { chatPlace, chatsQuery, lowPriorityQuery } from './cache';
import { useHeld, useQuietOn } from './quiet';
import { markChatRead } from './read';
import { Realtime } from './realtime';
import { startPrefetch } from './prefetch';
import { disablePush, isIOS, isStandalone, resyncPush } from './push';
import { localized, useLang, useT } from './i18n';
import { Lazy } from './lazy';
import { Conversation, SettingsMain, SettingsMenu } from './screens';
import { handleFrame, isSpaceLink, preloadAugmentation, settingsSection, spaceAt, spaces, useActiveSpaces, useAugmentations, useLowPriorityShown, useSettingsSections, useSpacesOff } from './registry';
import { settingsAt, settingsHref, type SettingsPlace } from './settingsroute';
import { MessagesSkeleton } from './Skeleton';
import { NewChatButton } from './NewChatButton';
import { useAccountChanges } from './NetworkFilter';
import { SectionTabs, type SectionsState } from './Sections';
import { setSocketOpen } from './conn';
import { edgeAxis, isEdgeStart, settingsOrigin, swipeBackDecision } from './gestures';
import { backToList, goBack, leaveSettings, listPathFor, phoneLayout, reducedMotion, slideOut, toggleSettings } from './nav';

export function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  const qc = useQueryClient();
  const t = useT();
  // /chat/<id>/media|files|links: the chat's "Media, links and files" page, over the conversation (ChatMedia).
  const [, params] = useRoute('/chat/:id/:sub?');
  const chatID = params?.id ? decodeURIComponent(params.id) : undefined;
  const chatSub = params?.sub === 'media' || params?.sub === 'files' || params?.sub === 'links' ? params.sub : undefined;
  const [path, navigate] = useLocation();
  // Settings (/settings, /settings/<page>), laid out like a space: its menu in the list column, a page in the pane
  // beside it (over it on a phone, as a chat over the list or a space's place over its list).
  const inSettings = settingsAt(path);
  const onSettings = !!inSettings;
  const settingsPlace = inSettings?.place;
  // A package's space (e.g. a dashboard package's), whether its package is on or not yet known: a link opens it at once.
  const inSpace = onSettings ? undefined : spaceAt(path);
  const spaceHere = inSpace?.space;
  // Spaces the server has said are off: their list leaves (from under the Settings menu too), their page closes (below).
  const spacesOff = useSpacesOff();
  // The list column under the Settings menu: the list of the screen it was opened from, kept mounted (hidden), so
  // leaving Settings finds it as it was (scroll, search).
  const settingsSpace = onSettings ? spaceAt(listPathFor(settingsOrigin(history.state)))?.space : undefined;
  // A space's list in place of the chat list.
  const spaceList = spaceHere ?? (settingsSpace && !spacesOff.has(settingsSpace.id) ? settingsSpace : undefined);
  // One of the space's places (a project in that dashboard…): the second page on a phone, like a chat.
  const spacePlace = inSpace?.place;
  // Reported to the server as what this window shows: the chat, or the space (whose own pushes it then holds back).
  const active = useRef<{ chat?: string; space?: string }>({});
  active.current = { chat: chatID, space: spaceHere?.id };
  const activeSpaces = useActiveSpaces();
  // A space whose package the server turned off (Settings → Extensions, maybe on another device): its page closes.
  useEffect(() => {
    if (spaceHere && spacesOff.has(spaceHere.id)) navigate('/', { replace: true });
  }, [spaceHere, spacesOff, navigate]);
  // A Settings URL this build has no page for: the menu, in its place. A page of 0.15.7 that is now a block: its
  // page's URL, the block as its anchor (the page scrolls to it).
  const settingsMoved = inSettings?.moved;
  useEffect(() => {
    if (settingsMoved) navigate(settingsMoved, { replace: true, state: history.state });
    else if (inSettings && !settingsPlace && path !== '/settings') navigate('/settings', { replace: true, state: history.state });
  }, [inSettings, settingsPlace, settingsMoved, path, navigate]);
  const [online, setOnline] = useState(true);
  const [view, setView] = useState<ListView>('inbox');
  const search = new URLSearchParams(useSearch());
  const focus = search.get('m') ?? undefined;
  const compose = search.get('compose') === '1';
  // A space's controller keeps its state, dialogs and toasts once the space has been opened.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(spaceList ? [spaceList.id] : []));
  if (spaceList && !seen.has(spaceList.id)) setSeen(new Set([...seen, spaceList.id]));
  // Low-priority chats with unread messages (loaded pages): the count on the header button, while a connector that
  // keeps that inbox is on.
  const lowPriorityOn = useLowPriorityShown();
  const lowPriority = useInfiniteQuery(lowPriorityQuery(lowPriorityOn));
  const lowUnread = useMemo(() => {
    const ids = new Set<string>();
    for (const p of lowPriority.data?.pages ?? []) for (const c of p.items) if (chatPlace(c) === 'lowPriority' && c.unreadCount > 0) ids.add(c.id);
    return ids.size;
  }, [lowPriority.data]);
  // Quiet hours (quiet.tsx): their tab while any exist, with the chats they hold now (loaded inbox pages).
  const quietOn = useQuietOn();
  const isHeldNow = useHeld();
  const inboxPages = useInfiniteQuery(chatsQuery()).data;
  const quietHeld = useMemo(() => {
    const ids = new Set<string>();
    for (const p of inboxPages?.pages ?? []) for (const c of p.items) if (chatPlace(c) === 'inbox' && isHeldNow(c)) ids.add(c.id);
    return ids.size;
  }, [inboxPages, isHeldNow]);

  // Notification clicks: the service worker asks an open window to show the chat.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown } | null;
      if (d?.type !== 'open' || typeof d.url !== 'string') return;
      if (/^\/(chat\/[^/?#\s]+(\?compose=1)?)?$/.test(d.url) || isSpaceLink(d.url)) navigate(d.url);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    void resyncPush().catch(() => {});
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [navigate]);

  const rtRef = useRef<Realtime>(undefined);
  useEffect(() => {
    const rt = new Realtime(
      qc,
      onSignedOut,
      (id, msgs) => {
        if (id === active.current.chat && document.visibilityState === 'visible' && msgs.some((m) => !m.isSender)) {
          markChatRead(qc, id);
        }
      },
      () => active.current.chat,
      () => active.current.space,
      (frame) => handleFrame(frame, qc),
    );
    rtRef.current = rt;
    const unsub = rt.subscribe((s) => {
      setOnline(s === 'open');
      setSocketOpen(s === 'open');
    });
    rt.connect();
    return () => {
      unsub();
      rt.stop();
    };
  }, [qc, onSignedOut]);

  useEffect(() => rtRef.current?.reportVisibility(), [chatID, spaceHere]);
  useEffect(() => startPrefetch(qc), [qc]);
  // A newly connected account: its chats and its place in the network filter, without a reload.
  useAccountChanges();
  // The list is up: fetch the conversation's chunk now, so opening a chat never waits for it.
  useEffect(() => Conversation.preload(), []);
  // And the chunks of the augmentations on (their slots in the conversation), once the server has said which.
  const augmentations = useAugmentations();
  useEffect(() => augmentations.forEach(preloadAugmentation), [augmentations]);

  // The server must end the session: signing out only here would sign straight back in on the next call. So a
  // network failure or a server error is tried again for about 20 s; then it throws and the row says so. A 401
  // means the session is already gone. An explicit sign-out leaves for the home first: the sign-in screen that follows
  // must not bring the next sign-in back to Settings (signinreturn.ts keeps the page of a lost session, not this one).
  const signedOut = () => {
    navigate('/', { replace: true });
    onSignedOut();
  };
  const logout = async () => {
    // An explicit logout also turns notifications off on this device.
    await disablePush().catch(() => {});
    for (const wait of [0, 1000, 2000, 4000, 5000, 8000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        await api.logout();
        return signedOut();
      } catch (e) {
        if (e instanceof HttpError && e.status !== 0 && e.status < 500) return signedOut();
      }
    }
    throw new Error('logout');
  };

  const sections: SectionsState = { spaces: activeSpaces, lowUnread, quiet: { on: quietOn, held: quietHeld }, showList: setView };

  const hasChat = !!(chatID || spacePlace || settingsPlace);
  const shellRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  usePhoneTransitions(shellRef, paneRef, hasChat, `${chatID ?? ''}|${spaceHere ? `${spaceHere.id}:${spacePlace ?? ''}` : ''}|${onSettings ? `settings:${settingsPlace ? settingsHref(settingsPlace) : ''}` : ''}`, navigate);
  const openSettings = () => toggleSettings(navigate);

  return (
    <div ref={shellRef} className={`shell ${hasChat ? 'has-chat' : ''}`}>
      {/* Any gear of the column (the chat list's, a space's): the Settings chunk is fetched as it is pressed. */}
      <aside className={`pane-list ${spaceList ? `space-list ${spaceList.id}-space` : ''}`} onPointerDownCapture={(e) => (e.target as Element).closest?.('[data-testid=open-settings]') && SettingsMenu.preload()}>
        {onSettings && <SettingsMenuColumn onClose={openSettings} />}
        <div className={`list-col ${onSettings ? 'under-settings' : ''}`} inert={onSettings} aria-hidden={onSettings || undefined}>
        {spaceList ? (
          <Lazy key={spaceList.id}>
            <spaceList.List place={spacePlace} here={spaceList === spaceHere} online={online} onSettings={openSettings} settingsIcon={<GearIcon />} tabs={<SectionTabs active={spaceList.id} s={sections} />} />
          </Lazy>
        ) : (
        <>
        <header className="list-header sections-header">
          <span className={`conn-dot ${online ? 'on' : 'off'}`} title={online ? t.shell.connected : t.shell.reconnecting} data-testid="conn-dot" />
          <SectionTabs active={view === 'inbox' ? 'chats' : view} s={sections} />
          <span className="header-actions">
            {view === 'inbox' && <NewChatButton />}
            <button type="button" className="icon-btn" aria-label={t.shell.settings} title={t.shell.settings} data-testid="open-settings" onClick={openSettings}>
              <GearIcon />
            </button>
          </span>
        </header>
        <ChatList activeID={chatID} view={view} />
        </>
        )}
        </div>
      </aside>
      <section ref={paneRef} className="pane-chat">
        {onSettings ? (
          <SettingsPage place={settingsPlace} onSignOut={logout} />
        ) : spaceHere ? (
          <Lazy key={spaceHere.id}>
            <spaceHere.Main place={spacePlace} />
          </Lazy>
        ) : chatID ? (
          <Lazy key="chat" fallback={<ConversationPlaceholder />}>
            <Conversation key={chatID} chatID={chatID} focus={focus} compose={compose} sub={chatSub} />
          </Lazy>
        ) : (
          <div className="empty-chat" aria-hidden="true" />
        )}
      </section>
      {spaces.map(
        (x) =>
          x.Controller &&
          seen.has(x.id) &&
          !spacesOff.has(x.id) && (
            <Lazy key={`controller-${x.id}`} failed={null}>
              <x.Controller active={spaceHere === x} listed={spaceList === x} />
            </Lazy>
          ),
      )}
    </div>
  );
}

/** Only when a chat opens at launch before its chunk is in (from a notification): the message skeleton. */
function ConversationPlaceholder() {
  return (
    <div className="conversation">
      <div className="messages">
        <MessagesSkeleton />
      </div>
    </div>
  );
}

/**
 * The list column on Settings: the menu's header is here (the title, Close out of Settings), so it shows at once and
 * stays when the chunk fails to load; the menu itself is the lazy Settings chunk.
 */
function SettingsMenuColumn({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <>
      <header className="list-header settings-menu-header">
        <h1 className="list-title settings-menu-title">{t.settings.title}</h1>
        {/* Close sits where the gear that opened Settings was (top right), so the same spot toggles it. */}
        <button type="button" className="icon-btn settings-close" aria-label={t.common.close} title={t.common.close} data-testid="settings-close" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <Lazy key="settings-menu">
        <SettingsMenu />
      </Lazy>
    </>
  );
}

/**
 * The pane of Settings: one page, with its header here, so Back and the title show at once and stay when the chunk
 * fails to load (Retry below it); the page itself is the lazy Settings chunk. Back (on a phone) returns to the menu.
 */
function SettingsPage({ place, onSignOut }: { place: SettingsPlace | undefined; onSignOut: () => Promise<void> }) {
  const t = useT();
  const lang = useLang();
  const [, navigate] = useLocation();
  // Escape: back to the menu from a page on a phone, else out of Settings, as it closed the former popup (not while
  // a select, field or dialog has it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
      if ((e.target as Element | null)?.closest?.('input, select, textarea')) return;
      if (place && phoneLayout()) backToList(navigate);
      else leaveSettings(navigate);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, place]);
  // The page's title: the core's from the launch strings, a package's from its client entry (SettingsSection.title).
  const shown = place ?? { core: 'general' };
  const pkgTitle = 'pkg' in shown ? settingsSection(shown.pkg, shown.section)?.title : undefined;
  const titles = { general: t.settings.general, reading: t.reading.title, quiet: t.quiet.title, app: t.settings.app, extensions: t.settings.manageExtensions };
  const title = 'core' in shown ? titles[shown.core] : pkgTitle ? localized(pkgTitle, lang) : t.settings.title;
  return (
    <div className="conversation settings-page" data-testid="settings-page">
      <header className="conv-header">
        <button type="button" className="icon-btn back" aria-label={t.common.back} title={t.common.back} data-testid="settings-back" onClick={() => backToList(navigate)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="conv-title">
          <h1 className="conv-name settings-title" id="settings-page-title">
            {title}
          </h1>
        </div>
      </header>
      <Lazy key="settings">
        <SettingsMain onSignOut={onSignOut} />
      </Lazy>
    </div>
  );
}

/** The Settings button's mark, with a dot while a page of Settings has something to look at (SettingsSection.useBadge). */
function GearIcon() {
  const sections = useSettingsSections();
  return (
    <span className="gear-mark">
      <GearSvg />
      {sections?.map((x) => (x.active && x.section.useBadge ? <SettingsDot key={`${x.pkg}/${x.section.id}`} use={x.section.useBadge} /> : null))}
    </span>
  );
}

function SettingsDot({ use }: { use: () => number }) {
  return use() > 0 ? <span className="gear-dot" data-testid="settings-attention" aria-hidden="true" /> : null;
}

function GearSvg() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Phone layout: the chat pane lies over the list (which keeps its scroll position underneath). A chat opened
 * from the list slides in; an edge swipe from the left drags the pane away and goes back.
 */
function usePhoneTransitions(
  shellRef: RefObject<HTMLDivElement | null>,
  paneRef: RefObject<HTMLElement | null>,
  hasChat: boolean,
  place: string,
  navigate: (to: string, opts?: { replace?: boolean; state?: unknown }) => void,
) {
  // Slide in when a chat opens over the list (not on a page load straight into a chat).
  const prev = useRef(hasChat);
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = hasChat;
    const shell = shellRef.current;
    if (!shell || was || !hasChat || !phoneLayout() || reducedMotion()) return;
    shell.classList.add('entering');
    const t = window.setTimeout(() => shell.classList.remove('entering'), 400);
    return () => {
      window.clearTimeout(t);
      shell.classList.remove('entering');
    };
  }, [hasChat, shellRef]);

  // Wherever we land after a swipe or the back slide: the pane goes back to its place.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (pane) {
      pane.style.transform = '';
      pane.style.transition = '';
    }
    shellRef.current?.classList.remove('swiping');
  }, [place, paneRef, shellRef]);

  useEffect(() => {
    const pane = paneRef.current;
    const shell = shellRef.current;
    if (!pane || !shell) return;
    // Safari's own edge swipe (not the home-screen app) already goes back: no second gesture there.
    if (isIOS() && !isStandalone()) return;
    type G = { x0: number; y0: number; axis?: 'x' | 'y'; dx: number; lastX: number; lastT: number; vx: number };
    let g: G | null = null;
    const reset = () => {
      pane.style.transition = '';
      pane.style.transform = '';
      shell.classList.remove('swiping');
    };
    const onStart = (e: TouchEvent) => {
      g = null;
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || !isEdgeStart(t.clientX) || !shell.classList.contains('has-chat') || !phoneLayout()) return;
      if ((e.target as Element).closest('.menu-backdrop, dialog')) return;
      // The bubbles' own touch handlers (long-press, swipe to reply) never see this touch.
      e.stopPropagation();
      g = { x0: t.clientX, y0: t.clientY, dx: 0, lastX: t.clientX, lastT: e.timeStamp, vx: 0 };
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!g || !t) return;
      e.stopPropagation();
      const dx = t.clientX - g.x0;
      if (!g.axis) {
        if (dx === 0 && t.clientY === g.y0) return;
        g.axis = edgeAxis(dx, t.clientY - g.y0);
        if (g.axis === 'y') {
          g = null;
          return;
        }
        shell.classList.add('swiping');
        pane.style.transition = 'none';
      }
      // The page must not scroll while the pane follows the finger.
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - g.lastT;
      if (dt > 0) g.vx = (t.clientX - g.lastX) / dt;
      g.lastX = t.clientX;
      g.lastT = e.timeStamp;
      g.dx = Math.max(0, dx);
      pane.style.transform = `translateX(${g.dx}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      const cur = g;
      g = null;
      if (!cur?.axis) return;
      e.stopPropagation();
      // A long pause before lifting the finger is no flick.
      const vx = e.timeStamp - cur.lastT > 120 ? 0 : cur.vx;
      if (e.type !== 'touchcancel' && swipeBackDecision(cur.dx, pane.offsetWidth, vx)) {
        slideOut(pane, () => {
          goBack(navigate);
          // Normally the new route resets the pane; never leave it off screen if nothing changed.
          window.setTimeout(() => shell.classList.contains('has-chat') && pane.style.transform && reset(), 800);
        });
        return;
      }
      if (reducedMotion()) return reset();
      pane.style.transition = 'transform 0.2s ease-out';
      pane.style.transform = 'translateX(0)';
      window.setTimeout(reset, 220);
    };
    pane.addEventListener('touchstart', onStart, { passive: true });
    pane.addEventListener('touchmove', onMove, { passive: false });
    pane.addEventListener('touchend', onEnd);
    pane.addEventListener('touchcancel', onEnd);
    return () => {
      pane.removeEventListener('touchstart', onStart);
      pane.removeEventListener('touchmove', onMove);
      pane.removeEventListener('touchend', onEnd);
      pane.removeEventListener('touchcancel', onEnd);
    };
  }, [paneRef, shellRef, navigate]);
}
