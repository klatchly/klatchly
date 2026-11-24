import type { ProviderModule } from './registry.js';

// The agent runtime contract (extension API 1.17): what a package that runs agents (hermes: Hermes Agent's
// api_server; the agents package's own runtime on llm) offers the package that shows them (agents: the agent inside
// a chat, the Agents space). A runtime is a provider module of this type; its consumer finds it with
// ModuleContext.provider(<its id>) as for any provider (it `enhances` the runtime's package), and names it in its
// own configuration (the agents manifest's `runtime`). Core operations every runtime has; the rest are capabilities
// it declares (`features`) and the optional members that go with them. The consumer adapts what it offers to them:
// no Agents space without `conversations`, no stop button without `stop`…
//
// Agent ids are the consumer's ([a-z0-9][a-z0-9_-]{0,31}); a runtime maps them to its own names (a Hermes profile).
// Calls reject with an Error carrying a numeric `status`, as an HTTP answer would: 404 (no such agent or
// conversation, or a route the runtime refuses), 409 (busy, or not ready: a run whose upstream id is not known
// yet), 503 (not configured or unavailable), anything else (the upstream's failure).

/** A text by language code ("en", "fr", "pt-BR"…). */
export type RuntimeText = Readonly<Record<string, string>>;

/** An agent as its consumer configures it on a runtime (and as the runtime reports it). */
export interface RuntimeAgent {
  id: string;
  /** Shown name. */
  label: string;
  /** One line about it, in English (a lead agent reads its helpers' descriptions), or null. */
  description: string | null;
  /** Agents it may hand work to when it leads a conversation (capability `helpers`), on the same runtime. */
  helpers: readonly string[];
  /** Offered in the consumer's conversations (the Agents space; capability `conversations`). */
  space: boolean;
  /** Title of the conversation that receives the messages it posts itself (capability `inbound`), or null. */
  inbox: string | null;
  /** Its standing instructions (a persona), for a runtime that keeps none itself (llm); null: none. */
  instructions: string | null;
}

/** An agent with whether it answers now. */
export type RuntimeAgentStatus = RuntimeAgent & { up: boolean };

/** What a runtime can do beyond the core operations. Fixed for the runtime's lifetime. */
export interface AgentRuntimeFeatures {
  /** Persistent conversations (`conversations`): what an Agents space needs. */
  conversations: boolean;
  /** A run's text arrives as it is written (`delta` events). */
  streaming: boolean;
  /** A run can be stopped (RuntimeRun.stop). */
  stop: boolean;
  /** Conversations can be renamed and pinned (RuntimeConversations.update). */
  organize: boolean;
  /** A message may carry images (RuntimeMessage.images). */
  images: boolean;
  /** A run may ask for permission (`approval` events, RuntimeRun.approve). */
  approvals: boolean;
  /** Group conversations: a lead hands work to helpers (allowedHelpers, onFollowUp). */
  helpers: boolean;
  /** Agents post messages of their own (onInbound). */
  inbound: boolean;
  /** Its agents use tools (files, the web, programs…). False: an agent can only answer from the model. */
  tools: boolean;
  /** The agent that is the runtime itself, if any (where messages for nobody in particular go). */
  mainAgent: string | null;
  /**
   * (1.19) It also lists conversations started elsewhere (another messaging app, a terminal…): read-only for the
   * consumer (RuntimeConversations.listOther; history readable, nothing sent into them). Absent: false.
   */
  otherSources?: boolean;
  /** (1.19) It has scheduled tasks it can list, read-only (AgentRuntime.jobs). Absent: false. */
  jobs?: boolean;
  /** (1.19) It keeps a read mark per conversation the consumer may set (RuntimeConversations.markRead). Absent: false. */
  readSync?: boolean;
  /**
   * (1.20) With `jobs`: a listed task can be paused and resumed (AgentRuntime.pauseJob / resumeJob). Nothing else:
   * no run now, no edit, no removal. Absent: false (the tasks stay read-only).
   */
  jobsControl?: boolean;
}

