import { useSyncExternalStore } from 'react';
import { looseText } from '../../../client/src/sdk';
import type { ComposerNetwork } from '../../../client/src/sdk';
import { DEFAULT_LANG_PREFS, type LangPrefs } from '../langs';
import { writingApi as api, type AssistMode, type AssistPrefs, type AssistTarget } from './api';

// Composer writing help (../server/assist.ts): per-chat settings, and the originals of messages sent after a
// translation, shown only to us under the sent message (kept on the server, matched by plain text); and the
// user's translation languages (app-wide, Settings → Translation languages).

// Per-chat settings, shared by the composer's menu and the conversation header.
let prefs = new Map<string, AssistPrefs>();
const loading = new Set<string>();
const prefListeners = new Set<() => void>();
function putPrefs(chatID: string, p: AssistPrefs) {
  prefs = new Map(prefs).set(chatID, p);
  prefListeners.forEach((l) => l());
}
const EMPTY: AssistPrefs = {};
export function usePrefs(chatID: string | undefined): AssistPrefs {
  const p = useSyncExternalStore(
    (l) => {
      prefListeners.add(l);
      return () => prefListeners.delete(l);
    },
    () => (chatID ? prefs.get(chatID) : undefined),
  );
  if (chatID && !p && !loading.has(chatID)) {
    loading.add(chatID);
    api.assistPrefs(chatID).then(
      (x) => putPrefs(chatID, x),
      () => putPrefs(chatID, {}),
    );
  }
  return p ?? EMPTY;
}
export async function savePrefs(chatID: string, p: AssistPrefs): Promise<AssistPrefs> {
  const out = await api.setAssistPrefs(chatID, p);
  putPrefs(chatID, out);
  return out;
}
export const rememberLang = (chatID: string, lang: AssistTarget) => putPrefs(chatID, { ...prefs.get(chatID), lang });

// The translation languages (app-wide, Settings): the defaults until the server answers, then its lists. Asked
// once, then again when the page comes back to the foreground or the network returns (at most every 30 s, so a
// change made on another device shows here); a failed ask is retried after 30 s, never on each render.
let langs: LangPrefs | undefined;
let langsAt = 0;
let langsInflight: Promise<LangPrefs> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
/** Bumped by each save: an older answer (a load, or an earlier save) must not overwrite a newer change. */
let langsSeq = 0;
const REFRESH_MS = 30_000;
const langListeners = new Set<() => void>();
function putLangs(p: LangPrefs) {
  langs = p;
  langListeners.forEach((l) => l());
}

/** Fetches the lists into the shared store (one request at a time). */
export function loadLangPrefs(): Promise<LangPrefs> {
  if (langsInflight) return langsInflight;
  const seq = langsSeq;
  langsAt = Date.now();
  clearTimeout(retry);
  langsInflight = api.langPrefs().then(
    (p) => {
      langsInflight = undefined;
      if (seq === langsSeq) putLangs(p);
      return langs ?? p;
    },
    (e) => {
      langsInflight = undefined;
      retry = setTimeout(() => void loadLangPrefs().catch(() => {}), REFRESH_MS);
      throw e;
    },
  );
  return langsInflight;
}

let watching = false;
function watchLangs() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  const refresh = () => {
    if (document.visibilityState === 'visible' && Date.now() - langsAt >= REFRESH_MS) void loadLangPrefs().catch(() => {});
  };
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
}

/** The lists as last known (undefined until the server first answered). */
export function useLoadedLangPrefs(): LangPrefs | undefined {
  const p = useSyncExternalStore(
    (l) => {
      langListeners.add(l);
      return () => langListeners.delete(l);
    },
    () => langs,
  );
  if (!langsAt) {
    watchLangs();
    void loadLangPrefs().catch(() => {});
  }
  return p;
}
export const useLangPrefs = (): LangPrefs => useLoadedLangPrefs() ?? DEFAULT_LANG_PREFS;

/** Saves the lists given: shown at once, the server's answer kept only if no newer change was made since. */
export async function saveLangPrefs(p: Partial<LangPrefs>): Promise<LangPrefs> {
  const seq = ++langsSeq;
  if (langs) putLangs({ ...langs, ...p });
  try {
    const out = await api.setLangPrefs(p);
    if (seq === langsSeq) putLangs(out);
    return out;
  } catch (e) {
    // Back to what the server has (unless a newer change is on its way).
    if (seq === langsSeq) {
      api.langPrefs().then(
        (x) => seq === langsSeq && putLangs(x),
        () => {},
      );
    }
    throw e;
  }
}

type Note = { original: string; lang: AssistTarget };
let notes = new Map<string, Map<string, Note>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function setNotes(chatID: string, fn: (m: Map<string, Note>) => void) {
  const m = new Map(notes.get(chatID) ?? []);
  fn(m);
  notes = new Map(notes).set(chatID, m);
  emit();
}

export function loadNotes(chatID: string): void {
  api.assistNotes(chatID).then(
    ({ items }) => setNotes(chatID, (m) => Object.entries(items).forEach(([k, v]) => m.set(k, v))),
    () => {},
  );
}

/** A message we are sending was a translation of `original`: keep it (here at once, on the server). */
export function addNote(chatID: string, sent: string, original: string, lang: AssistTarget): void {
  const k = looseText(sent);
  if (!k) return;
  setNotes(chatID, (m) => m.set(k, { original, lang }));
  api.addAssistNote(chatID, sent, original, lang).catch(() => {});
}

export function removeNote(chatID: string, sent: string): void {
  const k = looseText(sent);
  setNotes(chatID, (m) => m.delete(k));
  api.removeAssistNote(chatID, sent).catch(() => {});
}

export function useNote(chatID: string, text: string | undefined): Note | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (text ? notes.get(chatID)?.get(looseText(text)) : undefined),
  );
}

export class AssistError extends Error {
  constructor(
    public status: number,
    public lost: string[] = [],
  ) {
    super(`assist ${status}`);
  }
}

/** The chat's network and the formatting it displays, as the server shapes the result for it (server/assist.ts Format). */
export interface AssistFormat {
  network: string;
  formatting: Readonly<Record<string, number>>;
}

/** What the composer says of the chat's network, when it knows what it displays (else the Markdown stays as written). */
export function formatOf(network: ComposerNetwork | undefined): AssistFormat | undefined {
  return network?.formatting ? { network: network.name, formatting: network.formatting } : undefined;
}

/** POST /api/assist; a 422 carries the emoji / links / mentions the model dropped. */
export async function runAssist(body: { chatID: string; mode: AssistMode; text: string; target?: AssistTarget; keep?: string[]; format?: AssistFormat }): Promise<string> {
  const res = await fetch('/api/assist', {
    method: 'POST',
    redirect: 'manual',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { text?: string; lost?: string[] };
  if (!res.ok || typeof j.text !== 'string') throw new AssistError(res.status, Array.isArray(j.lost) ? j.lost : []);
  return j.text;
}
