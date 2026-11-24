import type {
  AgentRuntime,
  AgentRuntimeFeatures,
  ConversationItem,
  InboundMessage,
  InboundResult,
  RunEvent,
  RuntimeAgent,
  RuntimeConversation,
  RuntimeFollowUp,
  RuntimeJob,
  RuntimeMessage,
} from '#core/sdk.js';
import { setRuntimes } from '../server/runtimes.js';

// A stand-in agent runtime (the core's AgentRuntime contract) for the agents package's tests: no Hermes, no model.
// Its agents as given; conversations in memory; a turn's events pushed by the test (run.emit / run.end); what was
// asked of it recorded (calls). Hermes' own behaviour behind the contract is the hermes package's tests.

export type AgentSpec = Partial<RuntimeAgent> & { id: string };

export const ALL: AgentRuntimeFeatures = { conversations: true, streaming: true, stop: true, organize: true, images: true, approvals: true, helpers: true, inbound: true, tools: true, mainAgent: null };
export const NONE: AgentRuntimeFeatures = { conversations: false, streaming: false, stop: false, organize: false, images: false, approvals: false, helpers: false, inbound: false, tools: false, mainAgent: null };

const agentOf = (a: AgentSpec): RuntimeAgent => ({ label: a.id, description: null, helpers: [], space: true, inbox: null, instructions: null, ...a });
const err = (status: number) => Object.assign(new Error(`fake ${status}`), { status });

export interface FakeRun {
  agent: string;
  id: string;
  message: RuntimeMessage;
  helpers: readonly string[];
  emit: (ev: RunEvent) => void;
  end: (e?: Error) => void;
  stops: number;
  approvals: string[];
}

