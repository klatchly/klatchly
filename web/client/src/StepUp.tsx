import { useCallback, useEffect, useState } from 'react';
import { HttpError, request } from './endpoints';
import { passkeyAssertion } from './Auth';
import { useCatalog } from './i18n';
import type { SignInMessages } from './locales/signin/en';
import './stepup.css';

// Confirming it is the owner before a sensitive change (server/stepup.ts): the sign-in settings (SignInSettings.tsx)
// and the packages' pages whose server routes use the sdk's requireStepUp (an LLM provider's key…). useStepUp says
// whether this session may change them now (and asks again when the window closes); StepUpBox confirms with a
// passkey, or with a fresh sign-in at the OIDC provider when the session was opened there (or no passkey is left:
// server/auth.ts oidcStepUp), which leaves the page and comes back to it. Its strings are the sign-in catalog's
// (signin/*.ts).

export const signinCatalog: Readonly<Record<string, SignInMessages>> = Object.fromEntries(
  Object.entries(import.meta.glob<{ default: SignInMessages }>('./locales/signin/*.ts', { eager: true })).map(([f, m]) => [f.slice(f.lastIndexOf('/') + 1, -3), m.default]),
);

/** 'passkey' only now; the password forms of the removed sign-in stay in the type (extension API 1.x), never sent. */
export type StepUpMethod = 'passkey' | 'password' | 'password+code';
/** GET /api/auth/stepup. */
export interface StepUpState {
  leftMs: number;
  methods: StepUpMethod[];
}
/** What GET /api/auth/stepup also says (server/oidc.ts stepUpInfo): the OIDC provider's label when this session may confirm there. */
type StepUpInfo = StepUpState & { oidc?: string };

const api = {
  state: () => request<StepUpInfo>('GET', '/auth/stepup'),
  options: () => request<Record<string, unknown>>('POST', '/auth/stepup/options'),
  passkey: (response: unknown) => request<{ ok: true }>('POST', '/auth/stepup/passkey', { response }),
  oidc: (returnTo: string) => request<{ url: string }>('POST', '/auth/stepup/oidc', { returnTo }),
};

/** A change refused because the session must confirm first (sdk requireStepUp, or the sign-in routes). */
export const isStepUpError = (e: unknown): boolean => e instanceof HttpError && e.code === 'step_up';

/** Whether a confirmation is needed before a sensitive change (with no passkey left, StepUpBox says how to add one). */
export const stepUpLocked = (s: StepUpState | undefined): boolean => !!s && s.leftMs <= 0;

/**
 * This session's step-up state (undefined until known), fetched on mount and again when its window closes;
 * `reload` after a confirmation or a 'step_up' refusal. A page that already gets the state from its own API
 * (SignInSettings) passes it instead and skips the fetch.
 */
export function useStepUp(given?: StepUpState): { state: StepUpState | undefined; reload: () => Promise<void> } {
  const [own, setOwn] = useState<StepUpState>();
  const state = given ?? own;
  const reload = useCallback(() => api.state().then(setOwn, () => setOwn(undefined)), []);
  useEffect(() => {
    if (!given) void reload();
  }, [given, reload]);
  useEffect(() => {
    if (given || !state || state.leftMs <= 0 || !state.methods.length) return;
    const t = setTimeout(() => void reload(), state.leftMs + 500);
    return () => clearTimeout(t);
  }, [given, state, reload]);
  return { state, reload };
}

function errorText(m: SignInMessages, e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 429) return m.error.locked;
    const k = e.code as keyof SignInMessages['error'] | undefined;
    if (k && Object.hasOwn(m.error, k)) return m.error[k];
  }
  return m.error.failed;
}

/**
 * The confirmation box, shown while stepUpLocked: `onDone` runs once confirmed (reload the state). `testid` prefixes
 * its parts' test ids (<testid>, -passkey, -oidc). Whether the session may confirm at the OIDC provider, the box asks
 * the server itself (GET /api/auth/stepup: its `oidc` label), so every page that shows it offers that too.
 */
