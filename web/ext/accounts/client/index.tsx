import { definePackage, lazyChunk, space } from '../../../client/src/sdk';
import { launch } from '../locales/launch';
import { accountsPackage, networksSpace } from '../package';
import { AccountsIcon, useAccountsTrouble } from './launch';
import './space.css';

// The accounts package's client half, on the launch path: Settings → Networks (its entry's mark, title and count of
// accounts in trouble, which also puts a dot on the Settings button) and the space's old URLs, which send on to
// it (no button since 1.2). The page, its strings and styles are the chunk, loaded when the page opens.

const chunk = () => import('./AccountsSpace');
/** A launch string by language code. */
const by = <V,>(f: (m: (typeof launch)[string]) => V) => Object.fromEntries(Object.entries(launch).map(([lang, m]) => [lang, f(m)]));

export default definePackage({
  ...accountsPackage,
  modules: [
    space({
      ...networksSpace,
      button: false,
      label: by((m) => m.label),
      icon: AccountsIcon,
      List: lazyChunk(chunk, 'AccountsRedirectList'),
      Main: lazyChunk(chunk, 'AccountsRedirectMain'),
    }),
  ],
  settings: [
    {
      // As NETWORKS_SECTION (package.ts): written in place, as the boundary test reads it.
      id: 'networks',
      title: by((m) => m.settings),
      icon: AccountsIcon,
      segment: networksSpace.segment,
      useBadge: useAccountsTrouble,
      Body: lazyChunk(chunk, 'AccountsSettings'),
    },
  ],
});
