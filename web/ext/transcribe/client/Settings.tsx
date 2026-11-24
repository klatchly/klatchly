import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HttpError, isStepUpError, StepUpBox, StepUpLeft, stepUpLocked, useLang, useStepUp } from '../../../client/src/sdk';
import { defaultModel, KINDS, needsLanguage, RIVA_HOSTED, RIVA_PRESETS, rivaPreset, validFunctionId, type ProviderKind } from '../kinds';
import type { TranscribeMessages } from '../locales/index';
import { transcribeApi as api, type ProviderView, type ProvidersReply } from './api';
import { noteError, type NoteError } from './errors';
import { useT } from './i18n';
import { forgetShown } from './state';

// Settings → Transcription: the providers (the server's, from its configuration, and those added here), with which
// key, which model and language each uses, the default one (what the Transcribe button uses), and the transcripts
// kept. A key is typed once and never shown again ("key set", replace, clear). Adding, editing and removing a
// provider need a recent sign-in or confirmation (the step-up box on top); the model, the language, the default
// provider, Test and Clear do not.

type M = TranscribeMessages['settings'];
type Change = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;

function errorText(t: M, e: unknown): string {
  if (e instanceof HttpError && e.code && Object.hasOwn(t.error, e.code)) return t.error[e.code as keyof M['error']];
  return t.error.failed;
}

