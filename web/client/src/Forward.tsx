// The forward picker (search, recent chats, up to 5 targets, why a chat cannot take the content) and the
// outcome toast with "Open chat". Mounted by the conversation (ForwardHost), opened through forward.ts.
import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { api, type ForwardResult } from './endpoints';
import { chatsQuery } from './cache';
import { attachmentPlan, canAttach } from './caps';
import { Avatar } from './Avatar';
import { NetworkBadge, networkName } from './networks';
import { chatConnector } from './connectors';
import { useSheetDrag } from './sheet';
import { phoneLayout } from './nav';
import { useT } from './i18n';
import { cancelForward, dismissOutcome, finishForward, useForward, type ForwardJob } from './forward';
import type { Chat } from './types';
import type { Messages } from '../../server/locales/en';

const MAX_TARGETS = 5;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = window.setTimeout(() => setD(v), ms);
    return () => window.clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** Why this chat cannot take what is forwarded (the server checks the same), or undefined. */
export function blockedReason(t: Messages, chat: Chat, job: ForwardJob): string | undefined {
  if (chat.isReadOnly) return t.forward.readOnly;
  if (!job.files.length) return undefined;
  if (chatConnector(chat.id)?.textOnly) return t.forward.textOnly(networkName(chat.network));
  if (!canAttach(chat)) return t.forward.noFiles;
  for (const f of job.files) {
    const plan = attachmentPlan(chat, f.mime, f.size);
    if (!plan.ok) return plan.maxSize ? t.forward.tooLarge : t.forward.unsupported;
  }
  return undefined;
}

export function ForwardHost() {
  const { job, outcome } = useForward();
  return (
    <>
      {job && <ForwardPicker job={job} />}
      {outcome && <ForwardToast />}
    </>
  );
}

