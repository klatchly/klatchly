import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HttpError, lang, phoneLayout, useLang, useSheetDrag } from '../../../client/src/sdk';
import type { ComposerMenuProps, ConversationPanelProps, ConversationSlotProps } from '../../../client/src/sdk';
import { textIn } from '../locales/index';
import { api, type AgentSendMode, type AgentTrigger, type ChatAgentChoices, type ChatAgentConfig, type ChatAgentDraft, type ChatAgentState } from './api';
import { agentsT as tr, useT } from './strings';
import { useAgentChoices, useChatAgent, useChatAgentHere } from './launch';

// The agent inside a chat (server/chatagent.ts), in the core's slots: the per-chat Agent panel (header chip),
// the draft cards above the composer, and "Ask the agent" in the composer's ✨ menu. The chat's state and the
// agent list are launch-path hooks (launch.tsx), shared with the ✨ section's availability.

const COOLDOWNS = [30, 60, 120, 300, 900, 3600];
const asSheet = () => phoneLayout() || window.matchMedia('(pointer: coarse)').matches;
const key = (chatID: string) => ['chatagent', chatID] as const;

function RobotIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <rect x="4" y="8" width="16" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Conversation header: shows when an agent sits in the chat (its name, how it answers) and opens the panel. */
export function AgentHeader({ chatID, readOnly }: ConversationSlotProps) {
  const state = useChatAgent(chatID);
  return readOnly ? null : <AgentHeaderButton chatID={chatID} state={state} />;
}

function AgentHeaderButton({ chatID, state }: { chatID: string; state: ChatAgentState | undefined }) {
  const t = useT();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ sheet: boolean; anchor?: DOMRect } | null>(null);
  const choices = useAgentChoices(!!open || !!state?.config);
  const cfg = state?.config;
  const label = choices?.agents.find((a) => a.name === cfg?.agent)?.label ?? cfg?.agent;
  const on = !!cfg?.enabled;
  const mode = cfg ? (cfg.trigger === 'me' ? '@' : cfg.trigger === 'mention' ? '@*' : cfg.trigger === 'always' ? '∀' : 'auto') : '';
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`assist-chip agent-chip ${on ? 'set on' : cfg ? 'set' : ''} ${on && cfg?.trigger !== 'me' ? 'risky' : ''}`}
        aria-label={on && label ? t.chatAgent.attached(label) : t.chatAgent.chip}
        title={on && label ? t.chatAgent.attached(label) : t.chatAgent.chip}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        data-testid="agent-head-btn"
        data-on={on ? '1' : '0'}
        onClick={() => setOpen({ sheet: asSheet(), anchor: btn.current?.getBoundingClientRect() })}
      >
        <RobotIcon />
        {cfg && (
          <span className="assist-chip-text" data-testid="agent-head-summary">
            {on ? `${label ?? ''} · ${mode}${cfg.send === 'direct' ? ' · ⚡' : ''}` : t.chatAgent.off}
          </span>
        )}
      </button>
      {open && <AgentPanel chatID={chatID} state={state} choices={choices} sheet={open.sheet} anchor={open.anchor} onClose={() => setOpen(null)} />}
    </>
  );
}

type Form = Omit<ChatAgentConfig, 'updatedAt'>;

