import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { autosize, backToList, ConnBar, fromListState, HttpError, MessagesSkeleton, replaceKeepState, timeOf, useToast } from '../../../client/src/sdk';
import { api, type SpaceAgent, type SpaceItem } from './api';
import { AgentAvatar, agentLabel, localText, Menu, renameSession, sessionTitle, SourceBadge, titleParts, useAgents, useConversationActions, useSourceLabel, useSpaceSessions, type MenuAt } from './Agents';
import { cleanTitle, OWN_SOURCE } from './listing';
import { Markdown } from './Markdown';
import { useT } from './strings';
import { agentKeys } from './launch';

// A conversation with an agent: conversations created from Klatchly (Hermes api_server sessions "klatchly_...", "beep_..." before 0.26.1), relayed by the
// server (/api/agents/*). A turn runs on the server; this view attaches to it over SSE (snapshot, then live
// text, tools and approval requests) and can re-attach after a reload or from another device. A conversation started
// elsewhere ("ext_…": Telegram, a terminal…) is shown read-only, with "Continue in Klatchly": a new Klatchly conversation
// whose composer starts with its title and last exchange (nothing is sent until the user sends it).

const MAX_IMAGES = 4;
const MAX_SIDE = 1600;

/** `agents`: profiles a delegate_task call hands work to (group conversations). */
type Tool = { name: string; state: 'running' | 'done' | 'failed'; agents?: string[] };
type Approval = { command: string; description: string; choices: string[]; at: number };
type Snapshot = { status: 'running' | 'completed' | 'failed' | 'cancelled'; text: string; tools: Tool[]; approval: Approval | null; error: string | null };
type Pending = { text: string; thumbs: string[]; at: number };

export const spaceKeys = {
  sessions: ['agents-space', 'sessions'] as const,
  messages: (id: string) => ['agents-space', 'messages', id] as const,
};

/** Live state of a run, from /api/agents/runs/:key/events. */
function useRun(key: string | null, onEnd: (s: Snapshot) => void): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const end = useRef(onEnd);
  end.current = onEnd;
  useEffect(() => {
    if (!key) {
      setSnap(null);
      return;
    }
    const es = new EventSource(`/api/agents/runs/${encodeURIComponent(key)}/events`);
    const json = (e: Event) => {
      try {
        return JSON.parse((e as MessageEvent<string>).data) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    let done = false;
    es.addEventListener('snapshot', (e) => setSnap(json(e) as unknown as Snapshot));
    es.addEventListener('delta', (e) => {
      const d = json(e).delta;
      if (typeof d === 'string') setSnap((s) => (s ? { ...s, text: s.text + d } : s));
    });
    es.addEventListener('text', (e) => {
      const d = json(e).text;
      if (typeof d === 'string') setSnap((s) => (s ? { ...s, text: d } : s));
    });
    es.addEventListener('tools', (e) => {
      const d = json(e).tools;
      if (Array.isArray(d)) setSnap((s) => (s ? { ...s, tools: d as Tool[] } : s));
    });
    es.addEventListener('approval', (e) => {
      const d = json(e).approval as Approval | null | undefined;
      setSnap((s) => (s ? { ...s, approval: d ?? null } : s));
    });
    es.addEventListener('end', (e) => {
      done = true;
      es.close();
      const s = json(e) as unknown as Snapshot;
      setSnap(s);
      end.current(s);
    });
    es.onerror = () => {
      // Closed for good (run gone, signed out): stop following it. Otherwise EventSource reconnects and
      // the server starts again with a snapshot.
      if (es.readyState === EventSource.CLOSED && !done) {
        done = true;
        end.current({ status: 'failed', text: '', tools: [], approval: null, error: 'stream' });
      }
    };
    return () => es.close();
  }, [key]);
  return snap;
}

/** Image file -> JPEG data URL, longest side at most MAX_SIDE (keeps the request well under the 10 MB limits). */
async function toDataUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function ApprovalCard({ approval, agent, onAnswer }: { approval: Approval; agent: string; onAnswer: (choice: 'once' | 'deny') => void }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(i);
  }, []);
  const left = Math.max(0, Math.round(60 - (now - approval.at) / 1000));
  return (
    <div className="agents-approval" role="alert" data-testid="agents-approval">
      <div className="agents-approval-head">
        <strong>{t.agentSpace.approvalTitle(agent)}</strong>
        <span className="agents-approval-time">{left > 0 ? t.agentSpace.approvalExpires(left) : t.agentSpace.approvalExpired}</span>
      </div>
      {approval.description && <div className="agents-approval-desc">{approval.description}</div>}
      {approval.command && (
        <pre className="md-code">
          <code>{approval.command}</code>
        </pre>
      )}
      <div className="confirm-actions">
        <button type="button" className="text-btn danger" data-testid="agents-deny" onClick={() => onAnswer('deny')}>
          {t.agentSpace.approvalDeny}
        </button>
        <button type="button" className="text-btn primary" data-testid="agents-allow" onClick={() => onAnswer('once')}>
          {t.agentSpace.approvalAllow}
        </button>
      </div>
    </div>
  );
}

