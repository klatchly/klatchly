import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExtensionsDetails, ModuleType, OffCause, PackageDetails } from '../../server/extension';
import { HttpError, request } from './endpoints';
import { localized, useCatalog, useLang, useT } from './i18n';
import type { ExtensionsMessages } from './locales/extensions/en';
import { isStepUpError, StepUpBox, useStepUp } from './StepUp';
import './extensions.css';

// Settings → Extensions (its own chunk, loaded with the Settings page): every package of the build as a card (two
// columns where the pane allows), what it is made of and what it sees, its version and what it needs, and a switch
// that turns it off or on for the whole server at once (PUT /api/extensions/<id>; the other devices follow through
// the 'extensions' frame). Turning one off lists what goes with it first; turning one on whose required package is
// off offers to turn both on. A switch needs a recent sign-in or confirmation (server requireStepUp): refused, the
// step-up box shows above the cards, and the switch is pressed again once confirmed. Its strings are its own (locales/extensions/), not in the launch catalog.

const DETAILS = ['extensions', 'details'] as const;

// Strings: locales/extensions/<code>.ts, one file per language (English the reference and the fallback).
const strings = Object.fromEntries(
  Object.entries(import.meta.glob<{ default: ExtensionsMessages }>('./locales/extensions/*.ts', { eager: true })).map(([f, m]) => [f.slice(f.lastIndexOf('/') + 1, -3), m.default]),
);
type Strings = ExtensionsMessages;

/** A pending question before a switch acts: what goes off with it, or what it needs turned on. */
type Ask = { id: string; enabled: boolean; others: string[] };

/**
 * The packages that require `id` (directly or not) and stay turned off after it came back on (they went off with
 * it, and the choice is kept until made again): offered to the user to turn on too.
 */
function stillOff(data: ExtensionsDetails, id: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => {
    for (const q of data.packages) {
      if (!q.requires.some((d) => d.id === x) || out.includes(q.id)) continue;
      if (q.state === 'disabled' && q.canEnable) out.push(q.id);
      walk(q.id);
    }
  };
  walk(id);
  return out;
}

/** The section's body (its title is the Settings page's). */
export function ExtensionsSettings() {
  const s = useCatalog(strings);
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: DETAILS, queryFn: () => request<ExtensionsDetails>('GET', '/extensions/details'), staleTime: 0 });
  const [ask, setAsk] = useState<Ask>();
  const [failed, setFailed] = useState<string>();
  const [offer, setOffer] = useState<{ id: string; others: string[] }>();
  // One change at a time (a plain async call: react-query's mutations would grow the launch's vendor chunk).
  const [busy, setBusy] = useState(false);
  const stepUp = useStepUp();
  const [retry, setRetry] = useState<{ id: string; enabled: boolean; withRequired?: boolean }>();
  const toggle = async (v: { id: string; enabled: boolean; withRequired?: boolean }, offerOthers = true) => {
    setBusy(true);
    setFailed(undefined);
    setOffer(undefined);
    try {
      const data = await request<ExtensionsDetails>('PUT', `/extensions/${encodeURIComponent(v.id)}`, { enabled: v.enabled, ...(v.withRequired ? { withRequired: true } : {}) });
      qc.setQueryData(DETAILS, data);
      // Spaces, slots and sections of this tab follow at once (the other tabs and devices with the server's frame).
      void qc.invalidateQueries({ queryKey: ['extensions'], exact: true });
      // Back on: what went off with it stays off until asked; say so.
      const others = v.enabled && offerOthers ? stillOff(data, v.id) : [];
      if (others.length) setOffer({ id: v.id, others });
    } catch (e) {
      if (isStepUpError(e)) {
        setRetry(v);
        void stepUp.reload();
        return;
      }
      setFailed(v.id);
      if (e instanceof HttpError && e.status === 409) void q.refetch();
    } finally {
      setBusy(false);
      setAsk(undefined);
    }
  };

  const data = q.data;
  if (!data) return <p className="settings-hint">{q.isError ? s.failed : s.loading}</p>;
  const nameOf = (id: string) => {
    const p = data.packages.find((x) => x.id === id);
    return p?.about ? localized(p.about.name, lang) : id;
  };

  const enableToo = async (ids: string[]) => {
    for (const id of ids) await toggle({ id, enabled: true, withRequired: true }, false);
  };

  const press = (p: PackageDetails) => {
    const enabled = p.state === 'disabled' || (p.state === 'off' && p.cause?.kind === 'start');
    // Off: what requires it goes too, asked first. On: the packages it needs that are turned off, asked first.
    const others = enabled ? p.needs : p.dependants;
    if (others.length) setAsk({ id: p.id, enabled, others });
    else void toggle({ id: p.id, enabled });
  };

  return (
    <div className="ext-list" data-testid="extensions">
      <p className="settings-hint settings-lead">{s.intro}</p>
      <p className="settings-hint" data-testid="ext-api">
        {s.api(data.api)}
      </p>
      {retry && stepUp.state && (
        <StepUpBox
          methods={stepUp.state.methods}
          testid="ext-stepup"
          onDone={async () => {
            await stepUp.reload();
            setRetry(undefined);
            await toggle(retry);
          }}
        />
      )}
      <div className="ext-grid">
      {data.packages.map((p) => (
        <Package key={p.id} p={p} api={data.api} s={s} lang={lang} nameOf={nameOf} busy={busy} onPress={() => press(p)}>
          {ask?.id === p.id && (
            <div className="settings-row ext-ask" role="group" data-testid={`ext-confirm-${p.id}`}>
              <span className="settings-confirm" data-testid="ext-confirm-text">
                {ask.enabled ? s.confirmOn(nameOf(p.id), ask.others.map(nameOf).join(', ')) : s.confirmOff(nameOf(p.id), ask.others.map(nameOf).join(', '))}
              </span>
              <button type="button" className="text-btn" data-testid="ext-confirm-cancel" onClick={() => setAsk(undefined)}>
                {t.common.cancel}
              </button>
              <button
                type="button"
                className={`text-btn ${ask.enabled ? 'primary' : 'danger'}`}
                data-testid="ext-confirm-ok"
                disabled={busy}
                onClick={() => void toggle({ id: p.id, enabled: ask.enabled, withRequired: ask.enabled })}
              >
                {ask.enabled ? (ask.others.length === 1 ? s.onBoth : s.onAll) : s.offAll}
              </button>
            </div>
          )}
          {offer?.id === p.id && (
            <div className="settings-row ext-ask" role="group" data-testid={`ext-offer-${p.id}`}>
              <span className="settings-confirm" data-testid="ext-offer-text">
                {s.stillOff(offer.others.map(nameOf).join(', '), offer.others.length)}
              </span>
              <button type="button" className="text-btn" data-testid="ext-offer-cancel" onClick={() => setOffer(undefined)}>
                {s.noThanks}
              </button>
              <button type="button" className="text-btn primary" data-testid="ext-offer-ok" disabled={busy} onClick={() => void enableToo(offer.others)}>
                {s.onToo}
              </button>
            </div>
          )}
          {failed === p.id && (
            <p className="settings-note" data-testid="settings-note">
              {s.failed}
            </p>
          )}
        </Package>
      ))}
      </div>
    </div>
  );
}

