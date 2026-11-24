import { backMode, settingsLeave, settingsPageState } from './gestures';
import { isSpaceHome, spaces } from './registry';
import { settingsAt } from './settingsroute';

type Navigate = (to: string, opts?: { replace?: boolean; state?: unknown }) => void;

export const phoneLayout = () => window.matchMedia('(max-width: 799px)').matches;
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SLIDE_MS = 220;

/** The list a pane belongs to: a space's list for its places, the Settings menu for its pages, the chat list otherwise. */
export function listPathFor(path: string): string {
  if (settingsAt(path)) return path === '/settings' ? '/' : '/settings';
  for (const space of spaces.map((s) => s.path)) if (path === space || path.startsWith(`${space}/`)) return space;
  return '/';
}

/**
 * The gear: opens Settings over the current screen (one history entry, so Back returns there), or leaves it
 * when already open, so toggling never grows the history.
 */
export function toggleSettings(navigate: Navigate): void {
  if (settingsAt(location.pathname)) return leaveSettings(navigate);
  navigate('/settings', { state: { fromList: true, from: location.pathname } });
}

/** Leaves Settings for the screen it was opened from, from its menu or any of its pages, without growing the history. */
export function leaveSettings(navigate: Navigate): void {
  const to = settingsLeave(history.state, location.pathname === '/settings');
  if ('go' in to) history.go(to.go);
  else navigate(to.replace, { replace: true });
}

/**
 * A page of the Settings menu: from the menu, a list entry (Back returns to the menu, as from a chat); from
 * another page, or the page already shown beside the menu (`shown`, wide screen), it takes the current entry
 * (switching pages never grows the history).
 */
export function openSettingsPage(navigate: Navigate, href: string, shown = false): void {
  if (location.pathname === href) return;
  if (location.pathname === '/settings' && !shown) navigate(href, { state: settingsPageState(history.state) });
  else navigate(href, { replace: true, state: history.state });
}

/** History state for a chat opened from the list: Back then pops it instead of stacking a new list entry. */
export function fromListState(): { fromList: true } | null {
  const p = location.pathname;
  return p === '/' || isSpaceHome(p) ? { fromList: true } : null;
}

/** Same URL rewritten (query cleaned, session picked): keep the entry's state (fromList). */
export function replaceKeepState(navigate: Navigate, to: string): void {
  navigate(to, { replace: true, state: history.state });
}

/** Back to the list, without growing the history. */
export function goBack(navigate: Navigate): void {
  if (backMode(history.state) === 'pop') history.back();
  else navigate(listPathFor(location.pathname), { replace: true });
}

/** The chat pane slides out to the right (from where a swipe left it), then `done` runs. */
export function slideOut(pane: HTMLElement, done: () => void): void {
  if (reducedMotion()) return done();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  pane.style.transition = `transform ${SLIDE_MS}ms ease-out`;
  pane.style.transform = `translateX(${pane.offsetWidth}px)`;
  pane.addEventListener('transitionend', finish, { once: true });
  window.setTimeout(finish, SLIDE_MS + 80);
}

/** Back button of the chat and space headers: on a phone the pane slides away first. */
export function backToList(navigate: Navigate): void {
  const pane = document.querySelector<HTMLElement>('.shell.has-chat .pane-chat');
  if (!pane || !phoneLayout()) return goBack(navigate);
  pane.closest('.shell')?.classList.add('swiping');
  slideOut(pane, () => goBack(navigate));
}
