import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { HttpError, request } from './endpoints';
import { deviceLabel } from './Auth';
import { useCatalog, useLang, useT } from './i18n';
import type { SignInMessages } from './locales/signin/en';
import { Group as Card, Note, Row } from './Settings';
import { signinCatalog as CATALOG, StepUpBox, StepUpLeft, stepUpLocked, type StepUpState } from './StepUp';
import './signin.css';

// Settings → Général → Connexion: passkeys, and the OIDC provider when the server has one (server/auth.ts, signin.ts,
// oidc.ts). Its own chunk (strings, styles), fetched when Général opens. Closed, the row says how many passkeys and
// devices there are, and when a passkey was added lately (the same alert went to the other devices as a
// notification); Manage… opens the passkeys (add one on this device, rename, remove, never the last way to sign in), the provider (the
// account linked: issuer and subject; unlink) and the connected devices (sign one out, or all the others), or first
// the step-up box when a confirmation is needed (StepUp.tsx: a recent sign-in, a passkey or the provider).

/** GET /api/auth/settings (server/signin.ts describe). */
interface Passkey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  addedFrom: string | null;
}
interface Device {
  id: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  device: string | null;
  method?: string;
  current: boolean;
}
interface Provider {
  label: string;
  issuer: string;
  linked: { iss: string; sub: string; linkedAt: string } | null;
  pinnedSub: string | null;
  ready: boolean;
}
interface Settings {
  mode: 'passkey';
  passkeys: Passkey[];
  devices: Device[];
  oidc?: Provider | null;
  stepUp: StepUpState;
}

const api = {
  get: () => request<Settings>('GET', '/auth/settings'),
  addOptions: () => request<Record<string, unknown>>('POST', '/auth/passkeys/options'),
  add: (response: unknown, label: string) => request<Settings>('POST', '/auth/passkeys', { response, label }),
  rename: (id: string, label: string) => request<Settings>('PUT', `/auth/passkeys/${encodeURIComponent(id)}`, { label }),
  remove: (id: string) => request<Settings>('DELETE', `/auth/passkeys/${encodeURIComponent(id)}`),
  signOut: (id: string) => request<Settings>('DELETE', `/auth/sessions/${encodeURIComponent(id)}`),
  signOutOthers: () => request<Settings>('POST', '/auth/sessions/revoke-others'),
  unlink: () => request<Settings>('DELETE', '/auth/oidc'),
};

/** A passkey added this recently is announced on the row (and was pushed to the other devices when it was). */
const RECENT_MS = 14 * 24 * 3600_000;

function errorText(m: SignInMessages, e: unknown): string {
  // The browser's answer to the registration (@simplewebauthn/browser WebAuthnError): this authenticator already
  // holds one of the passkeys excluded, or the owner cancelled.
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return m.error.registered;
  if (e instanceof Error && e.name === 'NotAllowedError') return m.error.cancelled;
  if (e instanceof HttpError) {
    if (e.status === 429) return m.error.locked;
    const k = e.code as keyof SignInMessages['error'] | undefined;
    if (k && Object.hasOwn(m.error, k)) return m.error[k];
  }
  return m.error.failed;
}

/** One block of the opened row: its name on the left, its content on the right (stacked when narrow). */
function Group({ title, children, testid }: { title: string; children: ReactNode; testid: string }) {
  return (
    <div className="signin-group" data-testid={testid}>
      <h4 className="signin-sub">{title}</h4>
      <div className="signin-body">{children}</div>
    </div>
  );
}

