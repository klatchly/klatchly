import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import {
  clientIp,
  dataPath,
  jsonObject,
  log,
  pick,
  pushAll,
  RateLimiter,
  spaceViewedBy,
  type AgentRuntime,
  type BrowserFrame,
  type ConversationItem,
  type Env,
  type InboundMessage,
  type InboundResult,
  type ModuleContext,
  type Payload,
  type RunEvent,
  type RuntimeConversation,
  type RuntimeConversations,
  type RuntimeFollowUp,
  type RuntimeJob,
  type RuntimeRun,
} from '#core/sdk.js';
import { agentsSpace } from '../package.js';
import { agentsPushText } from '../locales/index.js';
import { entryOf, manifestOf } from './manifest.js';
import { agentList, agentsStatus, liveRuntimes, mainAgent, runtimeOf, statusError } from './runtimes.js';

// The Agents space: conversations with the agents of runtimes that keep them (the core's AgentRuntime, capability
// `conversations`: Hermes today), inside Klatchly. Its URLs (/agents, /api/agents/*) and its file (data/agents-space.json)
// were /hermes, /api/hermes/* and data/hermes.json before agents 3.0 (when Hermes was the only runtime): the file is
// moved on the first start (migrateStateFile), the old URLs are no longer served.
//
// Browser -> /api/agents/* (passkey session) -> the agent's runtime. Conversations created by Klatchly (ids "klatchly_…")
// are relayed both ways. A conversation belongs to the agent it was created with; that owner is remembered
// (data/agents-space.json) and every later call for it goes to that agent's runtime. Conversations started
// elsewhere (capability `otherSources`: Telegram, a terminal…) are listed with their source under "ext_<runtime's
// id>" and are READ-ONLY here: their history can be read, nothing is sent, renamed, pinned or deleted (403
// read_only); "Continue in Klatchly" is a new Klatchly conversation the browser seeds with their context. Unread counts
// stay Klatchly's (for those, messages since last seen); with `readSync` Klatchly tells the runtime its read state, best
// effort, never waited for. Scheduled tasks (capability `jobs`) are listed (GET /jobs), never as conversations; with
// `jobsControl` (agents 3.2) a listed task can be paused or resumed (POST /jobs/:id/pause|resume), nothing more.
//
// The space shows only while a runtime that is on keeps conversations and offers an agent in it (spaceShown: the
// core's ServerSpace.shown): otherwise no button, no page, no route.
//
// A turn is owned by this server, not by the browser: klatchly follows the runtime's run (text so far, tools,
// pending approval) and lets any browser (re)attach to it with its own SSE (snapshot first, then live events). An
// approval request or a finished reply also sends a Web Push to devices not looking at the Agents space. What the
// runtime can do (stop, approvals, images, rename and pin, helpers) is what the space offers.
//
// Agent -> Klatchly (capability `inbound`): what an agent posts is stored here (data/agents-space.json), shown in the
// conversation it targets and pushed. The runtime's main agent's messages go to the current conversation; an agent
// with an `inbox` posts to its own pinned conversation (made on the first message, remade if deleted).
//
// Logs: route, status, sizes, durations; never message text, never keys.

export const MAX_TEXT = 20_000;
export const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Below the CrowdSec appsec limit (10 MiB) and the api_server's own (10 MB).
const MAX_CHAT_BODY = 9 * 1024 * 1024;
const RUN_KEEP_MS = 10 * 60 * 1000;
const MAX_INBOX = 500;

// ── Start and stop ───────────────────────────────────────────────────────────

let started = false;
let frames: ((f: BrowserFrame) => void) | undefined;
let pushFn: ModuleContext['push'] | undefined;
/** Runtimes that hand this space what their agents post and their helpers' late results. */
let listening: AgentRuntime[] = [];
/** Web Push of the space: the package's (nothing once it is off); none at all while stopped. */
const push: ModuleContext['push'] = (payload) => (pushFn ? pushFn(payload) : Promise.resolve({ sent: 0, failed: 0, skipped: 0 }));

/**
 * Start / stop of the space (index.ts), and tests: the way to the browsers and the package's push (tests: the sdk's
 * pushAll). The runtimes come from runtimes.ts (setRuntimes).
 */
export function setSpace(on: boolean, toBrowsers?: (f: BrowserFrame) => void, pushTo?: ModuleContext['push']): void {
  for (const rt of listening) {
    rt.onInbound?.(undefined);
    rt.onFollowUp?.(undefined);
  }
  listening = [];
  if (!on) {
    // Stopped: turns still streaming end now (their browsers see the end), and nothing they do afterwards
    // notifies anyone.
    pushFn = undefined;
    for (const r of [...runs.values()]) {
      if (r.status === 'running') finish(r, 'failed', 'stopped');
      clearTimeout(r.dropTimer);
    }
    runs.clear();
    bySession.clear();
  }
  started = on;
  frames = on ? toBrowsers : undefined;
  pushFn = on ? (pushTo ?? pushAll) : undefined;
  if (on) listen();
}

/** The runtimes that are on now hand this space what their agents post (inbound) and helpers' late results. */
export function listen(): void {
  for (const { rt } of liveRuntimes()) {
    if (listening.includes(rt)) continue;
    if (rt.features.inbound && rt.onInbound) rt.onInbound((m) => receiveInbound(m));
    if (rt.features.helpers && rt.onFollowUp) rt.onFollowUp((f) => receiveFollowUp(f));
    listening.push(rt);
  }
}

