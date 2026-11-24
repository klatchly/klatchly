import { useEffect, useState } from 'react';
import { localized, useLang } from '../../../client/src/sdk';
import { llmApi as api, type ModelStats, type Ref, type RoutesView } from './api';
import { useT } from './i18n';

// Settings → Default models: model and fallback per use (the features of other packages that call a model:
// writing's translation of received messages and writing help), among the models enabled on every provider
// (Settings → Providers), each shown as "model · provider" with its recent latency, and a Test button that sends a
// fixed prompt (never user data). App-wide (../server/routes.ts).

type Slot = 'model' | 'fallback';
type TestState = { busy: true } | { busy: false; ok: boolean; ms: number };

/** A select's value for a model: provider and id (neither holds a '|'). */
const val = (r: Ref) => `${r.provider}|${r.model}`;
const ref = (v: string): Ref => {
  const at = v.indexOf('|');
  return { provider: v.slice(0, at), model: v.slice(at + 1) };
};
const same = (a: Ref | null, b: Ref | null) => !!a && !!b && a.provider === b.provider && a.model === b.model;

export function DefaultModels() {
  const t = useT().routes;
  const lang = useLang();
  const [view, setView] = useState<RoutesView>();
  const [note, setNote] = useState<string>();
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const load = () => api.routes().then(setView, () => setNote(t.failed));
  useEffect(() => void load(), []);

  if (!view) return note ? <p className="settings-note">{note}</p> : null;

  const secs = (ms: number) => `${new Intl.NumberFormat(lang, { maximumFractionDigits: ms < 10_000 ? 1 : 0 }).format(ms / 1000)} s`;
  const hint = (s: ModelStats | undefined) => {
    if (!s || !s.calls) return t.stat.none;
    if (s.errors * 2 >= s.calls) return t.stat.errors;
    if (s.medianMs === null || s.medianMs > view.patienceMs || s.aborted >= s.ok) return t.stat.slow;
    return t.stat.fast(secs(s.medianMs));
  };
  const names = new Map(view.providers.map((p) => [p.id, p.name]));
  const items = view.choices.items;
  const item = (r: Ref) => items.find((x) => same(x, r));
  /** Recent latency of a model, or "not enabled" when its provider no longer offers it here. */
  const status = (r: Ref) => {
    const m = item(r);
    return m && !m.enabled ? t.disabled : hint(m?.stats);
  };
  const isDef = (r: Ref) => same(r, view.defaults?.model ?? null);
  // The closed select shows little on a phone: the status is repeated under it (llm-status).
  const label = (r: Ref) => `${r.model} · ${names.get(r.provider) ?? r.provider}${isDef(r) ? ` (${t.default})` : ''} · ${status(r)}`;
  const unreachable = view.providers.filter((p) => view.choices.reachable[p.id] === false);

  const save = async (use: string, slot: Slot, value: string) => {
    const u = view.uses.find((x) => x.id === use)!;
    const cur = { model: u.model, fallback: u.fallback };
    const next = { ...cur, [slot]: value === 'none' ? null : ref(value) };
    if (!next.model) return;
    setNote(undefined);
    try {
      setView(await api.setRoutes({ [use]: { model: next.model, fallback: next.fallback ?? 'none' } }));
      setNote(t.saved);
    } catch {
      setNote(t.failed);
    }
  };

  const test = async (r: Ref) => {
    const k = val(r);
    setTests((s) => ({ ...s, [k]: { busy: true } }));
    try {
      const res = await api.test(r);
      setTests((s) => ({ ...s, [k]: { busy: false, ok: res.ok, ms: res.ms } }));
    } catch {
      setTests((s) => ({ ...s, [k]: { busy: false, ok: false, ms: 0 } }));
    }
    void api.routes().then(setView, () => {});
  };

  // Grouped by provider, in the order of Settings → Providers.
  const groups = view.providers.map((p) => ({ p, models: items.filter((x) => x.provider === p.id) })).filter((g) => g.models.length);

  // One row per model slot, as the core's Settings rows (.set-*): the label and the model's status on the left,
  // the select and Test on the right.
  const row = (use: RoutesView['uses'][number], slot: Slot) => {
    const r = slot === 'model' ? use.model : use.fallback;
    const value = r ? val(r) : 'none';
    const ts = r ? tests[val(r)] : undefined;
    const id = `llm-${use.id.replace('.', '-')}-${slot}`;
    return (
      <div className="set-row">
        <div className="set-text">
          <label className="set-label llm-label" htmlFor={id}>
            {slot === 'model' ? t.model : t.fallback}
          </label>
          {r && (
            <p className="llm-status" data-testid={`${id}-status`}>
              {status(r)}
              {ts && !ts.busy && (
                <span className={`llm-result ${ts.ok ? '' : 'bad'}`} data-testid={`${id}-result`}>
                  {' · '}
                  {ts.ok ? t.testOk(secs(ts.ms)) : t.testFail}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="set-control llm-pick">
          <select id={id} data-testid={id} value={value} disabled={!groups.length} onChange={(e) => void save(use.id, slot, e.target.value)}>
            {slot === 'fallback' && <option value="none">{t.none}</option>}
            {slot === 'model' && !r && (
              <option value="none" disabled>
                {t.pick}
              </option>
            )}
            {groups.map(({ p, models }) => (
              <optgroup key={p.id} label={p.name}>
                {models.map((m) => (
                  <option key={val(m)} value={val(m)}>
                    {label(m)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button type="button" className="text-btn llm-btn" data-testid={`${id}-test`} disabled={!r || ts?.busy} onClick={() => r && void test(r)}>
            {ts?.busy ? t.testing : t.test}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="llm-page" data-testid="llm-routes">
      <p className="settings-hint settings-lead">{t.hint(Math.round(view.patienceMs / 1000))}</p>
      {unreachable.map((p) => (
        <p key={p.id} className="settings-note">
          {t.unreachable(p.name)}
        </p>
      ))}
      {!groups.length && <p className="settings-note">{t.noModel}</p>}
      {!view.uses.length && <p className="settings-hint">{t.noUse}</p>}
      {view.uses.map((u) => (
        <fieldset key={u.id} className="llm-group" data-testid={`llm-use-${u.id.replace('.', '-')}`}>
          <legend className="llm-legend">{localized(u.label, lang)}</legend>
          <div className="set-group">
            {row(u, 'model')}
            {row(u, 'fallback')}
          </div>
        </fieldset>
      ))}
      {note && (
        <p className="settings-note" data-testid="llm-routes-note">
          {note}
        </p>
      )}
    </div>
  );
}