export function fakeRuntime(id: string, specs: AgentSpec[], features: Partial<AgentRuntimeFeatures> = {}) {
  const f: AgentRuntimeFeatures = { ...ALL, ...features };
  let own = specs.map(agentOf);
  let list = own;
  const down = new Set<string>();
  const convs = new Map<string, { agent: string; c: RuntimeConversation; items: ConversationItem[] }>();
  /** Conversations started elsewhere (capability otherSources), by the runtime's id. */
  const others = new Map<string, { agent: string; c: RuntimeConversation; items: ConversationItem[] }>();
  const jobLists = new Map<string, RuntimeJob[]>();
  let otherFailure: Error | null = null;
  let jobFailure: Error | null = null;
  /** Capability jobsControl: the task's state changed in place (recorded in calls). */
  const setJobState = (agent: string, jid: string, action: 'pause' | 'resume'): RuntimeJob => {
    calls.push({ op: action === 'pause' ? 'pauseJob' : 'resumeJob', agent, id: jid });
    if (jobFailure) throw jobFailure;
    const j = jobLists.get(agent)?.find((x) => x.id === jid);
    if (!j) throw err(404);
    j.state = action === 'pause' ? 'paused' : 'scheduled';
    return { ...j };
  };
  const calls: { op: string; agent?: string; id?: string; body?: unknown }[] = [];
  const runs: FakeRun[] = [];
  let inbound: ((m: InboundMessage) => Promise<InboundResult>) | undefined;
  let followUp: ((f: RuntimeFollowUp) => void) | undefined;
  let completion: (agent: string, messages: { role: string; content: string }[]) => Promise<string> = async () => {
    throw err(503);
  };
  const known = (a: string) => list.some((x) => x.id === a);
  const conv = (agent: string, cid: string) => {
    const x = convs.get(cid);
    if (!x || x.agent !== agent) throw err(404);
    return x;
  };

  const runtime: AgentRuntime = {
    type: 'provider',
    id,
    status: () => ({ ready: true }),
    features: f,
    configure: (next) => {
      calls.push({ op: 'configure', body: next });
      list = next ? next.map(agentOf) : own;
    },
    agents: () => list,
    agentsStatus: async () => list.map((a) => ({ ...a, up: !down.has(a.id) })),
    probe: async (a) => known(a) && !down.has(a),
    isUp: (a) => known(a) && !down.has(a),
    usable: async (a) => known(a) && !down.has(a),
    complete: (a, messages) => {
      calls.push({ op: 'complete', agent: a, body: messages });
      return completion(a, messages);
    },
    ...(f.conversations
      ? {
          conversations: {
            list: async (agent) => {
              if (down.has(agent)) throw err(503);
              return [...convs.values()].filter((x) => x.agent === agent).map((x) => x.c);
            },
            create: async (agent, cid) => {
              calls.push({ op: 'create', agent, id: cid });
              const c: RuntimeConversation = { id: cid, title: null, preview: null, lastActive: Date.now(), messages: 0, pinned: false };
              convs.set(cid, { agent, c, items: [] });
              return c;
            },
            get: async (agent, cid) => convs.get(cid)?.agent === agent ? convs.get(cid)!.c : null,
            ...(f.organize
              ? {
                  update: async (agent: string, cid: string, patch: { title?: string; pinned?: boolean }) => {
                    calls.push({ op: 'update', agent, id: cid, body: patch });
                    const x = conv(agent, cid);
                    if (patch.title !== undefined) x.c.title = patch.title || null;
                    if (patch.pinned !== undefined) x.c.pinned = patch.pinned;
                    return x.c;
                  },
                }
              : {}),
            remove: async (agent, cid) => {
              conv(agent, cid);
              convs.delete(cid);
            },
            history: async (agent, cid) => {
              const o = others.get(cid);
              if (o && o.agent === agent) return [...o.items];
              return [...conv(agent, cid).items];
            },
            ...(f.otherSources
              ? {
                  listOther: async (agent: string) => {
                    calls.push({ op: 'listOther', agent });
                    if (otherFailure) throw otherFailure;
                    return [...others.values()].filter((x) => x.agent === agent).map((x) => x.c);
                  },
                }
              : {}),
            ...(f.readSync
              ? {
                  markRead: async (agent: string, cid: string, read: boolean) => {
                    calls.push({ op: 'markRead', agent, id: cid, body: read });
                  },
                }
              : {}),
            send: (agent, cid, message, opts) => {
              calls.push({ op: 'send', agent, id: cid, body: { message, helpers: opts.helpers } });
              const queue: (RunEvent | { end: true; e?: Error })[] = [];
              let wake: (() => void) | undefined;
              const run: FakeRun = {
                agent,
                id: cid,
                message,
                helpers: opts.helpers,
                stops: 0,
                approvals: [],
                emit: (ev) => {
                  queue.push(ev);
                  wake?.();
                },
                end: (e) => {
                  queue.push({ end: true, e });
                  wake?.();
                },
              };
              runs.push(run);
              async function* events(): AsyncGenerator<RunEvent> {
                for (;;) {
                  while (queue.length) {
                    const x = queue.shift()!;
                    if ('end' in x) {
                      if (x.e) throw x.e;
                      return;
                    }
                    yield x;
                  }
                  await new Promise<void>((r) => (wake = r));
                  wake = undefined;
                }
              }
              return {
                events: events(),
                ...(f.stop ? { stop: async () => void run.stops++ } : {}),
                ...(f.approvals ? { approve: async (choice: 'once' | 'deny') => void run.approvals.push(choice) } : {}),
              };
            },
          },
        }
      : {}),
    ...(f.helpers
      ? {
          allowedHelpers: (lead: string, wanted: unknown, up: (a: string) => boolean) => {
            if (!Array.isArray(wanted)) return null;
            const cfg = list.find((a) => a.id === lead);
            if (!cfg || wanted.some((h) => !cfg.helpers.includes(h))) return null;
            return cfg.helpers.filter((h) => wanted.includes(h) && up(h));
          },
          onFollowUp: (h: ((x: RuntimeFollowUp) => void) | undefined) => void (followUp = h),
        }
      : {}),
    ...(f.jobs ? { jobs: async (agent: string) => jobLists.get(agent) ?? [] } : {}),
    ...(f.jobsControl
      ? {
          pauseJob: async (agent: string, jid: string) => setJobState(agent, jid, 'pause'),
          resumeJob: async (agent: string, jid: string) => setJobState(agent, jid, 'resume'),
        }
      : {}),
    ...(f.inbound ? { onInbound: (h: ((m: InboundMessage) => Promise<InboundResult>) | undefined) => void (inbound = h) } : {}),
  };
  return {
    runtime,
    calls,
    runs,
    /** A conversation's history, as the runtime would give it. */
    setHistory: (cid: string, items: ConversationItem[]) => void (convs.get(cid)!.items = items),
    /** A conversation the runtime already has. */
    addConversation: (agent: string, c: Partial<RuntimeConversation> & { id: string }) =>
      void convs.set(c.id, { agent, c: { title: null, preview: null, lastActive: Date.now(), messages: 0, pinned: false, ...c }, items: [] }),
    conversations: () => [...convs.values()],
    /** A conversation started elsewhere (listOther), with its history. */
    addOther: (agent: string, c: Partial<RuntimeConversation> & { id: string; source: string }, items?: ConversationItem[]) =>
      void others.set(c.id, { agent, c: { title: null, preview: null, lastActive: Date.now(), messages: 0, pinned: false, ...c }, items: items ?? others.get(c.id)?.items ?? [] }),
    clearOthers: () => others.clear(),
    /** listOther fails (null: works again). */
    failOthers: (e: Error | null) => void (otherFailure = e),
    setJobs: (agent: string, list: RuntimeJob[]) => void jobLists.set(agent, list),
    /** pauseJob / resumeJob fail (null: work again). */
    failJobs: (e: Error | null) => void (jobFailure = e),
    setDown: (a: string, isDown = true) => void (isDown ? down.add(a) : down.delete(a)),
    setAgents: (next: AgentSpec[]) => {
      own = next.map(agentOf);
      list = own;
    },
    complete: (fn: typeof completion) => void (completion = fn),
    /** What the runtime would hand its consumer for a message an agent posted. */
    post: (m: InboundMessage) => (inbound ? inbound(m) : Promise.reject(new Error('no consumer'))),
    followUp: (x: RuntimeFollowUp) => followUp?.(x),
  };
}

/** The runtimes the package sees (runtimes.ts), by name. */
export function useFakeRuntimes(map: Record<string, AgentRuntime>): void {
  setRuntimes((name) => map[name]);
}
