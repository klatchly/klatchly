import { augmentation, definePackage, lazyChunk, space } from '../../../client/src/sdk';
import { launch, type ExampleLaunch } from '../locales/launch';
import { examplePackage, exampleSpace, exampleWords } from '../package';
import './space.css';

// The example package's client half. This file is on the app's launch path (every package's entry is in the main
// bundle), so it holds only what the shell needs before the package's own chunk arrives: ids and URLs (from
// package.ts), labels and icons, and lazy components for the core's slots. Everything else (components, strings,
// styles) is the Example chunk, loaded the first time one of its components shows.
//
// Client code imports the core through client/src/sdk.ts only (the boundary test refuses any other core module).

const load = () => import('./Example');
/** A launch string by language code ({ en: …, fr: … }), as the core's slots take them. */
const by = (f: (m: ExampleLaunch) => string) => Object.fromEntries(Object.entries(launch).map(([lang, m]) => [lang, f(m)]));

export default definePackage({
  ...examplePackage,
  modules: [
    // The space: a sidebar button (open-example), its list (left column; the page itself on a phone) and its main
    // pane (right). URLs come from package.ts, never written again here.
    space({
      ...exampleSpace,
      label: by((m) => m.label),
      icon: ExampleIcon,
      List: lazyChunk(load, 'ExampleList'),
      Main: lazyChunk(load, 'ExampleMain'),
    }),
    // The augmentation's UI: a section of the composer's ✨ menu. `hint` is a line of the ✨ button's tooltip,
    // shown before the chunk loads: say where the text goes.
    augmentation({
      id: exampleWords.id,
      composer: {
        Menu: lazyChunk(load, 'ExampleMenu'),
        hint: () => by((m) => m.hint),
      },
    }),
  ],
  // A page of Settings, at /settings/ext/example/prefs. The id is written as a literal (the boundary test reads
  // it); its menu entry's test id is settings-item-example-prefs (package id, then page id), the page's settings-prefs.
  settings: [{ id: 'prefs', title: by((m) => m.settings), Body: lazyChunk(load, 'ExampleSettings'), icon: ExampleIcon }],
});

/** The button's and the Settings entry's mark: an inline SVG, 20 px, in currentColor (no image file). */
function ExampleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
