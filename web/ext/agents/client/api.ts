import { qs, request } from '../../../client/src/sdk';
import { launchApi } from './launch';

// The agents package's calls: the Agents space (/api/agents/*, server/space.ts) and the agent inside a chat
// (/api/chatagent/*, server/chatagent.ts). Same paths as when they were the core's.

// The Agents space (server/space.ts).
export interface SpaceSession {
  id: string;
  /** Hermes profile (agent) the conversation lives on. */
  agent: string;
  title: string | null;
  preview: string | null;
  own: boolean;
  lastActive: number;
  messages: number;
  pinned: boolean;
  unread: number;
  helpers: string[];
  /** Receives the messages its agent posts itself (e.g. scheduled recaps and alerts). */
  inbox: boolean;
  /** Where it was started ("telegram", "cli"…); absent: in Klatchly. */
  source?: string;
  /** Started elsewhere: read here, never written to (the server refuses). */
  readOnly?: true;
}
/** A scheduled task of an agent (GET /agents/jobs); `controllable`: it can be paused and resumed here (agents 3.2). */
export interface SpaceJob {
  agent: string;
  id: string;
  name: string;
  schedule: string | null;
  state: 'scheduled' | 'paused' | 'completed' | 'error';
  lastRun: number | null;
  lastStatus: 'ok' | 'failed' | null;
  nextRun: number | null;
  controllable?: boolean;
}
/** A text of the manifest by language code (locales textIn picks one). */
export type LocalText = Readonly<Record<string, string>>;
/** What an agent's runtime can do in the space (the core's AgentRuntime features): what the space offers. */
export interface AgentFeatures {
  stop: boolean;
  images: boolean;
  organize: boolean;
  helpers: boolean;
  approvals: boolean;
}
export interface SpaceAgent {
  name: string;
  features: AgentFeatures;
  label: string;
  description: LocalText | null;
  /** "#rrggbb" from the manifest, or null: picked from the name (agentColor). */
  color: string | null;
  helpers: string[];
  available: boolean;
}
export type SpaceItem =
  | { kind: 'user'; id: string; ts: number; text: string; images: number }
  | { kind: 'assistant'; id: string; ts: number; text: string }
  /** `agents[i]`: profiles tool call i delegated to (delegate_task in a group conversation). */
  | { kind: 'tools'; id: string; ts: number; tools: string[]; agents?: string[][] }
  | { kind: 'inbound'; id: string; ts: number; text: string }
  /** A helper agent's result in a group conversation (`agent` null: unknown profile). */
  | { kind: 'helper'; id: string; ts: number; agent: string | null; ok: boolean; text: string };

// The agent inside a chat (server/chatagent.ts).
export type AgentTrigger = 'me' | 'mention' | 'auto' | 'always';
export type AgentSendMode = 'draft' | 'direct';
export type AgentCause = AgentTrigger | 'ask';
export interface ChatAgentConfig {
  enabled: boolean;
  agent: string;
  trigger: AgentTrigger;
  send: AgentSendMode;
  disclose: boolean;
  handle: string;
  cooldownSec: number;
  dailyCap: number;
  notes: string;
  /** The pictures among the last messages go too (llm agents only; off by default). */
  images: boolean;
  updatedAt: number;
}
export interface ChatAgentDraft {
  id: string;
  chatID: string;
  agent: string;
  label: string;
  text: string;
  cause: AgentCause;
  replyTo?: string;
  createdAt: number;
}
export interface ChatAgentAudit {
  at: number;
  kind: 'trigger' | 'skip' | 'draft' | 'sent' | 'discarded' | 'limited' | 'error' | 'settings';
  cause?: AgentCause;
  agent?: string;
  detail?: string;
  text?: string;
}
export interface ChatAgentState {
  supported: boolean;
  config: ChatAgentConfig | null;
  drafts: ChatAgentDraft[];
  audit: ChatAgentAudit[];
  usage: { today: number; cap: number | null; cooldownLeft: number };
}
export interface ChatAgentChoice {
  name: string;
  label: string;
  description: LocalText | null;
  available: boolean;
  /** What the host declares it can reach; null: not declared (shown as the strongest). */
  access: 'limited' | 'extended' | 'full' | null;
  accessNote: LocalText | null;
  /** Where a chat's messages go when it is called (the privacy line); null: not said. */
  disclosure: LocalText | null;
  limited: boolean;
  /** Its runtime has no tools: "limited" is guaranteed by Klatchly, not only declared. */
  guaranteed?: boolean;
  /** The images option is offered (an agent of the llm runtime). */
  pictures?: boolean;
  handle: string;
}