function causeText(c: OffCause | undefined, s: Strings, nameOf: (id: string) => string): string {
  if (!c) return '';
  switch (c.kind) {
    case 'disabled':
      return s.cause.disabled;
    case 'config':
      return s.cause.config(c.missing.join(', '));
    case 'check':
      return s.cause.check(c.detail);
    case 'api':
      return s.cause.api(c.range, c.present);
    case 'requires':
      return c.state === 'missing'
        ? s.cause.missing(c.id)
        : c.state === 'version'
          ? s.cause.version(nameOf(c.id), c.range, c.present ?? '?')
          : c.state === 'disabled'
            ? s.cause.reqDisabled(nameOf(c.id))
            : s.cause.reqOff(nameOf(c.id));
    case 'cycle':
      return s.cause.cycle;
    case 'start':
      return s.cause.start(c.module);
  }
}

/**
 * What the package declares it reaches outside the app (package.ts network / listen / files / spawns; checked
 * against its server code by test/boundary.test.ts, not enforced at run time). Variables are named, never their
 * values; '*' (addresses given at run time) is flagged.
 */
function Capabilities({ p, s }: { p: PackageDetails; s: Strings }) {
  const c = p.capabilities;
  const any = c.network.includes('*');
  const to = c.network.map((x) => (x === '*' ? s.anyAddress : x)).join(', ');
  return (
    <>
      <p className={`ext-scope ${any ? 'ext-warn' : ''}`} data-testid={`ext-network-${p.id}`} data-network={c.network.join(' ')}>
        {c.network.length ? `${any ? '⚠ ' : ''}${s.network(to)}` : s.noNetwork}
      </p>
      {c.listen.length > 0 && (
        <p className="ext-scope" data-testid={`ext-listen-${p.id}`}>
          {s.listen(c.listen.join(', '))}
        </p>
      )}
      {c.files.length > 0 && (
        <p className="ext-scope" data-testid={`ext-files-${p.id}`}>
          {s.files(c.files.map((x) => (x === 'data' ? s.dataFiles : x)).join(', '))}
        </p>
      )}
      {c.spawns && (
        <p className="ext-scope ext-warn" data-testid={`ext-spawns-${p.id}`}>
          ⚠ {s.spawns}
        </p>
      )}
    </>
  );
}