/** A conversation as the runtime keeps it. */
export interface RuntimeConversation {
  id: string;
  title: string | null;
  /** Its first or last message, one line, or null. */
  preview: string | null;
  /** Last activity, ms since the epoch. */
  lastActive: number;
  messages: number;
  pinned: boolean;
  /**
   * Where it was started, when the runtime lists conversations of other origins (absent: through its consumer).
   * Set on every conversation of RuntimeConversations.listOther: a lower-case name ("telegram", "cli"…).
   */
  source?: string;
}

/** (1.19) A scheduled task of an agent (capability `jobs`), as much as a user needs to see: never its prompt. */
export interface RuntimeJob {
  id: string;
  name: string;
  /** How often it runs, as the runtime words it ("every 10m", "0 7 * * *"), or null. */
  schedule: string | null;
  state: 'scheduled' | 'paused' | 'completed' | 'error';
  /** Last run, ms since the epoch, or null (never ran). */
  lastRun: number | null;
  /** How the last run went (null: unknown or never ran). */
  lastStatus: 'ok' | 'failed' | null;
  /** Next run, ms since the epoch, or null. */
  nextRun: number | null;
}

/** A line of a conversation's history, as the consumer shows it (never tool output or internals). */
export type ConversationItem =
  | { kind: 'user'; id: string; ts: number; text: string; images: number }
  | { kind: 'assistant'; id: string; ts: number; text: string }
  /** Tools used; `agents[i]`: agents tool call i handed work to (capability `helpers`), when any did. */
  | { kind: 'tools'; id: string; ts: number; tools: string[]; agents?: string[][] }
  /** A helper's result in a group conversation (`agent` null: unknown). */
  | { kind: 'helper'; id: string; ts: number; agent: string | null; ok: boolean; text: string };

/** A user turn: its text and, with capability `images`, pictures as data: URLs (already checked by the consumer). */
export interface RuntimeMessage {
  text: string;
  images: readonly string[];
}

/** A permission a run waits for (capability `approvals`). */
export interface RunApproval {
  command: string;
  description: string;
  choices: readonly string[];
}

/** One event of a run, in order. The run is over when the stream ends. */
export type RunEvent =
  | { type: 'delta'; delta: string }
  /** The whole text so far (replaces what the deltas built, when longer). */
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; state: 'running' | 'done' | 'failed'; agents?: readonly string[] }
  | { type: 'approval'; approval: RunApproval | null }
  | { type: 'status'; status: 'completed' | 'failed' | 'cancelled' }
  | { type: 'error'; message: string };

/** A run started by RuntimeConversations.send. */
export interface RuntimeRun {
  events: AsyncIterable<RunEvent>;
  /** Capability `stop`. Rejects with status 409 while the run cannot be reached yet. */
  stop?(): Promise<void>;
  /** Capability `approvals`: answers the pending request, once or deny (never wider). Status 409: none. */
  approve?(choice: 'once' | 'deny'): Promise<void>;
}

/** Capability `conversations`. Each call names the agent the conversation lives on. */
export interface RuntimeConversations {
  list(agent: string): Promise<RuntimeConversation[]>;
  /** A new conversation under the consumer's id. */
  create(agent: string, id: string): Promise<RuntimeConversation>;
  /** null: not found. */
  get(agent: string, id: string): Promise<RuntimeConversation | null>;
  /** Capability `organize`: title (blank: the runtime's own) and pin. */
  update?(agent: string, id: string, patch: { title?: string; pinned?: boolean }): Promise<RuntimeConversation>;
  remove(agent: string, id: string): Promise<void>;
  /** Also for a conversation of listOther (capability `otherSources`), with the id it gave. */
  history(agent: string, id: string): Promise<ConversationItem[]>;
  /**
   * (1.19) Capability `otherSources`: conversations of the agent started elsewhere, each with its `source`, most
   * recent first. Read-only for the consumer: it never sends, renames, pins or removes them. Ids are the runtime's
   * own ([A-Za-z0-9][A-Za-z0-9_-]{0,79}), never one of the consumer's.
   */
  listOther?(agent: string): Promise<RuntimeConversation[]>;
  /**
   * (1.19) Capability `readSync`: the consumer's read state of a conversation (one of its own, or of listOther),
   * best effort (the consumer keeps its own unread counts and never waits on this).
   */
  markRead?(agent: string, id: string, read: boolean): Promise<void>;
  /** A turn; `helpers`: those the consumer allowed for it (allowedHelpers). */
  send(agent: string, id: string, message: RuntimeMessage, opts: { helpers: readonly string[] }): RuntimeRun;
}

