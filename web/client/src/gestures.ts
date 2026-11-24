// Touch gesture and navigation decisions. Pure functions (unit-tested in test/gestures.test.ts), no imports.

/** Edge swipe-back starts only this close to the left edge (clear of swipe-to-reply on the bubbles). */
export const EDGE_PX = 20;

export function isEdgeStart(x: number): boolean {
  return x >= 0 && x < EDGE_PX;
}

/**
 * Direction of a gesture from its first move: 'x' when mostly horizontal and to the right (a swipe back),
 * 'y' otherwise (the list scrolls as usual).
 */
export function edgeAxis(dx: number, dy: number): 'x' | 'y' {
  return dx > 0 && Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
}

/**
 * Release of an edge swipe (dx px dragged, vx px/ms at release): back past 35 % of the width or on a quick
 * flick to the right; otherwise the pane snaps back.
 */
export function swipeBackDecision(dx: number, width: number, vx: number): boolean {
  if (dx <= 0 || width <= 0) return false;
  return dx > width * 0.35 || (vx > 0.4 && dx > 24);
}

/**
 * Back from a chat: an entry opened from the list (history.state.fromList) goes back in history, so the
 * stack stays list → chat; any other entry (notification, link, reload) is replaced by the list.
 */
export function backMode(state: unknown): 'pop' | 'replace' {
  return !!state && typeof state === 'object' && (state as { fromList?: unknown }).fromList === true ? 'pop' : 'replace';
}

/** Drag down to dismiss (lightbox, bottom sheets): far enough, or a quick flick. */
export function swipeDismiss(dy: number, ms: number): boolean {
  return dy > 110 || (ms < 300 && dy > 50);
}

/**
 * Where Settings was opened from (history.state.from, kept across a reload): an app path, else the chat list.
 * Leaving Settings returns there; its list stays mounted, hidden, under the Settings menu.
 */
export function settingsOrigin(state: unknown): string {
  const from = !!state && typeof state === 'object' ? (state as { from?: unknown }).from : undefined;
  return typeof from === 'string' && from.length <= 512 && /^\/(?![/\\])/.test(from) && !/^\/settings(\/|$)/.test(from) ? from : '/';
}

/**
 * History state of a Settings page opened from the menu (/settings): a list entry like a chat's (Back pops it to
 * the menu), with where Settings was opened from, and whether the menu's own entry was a list entry too.
 */
export function settingsPageState(menuState: unknown): { fromList: true; from: string; settingsMenu: 'pop' | 'replace' } {
  return { fromList: true, from: settingsOrigin(menuState), settingsMenu: backMode(menuState) };
}

/**
 * Leaving Settings (its menu's Back, Escape on a wide screen, the gear): back past the page and the menu when
 * both were opened in the app, one step when this entry is the gear's own (the menu, or a page that took its
 * entry), else the screen it was opened from replaces this entry.
 */
export function settingsLeave(state: unknown, onMenu: boolean): { go: number } | { replace: string } {
  const menu = !onMenu && !!state && typeof state === 'object' ? (state as { settingsMenu?: unknown }).settingsMenu : undefined;
  if (menu !== undefined) return menu === 'pop' && backMode(state) === 'pop' ? { go: -2 } : { replace: settingsOrigin(state) };
  return backMode(state) === 'pop' ? { go: -1 } : { replace: settingsOrigin(state) };
}

/**
 * A chat row opens as the button goes down (desktop messaging apps do; a click lasts about a tenth of a second):
 * the main mouse button without a modifier (those open a new tab or window), on a row not already open (its click
 * leads back to the chat from its media page). Never a finger or a pen: that press may start a scroll.
 */
export function opensOnPress(e: { pointerType: string; button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, active: boolean): boolean {
  return !active && e.pointerType === 'mouse' && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}