/** An agent of the llm runtime (Settings → Agents (llm)): made there, or the manifest's (read-only). */
export interface LlmAgentRow {
  id: string;
  label: string;
  color: string | null;
  description: string | null;
  instructions: string;
  source: 'settings' | 'manifest';
  /** Who answers (the provider of its model in Settings → Default models), for the privacy line. */
  disclosure: LocalText | null;
}
export interface LlmAgentsReply {
  llm: boolean;
  ready: boolean;
  max: number;
  maxInstructions: number;
  agents: LlmAgentRow[];
}
export type LlmAgentFields = { label: string; color: string | null; description: string | null; instructions: string };

/** GET /chatagent/agents: the agents offered in chats, the one first offered, how many messages go at each call. */
export interface ChatAgentChoices {
  default: string | null;
  contextLines: number;
  /** With the images option: at most how many pictures go at each call. */
  maxPictures?: number;
  agents: ChatAgentChoice[];
}

const enc = encodeURIComponent;

export const api = {
  ...launchApi,
  /** `main`: the agent a new conversation is made with when none is named. */
  spaceAgents: () => request<{ agents: SpaceAgent[]; main: string | null }>('GET', '/agents/agents'),
  spaceCreate: (agent?: string) => request<{ session: SpaceSession }>('POST', '/agents/sessions', agent ? { agent } : {}),
  spacePatch: (id: string, patch: { title?: string; pinned?: boolean }) => request<{ session: SpaceSession }>('PATCH', `/agents/sessions/${enc(id)}`, patch),
  spaceSetHelpers: (id: string, helpers: string[]) => request<{ helpers: string[] }>('PUT', `/agents/sessions/${enc(id)}/helpers`, { helpers }),
  spaceDelete: (id: string) => request<{ ok: true }>('DELETE', `/agents/sessions/${enc(id)}`),
  spaceReadAll: (agent?: string) => request<{ marked: number }>('POST', '/agents/sessions/read', agent ? { agent } : {}),
  spaceMessages: (id: string) =>
    request<{ items: SpaceItem[]; run: string | null; agent: string; helpers: string[]; readOnly?: boolean; source?: string | null }>('GET', `/agents/sessions/${enc(id)}/messages`),
  spaceJobs: () => request<{ jobs: SpaceJob[] }>('GET', '/agents/jobs'),
  /** Pause or resume one task of `agent` (capability jobsControl): the task as it is now. */
  spaceJobControl: (agent: string, id: string, action: 'pause' | 'resume') => request<{ job: SpaceJob }>('POST', `/agents/jobs/${enc(id)}/${action}`, { agent }),
  spaceSend: (id: string, text: string, images: string[]) =>
    request<{ run: string }>('POST', `/agents/sessions/${enc(id)}/messages`, images.length ? { text, images } : { text }),
  spaceStop: (run: string) => request<{ ok: true }>('POST', `/agents/runs/${enc(run)}/stop`, {}),
  spaceApproval: (run: string, choice: 'once' | 'deny') => request<{ ok: true }>('POST', `/agents/runs/${enc(run)}/approval`, { choice }),
  setChatAgent: (chatID: string, patch: Partial<Omit<ChatAgentConfig, 'updatedAt'>>) =>
    request<{ config: ChatAgentConfig }>('PUT', '/chatagent/chat', { chatID, ...patch }),
  removeChatAgent: (chatID: string) => request<{ ok: true }>('DELETE', `/chatagent/chat${qs({ chatID })}`),
  askChatAgent: (chatID: string, instruction?: string) =>
    request<{ status: 'draft' | 'sent' | 'skipped'; draft?: ChatAgentDraft }>('POST', '/chatagent/ask', instruction ? { chatID, instruction } : { chatID }),
  sendAgentDraft: (id: string) => request<{ ok: true }>('POST', `/chatagent/drafts/${enc(id)}/send`, {}),
  llmAgents: () => request<LlmAgentsReply>('GET', '/chatagent/llm-agents'),
  addLlmAgent: (f: LlmAgentFields) => request<{ agent: LlmAgentRow }>('POST', '/chatagent/llm-agents', f),
  saveLlmAgent: (id: string, f: Partial<LlmAgentFields>) => request<{ agent: LlmAgentRow }>('PUT', `/chatagent/llm-agents/${enc(id)}`, f),
  removeLlmAgent: (id: string) => request<{ ok: true }>('DELETE', `/chatagent/llm-agents/${enc(id)}`),
  dropAgentDraft: (id: string, edited = false) => request<{ ok: true }>('DELETE', `/chatagent/drafts/${enc(id)}${edited ? '?edited=1' : ''}`),
};
