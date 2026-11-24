import { isIOS, isStandalone } from './platform';

/**
 * Sizes seen by the page, shown in Settings to diagnose iOS layout issues: screen, innerHeight, root height, the
 * safe-area top inset (> 0: the install draws under the status bar), standalone, and the top header's position.
 */
export function viewportReport(): string {
  const root = document.getElementById('root');
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;visibility:hidden;padding-top:env(safe-area-inset-top)';
  document.body.appendChild(probe);
  const safeTop = Math.round(parseFloat(getComputedStyle(probe).paddingTop) || 0);
  probe.remove();
  const header = document.querySelector('.list-header, .conv-header');
  const hdr = header ? `${getComputedStyle(header).position}@${Math.round(header.getBoundingClientRect().top)}` : '-';
  return `${screen.width}×${screen.height} · ${window.innerWidth}×${window.innerHeight} · ${Math.round(root?.getBoundingClientRect().height ?? 0)} · safe-top ${safeTop} · ${isStandalone() ? 'standalone' : 'browser'} · header ${hdr}`;
}

// Inputs that bring up the on-screen keyboard (not checkboxes, file pickers, buttons...).
const TEXT_INPUT = /^(text|search|email|url|tel|password|number)$/;
function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT.test(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}
const typing = () => isTextField(document.activeElement);

/**
 * html.kb-open while a text field has the focus (the keyboard is up on a phone). iOS keeps the bottom safe
 * area inset (home indicator) while the keyboard covers it, which leaves a gap under the composer: the
 * composers drop that padding while the class is set (styles.css).
 */
export function watchKeyboard(): void {
  const html = document.documentElement;
  const sync = () => html.classList.toggle('kb-open', typing());
  document.addEventListener('focusin', sync);
  // Moving from one field to another fires focusout then focusin: decide once the focus has landed.
  document.addEventListener('focusout', () => window.setTimeout(sync, 0));
}

/**
 * iOS. Home-screen app: with the translucent status bar, WebKit can size the page (100%, innerHeight) about
 * one status-bar height short of the screen, and after the keyboard closes it can keep a shrunken height.
 * Either way an empty band shows under the app. The app fills the whole screen there, so size the root from
 * the screen itself, re-checked whenever the viewport changes and once the keyboard is gone.
 * Keyboard (app and Safari): iOS ignores interactive-widget=resizes-content, so the keyboard covers the page
 * and WebKit pans it to show the field, taking the header off screen. While it is up, the root takes the
 * visible height (visualViewport) and the page stays at the top: header, messages and composer all fit.
 */
/** Whether the page draws under the status bar (an install from before 0.20.1: black-translucent). */
function underStatusBar(): boolean {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top)';
  document.body.appendChild(probe);
  const top = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return top > 0;
}

export function fitIOSViewport(): void {
  if (!isIOS()) return;
  const html = document.documentElement;
  const standalone = isStandalone();
  const vv = window.visualViewport;
  const screenSize = () => {
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    return portrait ? [Math.min(screen.width, screen.height), Math.max(screen.width, screen.height)] : [Math.max(screen.width, screen.height), Math.min(screen.width, screen.height)];
  };
  // A keyboard takes far more than this; a smaller difference is the status-bar band or Safari's toolbars.
  const KEYBOARD_PX = 120;
  const keyboardUp = () => {
    if (!vv || !typing()) return false;
    const full = standalone ? screenSize()[1]! : window.innerHeight;
    return vv.height < full - KEYBOARD_PX;
  };
  const fit = () => {
    if (keyboardUp()) {
      html.style.setProperty('--app-h', `${Math.round(vv!.height)}px`);
      if (window.scrollY !== 0 || vv!.offsetTop !== 0) window.scrollTo(0, 0);
      return;
    }
    // Focused but the keyboard not (yet) up: leave the layout alone until it shows or the field is left.
    if (typing()) return;
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    const [w, h] = screenSize();
    // Whenever the app spans the full screen width (not an iPad split view): the short layout comes and goes,
    // and not always with a smaller innerHeight or a resize event, so don't wait to measure it. Only for an install
    // that draws under the status bar (black-translucent, safe-area top > 0): with the opaque bar (0.20.1+, status
    // bar style "default") the page starts below it, and the screen height would make it a status bar too tall.
    if (standalone && underStatusBar() && Math.abs(window.innerWidth - w!) <= 1) html.style.setProperty('--app-h', `${h}px`);
    else html.style.removeProperty('--app-h');
  };
  fit();
  window.addEventListener('resize', fit);
  vv?.addEventListener('resize', fit);
  vv?.addEventListener('scroll', fit);
  window.addEventListener('orientationchange', () => window.setTimeout(fit, 300));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && fit());
  document.addEventListener('focusin', () => window.setTimeout(fit, 50));
  // The keyboard animates out after the blur; check once it is gone. iOS 26 can leave the visual viewport
  // offset (offsetTop > 0) after the keyboard closes: scroll back to the top explicitly.
  document.addEventListener('focusout', () =>
    [350, 700].forEach((ms) =>
      window.setTimeout(() => {
        if (typing()) return;
        window.scrollTo(0, 0);
        fit();
      }, ms),
    ),
  );
}