function Tools({ tools, agents }: { tools: Tool[]; agents?: SpaceAgent[] }) {
  const t = useT();
  return (
    <div className="agents-tools" data-testid="agents-tools">
      {tools.map((x, i) => {
        const state = (
          <span className="agents-tool-state" aria-hidden="true">
            {x.state === 'running' ? '◌' : x.state === 'failed' ? '✕' : '✓'}
          </span>
        );
        if (x.agents?.length) {
          // delegate_task in a group conversation: show who the work went to.
          const labels = x.agents.map((a) => agentLabel(agents, a));
          return (
            <span key={i} className={`agents-tool delegate ${x.state}`} title={t.agentSpace.delegatedTo(labels.join(', '))} data-testid="agents-tool-agent" data-agents={x.agents.join(',')}>
              {state}
              {x.agents.map((a, j) => (
                <span key={a} className="agents-tool-agent">
                  <AgentAvatar name={a} label={labels[j]!} size={16} />
                  {labels[j]}
                </span>
              ))}
            </span>
          );
        }
        return (
          <span key={i} className={`agents-tool ${x.state}`} title={t.agentSpace.tool(x.name)}>
            {state}
            {x.name}
          </span>
        );
      })}
    </div>
  );
}

/** `lead`: profile the conversation lives on (who posted its inbound messages). */
function ItemView({ item, agents, lead }: { item: SpaceItem; agents?: SpaceAgent[]; lead?: string }) {
  const t = useT();
  if (item.kind === 'tools') return <Tools agents={agents} tools={item.tools.map((name, i) => ({ name, state: 'done', agents: item.agents?.[i] }))} />;
  if (item.kind === 'helper') {
    const name = item.agent ?? '';
    const hl = item.agent ? agentLabel(agents, item.agent) : t.agentSpace.someAgent;
    return (
      <div className="msg other agents-helper-msg" data-testid="agents-helper-msg" data-agent={name}>
        <div className="bubble">
          <div className="sender agents-helper-sender">
            <AgentAvatar name={name || 'agent'} label={hl} size={18} />
            {hl}
          </div>
          {!item.ok && <div className="agents-helper-failed">{t.agentSpace.helperFailed}</div>}
          {item.text ? <Markdown text={item.text} /> : item.ok && <div className="agents-thinking">{t.agentSpace.helperEmpty}</div>}
          <div className="meta">{item.ts ? timeOf(new Date(item.ts).toISOString()) : ''}</div>
        </div>
      </div>
    );
  }
  if (item.kind === 'user') {
    return (
      <div className="msg own" data-testid="agents-user">
        <div className="bubble">
          {item.images > 0 && <div className="agents-img-note">📷 {t.agentSpace.images(item.images)}</div>}
          {item.text && <div className="text">{item.text}</div>}
          <div className="meta">{item.ts ? timeOf(new Date(item.ts).toISOString()) : ''}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`msg other ${item.kind === 'inbound' ? 'agents-inbound' : ''}`} data-testid={item.kind === 'inbound' ? 'agents-inbound' : 'agents-assistant'}>
      <div className="bubble">
        {item.kind === 'inbound' && <div className="sender">📬 {t.agentSpace.fromAgent(agentLabel(agents, lead ?? ''))}</div>}
        <Markdown text={item.text} />
        <div className="meta">{item.ts ? timeOf(new Date(item.ts).toISOString()) : ''}</div>
      </div>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (who: string, text: string) => `> ${who} : ${clip(text.trim(), 600).replace(/\n+/g, '\n> ')}`;

/** A new Klatchly conversation's first words when it continues one started elsewhere: its title and last exchange. */
export function seedText(items: SpaceItem[], o: { intro: string; me: string; agent: string }): string {
  const lastUser = [...items].reverse().find((x) => x.kind === 'user' && x.text.trim());
  const lastAnswer = [...items].reverse().find((x) => x.kind === 'assistant' && x.text.trim());
  const lines = [o.intro];
  const pair = [lastUser, lastAnswer].filter((x): x is Extract<SpaceItem, { kind: 'user' | 'assistant' }> => !!x).sort((a, b) => a.ts - b.ts);
  for (const x of pair) lines.push(quote(x.kind === 'user' ? o.me : o.agent, x.text));
  return `${lines.join('\n')}\n\n`;
}

/**
 * One agent conversation (`sessionId`), or a new one with `newAgent` (created on the first message; `seedFrom`: a
 * conversation started elsewhere it continues).
 */
export function ConversationView({ sessionId, newAgent, seedFrom }: { sessionId?: string; newAgent?: string; seedFrom?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const sessionsQ = useSpaceSessions();
  const agentsQ = useAgents().data;
  const agents = agentsQ?.agents;
  const current = sessionId;
  const msgsQ = useQuery({
    queryKey: spaceKeys.messages(current ?? ''),
    queryFn: () => api.spaceMessages(current!),
    enabled: !!current,
    staleTime: 5_000,
  });
  const session = sessionsQ.data?.sessions.find((s) => s.id === current);
  const agent = session?.agent ?? msgsQ.data?.agent ?? newAgent ?? agentsQ?.main ?? '';
  const label = agentLabel(agents, agent);
  // Started elsewhere: read here, never written to (the server refuses too).
  const readOnly = !!current && (current.startsWith('ext_') || !!session?.readOnly || !!msgsQ.data?.readOnly);
  const source = session?.source ?? msgsQ.data?.source ?? null;
  const sourceName = useSourceLabel();
  // "Continue in Klatchly": the conversation it continues (its history, already cached when coming from it).
  const seedQ = useQuery({ queryKey: spaceKeys.messages(seedFrom ?? ''), queryFn: () => api.spaceMessages(seedFrom!), enabled: !!seedFrom && !current, staleTime: 60_000 });
  const seedSession = seedFrom ? sessionsQ.data?.sessions.find((s) => s.id === seedFrom) : undefined;
  const seeded = useRef<string | null>(null);
  // Group conversation: helper agents the lead may delegate to. Before the first message (no conversation yet)
  // they are kept here and saved right after the conversation is created.
  const agentInfo = agents?.find((a) => a.name === agent);
  const leadHelpers = agentInfo?.helpers ?? [];
  // What the agent's runtime can do here (absent until the list is loaded: everything, as before).
  const can = agentInfo?.features ?? { stop: true, images: true, organize: true, helpers: true, approvals: true };
  const [draftHelpers, setDraftHelpers] = useState<string[]>([]);
  const helpers = current ? (msgsQ.data?.helpers ?? session?.helpers ?? []) : draftHelpers;
  const helperLabels = helpers.map((h) => agentLabel(agents, h));
  const [helpersMenu, setHelpersMenu] = useState<MenuAt | null>(null);
  const [localRun, setLocalRun] = useState<string | null>(null);
  // Rename in place: tap the title.
  const [editing, setEditing] = useState<string | null>(null);
  const runKey = localRun ?? msgsQ.data?.run ?? null;
  const [pending, setPending] = useState<Pending | null>(null);
  const [toast, flash] = useToast(3500);

  useEffect(() => {
    setLocalRun(null);
    setPending(null);
    setEditing(null);
    setDraftHelpers([]);
    setHelpersMenu(null);
    seeded.current = null;
  }, [current, newAgent, seedFrom]);

  const onEnd = useCallback(
    async (s: Snapshot) => {
      if (s.status === 'failed') flash(t.agentSpace.failed(label));
      if (current) await qc.refetchQueries({ queryKey: spaceKeys.messages(current) });
      void qc.invalidateQueries({ queryKey: spaceKeys.sessions });
      setLocalRun(null);
      setPending(null);
    },
    [current, qc, flash, t, label],
  );
  const live = useRun(runKey, onEnd);
  // Opening a conversation reads it (the server cleared its count): the list says so at once.
  useEffect(() => {
    if (!current || !msgsQ.dataUpdatedAt) return;
    qc.setQueryData<Awaited<ReturnType<typeof api.spaceSessions>>>(agentKeys.sessions, (d) =>
      d && d.sessions.some((x) => x.id === current && x.unread > 0) ? { ...d, sessions: d.sessions.map((x) => (x.id === current ? { ...x, unread: 0 } : x)) } : d,
    );
  }, [current, msgsQ.dataUpdatedAt, qc]);
  const running = !!runKey && (!live || live.status === 'running');

  // History; while a turn is live, what follows its user message comes from the live view instead.
  const items = useMemo(() => {
    const all = msgsQ.data?.items ?? [];
    if (!running) return all;
    let cut = all.length;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]!.kind === 'user') {
        cut = i + 1;
        break;
      }
    }
    return [...all.slice(0, cut), ...all.slice(cut).filter((x) => x.kind === 'inbound')];
  }, [msgsQ.data, running]);
  const lastUser = [...items].reverse().find((x) => x.kind === 'user');
  // The optimistic bubble goes once a history fetched after the send shows that user message.
  const showPending =
    !!pending && !(lastUser?.kind === 'user' && msgsQ.dataUpdatedAt > pending.at && lastUser.text === pending.text && lastUser.images === pending.thumbs.length);

  // Scroll: follow the bottom while the user is there.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    atBottom.current = true;
  }, [current]);
  // Keyboard up or down, composer growing: stay at the bottom if we were there.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !('ResizeObserver' in window)) return;
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === h) return;
      h = el.clientHeight;
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Composer
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (area.current) autosize(area.current);
  }, [text]);
  // A conversation that continues one started elsewhere starts with its context, once (the user edits or sends it).
  useEffect(() => {
    if (!seedFrom || current || !seedQ.data || seeded.current === seedFrom) return;
    seeded.current = seedFrom;
    const src = sourceName(seedSession?.source ?? seedQ.data.source ?? OWN_SOURCE);
    const title = cleanTitle(seedSession?.title)?.text ?? '';
    const seed = seedText(seedQ.data.items, { intro: t.agentSpace.seedIntro(src, title), me: t.agentSpace.seedMe, agent: label });
    setText((cur) => (cur.trim() ? cur : seed));
    window.setTimeout(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  }, [seedFrom, current, seedQ.data, seedSession, sourceName, t, label]);

  const addFiles = async (files: Iterable<File>) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    if (images.length + list.length > MAX_IMAGES) flash(t.agentSpace.tooManyImages(MAX_IMAGES));
    const room = list.slice(0, Math.max(0, MAX_IMAGES - images.length));
    const out: string[] = [];
    for (const f of room) {
      try {
        out.push(await toDataUrl(f));
      } catch {
        flash(t.agentSpace.imageFailed);
      }
    }
    if (out.length) setImages((cur) => [...cur, ...out].slice(0, MAX_IMAGES));
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length && can.images) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const setHelpers = async (next: string[]) => {
    if (!current) {
      setDraftHelpers(next);
      return;
    }
    try {
      const r = await api.spaceSetHelpers(current, next);
      qc.setQueryData<Awaited<ReturnType<typeof api.spaceMessages>>>(spaceKeys.messages(current), (d) => (d ? { ...d, helpers: r.helpers } : d));
      qc.setQueryData<Awaited<ReturnType<typeof api.spaceSessions>>>(agentKeys.sessions, (d) => (d ? { ...d, sessions: d.sessions.map((x) => (x.id === current ? { ...x, helpers: r.helpers } : x)) } : d));
    } catch {
      flash(t.agentSpace.actionFailed);
    }
  };
  const toggleHelper = (name: string) => void setHelpers(helpers.includes(name) ? helpers.filter((h) => h !== name) : leadHelpers.filter((h) => h === name || helpers.includes(h)));
  const openHelpers = (el?: HTMLElement) => {
    const r = el?.getBoundingClientRect();
    setHelpersMenu(window.matchMedia('(pointer: coarse)').matches || !r ? { sheet: true } : { x: r.right - 240, y: r.bottom + 4 });
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && !images.length) || sending || running) return;
    setSending(true);
    try {
      let sid = current;
      if (!sid) {
        sid = (await api.spaceCreate(agent)).session.id;
        if (draftHelpers.length) await api.spaceSetHelpers(sid, draftHelpers);
        replaceKeepState(navigate, `/agents/${sid}`);
      }
      const r = await api.spaceSend(sid, body, images);
      setPending({ text: body, thumbs: images, at: Date.now() });
      setLocalRun(r.run);
      setText('');
      setImages([]);
      atBottom.current = true;
      void qc.invalidateQueries({ queryKey: spaceKeys.sessions });
    } catch (e) {
      const st = e instanceof HttpError ? e.status : 0;
      flash(st === 409 ? t.agentSpace.busy(label) : st === 503 ? t.agentSpace.unavailableWith(label) : t.agentSpace.sendFailed);
      if (st === 409 && current) void qc.invalidateQueries({ queryKey: spaceKeys.messages(current) });
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      void send();
    }
  };
  const stop = async () => {
    if (!runKey) return;
    try {
      await api.spaceStop(runKey);
    } catch {
      flash(t.agentSpace.sendFailed);
    }
  };
  const answer = async (choice: 'once' | 'deny') => {
    if (!runKey) return;
    try {
      await api.spaceApproval(runKey, choice);
    } catch {
      flash(t.agentSpace.sendFailed);
    }
  };

  const actions = useConversationActions(() => navigate('/agents', { replace: true }), flash);
  const editRef = useRef<string | null>(null);
  editRef.current = editing;
  const saveTitle = async () => {
    // Enter then the blur of the vanishing field: save once.
    const v = editRef.current;
    editRef.current = null;
    setEditing(null);
    if (v === null || !current || v.trim() === (session?.title ?? '')) return;
    try {
      await renameSession(qc, current, v);
    } catch {
      flash(t.agentSpace.actionFailed);
    }
  };
  const unavailable = sessionsQ.isError && !msgsQ.data;
  const parts = session ? titleParts(session, t) : null;
  const title = session ? sessionTitle(session, t) : current ? t.agentSpace.untitled : t.agentSpace.newConversation;
  const continueInKlatchly = () => current && navigate(`/agents/new?agent=${encodeURIComponent(agent)}&from=${encodeURIComponent(current)}`, { state: fromListState() });

  return (
    <div className="conversation agents-conv" data-testid="agents-view">
      <header className="conv-header">
        <button type="button" className="icon-btn back" aria-label={t.common.back} data-testid="agents-back" onClick={() => backToList(navigate)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="agents-avatars" data-testid="agents-avatars">
          <AgentAvatar name={agent} label={label} size={34} />
          {helpers.map((h, i) => (
            <span key={h} className="agents-avatar-helper">
              <AgentAvatar name={h} label={helperLabels[i]!} size={20} />
            </span>
          ))}
        </span>
        <div className="conv-title agents-title">
          {editing !== null ? (
            <input
              className="agents-title-input"
              value={editing}
              maxLength={120}
              autoFocus
              enterKeyHint="done"
              aria-label={t.agentSpace.renameTitle}
              data-testid="agents-title-input"
              placeholder={session?.preview ?? ''}
              onChange={(e) => setEditing(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void saveTitle();
                } else if (e.key === 'Escape') setEditing(null);
              }}
            />
          ) : (
            <button
              type="button"
              className="agents-title-btn"
              data-testid="agents-title"
              disabled={!current || !can.organize || readOnly}
              title={current && can.organize && !readOnly ? t.agentSpace.rename : undefined}
              aria-label={title}
              onClick={() => setEditing(session?.title ?? '')}
            >
              <span className="conv-name">
                {parts ? parts.text : title}
                {parts?.suffix && <span className="agent-title-suffix">{parts.suffix}</span>}
              </span>
            </button>
          )}
          <span className="conv-sub agents-agent-name" data-testid="agents-agent">
            {source && <SourceBadge source={source} />}
            {helpers.length ? t.agentSpace.withHelpers(label, helperLabels.join(', ')) : label}
          </span>
        </div>
        {leadHelpers.length > 0 && !readOnly && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t.agentSpace.addAgents}
            title={t.agentSpace.addAgents}
            data-testid="agents-add-agents"
            onClick={(e) => openHelpers(e.currentTarget)}
          >
            <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">
              <circle cx="9" cy="8" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M2.5 19c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5M18.5 8v6M15.5 11h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {current && session && !readOnly && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t.agentSpace.menu}
            title={t.agentSpace.menu}
            data-testid="agents-more"
            disabled={running}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              actions.open(
                session,
                window.matchMedia('(pointer: coarse)').matches ? { sheet: true } : { x: r.right - 200, y: r.bottom + 4 },
                leadHelpers.length ? [{ id: 'agents', label: t.agentSpace.addAgents, run: () => openHelpers() }] : [],
              );
            }}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <circle cx="5" cy="12" r="1.8" fill="currentColor" />
              <circle cx="12" cy="12" r="1.8" fill="currentColor" />
              <circle cx="19" cy="12" r="1.8" fill="currentColor" />
            </svg>
          </button>
        )}
      </header>
      <ConnBar />
      {helpers.length > 0 && (
        <div className="agents-group" data-testid="agents-group" aria-label={t.agentSpace.groupAgents}>
          <span className="agents-group-chip lead">
            <AgentAvatar name={agent} label={label} size={18} />
            {label} <span className="agents-group-role">· {t.agentSpace.lead}</span>
          </span>
          {helpers.map((h, i) => (
            <span key={h} className="agents-group-chip" data-testid="agents-helper" data-agent={h}>
              <AgentAvatar name={h} label={helperLabels[i]!} size={18} />
              {helperLabels[i]}
              <button type="button" className="agents-group-remove" aria-label={t.agentSpace.removeHelper(helperLabels[i]!)} title={t.agentSpace.removeHelper(helperLabels[i]!)} data-testid="agents-helper-remove" onClick={() => toggleHelper(h)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className="messages agents-messages"
        ref={scroller}
        data-testid="agents-messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="msg-wrap agents-list">
          {unavailable && <div className="list-status">{t.agentSpace.unavailableWith(label)}</div>}
          {!unavailable && current && msgsQ.isPending && <MessagesSkeleton />}
          {!unavailable && !readOnly && !items.length && !pending && !running && !(current && msgsQ.isPending) && (
            <div className="agents-conv-empty" data-testid="agents-conv-empty">
              <AgentAvatar name={agent} label={label} size={56} />
              <span className="agents-conv-empty-name">{label}</span>
              {agentInfo?.description && <span className="agents-conv-empty-desc">{localText(agentInfo.description)}</span>}
              <span className="agents-conv-empty-hint">{t.agentSpace.emptyWith(label)}</span>
            </div>
          )}
          {items.map((it) => (
            <ItemView key={it.id} item={it} agents={agents} lead={agent} />
          ))}
          {showPending && pending && (
            <div className="msg own" data-testid="agents-pending">
              <div className="bubble pending">
                {pending.thumbs.length > 0 && (
                  <div className="agents-thumbs">
                    {pending.thumbs.map((u, i) => (
                      <img key={i} src={u} alt="" />
                    ))}
                  </div>
                )}
                {pending.text && <div className="text">{pending.text}</div>}
              </div>
            </div>
          )}
          {runKey && live && (live.status === 'running' || live.text || live.tools.length > 0) && (
            <>
              {live.tools.length > 0 && <Tools tools={live.tools} agents={agents} />}
              {live.approval && <ApprovalCard approval={live.approval} agent={label} onAnswer={answer} />}
              <div className="msg other" data-testid="agents-live">
                <div className="bubble">
                  {live.text ? <Markdown text={live.text} /> : <span className="agents-thinking">{t.agentSpace.thinkingWith(label)}</span>}
                  {live.status === 'cancelled' && <div className="meta">{t.agentSpace.stopped}</div>}
                </div>
              </div>
            </>
          )}
          {runKey && !live && <div className="agents-thinking">{t.agentSpace.thinkingWith(label)}</div>}
        </div>
      </div>

      {readOnly ? (
        <div className="agents-readonly" role="note" data-testid="agents-readonly">
          <div className="agents-readonly-text">
            <strong>{t.agentSpace.readOnlyBanner(sourceName(source ?? OWN_SOURCE))}</strong>
            <span>{t.agentSpace.readOnlyHint(sourceName(source ?? OWN_SOURCE))}</span>
          </div>
          <button type="button" className="space-btn primary" data-testid="agents-continue" onClick={continueInKlatchly}>
            {t.agentSpace.continueInKlatchly}
          </button>
        </div>
      ) : (
      <div className="composer">
        {images.length > 0 && (
          <div className="tray">
            {images.map((u, i) => (
              <div key={i} className="tray-item">
                <img className="tray-thumb" src={u} alt="" />
                <button type="button" className="tray-remove" aria-label={t.agentSpace.removeImage} onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="agents-file"
            onChange={(e) => {
              void addFiles(e.target.files ?? []);
              e.target.value = '';
            }}
          />
          {can.images && (
            <button type="button" className="icon-btn attach-btn" aria-label={t.agentSpace.attachImage} title={t.agentSpace.attachImage} data-testid="agents-attach" onClick={() => fileInput.current?.click()}>
              <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">
                <path d="M4 6h16v12H4zM4 15l4.5-4.5L13 15l2.5-2.5L20 17M15.5 9.5h.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={t.agentSpace.placeholderWith(label)}
            aria-label={t.agentSpace.placeholderWith(label)}
            data-testid="agents-input"
            maxLength={20_000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
          />
          {running && can.stop ? (
            <button type="button" className="send-btn agents-stop" aria-label={t.agentSpace.stop} title={t.agentSpace.stop} data-testid="agents-stop" onClick={stop}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button type="button" className="send-btn" aria-label={t.agentSpace.send} title={t.agentSpace.send} data-testid="agents-send" disabled={sending || running || (!text.trim() && !images.length)} onClick={send}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M4 12l16-8-6 16-2.5-6.5z" fill="currentColor" />
              </svg>
            </button>
          )}
        </div>
      </div>
      )}
      {actions.element}
      {helpersMenu && (
        <Menu
          at={helpersMenu}
          testid="helpers-menu"
          label={t.agentSpace.groupAgents}
          title={t.agentSpace.groupAgents}
          onClose={() => setHelpersMenu(null)}
          items={leadHelpers.map((h) => {
            const a = agents?.find((x) => x.name === h);
            const on = helpers.includes(h);
            const hl = agentLabel(agents, h);
            return {
              id: h,
              label: (
                <span className={`agent-pick ${a?.available || on ? '' : 'off'}`} data-on={on ? 'true' : 'false'}>
                  <AgentAvatar name={h} label={hl} size={28} />
                  <span className="agent-pick-text">
                    <span className="agent-pick-name">{hl}</span>
                    <span className="agent-pick-desc">{a?.available ? localText(a.description) : t.agentSpace.agentUnavailable}</span>
                  </span>
                  <span className="agent-pick-check" aria-hidden="true">
                    {on ? '✓' : '+'}
                  </span>
                </span>
              ),
              run: () => (on || a?.available) && toggleHelper(h),
            };
          })}
        />
      )}
      {toast && (
        <div className="toast" role="status" data-testid="toast">
          {toast}
        </div>
      )}
    </div>
  );
}
