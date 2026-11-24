import { augmentation, definePackage, type ModuleInfo } from '#core/sdk.js';
import type { LlmProvider } from '#ext/llm/api.js';
import { writingAbout } from '../locales/index.js';
import { writingModule, writingPackage } from '../package.js';
import { llmLabel, setLlm } from './ai.js';
import { setChats } from './chats.js';
import { assistRoutes } from './assist.js';
import { translateRoutes, translationsRoutes } from './translate.js';

// Writing's server half. Its API keeps the paths it had in the core (/api/assist, /api/translate,
// /api/translations), hence `mounts` rather than /api/writing/. Every call reaches the model through the llm
// provider it gets at start, where its two uses are listed (Settings → Default models: llm's page since llm 1.1,
// which replaced writing's /api/ai and its AI models page).

export default definePackage({
  ...writingPackage,
  about: writingAbout,
  modules: [
    augmentation({
      ...writingModule,
      mounts: { assist: assistRoutes, translate: translateRoutes, translations: translationsRoutes },
      // The privacy lines name who answers each feature (llm's labelFor: KLATCHLY_LLM_LABEL, or the provider's name):
      // `llmLabel` writing help (the ✨ menu), `llmLabelTranslate` the translation of received messages.
      info: (): ModuleInfo => {
        const assist = llmLabel('assist');
        const translate = llmLabel('translate');
        return { ...(assist ? { llmLabel: assist } : {}), ...(translate ? { llmLabelTranslate: translate } : {}) };
      },
      start: (ctx) => {
        const llm = ctx.provider<LlmProvider>('llm');
        if (!llm || !ctx.chats) throw new Error('no llm provider or chat reader');
        setLlm(llm);
        setChats(ctx.chats);
      },
      stop: () => {
        setLlm(undefined);
        setChats(undefined);
      },
    }),
  ],
});