function ForwardPicker({ job }: { job: ForwardJob }) {
  const t = useT();
  const sheet = phoneLayout();
  const ref = useSheetDrag(sheet, cancelForward);
  const [input, setInput] = useState('');
  const query = useDebounced(input.trim(), 250);
  const [picked, setPicked] = useState<Chat[]>([]);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string>();
  const recent = useInfiniteQuery(chatsQuery());
  const search = useQuery({ queryKey: ['forward-search', query], queryFn: () => api.searchChats(query), enabled: !!query, staleTime: 30_000 });
  const list = useMemo(() => {
    if (query) return search.data?.items ?? [];
    const seen = new Set<string>();
    const out: Chat[] = [];
    for (const p of recent.data?.pages ?? []) for (const c of p.items) if (!seen.has(c.id) && !c.isArchived && out.length < 40) (seen.add(c.id), out.push(c));
    return out;
  }, [query, search.data, recent.data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !sending && cancelForward();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sending]);

  const toggle = (c: Chat) => {
    setNote(undefined);
    setPicked((p) => {
      if (p.some((x) => x.id === c.id)) return p.filter((x) => x.id !== c.id);
      if (p.length >= MAX_TARGETS) {
        setNote(t.forward.maxTargets);
        return p;
      }
      return [...p, c];
    });
  };
  const send = async () => {
    if (!picked.length || sending) return;
    setSending(true);
    const titles = Object.fromEntries(picked.map((c) => [c.id, c.title || '…']));
    try {
      const r = await api.forward(job.sources, picked.map((c) => c.id));
      finishForward({ results: r.results, titles });
    } catch (e) {
      const code = (e as { code?: string }).code;
      finishForward({ results: [], titles, error: code ?? 'upstream' });
    }
  };

  return (
    <div className={`menu-backdrop newchat-backdrop ${sheet ? 'sheet-backdrop' : 'center-backdrop'}`} onClick={() => !sending && cancelForward()}>
      <div
        ref={ref}
        className={`msg-menu newchat forward-panel ${sheet ? 'sheet' : 'centered'}`}
        role="dialog"
        aria-modal="true"
        aria-label={t.forward.title}
        data-testid="forward-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {sheet && <div className="sheet-grab" aria-hidden="true" />}
        <div className="newchat-head">
          <span className="menu-title">{t.forward.title}</span>
          <span className="newchat-count" data-testid="forward-what">{t.forward.what(job.sources.length)}</span>
        </div>
        <div className="newchat-search">
          <input
            type="search"
            value={input}
            placeholder={t.forward.search}
            aria-label={t.forward.search}
            data-testid="forward-search"
            enterKeyHint="search"
            maxLength={200}
            autoFocus={!sheet}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        {picked.length > 0 && (
          <ul className="newchat-picked" data-testid="forward-picked">
            {picked.map((c) => (
              <li key={c.id}>
                <button type="button" className="newchat-pill" onClick={() => toggle(c)} aria-label={`${c.title} ×`}>
                  <span className="newchat-pill-name">{c.title}</span> ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <h3 className="picker-title">{query ? t.forward.results : t.forward.recent}</h3>
        {query && search.isSuccess && !list.length && <p className="newchat-note">{t.forward.noResults}</p>}
        <ul className="newchat-results" data-testid="forward-results">
          {list.map((c) => {
            const why = blockedReason(t, c, job);
            const on = picked.some((x) => x.id === c.id);
            return (
              <li key={c.id}>
                <button type="button" className="contact-row" data-testid="forward-chat" data-chat-id={c.id} aria-pressed={on} disabled={!!why || sending} onClick={() => toggle(c)}>
                  <Avatar chat={c} size={36} />
                  <span className="contact-main">
                    <span className="contact-name">{c.title || '…'}</span>
                    <span className="contact-sub">
                      <NetworkBadge network={c.network} size={11} /> {why ?? networkName(c.network)}
                    </span>
                  </span>
                  {!why && <span className={`contact-check ${on ? 'on' : ''}`} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="forward-foot">
          <span className="newchat-count" role="status">{note ?? (picked.length ? '' : t.forward.pick)}</span>
          <button type="button" className="primary-btn" data-testid="forward-send" disabled={!picked.length || sending} onClick={() => void send()}>
            {sending ? t.forward.sending : t.forward.send(picked.length)}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Forwarded to X · Open chat", what failed and why. */
function ForwardToast() {
  const t = useT();
  const [, navigate] = useLocation();
  const { outcome } = useForward();
  useEffect(() => {
    if (!outcome) return;
    const id = outcome.id;
    const timer = window.setTimeout(() => dismissOutcome(id), 7000);
    return () => window.clearTimeout(timer);
  }, [outcome]);
  if (!outcome) return null;
  const ok = outcome.results.filter((r) => r.ok);
  const bad = outcome.results.filter((r) => !r.ok);
  const reason = (r: ForwardResult) => t.forward.errors[r.error ?? 'upstream'] ?? t.forward.errors.upstream;
  const first = ok[0];
  const text = outcome.error
    ? `${t.forward.failed} (${t.forward.errors[outcome.error] ?? outcome.error})`
    : ok.length
      ? `${t.forward.done(outcome.titles[first!.chatID] ?? '…', ok.length)}${bad.length ? ` · ${t.forward.partial(bad.length)} (${reason(bad[0]!)})` : ''}`
      : `${t.forward.failed} (${bad.map(reason).join(', ')})`;
  return (
    <div className={`toast forward-toast ${ok.length ? '' : 'error'}`} role="status" data-testid="forward-toast" data-ok={ok.length} data-failed={bad.length}>
      <span>{text}</span>
      {first && (
        <button
          type="button"
          className="text-btn"
          data-testid="forward-open"
          onClick={() => {
            dismissOutcome();
            navigate(`/chat/${encodeURIComponent(first.chatID)}`);
          }}
        >
          {t.forward.openChat}
        </button>
      )}
    </div>
  );
}
