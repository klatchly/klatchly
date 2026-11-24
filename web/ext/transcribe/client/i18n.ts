import { useCatalog } from '../../../client/src/sdk';
import { transcribeCatalog, type TranscribeMessages } from '../locales/index';

// The transcribe chunk's strings, in the current language.
export const useT = (): TranscribeMessages => useCatalog(transcribeCatalog);
