import type { Locale } from '../../server/locales/en';
import { registerCatalogs } from './i18n';

// The app's interface catalogs (server/locales/, shared with the server): with the app's code only, never in the public
// boot entry (i18n.ts holds the language and the signed-out strings). Imported first by the private entry
// (appmain.tsx), so they are registered before any module of the app calls t() or useT().

const modules = import.meta.glob<{ default: Locale }>('../../server/locales/*.ts', { eager: true });
/** Every language of the interface, by its own name (the language picker, Settings). */
export const LOCALES: Locale[] = Object.values(modules)
  .map((m) => m.default)
  .sort((a, b) => a.name.localeCompare(b.name));
registerCatalogs(LOCALES);
