import { useMemo } from 'react';
import { localized, useCatalog, useLang, useModuleInfo, useT as useCoreT } from '../../../client/src/sdk';
import type { Messages } from '../../../client/src/sdk';
import { writingCatalog, type WritingMessages } from '../locales/index';
import { launch, llmLabelIn, type WritingLaunch } from '../locales/launch';
import { writingModule, writingPackage } from '../package';

// Writing's components read the core strings and their own under `t.writing` (and the launch-path ones under
// `t.writingLaunch`), as when they were one catalog; `t.privacy` is the privacy line of writing help, with who
// answers (the module's server info), and `t.privacyAll` the one of the chat's settings (both features: each named
// when they go to different providers).
export type T = Messages & { writing: WritingMessages; writingLaunch: WritingLaunch; privacy: string; privacyAll: string };

export function useT(): T {
  const t = useCoreT();
  const writing = useCatalog(writingCatalog);
  const lang = useLang();
  const info = useModuleInfo(writingPackage.id, 'augmentation', writingModule.id);
  return useMemo(() => {
    const l = localized(launch, lang);
    const assist = llmLabelIn(info, lang);
    const translate = llmLabelIn(info, lang, 'llmLabelTranslate');
    const privacy = l.privacy(assist);
    return { ...t, writing, writingLaunch: l, privacy, privacyAll: assist === translate ? privacy : localized(writingCatalog, lang).assist.privacyBoth(assist, translate) };
  }, [t, writing, lang, info]);
}

/** Outside React (an error line built in a promise): the current language's strings. */
export const writingT = (): WritingMessages => localized(writingCatalog);
