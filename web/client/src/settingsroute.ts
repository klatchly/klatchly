// Settings URLs (pure, shared with the tests). /settings is the menu (in the list column; on a wide screen the
// pane shows its first page beside it), /settings/<page> one of the core's pages, and /settings/ext/<package>/<id>
// a page a package contributes (ClientPackage.settings): a namespace of its own, so no package can shadow a core
// page whatever it names its sections.

/** The core's pages, in menu order (the server serves the same: server/settingspages.ts, checked by the tests). */
export const CORE_PAGES = ['general', 'reading', 'quiet', 'app', 'extensions'] as const;
/**
 * The pages of 0.15.7, now blocks of a page (0.15.8): their URLs still open, replaced by their page's with the
 * block as its anchor (/settings/notifications → /settings/general#notifications).
 */
export const MOVED_PAGES = { language: 'general', notifications: 'general', account: 'general', storage: 'app', about: 'app' } as const;
/** A package id or a section id, as it may appear in a URL: one lower-case segment. */
export const SETTINGS_SEGMENT = /^[a-z][a-z0-9-]{0,39}$/;
export type CorePage = (typeof CORE_PAGES)[number];
/** A block of a core page, by its 0.15.7 page id (its anchor). */
type SettingsBlock = keyof typeof MOVED_PAGES;

/** A place inside a package's page (/settings/ext/<package>/<section>/<sub>): the section's own pattern applies too. */
export const SETTINGS_SUB = /^[A-Za-z0-9_-]{1,600}$/;

/** A page of Settings: one of the core's, or a package's section (a place inside it: `sub`, SettingsSection.segment). */
export type SettingsPlace = { core: CorePage } | { pkg: string; section: string; sub?: string };

const isCore = (s: string): s is CorePage => (CORE_PAGES as readonly string[]).includes(s);
const isMoved = (s: string): s is SettingsBlock => Object.hasOwn(MOVED_PAGES, s);

/**
 * Where a path is in Settings: undefined outside it; `place` undefined for /settings itself and for a page this
 * build does not know (the menu then shows, and the pane its first page). A former page's path has its page as
 * `place` and, in `moved`, the URL that replaces it.
 */
export function settingsAt(path: string): { place: SettingsPlace | undefined; moved?: string } | undefined {
  if (path === '/settings') return { place: undefined };
  if (!path.startsWith('/settings/')) return undefined;
  const parts = path.slice('/settings/'.length).split('/');
  if (parts.length === 1 && isCore(parts[0]!)) return { place: { core: parts[0] } };
  if (parts.length === 1 && isMoved(parts[0]!)) return { place: { core: MOVED_PAGES[parts[0]] }, moved: `/settings/${MOVED_PAGES[parts[0]]}#${parts[0]}` };
  if (parts.length === 3 && parts[0] === 'ext' && SETTINGS_SEGMENT.test(parts[1]!) && SETTINGS_SEGMENT.test(parts[2]!)) {
    return { place: { pkg: parts[1]!, section: parts[2]! } };
  }
  if (parts.length === 4 && parts[0] === 'ext' && SETTINGS_SEGMENT.test(parts[1]!) && SETTINGS_SEGMENT.test(parts[2]!) && SETTINGS_SUB.test(parts[3]!)) {
    return { place: { pkg: parts[1]!, section: parts[2]!, sub: parts[3]! } };
  }
  return { place: undefined };
}

/** The URL of a page of Settings. */
export const settingsHref = (p: SettingsPlace): string =>
  'core' in p ? `/settings/${p.core}` : `/settings/ext/${p.pkg}/${p.section}${p.sub ? `/${p.sub}` : ''}`;

/** The page a place is in (its sub dropped). */
const pageOf = (p: SettingsPlace): SettingsPlace => ('core' in p ? p : { pkg: p.pkg, section: p.section });

/** Same page, whatever place inside it (the menu's aria-current). */
export const samePlace = (a: SettingsPlace | undefined, b: SettingsPlace | undefined): boolean =>
  !!a && !!b && settingsHref(pageOf(a)) === settingsHref(pageOf(b));