function Package(props:{ p: PackageDetails; api: string; s: Strings; lang: string; nameOf: (id: string) => string; busy: boolean; onPress: () => void; children: ReactNode }) {
  const { p, s, lang, nameOf } = props;
  const name = nameOf(p.id);
  const on = p.state === 'on';
  // A failed start is retried by turning it on again; one the server cannot run has no switch to press.
  const retry = p.state === 'off' && p.cause?.kind === 'start';
  const can = on ? p.canDisable : p.state === 'disabled' ? p.canEnable : retry;
  const why = on ? (p.keep === 'default-connector' ? s.keepDefault : p.keep === 'no-connector' ? s.keepLast : undefined) : !p.canEnable ? s.cannot : undefined;
  const scopes = p.modules.filter((m) => m.scope);
  return (
    <article className={`ext-pkg ${on ? '' : 'ext-off'}`} data-testid={`ext-${p.id}`} data-state={p.state} aria-labelledby={`ext-h-${p.id}`}>
      <div className="ext-head">
        <div className="ext-title">
          <h3 id={`ext-h-${p.id}`}>{name}</h3>
          <span className="ext-version" data-testid={`ext-version-${p.id}`}>
            {p.version}
          </span>
        </div>
        {retry ? (
          <button type="button" className="text-btn" data-testid={`ext-toggle-${p.id}`} disabled={props.busy} onClick={props.onPress}>
            {s.retry}
          </button>
        ) : (
          <button
            type="button"
            role="switch"
            className="ext-switch"
            aria-checked={on}
            aria-label={on ? s.turnOff(name) : s.turnOn(name)}
            data-testid={`ext-toggle-${p.id}`}
            disabled={!can || props.busy}
            onClick={props.onPress}
          >
            <span aria-hidden="true" />
          </button>
        )}
      </div>
      {p.about && <p className="ext-desc">{localized(p.about.description, lang)}</p>}
      <ul className="ext-badges">
        {p.modules.map((m) => (
          <li key={`${m.type}:${m.id}`} className={`ext-badge ext-${m.type}`} data-testid="ext-badge" data-type={m.type}>
            {s.type[m.type]}
          </li>
        ))}
      </ul>
      {scopes.map((m) => (
        <p key={m.id} className={`ext-scope ${m.scope === 'events' ? 'ext-warn' : ''}`} data-testid={`ext-scope-${p.id}`} data-scope={m.scope}>
          {m.scope === 'events' ? `⚠ ${s.events}` : s.onDemand}
        </p>
      ))}
      {p.chatSources && (
        <p className="ext-scope" data-testid={`ext-reads-${p.id}`}>
          {s.chatSources}
        </p>
      )}
      {p.sends && (
        <p className="ext-scope ext-warn" data-testid={`ext-sends-${p.id}`}>
          ⚠ {s.sends}
        </p>
      )}
      {p.bearer && (
        <p className="ext-scope" data-testid={`ext-bearer-${p.id}`}>
          {s.bearer}
        </p>
      )}
      <Capabilities p={p} s={s} />
      <p className="ext-state" data-testid={`ext-state-${p.id}`}>
        {on ? s.on : p.state === 'disabled' ? s.disabled : s.off(causeText(p.cause, s, nameOf))}
      </p>
      {why && <p className="settings-hint" data-testid={`ext-why-${p.id}`}>{why}</p>}
      {/* The facts close the card: in a row of cards they line up at the bottom. */}
      <dl className="ext-facts">
        <dt>{s.version(p.version)}</dt>
        <dd data-testid={`ext-apineed-${p.id}`}>{s.apiNeed(p.klatchly, p.apiOk, props.api)}</dd>
        {p.requires.length > 0 && (
          <>
            <dt>{s.requires}</dt>
            <dd data-testid={`ext-requires-${p.id}`}>{p.requires.map((d) => s.dep(nameOf(d.id), d.range, d.ok, d.present)).join(' · ')}</dd>
          </>
        )}
        {p.enhances.length > 0 && (
          <>
            <dt>{s.enhances}</dt>
            <dd>{p.enhances.map((d) => s.dep(nameOf(d.id), d.range, d.ok, d.present)).join(' · ')}</dd>
          </>
        )}
        {p.requiredBy.length > 0 && (
          <>
            <dt>{s.requiredBy}</dt>
            <dd data-testid={`ext-requiredby-${p.id}`}>{p.requiredBy.map(nameOf).join(', ')}</dd>
          </>
        )}
      </dl>
      {props.children}
    </article>
  );
}
