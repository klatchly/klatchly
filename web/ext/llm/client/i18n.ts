import { useCatalog } from '../../../client/src/sdk';
import { llmCatalog, type LlmMessages } from '../locales/index';

// The llm chunk's strings, in the current language.
export const useT = (): LlmMessages => useCatalog(llmCatalog);
