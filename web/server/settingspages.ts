// The Settings pages' URLs, shared by the server (which serves only these, server/app.ts) and the client
// (client/src/settingsroute.ts). Pure data, no imports.

/** The core's pages, in menu order: /settings/<page>. */
export const CORE_PAGES = ['general', 'reading', 'quiet', 'app', 'extensions'] as const;

/** The pages of 0.15.7, now blocks of a core page: still served, the client replaces them with their page's URL. */
export const MOVED_PAGES = ['language', 'notifications', 'account', 'storage', 'about'] as const;

/** A package id or a section id in a Settings URL (/settings/ext/<package>/<section>): one lower-case segment. */
export const SETTINGS_SEGMENT = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * A place inside a package's page (/settings/ext/<package>/<section>/<sub>, SettingsSection.segment): one segment, as
 * a space's places (its own pattern is the client's to check).
 */
export const SETTINGS_SUB = /^[A-Za-z0-9_-]{1,600}$/;

/**
 * Whether a path is a Settings page: /settings, a core page (or a former one), or a package's page (any well-formed
 * ids), with a place inside it or not.
 */
export function isSettingsPath(path: string): boolean {
  if (path === '/settings') return true;
  if (!path.startsWith('/settings/')) return false;
  const parts = path.slice('/settings/'.length).split('/');
  if (parts.length === 1) return [...CORE_PAGES, ...MOVED_PAGES].includes(parts[0] as never);
  if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== 'ext' || !SETTINGS_SEGMENT.test(parts[1]!) || !SETTINGS_SEGMENT.test(parts[2]!)) return false;
  return parts.length === 3 || SETTINGS_SUB.test(parts[3]!);
}