function AgentPanel({
  chatID,
  state,
  choices,
  sheet,
  anchor,
  onClose,
}: {
  chatID: string;
  state: ChatAgentState | undefined;
  choices: ChatAgentChoices | undefined;
  sheet: boolean;
  anchor?: DOMRect;
  onClose: () => void;
}) {
  const t = useT();
  const shown = useLang();
  const qc = useQueryClient();
  const ref = useSheetDrag(sheet, onClose);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Form starts from the chat's settings, or the defaults of the chosen agent.
  useEffect(() => {
    if (form || !state || !choices) return;
    const c = state.config;
    const def = choices.agents.find((a) => a.name === choices.default) ?? choices.agents[0];
    setForm(
      c
        ? { enabled: c.enabled, agent: c.agent, trigger: c.trigger, send: c.send, disclose: c.disclose, handle: c.handle, cooldownSec: c.cooldownSec, dailyCap: c.dailyCap, notes: c.notes, images: c.images === true }
        : { enabled: true, agent: def?.name ?? '', trigger: 'me', send: 'draft', disclose: true, handle: def?.handle ?? 'agent', cooldownSec: 120, dailyCap: 20, notes: '', images: false },
    );
  }, [form, state, choices]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useLayoutEffect(() => {
    if (sheet || !ref.current) return;
    const w = ref.current.offsetWidth;
    const right = anchor ? anchor.right : window.innerWidth / 2 + w / 2;
    const top = anchor ? anchor.bottom + 6 : 60;
    setPos({ left: Math.max(8, Math.min(right - w, window.innerWidth - w - 8)), top, maxHeight: window.innerHeight - top - 12 });
  }, [sheet, anchor, ref]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const agent = choices?.agents.find((a) => a.name === form?.agent);
  const save = async () => {
    if (!form) return;
    if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(form.handle.replace(/^@/, ''))) return setError(t.chatAgent.badHandle);
    setBusy(true);
    setError(undefined);
    try {
      // The images option only for an agent that takes pictures (the server refuses it otherwise).
      await api.setChatAgent(chatID, { ...form, images: form.images && !!agent?.pictures, handle: form.handle.replace(/^@/, '') });
      await qc.invalidateQueries({ queryKey: key(chatID) });
      onClose();
    } catch (e) {
      setError(e instanceof HttpError && e.code === 'bad_handle' ? t.chatAgent.badHandle : t.chatAgent.saveFailed);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(t.chatAgent.removeConfirm)) return;
    setBusy(true);
    try {
      await api.removeChatAgent(chatID);
      await qc.invalidateQueries({ queryKey: key(chatID) });
      onClose();
    } catch {
      setError(t.chatAgent.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const handle = form?.handle.replace(/^@/, '') || 'agent';
  return (
    <div className={`menu-backdrop newchat-backdrop ${sheet ? 'sheet-backdrop' : ''}`} onClick={onClose}>
      <div
        ref={ref}
        className={`msg-menu newchat agent-panel ${sheet ? 'sheet' : 'popover'}`}
        role="dialog"
        aria-modal="true"
        aria-label={t.chatAgent.title}
        data-testid="agent-panel"
        style={sheet ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight }}
        onClick={(e) => e.stopPropagation()}
      >
        {sheet && <div className="sheet-grab" aria-hidden="true" />}
        <div className="newchat-head">
          <span className="menu-title">{t.chatAgent.title}</span>
          <button type="button" className="icon-btn small" aria-label={t.common.close} data-testid="agent-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {state && !state.supported ? (
          <p className="newchat-note">{t.chatAgent.unsupported}</p>
        ) : !form || !choices ? (
          <p className="newchat-note">{t.common.loading}</p>
        ) : (
          <div className="agent-form">
            <p className="assist-privacy" data-testid="agent-privacy">
              {t.chatAgent.privacy(choices.contextLines, textIn(agent?.disclosure, shown))}
              {form.images && agent?.pictures && <> {t.chatAgent.privacyPictures(choices.maxPictures ?? 4)}</>}
            </p>
            <label className="agent-check">
              <input type="checkbox" checked={form.enabled} data-testid="agent-enabled" onChange={(e) => set('enabled', e.target.checked)} />
              <span>{t.chatAgent.enabled}</span>
            </label>

            <fieldset>
              <legend>{t.chatAgent.agent}</legend>
              {choices.agents.map((a) => (
                <label key={a.name} className="agent-radio">
                  <input
                    type="radio"
                    name="agent"
                    value={a.name}
                    checked={form.agent === a.name}
                    data-testid={`agent-choice-${a.name}`}
                    onChange={() => setForm((f) => (f ? { ...f, agent: a.name, handle: f.handle === choices.agents.find((x) => x.name === f.agent)?.handle ? a.handle : f.handle } : f))}
                  />
                  <span>
                    <span>
                      <b>{a.label}</b>
                      {a.access === 'limited' && <span className="agent-sub"> · {a.guaranteed ? t.chatAgent.noTools : t.chatAgent.limited(textIn(a.accessNote, shown))}</span>}
                      {!a.available && <span className="agent-sub"> · {t.chatAgent.unavailable}</span>}
                    </span>
                    {a.description && <span className="agent-desc">{textIn(a.description, shown)}</span>}
                  </span>
                </label>
              ))}
              {agent && agent.access !== 'limited' && (
                // What the host declares (the manifest's access); nothing declared: the strongest warning.
                <p className="agent-warn" role="alert" data-testid="agent-full-warning" data-access={agent.access ?? 'undeclared'}>
                  {agent.access === 'full'
                    ? t.chatAgent.fullWarning(agent.label, textIn(agent.accessNote, shown))
                    : agent.access === 'extended'
                      ? t.chatAgent.extendedWarning(textIn(agent.accessNote, shown))
                      : t.chatAgent.undeclaredWarning(agent.label)}{' '}
                  {t.chatAgent.thirdParty}
                </p>
              )}
            </fieldset>

            <fieldset>
              <legend>{t.chatAgent.trigger}</legend>
              {(
                [
                  ['me', t.chatAgent.triggerMe, t.chatAgent.triggerMeHint(handle)],
                  ['mention', t.chatAgent.triggerMention, t.chatAgent.triggerMentionHint(handle)],
                  ['auto', t.chatAgent.triggerAuto, t.chatAgent.triggerAutoHint],
                  ['always', t.chatAgent.triggerAlways, t.chatAgent.triggerAlwaysHint],
                ] as [AgentTrigger, string, string][]
              ).map(([v, label, hint]) => (
                <label key={v} className="agent-radio">
                  <input type="radio" name="trigger" value={v} checked={form.trigger === v} data-testid={`agent-trigger-${v}`} onChange={() => set('trigger', v)} />
                  <span>
                    {label}
                    <span className="agent-desc">{hint}</span>
                  </span>
                </label>
              ))}
              {form.trigger !== 'me' && (
                <p className="agent-warn" role="alert" data-testid="agent-risk">
                  {form.trigger === 'mention' ? t.chatAgent.riskMention : form.trigger === 'always' ? t.chatAgent.riskAlways : t.chatAgent.riskAuto}
                </p>
              )}
              <label className="agent-field">
                <span>{t.chatAgent.handle}</span>
                <span className="agent-handle">
                  @
                  <input
                    type="text"
                    value={form.handle}
                    maxLength={24}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-testid="agent-handle"
                    onChange={(e) => set('handle', e.target.value.trim())}
                  />
                </span>
              </label>
            </fieldset>

            <fieldset>
              <legend>{t.chatAgent.send}</legend>
              {(
                [
                  ['draft', t.chatAgent.sendDraft, t.chatAgent.sendDraftHint],
                  ['direct', t.chatAgent.sendDirect, t.chatAgent.sendDirectHint],
                ] as [AgentSendMode, string, string][]
              ).map(([v, label, hint]) => (
                <label key={v} className="agent-radio">
                  <input type="radio" name="send" value={v} checked={form.send === v} data-testid={`agent-send-${v}`} onChange={() => set('send', v)} />
                  <span>
                    {label}
                    <span className="agent-desc">{hint}</span>
                  </span>
                </label>
              ))}
              <label className="agent-check">
                <input type="checkbox" checked={form.disclose} data-testid="agent-disclose" onChange={(e) => set('disclose', e.target.checked)} />
                <span>
                  {t.chatAgent.disclose(agent?.label ?? form.agent)}
                  {!form.disclose && <span className="agent-desc">{t.chatAgent.discloseOff}</span>}
                </span>
              </label>
            </fieldset>

            <fieldset>
              <label className="agent-field">
                <span>{t.chatAgent.cooldown}</span>
                <select value={form.cooldownSec} data-testid="agent-cooldown" onChange={(e) => set('cooldownSec', Number(e.target.value))}>
                  {COOLDOWNS.map((n) => (
                    <option key={n} value={n}>
                      {t.chatAgent.seconds(n)}
                    </option>
                  ))}
                </select>
              </label>
              <span className="agent-desc">{t.chatAgent.cooldownHint}</span>
              <label className="agent-field">
                <span>{t.chatAgent.dailyCap}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={200}
                  value={form.dailyCap}
                  data-testid="agent-cap"
                  onChange={(e) => set('dailyCap', Math.max(1, Math.min(200, Math.round(Number(e.target.value) || 1))))}
                />
              </label>
              {state?.config && <span className="agent-desc" data-testid="agent-usage">{t.chatAgent.usage(state.usage.today, state.config.dailyCap)}</span>}
            </fieldset>

            {agent?.pictures ? (
              <label className="agent-check">
                <input type="checkbox" checked={form.images} data-testid="agent-images" onChange={(e) => set('images', e.target.checked)} />
                <span>
                  {t.chatAgent.pictures}
                  <span className="agent-desc">{t.chatAgent.picturesHint(choices.maxPictures ?? 4)}</span>
                </span>
              </label>
            ) : (
              agent && (
                <p className="agent-desc" data-testid="agent-images-none">
                  {t.chatAgent.picturesNone}
                </p>
              )
            )}

            <label className="agent-field agent-notes">
              <span>{t.chatAgent.notes}</span>
              <textarea rows={2} maxLength={500} value={form.notes} placeholder={t.chatAgent.notesHint} data-testid="agent-notes" onChange={(e) => set('notes', e.target.value)} />
            </label>

            {error && (
              <p className="agent-warn" role="alert" data-testid="agent-error">
                {error}
              </p>
            )}
            <div className="agent-actions">
              {state?.config && (
                <button type="button" className="text-btn danger" disabled={busy} data-testid="agent-remove" onClick={() => void remove()}>
                  {t.chatAgent.remove}
                </button>
              )}
              <button type="button" className="text-btn" disabled={busy} data-testid="agent-save" onClick={() => void save()}>
                {state?.config ? t.chatAgent.save : t.chatAgent.attach}
              </button>
            </div>

            {state?.config && (
              <details className="agent-history" data-testid="agent-history">
                <summary>{t.chatAgent.history}</summary>
                {state.audit.length ? (
                  <ul>
                    {state.audit.map((a, i) => (
                      <li key={`${a.at}-${i}`}>
                        <time>{new Date(a.at).toLocaleString(lang(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> {t.chatAgent.kinds[a.kind]}
                        {a.cause ? ` (${t.chatAgent.causes[a.cause]})` : ''}
                        {a.detail && a.kind !== 'settings' ? ` · ${a.detail}` : ''}
                        {a.text && <span className="agent-hist-text">{a.text}</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="agent-desc">{t.chatAgent.noHistory}</p>
                )}
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Above the composer: the drafts the chat's agent wrote (not in read-only chats). */
export function AgentConversation({ chatID, readOnly, fill, notify }: ConversationPanelProps) {
  const state = useChatAgent(chatID);
  if (readOnly || !state?.drafts.length) return null;
  return <AgentDrafts drafts={state.drafts} disclose={state.config?.disclose ?? true} onEdit={fill} onError={notify} />;
}

/** Drafts written by the agent, above the composer: send, put into the field to edit, or drop. */
function AgentDrafts({
  drafts,
  disclose,
  onEdit,
  onError,
}: {
  drafts: ChatAgentDraft[];
  disclose: boolean;
  onEdit: (text: string) => void;
  onError: (msg: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  if (!drafts.length) return null;
  const refresh = (d: ChatAgentDraft) => qc.invalidateQueries({ queryKey: key(d.chatID) });
  const act = async (d: ChatAgentDraft, what: 'send' | 'edit' | 'drop') => {
    setBusy(d.id);
    try {
      if (what === 'send') await api.sendAgentDraft(d.id);
      else await api.dropAgentDraft(d.id, what === 'edit');
      if (what === 'edit') onEdit(disclose ? `[${d.label}] ${d.text}` : d.text);
    } catch {
      onError(what === 'send' ? tr().chatAgent.sendFailed : tr().chatAgent.saveFailed);
    } finally {
      setBusy(null);
      void refresh(d);
    }
  };
  return (
    <div className="agent-drafts" data-testid="agent-drafts">
      {drafts.map((d) => (
        <div key={d.id} className="agent-draft" data-testid="agent-draft" data-id={d.id}>
          <span className="assist-bar-label">
            <RobotIcon size={13} /> {t.chatAgent.draftOf(d.label)}
          </span>
          <span className="agent-draft-text" data-testid="agent-draft-text">
            {disclose && <span className="agent-prefix">[{d.label}] </span>}
            {d.text}
          </span>
          <span className="agent-draft-actions">
            <button type="button" className="text-btn" disabled={busy === d.id} data-testid="agent-draft-drop" onClick={() => void act(d, 'drop')}>
              {t.chatAgent.draftDrop}
            </button>
            <button type="button" className="text-btn" disabled={busy === d.id} data-testid="agent-draft-edit" onClick={() => void act(d, 'edit')}>
              {t.chatAgent.draftEdit}
            </button>
            <button type="button" className="text-btn primary" disabled={busy === d.id} data-testid="agent-draft-send" onClick={() => void act(d, 'send')}>
              {t.chatAgent.draftSend}
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

/** "Ask the agent" (composer): the field's text is an instruction for it; the result lands as a draft or is sent. */
export async function askAgent(chatID: string, label: string, instruction: string, notify: (msg: string) => void, refresh: () => void): Promise<boolean> {
  try {
    const r = await api.askChatAgent(chatID, instruction.trim() || undefined);
    if (r.status === 'skipped') notify(tr().chatAgent.askSkipped(label));
    else if (r.status === 'sent') notify(tr().chatAgent.askSent(label));
    return true;
  } catch (e) {
    notify(e instanceof HttpError && e.status === 429 ? tr().chatAgent.askLimited : tr().chatAgent.askFailed);
    return false;
  } finally {
    refresh();
  }
}

/** "Ask the agent" in the ✨ menu: the field's text is its instruction (ComposerApi.run). */
export function AgentMenu({ api: composer, close }: ComposerMenuProps) {
  const t = useT();
  const qc = useQueryClient();
  const agent = useChatAgentHere(composer.chatID);
  if (!agent) return null;
  return (
    <>
      <p className="assist-h">{agent.label}</p>
      <button
        type="button"
        role="menuitem"
        data-testid="agent-ask"
        onClick={() => {
          close();
          const chatID = composer.chatID;
          composer.run(
            (instruction) => askAgent(chatID, agent.label, instruction, composer.notify, () => void qc.invalidateQueries({ queryKey: key(chatID) })),
            t.chatAgent.asking(agent.label),
          );
        }}
      >
        {t.chatAgent.ask}
      </button>
      <p className="assist-note">{t.chatAgent.askHint}</p>
    </>
  );
}