const unavailable = () => statusError(503);
/** Upstream status of a runtime error (0: not an upstream answer). */
export function upstreamStatus(e: unknown): number {
  const status = e instanceof Error ? (e as Error & { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : 0;
}

/** Whether the space shows: a runtime that is on keeps conversations and has an agent offered in the space. */
export function spaceShown(): boolean {
  // Asked whenever the browsers refetch the packages (a package went on or off): a runtime turned on since the
  // space started is handed its consumer now.
  if (started) listen();
  return liveRuntimes().some(({ rt }) => rt.features.conversations && !!rt.conversations && rt.agents().some((a) => a.space));
}

// ── Agents of the space ──────────────────────────────────────────────────────

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const validAgentId = (v: unknown): v is string => typeof v === 'string' && AGENT_ID.test(v);
/** Agents offered in the space, on a runtime that keeps conversations. */
const spaceAgents = () => agentList().filter((a) => a.space && !!runtimeOf(a.id)?.conversations);
/** An agent's shown name (its id when it is not configured). */
const labelOf = (agent: string) => agentList().find((a) => a.id === agent)?.label ?? agent;
/** The conversations of an agent's runtime (503: none, or the runtime is off). */
function convOf(agent: string): RuntimeConversations {
  const c = runtimeOf(agent)?.conversations;
  if (!c) throw unavailable();
  return c;
}
/** The agent a conversation is made with when none is named: the main agent, else the first of the space. */
const defaultAgent = (): string | null => {
  const main = mainAgent();
  const list = spaceAgents();
  return main && list.some((a) => a.id === main) ? main : (list[0]?.id ?? null);
};

/** An agent named by the browser: one of the space's agents, and it answers. */
async function usableAgent(v: unknown): Promise<string | null> {
  if (!validAgentId(v) || !spaceAgents().some((a) => a.id === v)) return null;
  return (await runtimeOf(v)!.probe(v)) ? v : null;
}

// ── IDs ──────────────────────────────────────────────────────────────────────

// "beep_…" before 0.26.1 (the app's former name): those conversations stay in Hermes and the data volume, still valid.
const SESSION_ID = /^(?:klatchly|beep)_\d{8}_\d{6}_[0-9a-f]{8}$/;
export const validSessionID = (v: unknown): v is string => typeof v === 'string' && SESSION_ID.test(v);
const RUN_KEY = /^[0-9a-f]{24}$/;
/** A conversation started elsewhere: "ext_" + the runtime's own id (RuntimeConversations.listOther). */
const FOREIGN_ID = /^ext_[0-9A-Za-z][0-9A-Za-z_-]{0,79}$/;
export const validForeignID = (v: unknown): v is string => typeof v === 'string' && FOREIGN_ID.test(v);
const RUNTIME_FOREIGN_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,79}$/;
const SOURCE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const runtimeIdOf = (id: string) => id.slice(4);

export function newSessionID(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const d = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const t = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `klatchly_${d}_${t}_${randomBytes(4).toString('hex')}`;
}

// ── Local state: current conversation + messages from agents (data/agents-space.json) ──

export interface InboxItem {
  id: string;
  sessionId: string | null;
  text: string;
  ts: number;
  /** Agent that posted it (absent: the main agent). */
  agent?: string;
}
interface LocalState {
  /** Last conversation of the main agent used in Klatchly: where its messages land. */
  main?: string;
  inbox: InboxItem[];
  /** Conversation -> agent it lives on. */
  owners: Record<string, string>;
  /** Conversation -> replies and messages from the agent not seen yet. */
  unread: Record<string, number>;
  /** Conversation -> helper agents its lead may delegate to (group conversations). */
  helpers: Record<string, string[]>;
  /** Conversation -> last message seen through Klatchly (one line), for the list (a runtime may only have the first). */
  last: Record<string, { text: string; own: boolean }>;
  /** Agent -> its inbox conversation (messages the agent posts itself, RuntimeAgent.inbox). */
  inboxes: Record<string, string>;
  /** Conversation started elsewhere ("ext_…") -> its number of messages when last seen in Klatchly (its unread: the rest). */
  seen: Record<string, number>;
}
let local: LocalState | undefined;
const stateFile = () => dataPath('agents-space.json');
/** The file's name before agents 3.0 (the space was /hermes). */
const FORMER_STATE_FILE = 'hermes.json';

/**
 * Moves data/hermes.json to data/agents-space.json when only the old one exists (one rename in the same folder:
 * atomic, nothing copied or lost: owners, unread counts, inbox, helpers). When both exist the new one is used and
 * the old one is left untouched (logged). Called before the state is first read; safe to call again.
 */
export function migrateStateFile(): 'moved' | 'both' | 'none' {
  const old = dataPath(FORMER_STATE_FILE);
  if (!existsSync(old)) return 'none';
  if (existsSync(stateFile())) {
    log('agents', 'state file: data/hermes.json left as is (data/agents-space.json is used)');
    return 'both';
  }
  try {
    renameSync(old, stateFile());
    log('agents', 'state file moved: data/hermes.json -> data/agents-space.json');
    return 'moved';
  } catch (e) {
    // Not fatal: the old file stays, and nothing is written until the next start tries again.
    log('agents', 'state file move failed', { name: e instanceof Error ? e.name : '?' });
    migrationFailed = true;
    return 'none';
  }
}
let migrationFailed = false;
let migrated = false;
/** The migration, once per process: at the space's start (for the log line at startup), else before the first read. */
export function ensureMigrated(): void {
  if (migrated) return;
  migrated = true;
  migrateStateFile();
}

function state(): LocalState {
  if (!local) {
    ensureMigrated();
    local = { inbox: [], owners: {}, unread: {}, helpers: {}, last: {}, inboxes: {}, seen: {} };
    try {
      const raw = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<LocalState>;
      if (validSessionID(raw.main)) local.main = raw.main;
      const rec = (o: unknown) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o as Record<string, unknown>).filter(([k]) => validSessionID(k)) : []);
      for (const [k, v] of rec(raw.owners)) if (validAgentId(v)) local.owners[k] = v;
      for (const [k, v] of rec(raw.unread)) if (Number.isSafeInteger(v) && (v as number) > 0) local.unread[k] = Math.min(v as number, 999);
      for (const [k, v] of rec(raw.helpers)) if (Array.isArray(v) && v.every(validAgentId)) local.helpers[k] = v.slice(0, 8);
      for (const [k, v] of rec(raw.last)) {
        const o = v as { text?: unknown; own?: unknown } | null;
        if (o && typeof o.text === 'string') local.last[k] = { text: o.text.slice(0, 200), own: o.own === true };
      }
      if (raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen)) {
        for (const [k, v] of Object.entries(raw.seen)) if (validForeignID(k) && Number.isSafeInteger(v) && (v as number) >= 0) local.seen[k] = v as number;
      }
      if (raw.inboxes && typeof raw.inboxes === 'object' && !Array.isArray(raw.inboxes)) {
        for (const [p, id] of Object.entries(raw.inboxes)) if (validAgentId(p) && validSessionID(id)) local.inboxes[p] = id;
      }
      if (Array.isArray(raw.inbox)) {
        local.inbox = raw.inbox.filter(
          (i): i is InboxItem =>
            !!i &&
            typeof i.id === 'string' &&
            typeof i.text === 'string' &&
            typeof i.ts === 'number' &&
            (i.sessionId === null || validSessionID(i.sessionId)) &&
            (i.agent === undefined || validAgentId(i.agent)),
        );
      }
    } catch {
      // first run
    }
  }
  return local;
}

