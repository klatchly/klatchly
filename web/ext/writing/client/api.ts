import { qs, request } from '../../../client/src/sdk';
import type { Lang, LangPrefs } from '../langs';
import type { AssistMode, AssistQuick } from './choices';
import type { MsgQuick } from './msgquick';

// Writing's calls (server/assist.ts, translate.ts), on the paths they had in the core.

export type { AssistMode, AssistQuick };
export type AssistTarget = Lang;
export type AssistMsgQuick = MsgQuick;
export interface AssistPrefs {
  /** '' when sent: back to the default (the first language for drafts). */
  lang?: AssistTarget | '';
  address?: string;
  /** '' when sent: back to the default. */
  quick?: AssistQuick | '';
  /** Same: '' back to the default (translate into the first language for received messages). */
  msgQuick?: AssistMsgQuick | '';
}

export const writingApi = {
  langPrefs: () => request<LangPrefs>('GET', '/assist/langs'),
  setLangPrefs: (p: Partial<LangPrefs>) => request<LangPrefs>('PUT', '/assist/langs', p),
  assistPrefs: (chatID: string) => request<AssistPrefs>('GET', `/assist/prefs${qs({ chatID })}`),
  setAssistPrefs: (chatID: string, p: AssistPrefs) => request<AssistPrefs>('PUT', '/assist/prefs', { chatID, ...p }),
  assistNotes: (chatID: string) => request<{ items: Record<string, { original: string; lang: AssistTarget }> }>('GET', `/assist/notes${qs({ chatID })}`),
  addAssistNote: (chatID: string, sent: string, original: string, lang: AssistTarget) =>
    request<{ ok: true }>('POST', '/assist/note', { chatID, sent, original, lang }),
  removeAssistNote: (chatID: string, sent: string) => request<{ ok: true }>('POST', '/assist/note', { chatID, sent, remove: true }),
  translations: (chatID: string) =>
    request<{ items: Record<string, { target: Lang; text: string }> }>('GET', `/translations${qs({ chatID })}`),
  hideTranslation: (chatID: string, messageID: string) => request<{ ok: true }>('POST', '/translations/hide', { chatID, messageID }),
  translate: (chatID: string, messageID: string, target: Lang) =>
    request<{ text: string; target: string }>('POST', '/translate', { chatID, messageID, target }),
  translateImage: (chatID: string, messageID: string, index: number, target: Lang) =>
    request<{ text: string; target: string }>('POST', '/translate/image', { chatID, messageID, index, target }),
};