export function SignInRow() {
  const m = useCatalog(CATALOG);
  const t = useT();
  const lang = useLang();
  const [s, setS] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [open, setOpen] = useState(false);
  // The passkey being renamed (its id and the name typed), and the action waiting for a confirmation.
  const [editing, setEditing] = useState<{ id: string; label: string }>();
  // The name of the passkey being added on this device (open while set).
  const [adding, setAdding] = useState<string>();
  const [ask, setAsk] = useState<{ text: string; testid: string; go: () => Promise<Settings> }>();

  const load = useCallback(() => api.get().then(setS, () => setNote(m.error.failed)), [m]);
  useEffect(() => void load(), [load]);
  // The step-up window closes on its own: ask again then.
  useEffect(() => {
    if (!s || s.stepUp.leftMs <= 0) return;
    const timer = setTimeout(() => void load(), s.stepUp.leftMs + 500);
    return () => clearTimeout(timer);
  }, [s, load]);

  if (!s) return null;
  const day = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' });
  const moment = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const run = async (fn: () => Promise<Settings>) => {
    setBusy(true);
    setNote(undefined);
    try {
      setS(await fn());
      setAsk(undefined);
      setEditing(undefined);
      setAdding(undefined);
    } catch (e) {
      setNote(errorText(m, e));
      if (e instanceof HttpError && (e.code === 'step_up' || e.status === 404)) void load();
    } finally {
      setBusy(false);
    }
  };
  const locked = stepUpLocked(s.stepUp);
  const newest = s.passkeys.reduce<Passkey | undefined>((a, k) => (!a || k.createdAt > a.createdAt ? k : a), undefined);
  const recent = newest && s.passkeys.length > 1 && Date.now() - Date.parse(newest.createdAt) < RECENT_MS ? newest : undefined;

  const help = (
    <>
      <p className="settings-state" data-testid="signin-state" data-mode={s.mode}>
        {m.state(s.passkeys.length, s.devices.length)}
      </p>
      <p className="settings-hint">{s.oidc ? m.hintOidc(s.oidc.label) : m.hint}</p>
      {recent && (
        <p className="settings-hint signin-alert" data-testid="signin-added">
          {m.added(recent.label, day.format(new Date(recent.createdAt)), recent.addedFrom)}
        </p>
      )}
    </>
  );

  const close = () => {
    setOpen(false);
    setEditing(undefined);
    setAsk(undefined);
    setAdding(undefined);
  };
  const toggle = (
    <div className="settings-actions">
      <button type="button" className="text-btn" aria-expanded={open} aria-controls="signin-detail" data-testid="signin-change" onClick={() => (open ? close() : setOpen(true))}>
        {open ? m.done : m.change}
      </button>
    </div>
  );

  const confirmLine = (testid: string) =>
    ask?.testid === testid && (
      <div className="signin-ask" role="group" data-testid="signin-ask">
        <span>{ask.text}</span>
        <button type="button" className="text-btn" onClick={() => setAsk(undefined)}>
          {t.common.cancel}
        </button>
        <button type="button" className="text-btn danger" data-testid="signin-ask-ok" onClick={() => void run(ask.go)}>
          {testid === 'others' ? m.signOutOthers : testid.startsWith('device:') ? m.signOut : testid === 'oidc' ? m.unlink : m.remove}
        </button>
      </div>
    );

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    if (editing) void run(() => api.rename(editing.id, editing.label));
  };
  // A passkey on this device: the server's options (the passkeys there excluded), the browser's ceremony, then saved.
  const addPasskey = (e: FormEvent) => {
    e.preventDefault();
    const label = adding?.trim();
    if (label)
      void run(async () => {
        const optionsJSON = (await api.addOptions()) as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'];
        return api.add(await startRegistration({ optionsJSON }), label);
      });
  };

  const passkeys = (
    <Group title={m.passkeys} testid="signin-passkeys">
      <ul className="signin-list">
        {s.passkeys.map((k) => (
          <li key={k.id} className="signin-item" data-testid="signin-passkey" data-id={k.id}>
            {editing?.id === k.id ? (
              <form className="signin-line" onSubmit={saveName}>
                <input className="signin-input" maxLength={60} aria-label={m.name} data-testid="signin-passkey-name" value={editing.label} autoFocus onChange={(e) => setEditing({ id: k.id, label: e.target.value })} />
                <button type="button" className="text-btn" onClick={() => setEditing(undefined)}>
                  {t.common.cancel}
                </button>
                <button type="submit" className="text-btn primary" disabled={!editing.label.trim()} data-testid="signin-passkey-save">
                  {m.save}
                </button>
              </form>
            ) : (
              <>
                <span className="signin-name" data-testid="signin-passkey-label">
                  {k.label}
                </span>
                <span className="signin-meta">
                  {[m.created(day.format(new Date(k.createdAt))), k.addedFrom && m.from(k.addedFrom), m.lastUsed(k.lastUsedAt ? day.format(new Date(k.lastUsedAt)) : null)].filter(Boolean).join(' · ')}
                </span>
                <span className="settings-actions">
                  <button type="button" className="text-btn" data-testid="signin-passkey-rename" onClick={() => setEditing({ id: k.id, label: k.label })}>
                    {m.rename}
                  </button>
                  <button
                    type="button"
                    className="text-btn danger"
                    data-testid="signin-passkey-remove"
                    disabled={s.passkeys.length < 2 && !s.oidc?.ready}
                    title={s.passkeys.length < 2 && !s.oidc?.ready ? m.lastPasskey : undefined}
                    onClick={() => setAsk({ text: m.removeConfirm(k.label), testid: `passkey:${k.id}`, go: () => api.remove(k.id) })}
                  >
                    {m.remove}
                  </button>
                </span>
              </>
            )}
            {confirmLine(`passkey:${k.id}`)}
          </li>
        ))}
      </ul>
      {adding === undefined ? (
        <div className="settings-actions">
          <button type="button" className="text-btn" data-testid="signin-passkey-add" onClick={() => setAdding(deviceLabel())}>
            {m.add}
          </button>
        </div>
      ) : (
        <form className="signin-line" onSubmit={addPasskey} data-testid="signin-passkey-new">
          <input className="signin-input" maxLength={60} aria-label={m.addName} data-testid="signin-passkey-new-name" value={adding} autoFocus onChange={(e) => setAdding(e.target.value)} />
          <button type="button" className="text-btn" onClick={() => setAdding(undefined)}>
            {t.common.cancel}
          </button>
          <button type="submit" className="text-btn primary" disabled={!adding.trim()} data-testid="signin-passkey-create">
            {m.addCreate}
          </button>
        </form>
      )}
      {s.passkeys.length < 2 && !s.oidc?.ready && <p className="settings-hint">{m.lastPasskey}</p>}
      <p className="settings-hint">{m.passkeysHint}</p>
    </Group>
  );

  const oidc = s.oidc;
  const provider = oidc && (
    <Group title={m.provider(oidc.label)} testid="signin-oidc">
      <p className="settings-hint" data-testid="signin-oidc-issuer">
        {m.providerIssuer(oidc.issuer)}
      </p>
      {oidc.linked ? (
        <div className="signin-item" data-testid="signin-oidc-linked">
          <span className="signin-name">{m.providerLinked(oidc.linked.sub, day.format(new Date(oidc.linked.linkedAt)))}</span>
          <span className="settings-actions">
            <button
              type="button"
              className="text-btn danger"
              data-testid="signin-oidc-unlink"
              disabled={!s.passkeys.length && !oidc.pinnedSub}
              title={!s.passkeys.length && !oidc.pinnedSub ? m.error.last_method : undefined}
              onClick={() => setAsk({ text: m.unlinkConfirm(oidc.label), testid: 'oidc', go: api.unlink })}
            >
              {m.unlink}
            </button>
          </span>
          {confirmLine('oidc')}
        </div>
      ) : (
        !oidc.pinnedSub && <p className="settings-hint" data-testid="signin-oidc-none">{m.providerNone}</p>
      )}
      {oidc.pinnedSub && <p className="settings-hint" data-testid="signin-oidc-pinned">{m.providerPinned(oidc.pinnedSub)}</p>}
      <p className="settings-hint">{m.providerHint}</p>
    </Group>
  );

  const others = s.devices.filter((d) => !d.current).length;
  const devices = (
    <Group title={m.devices} testid="signin-devices">
      <ul className="signin-list">
        {s.devices.map((d) => (
          <li key={d.id} className="signin-item" data-testid="signin-device" data-current={d.current ? '1' : undefined}>
            <span className="signin-name">
              {d.device && d.device !== '?' ? d.device : m.unknownDevice}
              {d.current && <span className="signin-badge">{m.thisDevice}</span>}
            </span>
            <span className="signin-meta">
              {[m.signedIn(day.format(new Date(d.createdAt))), oidc && m.via(d.method === 'oidc' ? oidc.label : m.passkey), m.seen(moment.format(new Date(d.lastSeen))), m.expires(day.format(new Date(d.expiresAt)))].filter(Boolean).join(' · ')}
            </span>
            {!d.current && (
              <span className="settings-actions">
                <button type="button" className="text-btn danger" data-testid="signin-device-signout" onClick={() => setAsk({ text: m.signOutConfirm(d.device && d.device !== '?' ? d.device : m.unknownDevice), testid: `device:${d.id}`, go: () => api.signOut(d.id) })}>
                  {m.signOut}
                </button>
              </span>
            )}
            {confirmLine(`device:${d.id}`)}
          </li>
        ))}
      </ul>
      <p className="settings-hint">{m.devicesHint}</p>
      {others > 0 && (
        <div className="settings-actions">
          <button type="button" className="text-btn danger" data-testid="signin-signout-others" onClick={() => setAsk({ text: m.signOutOthersConfirm, testid: 'others', go: api.signOutOthers })}>
            {m.signOutOthers}
          </button>
        </div>
      )}
      {confirmLine('others')}
    </Group>
  );

  // Opened: the confirmation first when one is needed (its own strip), then the blocks in an inset panel.
  const detail =
    open &&
    (locked ? (
      <div className="signin-confirm" id="signin-detail">
        <StepUpBox methods={s.stepUp.methods} onDone={load} testid="signin-stepup" />
        <Note text={note} />
      </div>
    ) : (
      <div className="signin" id="signin-detail">
        <StepUpLeft state={s.stepUp} />
        <fieldset className="signin-fields" disabled={busy}>
          {passkeys}
          {provider}
          {devices}
        </fieldset>
        <Note text={note} />
      </div>
    ));

  return (
    <Card title={t.settings.groupSecurity}>
      <Row block="signin" label={m.label} help={help} detail={detail || undefined}>
        {toggle}
        {!open && <Note text={note} />}
      </Row>
    </Card>
  );
}
