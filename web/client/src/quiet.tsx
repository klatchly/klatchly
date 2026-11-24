import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { anyRule, everyDay, hhmm, isHeld, minutesOf, quietSince, ruleFor, type QuietRule, type QuietRules } from '../../server/quiethours';
import { api, type QuietReply } from './endpoints';
import { useT } from './i18n';
import type { Chat } from './types';

// Quiet hours (server/quiethours.ts has the rules, server/quiet.ts keeps them): what the client does with them. A
// held chat leaves the inbox and its counts and shows under the Quiet tab until its window closes; the server holds
// its notifications and leaves it out of the app badge. The window is read against a clock that ticks every 20 s,
// so a chat comes back on its own without a reload.

export const quietKey = ['quiet'] as const;

export const useQuiet = () => useQuery({ queryKey: quietKey, queryFn: api.quiet, staleTime: 60_000, refetchInterval: 5 * 60_000 });

// One clock for every view: started by the first one that reads it, stopped with the last.
let now = Date.now();
const clockSubs = new Set<() => void>();
let clock: number | undefined;
function subscribeClock(f: () => void) {
  clockSubs.add(f);
  if (clock === undefined) {
    clock = window.setInterval(() => {
      now = Date.now();
      clockSubs.forEach((g) => g());
    }, 20_000);
  }
  return () => {
    clockSubs.delete(f);
    if (!clockSubs.size && clock !== undefined) {
      window.clearInterval(clock);
      clock = undefined;
    }
  };
}
/** Now, to 20 s: views that depend on a window re-render as it opens or closes. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => now);
}

/** Whether a chat is held now (stable while the rules and the clock do not move). */
export function useHeld(): (c: Chat) => boolean {
  const rules = useQuiet().data;
  const t = useNow();
  return useCallback((c: Chat) => isHeld(rules, c, t), [rules, t]);
}

/** Whether any quiet hours exist (the Quiet tab shows then). */
export const useQuietOn = (): boolean => anyRule(useQuiet().data);

/** The chats held now among `chats`. */
export function useHeldOf(chats: Chat[]): Chat[] {
  const held = useHeld();
  return useMemo(() => chats.filter(held), [chats, held]);
}

/**
 * When chats leave the Quiet list because their window closed (not because they were read or shown early): how
 * many, once, for the list's toast.
 */
export function useQuietReturn(chats: Chat[], onBack: (n: number) => void): void {
  const rules = useQuiet().data;
  const t = useNow();
  const prev = useRef<Set<string>>(new Set());
  useEffect(() => {
    const held = new Set(chats.filter((c) => isHeld(rules, c, t)).map((c) => c.id));
    const back = [...prev.current].filter((id) => {
      if (held.has(id)) return false;
      const c = chats.find((x) => x.id === id);
      return !!c && c.unreadCount > 0 && quietSince(rules, c.id, c.accountID, t) === null;
    });
    prev.current = held;
    if (back.length) onBack(back.length);
  }, [chats, rules, t, onBack]);
}

/** Saves a reply into the cache: every view follows. */
const keep = (qc: QueryClient, r: QuietReply) => qc.setQueryData(quietKey, r);

export async function setAccountQuiet(qc: QueryClient, accountID: string, rule: QuietRule | null): Promise<void> {
  keep(qc, await api.setAccountQuiet(accountID, rule));
}
export async function setChatQuiet(qc: QueryClient, chatID: string, rule: QuietRule | false | null): Promise<void> {
  keep(qc, await api.setChatQuiet(chatID, rule));
}
export async function releaseQuiet(qc: QueryClient): Promise<void> {
  keep(qc, await api.releaseQuiet());
}
export async function resetChatQuiet(qc: QueryClient): Promise<void> {
  keep(qc, await api.resetChatQuiet());
}

/** The device's time zone, for a rule saved here. */
export const deviceZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** "22:00 – 07:00 · Every day" (or the days, Monday first). */
export function ruleText(t: ReturnType<typeof useT>, r: QuietRule): string {
  const days = r.days.length === 7 ? t.quiet.everyDay : [1, 2, 3, 4, 5, 6, 0].filter((d) => r.days.includes(d)).map((d) => t.quiet.dayNames[d]).join(' ');
  return t.quiet.summary(hhmm(r.from), hhmm(r.to), days);
}