let saveTimer: NodeJS.Timeout | undefined;
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // The old file could not be moved: writing a new one would hide it (its unread counts, inbox, owners).
    if (migrationFailed) return;
    try {
      const tmp = `${stateFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state()) + '\n', { mode: 0o600 });
      renameSync(tmp, stateFile());
    } catch {
      log('agents', 'store write failed');
    }
  }, 300);
}

function setMain(id: string): void {
  const main = mainAgent();
  if (!main || ownerKnown(id) !== main) return;
  if (state().main !== id) {
    state().main = id;
    save();
  }
}

const ownerKnown = (id: string): string | undefined => state().owners[id];
function setOwner(id: string, agent: string): void {
  if (state().owners[id] !== agent) {
    state().owners[id] = agent;
    save();
  }
}
function bumpUnread(id: string): void {
  const was = state().unread[id] ?? 0;
  state().unread[id] = Math.min(was + 1, 999);
  save();
  if (!was) syncRead(id, false);
}
function clearUnread(id: string): void {
  if (state().unread[id]) {
    delete state().unread[id];
    save();
    syncRead(id, true);
  }
}

/**
 * Tells the conversation's runtime Klatchly's read state (capability `readSync`): best effort, in the background (Klatchly's
 * own counts are what the list shows). Only on a change of state, so a busy conversation costs one call.
 */
export function syncRead(id: string, read: boolean): void {
  const agent = validForeignID(id) ? foreignOwners.get(id) : ownerKnown(id);
  if (!agent) return;
  const rt = runtimeOf(agent);
  const conv = rt?.features.readSync ? rt.conversations : undefined;
  if (!conv?.markRead) return;
  conv.markRead(agent, validForeignID(id) ? runtimeIdOf(id) : id, read).catch((e: unknown) => log('agents', 'read mark not synced', { status: upstreamStatus(e) }));
}
function setLast(id: string, text: string, own: boolean): void {
  const line = notificationText(text, 160);
  if (!line) return;
  state().last[id] = { text: line, own };
  save();
}
function forget(id: string): void {
  const st = state();
  st.inbox = st.inbox.filter((i) => i.sessionId !== id);
  if (st.main === id) delete st.main;
  delete st.owners[id];
  delete st.unread[id];
  delete st.helpers[id];
  delete st.last[id];
  for (const [p, s] of Object.entries(st.inboxes)) if (s === id) delete st.inboxes[p];
  save();
}

/** Tests: start from an empty local state. */
/** Tests: forget the state read from disk, so that the next use reads (and migrates) the files again. */
export function reloadSpaceStateForTests(): void {
  clearTimeout(saveTimer);
  local = undefined;
  migrated = false;
  migrationFailed = false;
}

export function resetSpaceStateForTests(): void {
  local = { inbox: [], owners: {}, unread: {}, helpers: {}, last: {}, inboxes: {}, seen: {} };
  foreignOwners.clear();
  foreignSummaries.clear();
  for (const r of runs.values()) clearTimeout(r.dropTimer);
  runs.clear();
  bySession.clear();
}

// ── Events to the browsers (ModuleContext.toBrowsers, over the app WebSocket) ───

type SpaceEvent = { type: 'agents.inbound' | 'agents.run'; sessionId: string | null; status?: string };
const emit = (ev: SpaceEvent) => frames?.(ev);

// ── Conversations ────────────────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  /** Agent the conversation lives on. */
  agent: string;
  title: string | null;
  preview: string | null;
  /** The preview is the user's own message. */
  own: boolean;
  lastActive: number;
  messages: number;
  pinned: boolean;
  unread: number;
  helpers: string[];
  /** The conversation receives the messages its agent posts itself (recaps, alerts). */
  inbox: boolean;
  /** Where it was started, when its runtime says (absent: through Klatchly). */
  source?: string;
  /** Started elsewhere: shown, never written to (nothing sent, renamed, pinned or deleted from Klatchly). */
  readOnly?: true;
}

export const MAX_TITLE = 120;

const toSummary = (s: RuntimeConversation, agent: string): SessionSummary => ({
  id: s.id,
  agent,
  title: s.title,
  preview: state().last[s.id]?.text ?? s.preview,
  own: state().last[s.id]?.own ?? true,
  lastActive: s.lastActive,
  messages: s.messages,
  pinned: s.pinned,
  unread: state().unread[s.id] ?? 0,
  helpers: state().helpers[s.id] ?? [],
  inbox: agent !== mainAgent() && state().inboxes[agent] === s.id,
  ...(s.source ? { source: s.source } : {}),
});

/** Pinned first, then most recent activity. */
export const bySessionOrder = (a: SessionSummary, b: SessionSummary) => Number(b.pinned) - Number(a.pinned) || b.lastActive - a.lastActive;

async function listOn(agent: string): Promise<SessionSummary[]> {
  const out = (await convOf(agent).list(agent)).filter((s) => validSessionID(s.id));
  for (const s of out) setOwner(s.id, agent);
  return out.map((s) => toSummary(s, agent));
}

/** Conversation started elsewhere ("ext_…") -> the agent it lives on, and its summary (from the last listing). */
const foreignOwners = new Map<string, string>();
const foreignSummaries = new Map<string, SessionSummary>();
/** How long a listing waits for the conversations of other sources (the runtime goes on and caches them). */
const OTHER_WAIT_MS = 3_000;

/** A conversation of another source -> its summary; its unread count: the messages since it was last seen in Klatchly. */
function foreignSummary(c: RuntimeConversation, agent: string): SessionSummary | null {
  if (!RUNTIME_FOREIGN_ID.test(c.id) || !c.source || !SOURCE_NAME.test(c.source)) return null;
  const id = `ext_${c.id}`;
  const st = state();
  // First seen: read (no flood of old conversations).
  if (st.seen[id] === undefined) {
    st.seen[id] = c.messages;
    save();
  }
  const s: SessionSummary = {
    id,
    agent,
    title: c.title,
    preview: c.preview,
    own: false,
    lastActive: c.lastActive,
    messages: c.messages,
    pinned: false,
    unread: Math.min(Math.max(0, c.messages - st.seen[id]!), 999),
    helpers: [],
    inbox: false,
    source: c.source,
    readOnly: true,
  };
  foreignOwners.set(id, agent);
  foreignSummaries.set(id, s);
  return s;
}

/** Conversations of other sources of an agent (capability `otherSources`), [] when it has none or is slow. */
async function listOtherOn(agent: string): Promise<SessionSummary[]> {
  const rt = runtimeOf(agent);
  const conv = rt?.features.otherSources ? rt.conversations : undefined;
  if (!conv?.listOther) return [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const list = await Promise.race([
      conv.listOther(agent),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), OTHER_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (!list) log('agents', 'other sources: still listing', { agent });
    return (list ?? []).map((c) => foreignSummary(c, agent)).filter((s): s is SessionSummary => !!s);
  } catch (e) {
    log('agents', 'other sources not listed', { agent, status: upstreamStatus(e) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Seen up to now (read): its unread count goes to 0. */
function markSeen(id: string, sync = true): void {
  const s = foreignSummaries.get(id);
  if (!s) return;
  const before = state().seen[id] ?? 0;
  const had = before < s.messages;
  // Never back: a listing answered from the runtime's cache may be older than one seen before.
  state().seen[id] = Math.max(before, s.messages);
  s.unread = 0;
  const keys = Object.keys(state().seen);
  // Kept bounded: the oldest marks go first (a conversation listed again starts read).
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete state().seen[k];
  save();
  if (had && sync) syncRead(id, true);
}

/**
 * Conversations of every agent of the space that is up: Klatchly's, and those started elsewhere (read-only). Fails
 * only when no agent could be listed.
 */
export async function listSessions(): Promise<{ sessions: SessionSummary[]; down: string[] }> {
  const ids = new Set(spaceAgents().map((a) => a.id));
  const agents = (await agentsStatus()).filter((a) => ids.has(a.id));
  const down = agents.filter((a) => !a.up).map((a) => a.id);
  const up = agents.filter((a) => a.up);
  const [results, others] = await Promise.all([Promise.allSettled(up.map((a) => listOn(a.id))), Promise.all(up.map((a) => listOtherOn(a.id)))]);
  const sessions: SessionSummary[] = [];
  let failure: unknown = unavailable();
  let listed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      listed++;
      sessions.push(...r.value);
    } else {
      failure = r.reason;
      log('agents', 'list failed on an agent', { status: upstreamStatus(r.reason) });
    }
  }
  if (!listed) throw failure;
  for (const o of others) sessions.push(...o);
  return { sessions: sessions.sort(bySessionOrder), down };
}

/** The agent a conversation of another source lives on: from the last listing, else a new one. */
async function foreignOwner(id: string): Promise<string | null> {
  if (!foreignOwners.has(id)) await listSessions();
  return foreignOwners.get(id) ?? null;
}

/** A runtime that may pause and resume its agent's tasks (capability `jobsControl`, with `jobs`). */
const controlsJobs = (rt: AgentRuntime | undefined): rt is AgentRuntime & Required<Pick<AgentRuntime, 'jobs' | 'pauseJob' | 'resumeJob'>> =>
  !!rt?.features.jobs && !!rt.features.jobsControl && !!rt.jobs && !!rt.pauseJob && !!rt.resumeJob;

export type SpaceJob = RuntimeJob & { agent: string; controllable: boolean };
const spaceJob = (j: RuntimeJob, agent: string, controllable: boolean): SpaceJob => ({ ...j, agent, controllable: controllable && j.state !== 'completed' });

/** The scheduled tasks of the space's agents that are up (capability `jobs`); `controllable`: pause / resume offered. */
export async function listJobs(): Promise<SpaceJob[]> {
  const ids = new Set(spaceAgents().map((a) => a.id));
  const agents = (await agentsStatus()).filter((a) => ids.has(a.id) && a.up);
  const lists = await Promise.all(
    agents.map(async (a) => {
      const rt = runtimeOf(a.id);
      if (!rt?.features.jobs || !rt.jobs) return [];
      try {
        const ctl = controlsJobs(rt);
        return (await rt.jobs(a.id)).map((j) => spaceJob(j, a.id, ctl));
      } catch (e) {
        log('agents', 'jobs not listed', { agent: a.id, status: upstreamStatus(e) });
        return [];
      }
    }),
  );
  return lists.flat().sort((x, y) => (y.lastRun ?? 0) - (x.lastRun ?? 0));
}

async function createSession(agent: string): Promise<SessionSummary> {
  const id = newSessionID();
  const s = await convOf(agent).create(agent, id);
  setOwner(id, agent);
  return toSummary(s, agent);
}

/** Agent a Klatchly conversation lives on: remembered, else looked up on every agent of the space that is up. */
export async function ownerOf(id: string): Promise<string | null> {
  const known = ownerKnown(id);
  if (known && agentList().some((a) => a.id === known)) return known;
  const ids = new Set(spaceAgents().map((a) => a.id));
  for (const a of await agentsStatus()) {
    if (!a.up || !ids.has(a.id)) continue;
    if (await convOf(a.id).get(a.id, id)) {
      setOwner(id, a.id);
      return a.id;
    }
  }
  return null;
}

const sessionExists = async (id: string, agent: string): Promise<boolean> => !!(await convOf(agent).get(agent, id));

// ── History, as the browser shows it ────────────────────────────────────────

/** A runtime's history line, or a message an agent posted itself (kept here). */
export type Item = ConversationItem | { kind: 'inbound'; id: string; ts: number; text: string };

// ── Runs ─────────────────────────────────────────────────────────────────────

export interface Approval {
  command: string;
  description: string;
  choices: string[];
  /** When it arrived (the browser shows the time left). */
  at: number;
}

export interface Snapshot {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  text: string;
  /** `agents`: agents a tool call hands work to (group conversations). */
  tools: { name: string; state: 'running' | 'done' | 'failed'; agents?: string[] }[];
  approval: Approval | null;
  error: string | null;
}

type Listener = (event: string, data: unknown) => void;

export interface Run extends Snapshot {
  key: string;
  sessionId: string;
  agent: string;
  handle: RuntimeRun | null;
  listeners: Set<Listener>;
  dropTimer?: NodeJS.Timeout;
  startedAt: number;
  /** Over: finished once (a stop of the space may end it before its stream does). */
  ended?: boolean;
}

const runs = new Map<string, Run>();
const bySession = new Map<string, Run>();

const snapshot = (r: Run): Snapshot => ({ status: r.status, text: r.text, tools: r.tools.map((t) => ({ ...t, ...(t.agents ? { agents: [...t.agents] } : {}) })), approval: r.approval, error: r.error });
export const activeRunFor = (sessionId: string) => bySession.get(sessionId);

function send(r: Run, event: string, data: unknown) {
  for (const l of r.listeners) l(event, data);
}

/** One run event of the runtime -> run state, browser event. Exported for tests. */
export function applyEvent(r: Run, ev: RunEvent): void {
  switch (ev.type) {
    case 'delta':
      if (!ev.delta) return;
      r.text += ev.delta;
      send(r, 'delta', { delta: ev.delta });
      return;
    case 'tool': {
      if (ev.state === 'running') r.tools.push(ev.agents?.length ? { name: ev.name, state: 'running', agents: [...ev.agents] } : { name: ev.name, state: 'running' });
      else {
        const t = [...r.tools].reverse().find((x) => x.name === ev.name && x.state === 'running');
        if (t) t.state = ev.state;
        else r.tools.push({ name: ev.name, state: ev.state });
      }
      send(r, 'tools', { tools: r.tools });
      return;
    }
    case 'approval':
      if (!ev.approval) {
        if (!r.approval) return;
        r.approval = null;
        send(r, 'approval', { approval: null });
        return;
      }
      r.approval = { command: ev.approval.command, description: ev.approval.description, choices: [...ev.approval.choices], at: Date.now() };
      send(r, 'approval', { approval: r.approval });
      emit({ type: 'agents.run', sessionId: r.sessionId, status: 'approval' });
      void notifyApproval(r);
      return;
    case 'text':
      if (ev.text.length >= r.text.length) r.text = ev.text.slice(0, 200_000);
      send(r, 'text', { text: r.text });
      return;
    case 'status':
      r.status = ev.status;
      return;
    case 'error':
      r.error = ev.message.slice(0, 300) || 'error';
      r.status = 'failed';
      return;
  }
}

function finish(r: Run, status?: Snapshot['status'], error?: string) {
  if (r.ended) return;
  r.ended = true;
  if (bySession.get(r.sessionId) === r) bySession.delete(r.sessionId);
  if (status) r.status = status;
  else if (r.status === 'running') r.status = 'completed';
  if (error && !r.error) r.error = error;
  r.approval = null;
  send(r, 'end', snapshot(r));
  r.listeners.clear();
  emit({ type: 'agents.run', sessionId: r.sessionId, status: r.status });
  log('agents', 'run end', { status: r.status, ms: Date.now() - r.startedAt, chars: r.text.length, tools: r.tools.length });
  if (r.status === 'completed') {
    setLast(r.sessionId, r.text, false);
    bumpUnread(r.sessionId);
    void notifyReply(r);
  }
  r.dropTimer = setTimeout(() => runs.delete(r.key), RUN_KEEP_MS);
  r.dropTimer.unref?.();
}

export function startRun(sessionId: string, text: string, images: readonly string[], agent: string, helpers: readonly string[] = []): Run {
  const r: Run = {
    key: randomBytes(12).toString('hex'),
    sessionId,
    agent,
    handle: null,
    listeners: new Set(),
    startedAt: Date.now(),
    status: 'running',
    text: '',
    tools: [],
    approval: null,
    error: null,
  };
  runs.set(r.key, r);
  bySession.set(sessionId, r);
  emit({ type: 'agents.run', sessionId, status: 'running' });
  void (async () => {
    try {
      r.handle = convOf(agent).send(agent, sessionId, { text, images }, { helpers });
      for await (const ev of r.handle.events) {
        if (r.ended) break;
        applyEvent(r, ev);
      }
      finish(r);
    } catch (e) {
      log('agents', 'run error', { status: upstreamStatus(e), name: e instanceof Error ? e.name : 'unknown' });
      finish(r, 'failed', upstreamStatus(e) ? `upstream ${upstreamStatus(e)}` : 'stream');
    }
  })();
  return r;
}

// ── Push ─────────────────────────────────────────────────────────────────────

/** Markdown-ish text -> one line for a notification body. */
export function notificationText(s: string, max = 180): string {
  const flat = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The space's notifications (app paths; push.ts makes them absolute `navigate` URLs). Exported for tests. */
export function approvalPayload(key: string, sessionId: string, description: string | undefined, lang: string | undefined, label: string): Payload {
  const t = pick(agentsPushText, lang);
  return { title: t.approvalTitle(label), body: description ? t.approvalBody(label, description) : t.approvalTitle(label), tag: `agents-approval-${key}`, url: `/agents/${sessionId}`, ts: Date.now() };
}

export function replyPayload(sessionId: string, text: string, title: string): Payload | null {
  const body = notificationText(text);
  return body ? { title, body, tag: `agents-${sessionId}`, url: `/agents/${sessionId}`, ts: Date.now() } : null;
}

export function inboundPayload(item: InboxItem): Payload {
  const title = labelOf(item.agent ?? mainAgent() ?? '');
  return { title, body: notificationText(item.text) || '…', tag: `agents-in-${item.id}`, url: item.sessionId ? `/agents/${item.sessionId}` : '/agents', ts: item.ts };
}

async function notifyApproval(r: Run) {
  if (!r.approval) return;
  const desc = r.approval.description;
  const res = await push((s) => (spaceViewedBy(s.sessionHash, agentsSpace.id) ? null : approvalPayload(r.key, r.sessionId, desc, s.lang, labelOf(r.agent))));
  log('agents', 'approval push', { sent: res.sent, skipped: res.skipped });
}

async function notifyReply(r: Run) {
  const p = replyPayload(r.sessionId, r.text, labelOf(r.agent));
  if (!p) return;
  await push((s) => (spaceViewedBy(s.sessionHash, agentsSpace.id) ? null : p));
}

async function notifyInbound(item: InboxItem) {
  const p = inboundPayload(item);
  const res = await push((s) => (spaceViewedBy(s.sessionHash, agentsSpace.id) ? null : p));
  log('agents', 'inbound push', { sent: res.sent, skipped: res.skipped });
}

// ── Helpers' late results (capability `helpers`) ─────────────────────────────

/** A helper's result that arrived after its lead's turn: the conversation's preview, unread, a push. */
export function receiveFollowUp(f: RuntimeFollowUp): void {
  if (!started || !validSessionID(f.conversation)) return;
  const head = f.results[0];
  const label = labelOf(head?.agent ?? f.agent);
  const text = f.results.map((x) => x.text).filter(Boolean).join('\n') || '…';
  setLast(f.conversation, `${label} : ${text}`, false);
  bumpUnread(f.conversation);
  emit({ type: 'agents.inbound', sessionId: f.conversation });
  const p = replyPayload(f.conversation, text, label);
  if (p) void push((s) => (spaceViewedBy(s.sessionHash, agentsSpace.id) ? null : { ...p, tag: `agents-helper-${f.key}` }));
}

// ── Inbound (agent -> Klatchly, capability `inbound`) ────────────────────────────

/** The inbox conversation of an agent: the remembered one if it still exists, else a new pinned one. */
async function inboxSession(agent: string, title: string): Promise<string> {
  const cur = state().inboxes[agent];
  if (cur && ownerKnown(cur) === agent && (await sessionExists(cur, agent))) return cur;
  if (cur) forget(cur);
  const id = (await createSession(agent)).id;
  state().inboxes[agent] = id;
  save();
  const c = convOf(agent);
  if (c.update) {
    try {
      await c.update(agent, id, { title, pinned: true });
    } catch (e) {
      // Still usable untitled (e.g. the runtime refuses a title another conversation already has).
      log('agents', 'inbox: title not set', { agent, status: upstreamStatus(e) });
    }
  }
  emit({ type: 'agents.run', sessionId: id, status: 'updated' });
  return id;
}

/**
 * A message an agent posted (already authenticated by its runtime) -> stored item; picks the conversation and
 * whether the runtime may mirror into it.
 */
export async function receiveInbound(m: InboundMessage): Promise<InboundResult> {
  const main = mainAgent();
  const agent = m.agent === main ? null : agentList().find((a) => a.id === m.agent && a.inbox);
  if (agent === undefined) return { ok: false, status: 403, error: 'unknown_agent' };
  if (!m.text || m.text.length > MAX_TEXT) return { ok: false, status: 400, error: 'bad_request' };
  const id = m.id ?? randomBytes(8).toString('hex');
  if (state().inbox.some((i) => i.id === id)) return { ok: true, duplicate: true, mirror: null };

  // Target: an explicit Klatchly conversation of the posting agent, else (main agent) the current one ("main") or a
  // new one, else (other agent) its inbox conversation. Never a conversation of another agent: the runtime mirrors
  // into the conversation it is given, inside that agent.
  let sessionId: string | null = null;
  try {
    const mine = (id: string) => (ownerKnown(id) ?? main) === m.agent;
    const chat = m.conversation;
    if (validSessionID(chat) && mine(chat) && (await sessionExists(chat, m.agent))) sessionId = chat;
    else if (agent) sessionId = await inboxSession(m.agent, agent.inbox!);
    else if (state().main && mine(state().main!) && (await sessionExists(state().main!, m.agent))) sessionId = state().main!;
    else {
      sessionId = (await createSession(m.agent)).id;
      setMain(sessionId);
    }
  } catch (e) {
    log('agents', 'inbound: no session', { agent: m.agent, status: upstreamStatus(e) });
    sessionId = null;
  }
  const item: InboxItem = { id, sessionId, text: m.text, ts: Date.now(), ...(agent ? { agent: m.agent } : {}) };
  const inbox = state().inbox;
  inbox.push(item);
  if (inbox.length > MAX_INBOX) inbox.splice(0, inbox.length - MAX_INBOX);
  if (sessionId) {
    bumpUnread(sessionId);
    setLast(sessionId, m.text, false);
  }
  save();
  emit({ type: 'agents.inbound', sessionId });
  void notifyInbound(item);
  // Mirror only between turns: a copy written in the middle of a turn would land inside it.
  const mirror = sessionId && !bySession.has(sessionId) ? sessionId : null;
  log('agents', 'inbound', { agent: m.agent, chars: m.text.length, mirror: !!mirror });
  return { ok: true, mirror };
}

// ── Browser routes (/api/agents/*, passkey session required) ────────────────

const chatLimiter = new RateLimiter(10 * 60 * 1000, 60, 100);
const small = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) });
const chatBody = bodyLimit({ maxSize: MAX_CHAT_BODY, onError: (c) => c.json({ error: 'too_large' }, 413) });
const IMAGE_URL = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

/** {text, images} from the browser -> a turn (text, data-URL images), or null. */
export function chatMessage(body: Record<string, unknown> | null): { text: string; images: string[] } | null {
  if (!body || Object.keys(body).some((k) => k !== 'text' && k !== 'images')) return null;
  const text = body.text === undefined ? '' : body.text;
  const images = body.images === undefined ? [] : body.images;
  if (typeof text !== 'string' || text.length > MAX_TEXT || !Array.isArray(images) || images.length > MAX_IMAGES) return null;
  for (const u of images) {
    const m = typeof u === 'string' ? IMAGE_URL.exec(u) : null;
    if (!m || Buffer.byteLength(m[2]!, 'base64') > MAX_IMAGE_BYTES) return null;
  }
  if (!text.trim() && !images.length) return null;
  return { text, images: images as string[] };
}

function upstreamFail(c: { json: (b: unknown, s: 502 | 503 | 404 | 409) => Response }, e: unknown, route: string) {
  const status = upstreamStatus(e);
  log('agents', 'upstream error', { route, status });
  if (status === 404) return c.json({ error: 'not_found' }, 404);
  if (status === 409) return c.json({ error: 'busy' }, 409);
  return c.json({ error: 'upstream' }, status === 503 ? 503 : 502);
}

export const spaceRoutes = new Hono<Env>();

// Mounted at /api/agents while the package is on and the space shows (paths below are relative to it). /status
// stays for clients of before the packages, which asked it whether to show the space.
spaceRoutes.get('/status', (c) => c.json({ enabled: true }));

/**
 * The agents of the space, with what the manifest says to show (colour, null: picked from the id; description by
 * language) and what their runtime can do there (`features`); `main`: the agent a new conversation is made with.
 */
spaceRoutes.get('/agents', async (c) => {
  const ids = new Set(spaceAgents().map((a) => a.id));
  const all = await agentsStatus();
  const m = manifestOf(all);
  return c.json({
    main: defaultAgent(),
    agents: all
      .filter((a) => ids.has(a.id))
      .map((a) => {
        const e = entryOf(m, a);
        const f = runtimeOf(a.id)?.features;
        return {
          name: a.id,
          label: a.label,
          description: e.description,
          color: e.color,
          helpers: f?.helpers ? a.helpers : [],
          available: a.up,
          features: { stop: !!f?.stop, images: !!f?.images, organize: !!f?.organize, helpers: !!f?.helpers, approvals: !!f?.approvals },
        };
      }),
  });
});

spaceRoutes.get('/sessions', async (c) => {
  try {
    const { sessions, down } = await listSessions();
    const st = state();
    const mainId = mainAgent();
    const main = st.main && sessions.some((s) => s.id === st.main) ? st.main : (sessions.find((s) => s.agent === mainId)?.id ?? null);
    const active = sessions.filter((s) => bySession.has(s.id)).map((s) => s.id);
    return c.json({ sessions, main, active, down });
  } catch (e) {
    return upstreamFail(c, e, 'GET /agents/sessions');
  }
});

spaceRoutes.post('/sessions', small, async (c) => {
  if (!chatLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const body = await jsonObject(c);
  if (!body || Object.keys(body).some((k) => k !== 'agent')) return c.json({ error: 'bad_request' }, 400);
  const agent = await usableAgent(body.agent === undefined ? defaultAgent() : body.agent);
  if (!agent) return c.json({ error: 'unknown_agent' }, 400);
  try {
    const s = await createSession(agent);
    setMain(s.id);
    return c.json({ session: s });
  } catch (e) {
    return upstreamFail(c, e, 'POST /agents/sessions');
  }
});

/** Owner of a conversation named in the URL, or a response (404/503) to send instead. */
async function ownerFor(c: { json: (b: unknown, s: 502 | 503 | 404 | 409) => Response }, id: string, route: string): Promise<string | Response> {
  if (!validSessionID(id)) return c.json({ error: 'not_found' }, 404);
  try {
    const p = await ownerOf(id);
    return p ?? c.json({ error: 'not_found' }, 404);
  } catch (e) {
    return upstreamFail(c, e, route);
  }
}

/** What the browser may not do to a conversation started elsewhere: anything but read it. */
const readOnly = (c: { json: (b: unknown, s: 403) => Response }) => c.json({ error: 'read_only' }, 403);

spaceRoutes.get('/jobs', async (c) => c.json({ jobs: await listJobs() }));

// Pause / resume a scheduled task (capability jobsControl): {agent}, the agent whose listing has it. Nothing else of a
// task can be changed from here (no run, edit or removal). Logged without its name or id.
const jobLimiter = new RateLimiter(10 * 60 * 1000, 30, 60);
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
async function controlJob(c: Context<Env>, action: 'pause' | 'resume') {
  if (!jobLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const id = c.req.param('id') ?? '';
  const body = await jsonObject(c);
  if (!body || Object.keys(body).some((k) => k !== 'agent') || typeof body.agent !== 'string' || !JOB_ID.test(id)) return c.json({ error: 'bad_request' }, 400);
  const agent = body.agent;
  if (!spaceAgents().some((a) => a.id === agent)) return c.json({ error: 'unknown_agent' }, 400);
  const rt = runtimeOf(agent);
  if (!controlsJobs(rt)) return c.json({ error: 'not_supported' }, 403);
  try {
    const listed = (await rt.jobs(agent)).find((j) => j.id === id);
    if (!listed || listed.state === 'completed') return c.json({ error: 'not_found' }, 404);
    const job = await (action === 'pause' ? rt.pauseJob(agent, id) : rt.resumeJob(agent, id));
    log('agents', 'job control', { agent, action, state: job.state });
    return c.json({ job: spaceJob(job, agent, true) });
  } catch (e) {
    log('agents', 'job control failed', { agent, action, status: upstreamStatus(e) });
    return upstreamFail(c, e, `POST /agents/jobs/:id/${action}`);
  }
}
spaceRoutes.post('/jobs/:id/pause', small, (c) => controlJob(c, 'pause'));
spaceRoutes.post('/jobs/:id/resume', small, (c) => controlJob(c, 'resume'));

spaceRoutes.get('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  if (validForeignID(id)) {
    try {
      if (!(await foreignOwner(id))) return c.json({ error: 'not_found' }, 404);
    } catch (e) {
      return upstreamFail(c, e, 'GET /agents/sessions/:id');
    }
    return c.json({ session: foreignSummaries.get(id) });
  }
  const agent = await ownerFor(c, id, 'GET /agents/sessions/:id');
  if (agent instanceof Response) return agent;
  try {
    const s = await convOf(agent).get(agent, id);
    return s ? c.json({ session: toSummary(s, agent) }) : c.json({ error: 'not_found' }, 404);
  } catch (e) {
    return upstreamFail(c, e, 'GET /agents/sessions/:id');
  }
});

/** Rename / pin: {title?, pinned?}. A blank title gives the conversation back to its runtime's automatic title. */
export function sessionPatch(body: Record<string, unknown> | null): { title?: string; pinned?: boolean } | null {
  if (!body || !Object.keys(body).length || Object.keys(body).some((k) => k !== 'title' && k !== 'pinned')) return null;
  const out: { title?: string; pinned?: boolean } = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return null;
    const t = body.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length > MAX_TITLE) return null;
    out.title = t;
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') return null;
    out.pinned = body.pinned;
  }
  return out;
}

spaceRoutes.patch('/sessions/:id', small, async (c) => {
  const id = c.req.param('id');
  if (validForeignID(id)) return readOnly(c);
  const patch = sessionPatch(await jsonObject(c));
  if (!patch) return c.json({ error: 'bad_request' }, 400);
  const agent = await ownerFor(c, id, 'PATCH /agents/sessions/:id');
  if (agent instanceof Response) return agent;
  const conv = convOf(agent);
  if (!conv.update) return c.json({ error: 'unsupported' }, 409);
  try {
    const s = await conv.update(agent, id, patch);
    emit({ type: 'agents.run', sessionId: id, status: 'updated' });
    log('agents', 'session patch', { title: patch.title !== undefined, pinned: patch.pinned !== undefined });
    return c.json({ session: toSummary(s, agent) });
  } catch (e) {
    if (upstreamStatus(e) === 400) return c.json({ error: 'bad_request' }, 400);
    return upstreamFail(c, e, 'PATCH /agents/sessions/:id');
  }
});

// "Mark all as read" (the list's button): every conversation's unread count, or only one agent's (the list filtered).
spaceRoutes.post('/sessions/read', small, async (c) => {
  let agent: string | undefined;
  try {
    const b = (await c.req.json()) as unknown;
    if (b && typeof b === 'object' && !Array.isArray(b) && typeof (b as { agent?: unknown }).agent === 'string') agent = (b as { agent: string }).agent;
  } catch {
    // no body: every conversation
  }
  const st = state();
  const main = mainAgent();
  const ids = Object.keys(st.unread).filter((id) => !agent || (st.owners[id] ?? main) === agent);
  for (const id of ids) delete st.unread[id];
  if (ids.length) save();
  for (const id of ids) syncRead(id, true);
  // Conversations started elsewhere: seen up to now.
  const others = [...foreignSummaries.values()].filter((s) => s.unread > 0 && (!agent || s.agent === agent));
  for (const s of others) markSeen(s.id);
  log('agents', 'marked read', { conversations: ids.length + others.length, ...(agent ? { agent } : {}) });
  return c.json({ marked: ids.length + others.length });
});

spaceRoutes.delete('/sessions/:id', async (c) => {
  const id = c.req.param('id');
  if (validForeignID(id)) return readOnly(c);
  if (validSessionID(id) && bySession.has(id)) return c.json({ error: 'busy' }, 409);
  const agent = await ownerFor(c, id, 'DELETE /agents/sessions/:id');
  if (agent instanceof Response) return agent;
  try {
    await convOf(agent).remove(agent, id);
  } catch (e) {
    return upstreamFail(c, e, 'DELETE /agents/sessions/:id');
  }
  forget(id);
  return c.json({ ok: true });
});

spaceRoutes.get('/sessions/:id/messages', async (c) => {
  const id = c.req.param('id');
  if (validForeignID(id)) {
    try {
      const agent = await foreignOwner(id);
      if (!agent) return c.json({ error: 'not_found' }, 404);
      const items: Item[] = await convOf(agent).history(agent, runtimeIdOf(id));
      items.sort((a, b) => a.ts - b.ts);
      // Opening it reads it.
      markSeen(id);
      const s = foreignSummaries.get(id);
      return c.json({ items, run: null, agent, helpers: [], readOnly: true, source: s?.source ?? null });
    } catch (e) {
      return upstreamFail(c, e, 'GET /agents/sessions/:id/messages');
    }
  }
  const agent = await ownerFor(c, id, 'GET /agents/sessions/:id/messages');
  if (agent instanceof Response) return agent;
  try {
    const items: Item[] = await convOf(agent).history(agent, id);
    // Messages with no conversation (none could be made) show in every conversation of the agent that posted them.
    const main = mainAgent();
    for (const i of state().inbox) if (i.sessionId === id || (i.sessionId === null && (i.agent ?? main) === agent)) items.push({ kind: 'inbound', id: `in-${i.id}`, ts: i.ts, text: i.text });
    items.sort((a, b) => a.ts - b.ts);
    const run = bySession.get(id);
    // Opening the conversation reads it.
    clearUnread(id);
    return c.json({ items, run: run ? run.key : null, agent, helpers: state().helpers[id] ?? [] });
  } catch (e) {
    return upstreamFail(c, e, 'GET /agents/sessions/:id/messages');
  }
});

spaceRoutes.post('/sessions/:id/messages', chatBody, async (c) => {
  const id = c.req.param('id');
  // Never into a conversation started elsewhere (its answer would not reach its app; "Continue in Klatchly" instead).
  if (validForeignID(id)) return readOnly(c);
  if (!validSessionID(id)) return c.json({ error: 'not_found' }, 404);
  if (!chatLimiter.allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429);
  const message = chatMessage(await jsonObject(c));
  if (message === null) return c.json({ error: 'bad_request' }, 400);
  if (bySession.has(id)) return c.json({ error: 'busy', run: bySession.get(id)!.key }, 409);
  const agent = await ownerFor(c, id, 'POST /agents/sessions/:id/messages');
  if (agent instanceof Response) return agent;
  const rt = runtimeOf(agent)!;
  // Pictures only for a runtime that takes them.
  if (message.images.length && !rt.features.images) return c.json({ error: 'bad_request' }, 400);
  try {
    if (!(await sessionExists(id, agent))) return c.json({ error: 'not_found' }, 404);
  } catch (e) {
    return upstreamFail(c, e, 'POST /agents/sessions/:id/messages');
  }
  setMain(id);
  setLast(id, message.text.trim() ? message.text : '📷', true);
  // The helpers the lead may use (whether they answer now is the runtime's to check at the turn).
  const helpers = rt.features.helpers && rt.allowedHelpers ? (rt.allowedHelpers(agent, state().helpers[id] ?? [], () => true) ?? []) : [];
  const r = startRun(id, message.text, message.images, agent, helpers);
  log('agents', 'run start', { images: message.images.length });
  return c.json({ run: r.key });
});

/** PUT /agents/sessions/:id/helpers body -> wanted helper list, or null. */
export function helpersBody(body: Record<string, unknown> | null): string[] | null {
  if (!body || Object.keys(body).some((k) => k !== 'helpers') || !Array.isArray(body.helpers)) return null;
  if (body.helpers.length > 8 || !body.helpers.every(validAgentId)) return null;
  return [...new Set(body.helpers as string[])];
}

// Group conversations: helper agents of a conversation (stored here; given to the runtime at each turn).
spaceRoutes.put('/sessions/:id/helpers', small, async (c) => {
  const id = c.req.param('id');
  if (validForeignID(id)) return readOnly(c);
  const wanted = helpersBody(await jsonObject(c));
  if (!wanted) return c.json({ error: 'bad_request' }, 400);
  const agent = await ownerFor(c, id, 'PUT /agents/sessions/:id/helpers');
  if (agent instanceof Response) return agent;
  const rt = runtimeOf(agent)!;
  // Any helper the lead is configured for; whether it answers is checked at each turn.
  const helpers = rt.features.helpers && rt.allowedHelpers ? rt.allowedHelpers(agent, wanted, () => true) : wanted.length ? null : [];
  if (!helpers || helpers.length !== wanted.length) return c.json({ error: 'unknown_agent' }, 400);
  const st = state();
  if (helpers.length) st.helpers[id] = helpers;
  else delete st.helpers[id];
  save();
  emit({ type: 'agents.run', sessionId: id, status: 'updated' });
  log('agents', 'helpers set', { count: helpers.length });
  return c.json({ helpers });
});

// Live run: snapshot first, then events, until the run ends. Any device can attach, and re-attach.
spaceRoutes.get('/runs/:key/events', (c) => {
  const key = c.req.param('key');
  const r = RUN_KEY.test(key) ? runs.get(key) : undefined;
  if (!r) return c.json({ error: 'not_found' }, 404);
  c.header('Cache-Control', 'no-store');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    let id = 0;
    const queue: { event: string; data: unknown }[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    const listener: Listener = (event, data) => {
      queue.push({ event, data });
      if (event === 'end') ended = true;
      wake?.();
    };
    stream.onAbort(() => {
      r.listeners.delete(listener);
      ended = true;
      wake?.();
    });
    await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot(r)), id: String(id++) });
    if (r.status !== 'running') {
      await stream.writeSSE({ event: 'end', data: JSON.stringify(snapshot(r)), id: String(id++) });
      return;
    }
    r.listeners.add(listener);
    while (!stream.aborted) {
      while (queue.length) {
        const e = queue.shift()!;
        await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data), id: String(id++) });
      }
      if (ended) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 15_000).unref?.();
      });
      wake = undefined;
      if (!queue.length && !ended) await stream.write(': keepalive\n\n');
    }
    r.listeners.delete(listener);
  });
});

spaceRoutes.post('/runs/:key/stop', small, async (c) => {
  const key = c.req.param('key');
  const r = RUN_KEY.test(key) ? runs.get(key) : undefined;
  if (!r) return c.json({ error: 'not_found' }, 404);
  if (r.status !== 'running') return c.json({ ok: true });
  if (!r.handle?.stop) return c.json({ error: 'unsupported' }, 409);
  try {
    await r.handle.stop();
    return c.json({ ok: true });
  } catch (e) {
    if (upstreamStatus(e) === 409) return c.json({ error: 'not_ready' }, 409);
    return upstreamFail(c, e, 'POST /agents/runs/:key/stop');
  }
});

spaceRoutes.post('/runs/:key/approval', small, async (c) => {
  const key = c.req.param('key');
  const r = RUN_KEY.test(key) ? runs.get(key) : undefined;
  if (!r) return c.json({ error: 'not_found' }, 404);
  const body = await jsonObject(c);
  // Only "once" (Allow) and "deny" (Refuse): never widen an approval to the whole session or forever.
  if (!body || Object.keys(body).some((k) => k !== 'choice') || (body.choice !== 'once' && body.choice !== 'deny')) {
    return c.json({ error: 'bad_request' }, 400);
  }
  if (!r.approval || !r.handle?.approve) return c.json({ error: 'no_approval' }, 409);
  try {
    await r.handle.approve(body.choice as 'once' | 'deny');
  } catch (e) {
    if (upstreamStatus(e) === 409) return c.json({ error: 'no_approval' }, 409);
    return upstreamFail(c, e, 'POST /agents/runs/:key/approval');
  }
  log('agents', 'approval', { choice: body.choice as string });
  r.approval = null;
  send(r, 'approval', { approval: null });
  return c.json({ ok: true });
});