export function StepUpBox({ methods, onDone, testid = 'stepup' }: { methods: readonly StepUpMethod[]; onDone: () => void | Promise<void>; testid?: string }) {
  return <Box methods={methods} onDone={onDone} testid={testid} />;
}

/** StepUpBox, with the line above its buttons given (StepUpPrompt: an action, not settings). */
function Box({ methods, onDone, testid, hint }: { methods: readonly StepUpMethod[]; onDone: () => void | Promise<void>; testid: string; hint?: string }) {
  const m = useCatalog(signinCatalog);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    void api.state().then((s) => setProvider(s.oidc ?? null), () => setProvider(null));
  }, []);
  const atProvider = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      // Leaves for the provider; back on this page once confirmed (server/oidc.ts: a page of the app only).
      window.location.assign((await api.oidc(window.location.pathname)).url);
    } catch (e) {
      setNote(errorText(m, e));
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      await api.passkey(await passkeyAssertion(api.options));
      await onDone();
    } catch (e) {
      setNote(errorText(m, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stepup" data-testid={testid}>
      <p className="settings-hint">{methods.includes('passkey') || provider ? (hint ?? m.confirm) : m.noPasskey}</p>
      {methods.includes('passkey') && (
        <button type="button" className="text-btn primary" disabled={busy} data-testid={`${testid}-passkey`} onClick={() => void confirm()}>
          {m.confirmPasskey}
        </button>
      )}
      {provider && (
        <button type="button" className="text-btn primary" disabled={busy} data-testid={`${testid}-oidc`} onClick={() => void atProvider()}>
          {m.confirmOidc(provider)}
        </button>
      )}
      {note && (
        <p className="settings-note" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}

/** The line shown while changes are allowed: how long is left. */
export function StepUpLeft({ state }: { state: StepUpState }) {
  const m = useCatalog(signinCatalog);
  return <p className="settings-hint">{m.confirmed(Math.max(1, Math.round(state.leftMs / 60_000)))}</p>;
}

// An action (not a settings page) whose server route uses requireStepUp: withStepUp(fn) runs it, and on a 'step_up'
// refusal opens the confirmation (StepUpPrompt, rendered once by the page) then runs it again; closing the prompt
// rejects with the refusal. One prompt at a time: a second refusal while it is open waits for the same answer.
type Pending = { methods: StepUpMethod[]; done: () => void; cancel: () => void };
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
let waiting: Promise<boolean> | null = null;

function askStepUp(): Promise<boolean> {
  waiting ??= api.state().then(
    (st) =>
      new Promise<boolean>((resolve) => {
        const end = (ok: boolean) => {
          pending = null;
          waiting = null;
          changed();
          resolve(ok);
        };
        pending = { methods: st.methods, done: () => end(true), cancel: () => end(false) };
        changed();
      }),
    () => ((waiting = null), false),
  );
  return waiting;
}

export async function withStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isStepUpError(e) || !(await askStepUp())) throw e;
    return fn();
  }
}

/** The confirmation withStepUp opens, over the page. */
export function StepUpPrompt({ testid = 'stepup-prompt' }: { testid?: string }) {
  const m = useCatalog(signinCatalog);
  const [, render] = useState(0);
  useEffect(() => {
    const l = () => render((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  useEffect(() => {
    if (!pending) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && pending?.cancel();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const p = pending;
  if (!p) return null;
  return (
    <div className="stepup-backdrop" data-testid={testid} onClick={(e) => e.target === e.currentTarget && p.cancel()}>
      <div className="stepup-dialog" role="dialog" aria-modal="true">
        <Box methods={p.methods} onDone={p.done} testid={`${testid}-box`} hint={m.confirmAction} />
        <button type="button" className="text-btn" data-testid={`${testid}-cancel`} onClick={p.cancel}>
          {m.cancel}
        </button>
      </div>
    </div>
  );
}
