import { useState, type FormEvent } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { authApi as api, HttpError } from './api';
import { useBootT } from './i18n';

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <circle cx="8" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 12h9M18 12v3M21 12v2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

type State = 'idle' | 'busy' | 'error';
type PasskeyOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

/** What the sign-in page offers (GET /api/session, server/auth.ts loginMethods): passkeys, an OIDC provider. */
export interface LoginMethods {
  passkey: boolean;
  /** The provider configured on the server (server/oidc.ts): "Continue with <label>". */
  oidc?: { label: string };
}

/** Sends the browser to the provider (the URL a POST of server/oidc.ts gives); it comes back on its own. */
async function toProvider(start: () => Promise<{ url: string }>): Promise<void> {
  const { url } = await start();
  window.location.assign(url);
}

/** A passkey assertion: for sign-in on /auth/options, or on the challenge `options` gives (step-up). */
export async function passkeyAssertion(options: () => Promise<Record<string, unknown>> = api.loginOptions): Promise<unknown> {
  const optionsJSON = (await options()) as unknown as PasskeyOptions;
  return startAuthentication({ optionsJSON });
}

/**
 * The sign-in page: the key button (passkeys; a new device enrolls on /enroll with a code from the server) and, when
 * the server has an OIDC provider, "Continue with <label>" (the provider decides how one authenticates there).
 */
export function Login({ onDone, methods, beforeProvider }: { onDone: () => void; methods?: LoginMethods; beforeProvider?: () => void }) {
  const t = useBootT();
  const [state, setState] = useState<State>('idle');
  const [note, setNote] = useState<string>();
  const unlock = async () => {
    setState('busy');
    setNote(undefined);
    try {
      await api.loginVerify(await passkeyAssertion());
      onDone();
    } catch (e) {
      setState('error');
      setNote(e instanceof HttpError && e.status === 429 ? t.locked : undefined);
    }
  };
  const provider = async () => {
    setState('busy');
    setNote(undefined);
    try {
      // The page this sign-in shows over (a shared link on /share…), kept in this tab: the provider comes back to /.
      beforeProvider?.();
      await toProvider(api.oidcStart);
    } catch (e) {
      setState('error');
      setNote(e instanceof HttpError && e.status === 429 ? t.locked : e instanceof HttpError && e.code === 'unavailable' ? t.providerUnavailable : undefined);
    }
  };
  return (
    <main className={`gate gate-${state}`}>
      <div className="gate-mark" aria-hidden="true" />
      {methods?.passkey !== false && (
        <button type="button" className="gate-key" aria-label={t.unlock} data-testid="unlock" onClick={() => void unlock()} disabled={state === 'busy'}>
          <KeyIcon />
        </button>
      )}
      {methods?.oidc && (
        <button type="button" className="gate-provider" data-testid="oidc-continue" onClick={() => void provider()} disabled={state === 'busy'}>
          {t.continueWith(methods.oidc.label)}
        </button>
      )}
      {note && (
        <p className="gate-note" role="alert" data-testid="login-note">
          {note}
        </p>
      )}
    </main>
  );
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'passkey';
}

/**
 * /enroll, with a code from the server (cli.js enroll): registers a passkey on this device or, when the server has
 * an OIDC provider, links the provider's account (the identity that signs in next: server/oidc.ts).
 */
export function Enroll({ onDone, methods }: { onDone: () => void; methods?: LoginMethods }) {
  const t = useBootT();
  const [code, setCode] = useState('');
  const [state, setState] = useState<State>('idle');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('busy');
    try {
      const optionsJSON = (await api.enrollOptions(code)) as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'];
      const response = await startRegistration({ optionsJSON });
      await api.enrollVerify(code, response, deviceLabel());
      onDone();
    } catch {
      setState('error');
    }
  };
  const ready = code.replace(/[\s-]/g, '').length >= 20;
  const link = async () => {
    setState('busy');
    try {
      await toProvider(() => api.oidcLink(code));
    } catch {
      setState('error');
    }
  };
  return (
    <main className={`gate gate-${state}`}>
      <div className="gate-mark" aria-hidden="true" />
      <form className="gate-form" onSubmit={submit}>
        <input
          className="gate-code"
          aria-label={t.code}
          data-testid="enroll-code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          maxLength={40}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (state === 'error') setState('idle');
          }}
        />
        <button type="submit" className="gate-key" aria-label={t.register} data-testid="enroll-submit" disabled={state === 'busy' || !ready}>
          <KeyIcon />
        </button>
        {methods?.oidc && (
          <button type="button" className="gate-provider" data-testid="oidc-link" disabled={state === 'busy' || !ready} onClick={() => void link()}>
            {t.linkWith(methods.oidc.label)}
          </button>
        )}
      </form>
    </main>
  );
}