/** A message an agent posts itself (capability `inbound`), already authenticated by the runtime. */
export interface InboundMessage {
  agent: string;
  /** Its id for deduplication, or null. */
  id: string | null;
  /** A conversation id it names, "main", or null. */
  conversation: string | null;
  text: string;
}

/** The consumer's answer: where it landed (`mirror`: the conversation the runtime may copy it into, or null). */
export type InboundResult = { ok: true; duplicate?: boolean; mirror: string | null } | { ok: false; status: 400 | 403; error: string };

/** Results of helpers that arrive after the lead's turn ended (capability `helpers`). */
export interface RuntimeFollowUp {
  agent: string;
  conversation: string;
  /** Stable per delivery (notification tags). */
  key: string;
  results: { agent: string | null; ok: boolean; text: string }[];
}

export interface AgentRuntime extends ProviderModule {
  readonly features: AgentRuntimeFeatures;
  /** Its agents from its consumer (null: the runtime's own list, if it has one). */
  configure(list: readonly RuntimeAgent[] | null): void;
  /** Its agents now (the runtime may add one, e.g. its main agent). */
  agents(): readonly RuntimeAgent[];
  /** Every agent with whether it answers (cached by the runtime). */
  agentsStatus(): Promise<RuntimeAgentStatus[]>;
  probe(agent: string): Promise<boolean>;
  /** Last known state, without the network. */
  isUp(agent: string): boolean;
  /** A configured agent that answers. */
  usable(agent: string): Promise<boolean>;
  /** One stateless completion: the caller sends the whole context; nothing stays in the runtime. */
  complete(agent: string, messages: { role: 'system' | 'user'; content: string }[], timeoutMs?: number): Promise<string>;
  /** Where an agent's messages go, when the runtime knows (the model's provider), for the privacy line. */
  disclosure?(agent: string): RuntimeText | null;
  conversations?: RuntimeConversations;
  /** (1.19) Capability `jobs`: an agent's scheduled tasks (read-only), most recently run first. */
  jobs?(agent: string): Promise<RuntimeJob[]>;
  /**
   * (1.20) Capability `jobsControl`: pause a task the runtime listed (jobs) for that agent; resolves to the task as
   * it is now. Status 404: not one of the agent's listed tasks.
   */
  pauseJob?(agent: string, id: string): Promise<RuntimeJob>;
  /** (1.20) Capability `jobsControl`: resume a paused task the runtime listed for that agent (as pauseJob). */
  resumeJob?(agent: string, id: string): Promise<RuntimeJob>;
  /** Helpers a lead may really use: those wanted, within its configuration, `up`. null: one it may not use. */
  allowedHelpers?(lead: string, wanted: unknown, up: (agent: string) => boolean): string[] | null;
  /** Who receives what agents post (one consumer; undefined: none). */
  onInbound?(handler: ((m: InboundMessage) => Promise<InboundResult>) | undefined): void;
  /** Who receives helpers' late results (one consumer; undefined: none, and nothing is watched any more). */
  onFollowUp?(handler: ((f: RuntimeFollowUp) => void) | undefined): void;
}
