import { augmentation, definePackage, lazyChunk } from '../../../client/src/sdk';
import { launch, llmLabelIn, type WritingLaunch } from '../locales/launch';
import { writingModule, writingPackage } from '../package';

// Writing's client half, on the launch path: which slots it fills (all lazy, from the Writing chunk) and the few
// strings the core shows before that chunk arrives.

const load = () => import('./Writing');
/** A launch string by language code. */
const by = (f: (m: WritingLaunch, lang: string) => string) => Object.fromEntries(Object.entries(launch).map(([lang, m]) => [lang, f(m, lang)]));

export default definePackage({
  ...writingPackage,
  modules: [
    augmentation({
      id: writingModule.id,
      composer: {
        Menu: lazyChunk(load, 'WritingMenu'),
        Tools: lazyChunk(load, 'WritingTools'),
        hint: (info) => by((m, lang) => `${m.privacy(llmLabelIn(info, lang))}\n${m.shortcuts}`),
        // Its fixes and translation also in the ✨ of a message being edited (often to fix its spelling).
        inEdit: true,
      },
      Header: lazyChunk(load, 'WritingHeader'),
      Conversation: lazyChunk(load, 'WritingConversation'),
      message: {
        Actions: lazyChunk(load, 'WritingActions'),
        Below: lazyChunk(load, 'WritingBelow'),
        Menu: lazyChunk(load, 'WritingMenuEntries'),
      },
    }),
  ],
  settings: [
    { id: 'langs', title: by((m) => m.langsTitle), Body: lazyChunk(load, 'LangSettings'), icon: LangsIcon },
  ],
});

/** Its Settings entry (Translation languages): a character and a letter, as on the one-tap translate button. */
function LangsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M4 5h9M8.5 3v2M11 5c-.8 3.6-3.2 6.4-6.5 8M6.5 8.5c1.2 2 3 3.6 5 4.5M13 21l4-9 4 9M14.4 18h5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
