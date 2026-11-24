import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { HttpError, isStepUpError, StepUpBox, StepUpLeft, stepUpLocked, useLang, useStepUp } from '../../../client/src/sdk';
import { textIn } from '../locales/index';
import { api, type LlmAgentFields, type LlmAgentRow, type LlmAgentsReply } from './api';
import { useT, type T } from './strings';
import './llmagents.css';

// Settings → Agents (llm): the agents of the package's own runtime on the llm provider (server/llmruntime.ts),
// offered in chats only. Made, changed and removed here (each change needs a recent sign-in or confirmation: the
// core's step-up box); the host's (manifest, `runtime: "llm"`) are listed read-only. An agent's model is chosen in
// Settings → Default models (the llm package's page, one entry per agent); its access is always "limited" (no
// tools); its privacy line names the provider of that model.

type M = T['llmAgents'];
const COLOR = /^#[0-9a-fA-F]{6}$/;

function errorText(t: M, e: unknown): string {
  if (e instanceof HttpError && e.code && Object.hasOwn(t.error, e.code)) return t.error[e.code as keyof M['error']];
  return t.error.failed;
}

export function LlmAgents() {
  const t = useT().llmAgents;
  const step = useStepUp();
  const [data, setData] = useState<LlmAgentsReply>();
  const [note, setNote] = useState<string>();
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  const load = useCallback(() => api.llmAgents().then(setData, () => setNote(t.error.failed)), [t]);
  useEffect(() => void load(), [load]);

  if (!data || !step.state) return note ? <p className="settings-note">{note}</p> : null;
  const locked = stepUpLocked(step.state);
  const own = data.agents.filter((a) => a.source === 'settings');

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
    <div className="agents-llm-page" data-testid="agents-llm">
      <p className="settings-hint settings-lead">{t.hint}</p>
      {!data.llm && <p className="settings-hint agents-llm-warn" data-testid="agents-llm-off">{t.llmOff}</p>}
      <p className="settings-hint">
        {t.modelsHint}{' '}
        <Link href="/settings/ext/llm/models" className="agents-llm-link" data-testid="agents-llm-models">
          {t.modelsLink}
        </Link>
      </p>
      {locked ? <StepUpBox methods={step.state.methods} onDone={step.reload} testid="agents-llm-stepup" /> : <StepUpLeft state={step.state} />}
      {data.agents.map((a) =>
        editing === a.id ? (
          <AgentForm key={a.id} t={t} max={data.maxInstructions} start={a} onCancel={() => setEditing(null)} onSave={async (f) => (await change(() => api.saveLlmAgent(a.id, f))) && setEditing(null)} />
        ) : (
          <AgentCard key={a.id} a={a} t={t} locked={locked} onEdit={() => setEditing(a.id)} onRemove={() => window.confirm(t.removeConfirm(a.label)) && void change(() => api.removeLlmAgent(a.id), t.removed)} />
        ),
      )}
      {!data.agents.length && <p className="settings-hint" data-testid="agents-llm-empty">{t.empty}</p>}
      {editing === 'new' ? (
        <AgentForm t={t} max={data.maxInstructions} onCancel={() => setEditing(null)} onSave={async (f) => (await change(() => api.addLlmAgent(f))) && setEditing(null)} />
      ) : (
        <div className="agents-llm-actions agents-llm-add">
          <button type="button" className="text-btn agents-llm-btn" data-testid="agents-llm-add" disabled={locked || own.length >= data.max} onClick={() => setEditing('new')}>
            {t.add}
          </button>
        </div>
      )}
      {note && (
        <p className="settings-note" data-testid="agents-llm-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

function AgentCard({ a, t, locked, onEdit, onRemove }: { a: LlmAgentRow; t: M; locked: boolean; onEdit: () => void; onRemove: () => void }) {
  const lang = useLang();
  const who = textIn(a.disclosure, lang);
  return (
    <fieldset className="agents-llm-group" data-testid={`agents-llm-agent-${a.id}`}>
      <legend className="agents-llm-legend">
        {a.color && <span className="agents-llm-dot" style={{ background: a.color }} aria-hidden="true" />}
        {a.label}
        {a.source === 'manifest' && <span className="agents-llm-tag">{t.fromHost}</span>}
      </legend>
      <div className="set-group">
        {a.description && (
          <div className="set-row">
            <div className="set-text">
              <span className="set-label">{a.description}</span>
            </div>
          </div>
        )}
        <div className="set-row">
          <div className="set-text">
            <span className="set-label">{t.access}</span>
            <span className="settings-hint agents-llm-sub">{t.accessValue}</span>
          </div>
        </div>
        <div className="set-row">
          <div className="set-text">
            <span className="set-label">{t.privacy}</span>
            <span className="settings-hint agents-llm-sub" data-testid="agents-llm-privacy">
              {who ? t.privacyTo(who) : t.privacyUnknown}
            </span>
          </div>
        </div>
        {a.instructions && (
          <div className="set-row">
            <div className="set-text">
              <span className="set-label">{t.instructions}</span>
              <span className="settings-hint agents-llm-sub agents-llm-pre">{a.instructions}</span>
            </div>
          </div>
        )}
        {a.source === 'settings' && (
          <div className="set-row">
            <div className="set-control agents-llm-actions">
              <button type="button" className="text-btn agents-llm-btn" data-testid={`agents-llm-edit-${a.id}`} disabled={locked} onClick={onEdit}>
                {t.edit}
              </button>
              <button type="button" className="text-btn agents-llm-btn danger" data-testid={`agents-llm-remove-${a.id}`} disabled={locked} onClick={onRemove}>
                {t.remove}
              </button>
            </div>
          </div>
        )}
      </div>
    </fieldset>
  );
}

function AgentForm({ t, max, start, onCancel, onSave }: { t: M; max: number; start?: LlmAgentRow; onCancel: () => void; onSave: (f: LlmAgentFields) => Promise<unknown> }) {
  const [label, setLabel] = useState(start?.label ?? '');
  const [color, setColor] = useState(start?.color ?? '');
  const [description, setDescription] = useState(start?.description ?? '');
  const [instructions, setInstructions] = useState(start?.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const colorOk = !color || COLOR.test(color);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !colorOk) return;
    setBusy(true);
    try {
      await onSave({ label: label.trim(), color: color ? color.toLowerCase() : null, description: description.trim() || null, instructions: instructions.trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="agents-llm-form" data-testid="agents-llm-form" onSubmit={submit}>
      <label className="agents-llm-field">
        {t.name}
        <input className="agents-llm-input" data-testid="agents-llm-name" value={label} maxLength={40} required onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="agents-llm-field">
        {t.color}
        <input className="agents-llm-input" data-testid="agents-llm-color" value={color} placeholder="#2f8a7a" maxLength={7} onChange={(e) => setColor(e.target.value.trim())} />
        {!colorOk && <span className="agents-llm-error">{t.colorHint}</span>}
      </label>
      <label className="agents-llm-field">
        {t.description}
        <input className="agents-llm-input" data-testid="agents-llm-description" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="agents-llm-field">
        {t.instructions}
        <textarea className="agents-llm-input agents-llm-area" data-testid="agents-llm-instructions" value={instructions} maxLength={max} rows={6} placeholder={t.instructionsPlaceholder} onChange={(e) => setInstructions(e.target.value)} />
        <span className="settings-hint">{t.instructionsHint}</span>
      </label>
      <div className="agents-llm-actions">
        <button type="submit" className="text-btn primary agents-llm-btn" data-testid="agents-llm-save" disabled={busy || !label.trim() || !colorOk}>
          {t.save}
        </button>
        <button type="button" className="text-btn agents-llm-btn" onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