export function TranscriptionSettings() {
  const t = useT().settings;
  const step = useStepUp();
  const qc = useQueryClient();
  const [data, setData] = useState<ProvidersReply>();
  const [note, setNote] = useState<string>();
  const [adding, setAdding] = useState(false);

  const load = useCallback(
    () =>
      api.providers().then(
        (r) => {
          setData(r);
          // The buttons under the voice notes follow (a provider added or removed, another default).
          void qc.invalidateQueries({ queryKey: ['transcribe'] });
        },
        () => setNote(t.error.failed),
      ),
    [t, qc],
  );
  useEffect(() => void load(), [load]);

  if (!data || !step.state) return note ? <p className="settings-note">{note}</p> : null;
  const locked = stepUpLocked(step.state);

  /** Runs a change; a 'step_up' refusal shows the confirmation box again. */
  const change: Change = async (fn, ok = t.saved) => {
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
  const first = data.providers[0];

  return (
    <div className="transcribe-page" data-testid="transcribe-settings">
      <p className="settings-hint settings-lead">{t.hint}</p>
      {locked ? <StepUpBox methods={step.state.methods} onDone={step.reload} testid="transcribe-stepup" /> : <StepUpLeft state={step.state} />}
      {data.providers.length > 0 ? (
        <fieldset className="transcribe-group">
          <legend className="transcribe-legend">{t.defaultTitle}</legend>
          <div className="set-group">
            <div className="set-row">
              <div className="set-text">
                <span className="settings-hint transcribe-status">{t.defaultHint}</span>
              </div>
              <div className="set-control transcribe-pick">
                <select aria-label={t.defaultTitle} data-testid="transcribe-default" value={data.default ?? ''} onChange={(e) => void change(() => api.setDefault(e.target.value || null))}>
                  {first && <option value="">{t.defaultFirst(first.name)}</option>}
                  {data.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </fieldset>
      ) : (
        <p className="settings-note" data-testid="transcribe-none">
          {t.none}
        </p>
      )}
      {data.providers.map((p) => (
        <ProviderCard key={p.id} p={p} t={t} locked={locked} change={change} />
      ))}
      {adding ? (
        <ProviderForm t={t} onCancel={() => setAdding(false)} onSave={async (b) => (await change(() => api.addProvider(b as AddBody))) && setAdding(false)} />
      ) : (
        <div className="transcribe-actions transcribe-add">
          <button type="button" className="text-btn transcribe-sbtn" data-testid="transcribe-add" disabled={locked} onClick={() => setAdding(true)}>
            {t.add}
          </button>
        </div>
      )}
      <fieldset className="transcribe-group">
        <legend className="transcribe-legend">{t.transcriptsTitle}</legend>
        <div className="set-group">
          <div className="set-row">
            <div className="set-text">
              <span className="transcribe-status" data-testid="transcribe-count">
                {t.transcripts(data.transcripts)}
              </span>
            </div>
            <div className="set-control transcribe-actions">
              <button
                type="button"
                className="text-btn transcribe-sbtn danger"
                data-testid="transcribe-clear"
                disabled={!data.transcripts}
                onClick={() => {
                  if (window.confirm(t.clearConfirm)) void change(() => api.clear().then(forgetShown), t.cleared);
                }}
              >
                {t.clear}
              </button>
            </div>
          </div>
        </div>
      </fieldset>
      {note && (
        <p className="settings-note" data-testid="transcribe-message" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

function ProviderCard({ p, t, locked, change }: { p: ProviderView; t: M; locked: boolean; change: Change }) {
  const lang = useLang();
  const noteErr = useT().note.error;
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; ms: number; error?: NoteError; code?: string } | 'busy'>();
  const tid = `transcribe-provider-${p.id}`;
  const secs = (ms: number) => `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(ms / 1000)} s`;

  const runTest = async () => {
    setTest('busy');
    try {
      const r = await api.test(p.id);
      setTest(r.ok ? { ok: true, ms: r.ms } : { ok: false, ms: r.ms, error: noteError(r.error), ...(r.error ? { code: r.error } : {}) });
    } catch (e) {
      // Its own sentence (the raw code kept for the tooltip, to diagnose).
      setTest({ ok: false, ms: 0, error: noteError(e instanceof HttpError ? e.code : undefined), code: e instanceof HttpError ? (e.code ?? String(e.status)) : 'network' });
    }
  };
  const remove = () => {
    if (window.confirm(t.removeConfirm(p.name))) void change(() => api.removeProvider(p.id));
  };

  return (
    <fieldset className="transcribe-group" data-testid={tid}>
      <legend className="transcribe-legend">
        {p.name}
        {p.fromServer && <span className="transcribe-tag">{t.fromServer}</span>}
      </legend>
      <div className="set-group">
        <div className="set-row">
          <div className="set-text">
            <span className="set-label transcribe-label">{t.kinds[p.kind]}</span>
            <p className="transcribe-status transcribe-url" data-testid={`${tid}-url`}>
              {p.url}
            </p>
            <p className="transcribe-status" data-testid={`${tid}-key`}>
              {p.keySet ? t.keySet : t.noKey}
              {test && test !== 'busy' && (
                <span className={test.ok ? '' : 'transcribe-bad'} data-testid={`${tid}-result`} data-error={test.ok ? undefined : test.code} title={test.ok ? undefined : test.code}>
                  {' · '}
                  {test.ok ? t.testOk(secs(test.ms)) : t.testFail(noteErr[test.error ?? 'failed'])}
                </span>
              )}
            </p>
          </div>
          <div className="set-control transcribe-actions">
            <button type="button" className="text-btn transcribe-sbtn" data-testid={`${tid}-test`} title={t.testHint} disabled={test === 'busy'} onClick={() => void runTest()}>
              {test === 'busy' ? t.testing : t.test}
            </button>
            <button type="button" className="text-btn transcribe-sbtn" data-testid={`${tid}-edit`} disabled={locked} aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
              {t.edit}
            </button>
            {!p.fromServer && (
              <button type="button" className="text-btn transcribe-sbtn danger" data-testid={`${tid}-remove`} disabled={locked} onClick={remove}>
                {t.remove}
              </button>
            )}
          </div>
        </div>
        {p.fromServer && editing && <p className="settings-hint transcribe-status">{t.fromServerHint}</p>}
        {editing && !locked && <ProviderForm t={t} current={p} onCancel={() => setEditing(false)} onSave={async (b) => (await change(() => api.updateProvider(p.id, b as EditBody))) && setEditing(false)} />}
        <ModelRow p={p} t={t} change={change} />
      </div>
    </fieldset>
  );
}

/** A model and a language, as the form edits them. */
function ModelFields({ kind, model, language, onModel, onLanguage, prefix, t }: { kind: ProviderKind; model: string; language: string; onModel: (m: string) => void; onLanguage: (l: string) => void; prefix: string; t: M }) {
  const preset = kind === 'nvidia-riva' ? rivaPreset(model) : undefined;
  const [other, setOther] = useState(kind === 'nvidia-riva' && !preset);
  return (
    <>
      {kind === 'nvidia-riva' ? (
        <label className="transcribe-field">
          {t.model}
          <select
            data-testid={`${prefix}-model`}
            value={other ? 'other' : model}
            onChange={(e) => {
              const v = e.target.value;
              setOther(v === 'other');
              if (v !== 'other') {
                onModel(v);
                const p = rivaPreset(v);
                if (p && !p.auto && !language) onLanguage(p.lang ?? '');
              } else onModel('');
            }}
          >
            {RIVA_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {t.presets[p.id] ?? p.id}
              </option>
            ))}
            <option value="other">{t.modelOther}</option>
          </select>
        </label>
      ) : (
        <label className="transcribe-field">
          {t.model}
          <input className="transcribe-input" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={100} data-testid={`${prefix}-model`} value={model} onChange={(e) => onModel(e.target.value.trim())} />
          <span className="settings-hint">{t.modelHint}</span>
        </label>
      )}
      {other && (
        <label className="transcribe-field">
          {t.functionId}
          <input className="transcribe-input" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={36} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" data-testid={`${prefix}-function`} value={model} onChange={(e) => onModel(e.target.value.trim().toLowerCase())} />
        </label>
      )}
      <label className="transcribe-field">
        {t.language}
        <input className="transcribe-input" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={12} placeholder={t.languageAuto} data-testid={`${prefix}-language`} value={language} onChange={(e) => onLanguage(e.target.value.trim())} />
        <span className="settings-hint">{needsLanguage(kind, model) && !language ? t.error.language_required : t.languageHint}</span>
      </label>
    </>
  );
}

const modelOk = (kind: ProviderKind, model: string) => (kind === 'nvidia-riva' ? !!rivaPreset(model) || validFunctionId(model) : !!model);

/** The provider's model and language: saved at once, no step-up (where the sound goes does not change). */
function ModelRow({ p, t, change }: { p: ProviderView; t: M; change: Change }) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(p.model);
  const [language, setLanguage] = useState(p.language);
  const tid = `transcribe-provider-${p.id}`;
  useEffect(() => {
    setModel(p.model);
    setLanguage(p.language);
  }, [p.model, p.language]);
  const shown = p.model + (p.language ? ` · ${p.language}` : ` · ${t.languageAuto}`);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await change(() => api.setModel(p.id, model, language))) setOpen(false);
  };
  return (
    <>
      <div className="set-row">
        <div className="set-text">
          <span className="set-label transcribe-label">{t.model}</span>
          <p className="transcribe-status" data-testid={`${tid}-model`}>
            {shown}
          </p>
        </div>
        <div className="set-control transcribe-actions">
          <button type="button" className="text-btn transcribe-sbtn" data-testid={`${tid}-model-edit`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? t.cancel : t.edit}
          </button>
        </div>
      </div>
      {open && (
        <form className="transcribe-form" onSubmit={(e) => void save(e)}>
          <ModelFields kind={p.kind} model={model} language={language} onModel={setModel} onLanguage={setLanguage} prefix={`${tid}-m`} t={t} />
          <div className="transcribe-actions">
            <button type="submit" className="text-btn transcribe-sbtn primary" data-testid={`${tid}-model-save`} disabled={!modelOk(p.kind, model) || (needsLanguage(p.kind, model) && !language)}>
              {t.save}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

type AddBody = { kind: ProviderKind; name: string; url: string; key?: string; model: string; language: string };
/** Only what changed (a key: a new one, or null to clear it). */
type EditBody = { name?: string; url?: string; key?: string | null };

const usualUrl = (k: ProviderKind) => (k === 'nvidia-riva' ? RIVA_HOSTED : '');

/** Adding (no `current`: also its model and language) or editing a provider. The key field starts empty. */
function ProviderForm({ t, current, onCancel, onSave }: { t: M; current?: ProviderView; onCancel: () => void; onSave: (b: AddBody | EditBody) => Promise<unknown> }) {
  const [kind, setKind] = useState<ProviderKind>(current?.kind ?? 'nvidia-riva');
  const [name, setName] = useState(current?.name ?? 'NVIDIA');
  const [url, setUrl] = useState(current?.url ?? RIVA_HOSTED);
  const [key, setKey] = useState('');
  const [keyMode, setKeyMode] = useState<'keep' | 'replace' | 'clear'>(current?.keySet ? 'keep' : 'replace');
  const [model, setModel] = useState(defaultModel('nvidia-riva'));
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const server = !!current?.fromServer;
  const prefix = current ? `transcribe-edit-${current.id}` : 'transcribe-new';
  const defaultName = (k: ProviderKind) => (k === 'nvidia-riva' ? 'NVIDIA' : t.kinds.openai);

  const pickKind = (k: ProviderKind) => {
    if (!url || url === usualUrl(kind)) setUrl(usualUrl(k));
    if (!name.trim() || name === defaultName(kind)) setName(defaultName(k));
    setModel(defaultModel(k));
    setLanguage('');
    setKind(k);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const newKey = keyMode === 'replace' && key ? key : keyMode === 'clear' ? null : undefined;
    try {
      if (current) {
        const ch: EditBody = {};
        if (name.trim() !== current.name) ch.name = name.trim();
        if (!server && url.trim() !== current.url) ch.url = url.trim();
        if (!server && newKey !== undefined) ch.key = newKey;
        if (Object.keys(ch).length) await onSave(ch);
        else onCancel();
      } else await onSave({ kind, name: name.trim(), url: url.trim(), model, language, ...(newKey ? { key: newKey } : {}) });
    } finally {
      setBusy(false);
      setKey('');
    }
  };
  const host = (u: string) => {
    try {
      return new URL(u.trim()).host;
    } catch {
      return null;
    }
  };
  const moved = !!current && !server && host(url) !== host(current.url);

  return (
    <form className="transcribe-form" data-testid={prefix} onSubmit={(e) => void submit(e)}>
      {!current && (
        <label className="transcribe-field">
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
      <label className="transcribe-field">
        {t.name}
        <input className="transcribe-input" maxLength={40} data-testid={`${prefix}-name`} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {!server && (
        <label className="transcribe-field">
          {t.url[kind]}
          <input
            className="transcribe-input"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            maxLength={300}
            placeholder={kind === 'nvidia-riva' ? RIVA_HOSTED : 'https://…/v1'}
            data-testid={`${prefix}-url`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
      )}
      {!server &&
        (keyMode === 'replace' ? (
          <label className="transcribe-field">
            {current?.keySet ? t.keyNew : t.key}
            <input className="transcribe-input" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={1000} data-testid={`${prefix}-key`} value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
        ) : (
          <div className="transcribe-field">
            {t.key}
            <span className="settings-hint" data-testid={`${prefix}-key-state`}>
              {keyMode === 'clear' ? t.noKey : moved ? t.error.key_reentry : `${t.keySet} · ${t.keyKept}`}
            </span>
            <div className="transcribe-actions">
              <button type="button" className="text-btn transcribe-sbtn" data-testid={`${prefix}-key-replace`} onClick={() => setKeyMode('replace')}>
                {t.keyReplace}
              </button>
              {keyMode === 'keep' && (
                <button type="button" className="text-btn transcribe-sbtn danger" data-testid={`${prefix}-key-clear`} onClick={() => setKeyMode('clear')}>
                  {t.keyClear}
                </button>
              )}
            </div>
          </div>
        ))}
      {!current && <ModelFields key={kind} kind={kind} model={model} language={language} onModel={setModel} onLanguage={setLanguage} prefix={prefix} t={t} />}
      <div className="transcribe-actions">
        <button type="button" className="text-btn transcribe-sbtn" onClick={onCancel}>
          {t.cancel}
        </button>
        <button
          type="submit"
          className="text-btn transcribe-sbtn primary"
          data-testid={`${prefix}-save`}
          disabled={busy || !name.trim() || (!server && !url.trim()) || (!current && (!modelOk(kind, model) || (needsLanguage(kind, model) && !language)))}
        >
          {t.save}
        </button>
      </div>
    </form>
  );
}