/** A rule's editor: from, to, the days; Save hands the rule back (in the device's zone). */
export function RuleEditor({ rule, onSave, busy, testid }: { rule?: QuietRule; onSave: (r: QuietRule) => void; busy?: boolean; testid: string }) {
  const t = useT();
  const [from, setFrom] = useState(hhmm(rule?.from ?? 22 * 60));
  const [to, setTo] = useState(hhmm(rule?.to ?? 7 * 60));
  const [days, setDays] = useState<number[]>(rule?.days ?? [0, 1, 2, 3, 4, 5, 6]);
  const f = minutesOf(from);
  const e = minutesOf(to);
  const ok = f !== undefined && e !== undefined && f !== e && days.length > 0;
  const toggle = (d: number) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort());
  return (
    <div className="quiet-editor" data-testid={testid}>
      <div className="quiet-times">
        <label className="quiet-time">
          <span>{t.quiet.from}</span>
          <input type="time" value={from} step={300} data-testid={`${testid}-from`} onChange={(x) => setFrom(x.target.value)} />
        </label>
        <label className="quiet-time">
          <span>{t.quiet.to}</span>
          <input type="time" value={to} step={300} data-testid={`${testid}-to`} onChange={(x) => setTo(x.target.value)} />
        </label>
      </div>
      <div className="quiet-days" role="group" aria-label={t.quiet.days}>
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <button key={d} type="button" className={`quiet-day ${days.includes(d) ? 'on' : ''}`} aria-pressed={days.includes(d)} data-testid={`${testid}-day-${d}`} onClick={() => toggle(d)}>
            {t.quiet.dayNames[d]}
          </button>
        ))}
      </div>
      <div className="quiet-editor-foot">
        <span className="settings-hint">{t.quiet.zone(rule?.tz ?? deviceZone())}</span>
        <button
          type="button"
          className="text-btn primary"
          disabled={!ok || busy}
          data-testid={`${testid}-save`}
          onClick={() => ok && onSave({ ...everyDay(f, e, deviceZone()), days })}
        >
          {t.quiet.save}
        </button>
      </div>
    </div>
  );
}

type ChatChoice = 'account' | 'own' | 'never';

/** A chat's quiet hours (its menu): like its network, its own hours, or never quiet. */
export function QuietChatDialog({ chat, onClose, onError }: { chat: Pick<Chat, 'id' | 'accountID' | 'title'>; onClose: () => void; onError: (text: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const rules = useQuiet().data;
  const ref = useRef<HTMLDialogElement>(null);
  const own = rules?.chats[chat.id];
  const account = chat.accountID && rules ? rules.accounts[chat.accountID] : undefined;
  const [choice, setChoice] = useState<ChatChoice>(own === false ? 'never' : own ? 'own' : 'account');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const save = async (rule: QuietRule | false | null) => {
    setBusy(true);
    try {
      await setChatQuiet(qc, chat.id, rule);
      onClose();
    } catch {
      onError(t.quiet.failed);
      setBusy(false);
    }
  };
  const pick = (c: ChatChoice) => {
    setChoice(c);
    if (c === 'account') void save(null);
    if (c === 'never') void save(false);
  };
  const option = (c: ChatChoice, label: string, sub?: string) => (
    <label className={`quiet-option ${choice === c ? 'on' : ''}`}>
      <input type="radio" name="quiet-choice" checked={choice === c} disabled={busy} data-testid={`quiet-choice-${c}`} onChange={() => pick(c)} />
      <span className="quiet-option-text">
        <span>{label}</span>
        {sub && <span className="settings-hint">{sub}</span>}
      </span>
    </label>
  );
  return (
    <dialog ref={ref} className="confirm quiet-dialog" aria-label={t.quiet.chatTitle(chat.title ?? '')} data-testid="quiet-dialog" onCancel={onClose} onClose={onClose}>
      <h2 className="quiet-dialog-title">{t.quiet.chatTitle(chat.title ?? '')}</h2>
      <div className="quiet-options" role="radiogroup">
        {option('account', account ? t.quiet.followAccount : t.quiet.followAccountNone, account ? ruleText(t, account) : undefined)}
        {option('own', t.quiet.own, own ? ruleText(t, own) : undefined)}
        {choice === 'own' && <RuleEditor rule={own || account || undefined} busy={busy} testid="quiet-chat-rule" onSave={(r) => void save(r)} />}
        {option('never', t.quiet.never)}
      </div>
      <p className="settings-hint">{t.quiet.phone}</p>
      <div className="confirm-actions">
        <button type="button" className="text-btn" onClick={onClose}>
          {t.common.close}
        </button>
      </div>
    </dialog>
  );
}

/** The moon: the Quiet tab, the Settings entry, the conversation's mark. */
export function MoonIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

/** A chat quiet right now (its window open): the conversation header's mark. */
export function useChatQuietNow(chat: Pick<Chat, 'id' | 'accountID'> | undefined): boolean {
  const rules = useQuiet().data;
  const t = useNow();
  return !!chat && quietSince(rules, chat.id, chat.accountID, t) !== null;
}

export { ruleFor, type QuietRules };
