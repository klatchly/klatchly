import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { HttpError, isStepUpError, StepUpBox, StepUpLeft, stepUpLocked, useLang, useStepUp } from '../../../client/src/sdk';
import { KIND_INFO, KINDS, type ProviderKind } from '../kinds';
import type { LlmMessages } from '../locales/index';
import { llmApi as api, type ModelItem, type ProviderTest, type ProviderView } from './api';
import { useT } from './i18n';

// Settings → Providers: where the models are (the server's provider, from its configuration, and those added
// here), with which key, and which of their models are offered in Default models. A key is typed once and never
// shown again ("key set", replace, clear). Adding, editing and removing a provider need a recent sign-in or
// confirmation (the step-up box on top, client/src/StepUp.tsx); ticking models and Test do not.

type M = LlmMessages['providers'];

function errorText(t: M, e: unknown): string {
  if (e instanceof HttpError && e.code && Object.hasOwn(t.error, e.code)) return t.error[e.code as keyof M['error']];
  return t.error.failed;
}

export function Providers() {
  const t = useT().providers;
  const step = useStepUp();
  const [list, setList] = useState<ProviderView[]>();
  const [note, setNote] = useState<string>();
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api.providers().then((r) => setList(r.providers), () => setNote(t.error.failed)), [t]);
  useEffect(() => void load(), [load]);

  if (!list || !step.state) return note ? <p className="settings-note">{note}</p> : null;
  const locked = stepUpLocked(step.state);

  /** Runs a change; a 'step_up' refusal shows the confirmation box again. */
  const change = async (fn: () => Promise<unknown>, ok = t.saved): Promise<boolean> => {
    setNote(undefined);
    try {
      await fn();
      await load();
      setNote(ok);
      return true;
    } catch (e) {
      if (isStepUpError(e)) void step.reload();
      setNote(errorText(t, e));
      return false;
    }
  };

  return (
    <div className="llm-page" data-testid="llm-providers">
      <p className="settings-hint settings-lead">{t.hint}</p>
      {locked ? <StepUpBox methods={step.state.methods} onDone={step.reload} testid="llm-stepup" /> : <StepUpLeft state={step.state} />}
      {list.map((p) => (
        <ProviderCard key={p.id} p={p} t={t} locked={locked} change={change} />
      ))}
      {adding ? (
        <ProviderForm t={t} onCancel={() => setAdding(false)} onSave={async (b) => (await change(() => api.addProvider(b as AddBody))) && setAdding(false)} />
      ) : (
        <div className="llm-actions llm-add">
          <button type="button" className="text-btn llm-btn" data-testid="llm-add" disabled={locked} onClick={() => setAdding(true)}>
            {t.add}
          </button>
        </div>
      )}
      {note && (
        <p className="settings-note" data-testid="llm-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

type Change = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;

function ProviderCard({ p, t, locked, change }: { p: ProviderView; t: M; locked: boolean; change: Change }) {
  const lang = useLang();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [test, setTest] = useState<ProviderTest | 'busy'>();
  const [count, setCount] = useState<{ on: number; all: number; every: boolean }>();
  const tid = `llm-provider-${p.id}`;
  const secs = (ms: number) => `${new Intl.NumberFormat(lang, { maximumFractionDigits: ms < 10_000 ? 1 : 0 }).format(ms / 1000)} s`;

  const runTest = async () => {
    setTest('busy');
    try {
      setTest(await api.testProvider(p.id));
    } catch (e) {
      setTest({ ok: false, ms: 0, keyChecked: false, error: e instanceof HttpError ? String(e.status) : 'network' });
    }
  };
  const remove = () => {
    if (window.confirm(t.removeConfirm(p.name))) void change(() => api.removeProvider(p.id));
  };

  return (
    <fieldset className="llm-group" data-testid={tid}>
      <legend className="llm-legend">
        {p.name}
        {p.fromServer && <span className="llm-tag">{t.fromServer}</span>}
      </legend>
      <div className="set-group">
        <div className="set-row">
          <div className="set-text">
            <span className="set-label llm-label">{t.kinds[p.kind]}</span>
            <p className="llm-status llm-url" data-testid={`${tid}-url`}>
              {p.url}
            </p>
            <p className="llm-status" data-testid={`${tid}-key`}>
              {p.keySet ? t.keySet : t.noKey}
              {test && test !== 'busy' && (
                <span className={`llm-result ${test.ok ? '' : 'bad'}`} data-testid={`${tid}-result`}>
                  {' · '}
                  {test.ok ? `${t.testOk(test.models ?? 0, secs(test.ms))}${test.keyChecked ? ` · ${t.testKeyOk}` : ''}` : t.testFail(test.error ?? '?')}
                </span>
              )}
            </p>
          </div>
          <div className="set-control llm-actions">
            <button type="button" className="text-btn llm-btn" data-testid={`${tid}-test`} disabled={test === 'busy'} onClick={() => void runTest()}>
              {test === 'busy' ? t.testing : t.test}
            </button>
            <button type="button" className="text-btn llm-btn" data-testid={`${tid}-edit`} disabled={locked} aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
              {t.edit}
            </button>
            {!p.fromServer && (
              <button type="button" className="text-btn llm-btn danger" data-testid={`${tid}-remove`} disabled={locked} onClick={remove}>
                {t.remove}
              </button>
            )}
          </div>
        </div>
        {p.fromServer && editing && <p className="settings-hint llm-status">{t.fromServerHint}</p>}
        {editing && !locked && (
          <ProviderForm
            t={t}
            current={p}
            onCancel={() => setEditing(false)}
            onSave={async (b) => (await change(() => api.updateProvider(p.id, b as EditBody))) && setEditing(false)}
          />
        )}
        <div className="set-row">
          <div className="set-text">
            <span className="set-label llm-label">{t.models}</span>
            {count && (
              <p className="llm-status" data-testid={`${tid}-count`}>
                {count.every ? t.modelsAll(count.all) : t.modelsCount(count.on, count.all)}
              </p>
            )}
          </div>
          <div className="set-control llm-one">
            <button type="button" className="text-btn llm-btn" data-testid={`${tid}-models`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? t.modelsClose : t.modelsPick}
            </button>
          </div>
        </div>
        {open && <ModelPicker p={p} t={t} onCount={setCount} />}
      </div>
      {!open && <ModelCount p={p} onCount={setCount} />}
    </fieldset>
  );
}

/** The count of enabled models, while the picker is closed. */
function ModelCount({ p, onCount }: { p: ProviderView; onCount: (c: { on: number; all: number; every: boolean }) => void }) {
  useEffect(() => {
    api.models(p.id).then(
      (r) => onCount({ on: r.items.filter((m) => m.enabled).length, all: r.items.length, every: r.all }),
      () => {},
    );
  }, [p.id, p.all, p.url, p.keySet]);
  return null;
}

function ModelPicker({ p, t, onCount }: { p: ProviderView; t: M; onCount: (c: { on: number; all: number; every: boolean }) => void }) {
  const [items, setItems] = useState<ModelItem[]>();
  const [all, setAll] = useState(false);
  const [reachable, setReachable] = useState(true);
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string>();
  const tid = `llm-provider-${p.id}`;

  const show = (r: { reachable: boolean; all: boolean; items: ModelItem[] }) => {
    setItems(r.items);
    setAll(r.all);
    setReachable(r.reachable);
    onCount({ on: r.items.filter((m) => m.enabled).length, all: r.items.length, every: r.all });
  };
  const load = (refresh = false) => api.models(p.id, refresh).then(show, (e) => setError(errorText(t, e)));
  useEffect(() => void load(), [p.id]);

  if (!items) return error ? <p className="settings-note">{error}</p> : null;

  /** Saves the enabled list (null: all it lists), then shows it as the server has it. */
  const put = async (models: string[] | null) => {
    setError(undefined);
    try {
      await api.setModels(p.id, models);
      await load();
    } catch (e) {
      setError(errorText(t, e));
    }
  };
  const enabled = items.filter((m) => m.enabled).map((m) => m.id);
  const toggle = (id: string, on: boolean) => {
    // Shown at once; the server's answer (or the error) follows.
    setItems(items.map((m) => (m.id === id ? { ...m, enabled: on } : m)));
    void put(on ? [...enabled, id] : enabled.filter((x) => x !== id));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const id = manual.trim();
    if (!id) return;
    setManual('');
    void put([...new Set([...enabled, id])]);
  };
  const q = filter.trim().toLowerCase();
  const shown = q ? items.filter((m) => m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q)) : items;

  return (
    <div className="llm-models" data-testid={`${tid}-picker`}>
      <p className="settings-hint">{t.modelsHint}</p>
      {!reachable && <p className="settings-note">{t.modelsUnreachable}</p>}
      {p.fromServer && (
        <label className="llm-check llm-all">
          <input type="checkbox" checked={all} data-testid={`${tid}-all`} onChange={(e) => void put(e.target.checked ? null : enabled)} />
          <span className="llm-check-text">{t.modelsAllToggle}</span>
        </label>
      )}
      <div className="llm-line">
        <input className="llm-input" type="search" aria-label={t.modelsFilter} placeholder={t.modelsFilter} data-testid={`${tid}-filter`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button type="button" className="text-btn llm-btn" data-testid={`${tid}-refresh`} onClick={() => void load(true)}>
          {t.modelsRefresh}
        </button>
      </div>
      {q && <p className="settings-hint">{t.modelsShown(shown.length, items.length)}</p>}
      {items.length ? (
        <ul className="llm-list" data-testid={`${tid}-list`}>
          {shown.map((m) => (
            <li key={m.id}>
              <label className="llm-check">
                <input type="checkbox" checked={m.enabled} disabled={all} data-testid={`${tid}-model-${m.id}`} onChange={(e) => toggle(m.id, e.target.checked)} />
                <span className="llm-check-text">
                  {m.id}
                  {(m.name || !m.listed) && <span className="llm-check-sub">{m.listed ? m.name : t.modelsByHand}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        reachable && <p className="settings-hint">{t.modelsNone}</p>
      )}
      <form className="llm-line" onSubmit={add}>
        <input className="llm-input" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={100} aria-label={t.modelAdd} placeholder={t.modelAdd} data-testid={`${tid}-manual`} value={manual} onChange={(e) => setManual(e.target.value)} />
        <button type="submit" className="text-btn llm-btn" disabled={!manual.trim() || all} data-testid={`${tid}-manual-add`}>
          {t.modelAddGo}
        </button>
      </form>
      {error && (
        <p className="llm-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

type AddBody = { kind: ProviderKind; name: string; url: string; key?: string };
/** Only what changed (a key: a new one, or null to clear it). */
type EditBody = { name?: string; url?: string; key?: string | null };

/** Adding (no `current`) or editing a provider. The key field is empty: typing one replaces the key. */
function ProviderForm({ t, current, onCancel, onSave }: { t: M; current?: ProviderView; onCancel: () => void; onSave: (b: AddBody | EditBody) => Promise<unknown> }) {
  const [kind, setKind] = useState<ProviderKind>(current?.kind ?? 'openai');
  const [name, setName] = useState(current?.name ?? t.kinds.openai);
  const [url, setUrl] = useState(current?.url ?? KIND_INFO.openai.url);
  const [key, setKey] = useState('');
  const [keyMode, setKeyMode] = useState<'keep' | 'replace' | 'clear'>(current?.keySet ? 'keep' : 'replace');
  const [busy, setBusy] = useState(false);
  const server = !!current?.fromServer;
  const prefix = current ? `llm-edit-${current.id}` : 'llm-new';

  const pickKind = (k: ProviderKind) => {
    // A fresh form follows the kind: its usual address and name, unless typed over.
    if (!current) {
      if (!url || url === KIND_INFO[kind].url) setUrl(KIND_INFO[k].url);
      if (!name.trim() || name === t.kinds[kind]) setName(t.kinds[k]);
    }
    setKind(k);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const newKey = keyMode === 'replace' && key ? key : keyMode === 'clear' ? null : undefined;
    try {
      if (current) {
        // Only what changed (the server's provider: its name).
        const ch: EditBody = {};
        if (name.trim() !== current.name) ch.name = name.trim();
        if (!server && url.trim() !== current.url) ch.url = url.trim();
        if (!server && newKey !== undefined) ch.key = newKey;
        if (Object.keys(ch).length) await onSave(ch);
        else onCancel();
      } else await onSave({ kind, name: name.trim(), url: url.trim(), ...(newKey ? { key: newKey } : {}) });
    } finally {
      setBusy(false);
      setKey('');
    }
  };
  const needsKey = KIND_INFO[kind].keyRequired;
  // Another host: the stored key is not kept for it (the server drops it, or asks for it again).
  const host = (u: string) => {
    try {
      return new URL(u.trim()).host;
    } catch {
      return null;
    }
  };
  const moved = !!current && !server && host(url) !== host(current.url);

  return (
    <form className="llm-form" data-testid={prefix} onSubmit={(e) => void submit(e)}>
      {!current && (
        <label className="llm-field">
          {t.kind}
          <select data-testid={`${prefix}-kind`} value={kind} onChange={(e) => pickKind(e.target.value as ProviderKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t.kinds[k]}
              </option>
            ))}
          </select>
          <span className="settings-hint">{t.kindHints[kind]}</span>
        </label>
      )}
      <label className="llm-field">
        {t.name}
        <input className="llm-input" maxLength={40} data-testid={`${prefix}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {!server && (
        <label className="llm-field">
          {t.url}
          <input className="llm-input" type="url" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={300} placeholder="https://…/v1" data-testid={`${prefix}-url`} value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
      )}
      {!server &&
        (keyMode === 'replace' ? (
          <label className="llm-field">
            {current?.keySet ? t.keyNew : t.key}
            <input className="llm-input" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={1000} data-testid={`${prefix}-key`} value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
        ) : (
          <div className="llm-field">
            {t.key}
            <span className="settings-hint" data-testid={`${prefix}-key-state`}>
              {keyMode === 'clear' ? t.noKey : moved ? t.error.key_reentry : `${t.keySet} · ${t.keyKept}`}
            </span>
            <div className="llm-actions">
              <button type="button" className="text-btn llm-btn" data-testid={`${prefix}-key-replace`} onClick={() => setKeyMode('replace')}>
                {t.keyReplace}
              </button>
              {keyMode === 'keep' && !needsKey && (
                <button type="button" className="text-btn llm-btn danger" data-testid={`${prefix}-key-clear`} onClick={() => setKeyMode('clear')}>
                  {t.keyClear}
                </button>
              )}
            </div>
          </div>
        ))}
      <div className="llm-actions">
        <button type="button" className="text-btn llm-btn" onClick={onCancel}>
          {t.cancel}
        </button>
        <button type="submit" className="text-btn llm-btn primary" data-testid={`${prefix}-save`} disabled={busy || !name.trim() || (!server && !url.trim()) || (!current && needsKey && !key)}>
          {t.save}
        </button>
      </div>
    </form>
  );
}
