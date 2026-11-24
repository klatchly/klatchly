import type { AugmentationScope, PackageInfo, SpaceInfo } from '#core/extension.js';

// Agents: the instance's agents in Klatchly, over agent runtimes (the core's AgentRuntime contract): Hermes (the hermes
// package's provider) and its own runtime on llm. Which agents: the manifest (KLATCHLY_AGENTS_FILE) and Settings → Agents
// (llm). Two modules: the Agents space (conversations with each agent, group conversations, messages the agents post
// themselves; only with a runtime that keeps conversations) and the agent inside a chat (an agent attached to a
// normal chat writes there, as drafts or directly). What both halves share: the package, the
// space's URLs, the augmentation's id and scope.

export const agentsPackage = {
  id: 'agents',
  // 1.1: the chat agent's privacy line names who its messages go to from KLATCHLY_AGENTS_LABEL (the module's info),
  // no name when unset, instead of a name written in its catalogs.
  // 1.2: the agents manifest (KLATCHLY_AGENTS_FILE, server/manifest.ts): which agents, their label, colour,
  // description, where they are offered, the access and disclosure the host declares (no more guesses from profile
  // names); the chat agent's prompts in English; texts name the agent, not "Hermes".
  // 2.0: no longer requires hermes: agents run on runtimes (the core's AgentRuntime), Hermes or the package's own
  // on llm (agents made in Settings → Agents (llm), or `runtime: "llm"` in the manifest); the Agents space shows only
  // with a runtime that keeps conversations; the space's protocol code moved to the hermes package.
  // 3.0: the space is /agents (was /hermes), its API under /api/agents (was /api/hermes), its file
  // data/agents-space.json (data/hermes.json moved on the first start), its frames agents.*; the old paths are not
  // served (notifications delivered before open the same place: SpaceInfo.formerPaths). The chat agent may send a
  // chat's pictures to an llm agent (an option per chat, off by default).
  // 3.1: the list shows the conversations a runtime started elsewhere (capability otherSources: "ext_…", read-only,
  // with their source; terminal ones only through the filter), one control row (search, Filter: agents, sources,
  // unread only) instead of the agent chips, the scheduled tasks under Automations (capability jobs, read-only),
  // Klatchly's read state told to the runtime (readSync); titles cleaned; the agents home is /agents/overview (was
  // /agents/agents, no longer served).
  // 3.2: a scheduled task can be paused and resumed from Automations (capability jobsControl, extension API 1.20:
  // POST /api/agents/jobs/:id/pause|resume, confirmed in the page, rate-limited); never run, edited or removed.
  version: '3.2.0',
  // 1.20: jobsControl (pauseJob / resumeJob). 1.19: the runtime capabilities otherSources, jobs, readSync. 1.18: SpaceInfo.formerPaths. 1.17: the agent runtime contract and ServerSpace.shown. 1.16: its capability
  // declarations (below).
  klatchly: '^2.0',
  // Its runtimes: hermes (2.0: the AgentRuntime), and llm (1.2) under its own runtime. Never a reason to be off.
  enhances: { hermes: '^2.0', llm: '^1.2' },
  // The manifest (a JSON file, mounted read-only): which agents, and what is shown and said about them. Without it,
  // KLATCHLY_HERMES_AGENTS (the hermes package's) and these two: the name the chat agent writes as (else the user's name
  // in that chat), and where a chat's messages go (every agent's disclosure: one name, or a JSON object by
  // language, English required). KLATCHLY_AGENTS_OWNER_NAME also stands in for a manifest without `owner`.
  optionalConfig: ['KLATCHLY_AGENTS_FILE', 'KLATCHLY_AGENTS_OWNER_NAME', 'KLATCHLY_AGENTS_LABEL'],
  // Capabilities (1.16): its own files in the data volume (conversation state, chat agents, the agents made in
  // Settings) and the manifest; it reaches its runtimes through their providers (hermes's connection, llm's), none
  // of its own.
  files: ['data', 'KLATCHLY_AGENTS_FILE'],
  // First of the spaces in the sidebar, and its chat agent's chip and ✨ section before writing help's.
  order: 40,
} as const satisfies PackageInfo;

/**
 * The space: /agents (its list; on a wide screen the agents home beside it), /agents/<conversation id> (Klatchly's
 * "klatchly_…" ("beep_…" before 0.26.1, still served), or "ext_…" started elsewhere, read-only), /agents/new?agent=<profile>[&from=ext_…] (a conversation made
 * on the first message), /agents/overview (the agents home over the list, on a phone; /agents/agents before 3.1,
 * not served), /agents/automations (the scheduled tasks). It was /hermes before 3.0: only notifications delivered
 * before then still name it (the service worker opens the same place under /agents); nothing is served there.
 */
export const agentsSpace = {
  id: 'agents',
  path: '/agents',
  segment: 'klatchly_[0-9a-z_]{1,60}|beep_[0-9a-z_]{1,60}|ext_[0-9A-Za-z][0-9A-Za-z_-]{0,79}|new|overview|automations',
  formerPaths: ['/hermes'],
} as const satisfies SpaceInfo;

/**
 * The agent inside a chat. 'events': it watches every new message of the chats it sits in (its trigger modes),
 * reads their latest page and writes there in the user's name, through the core's ChatActor.
 */
export const chatAgentModule = { id: 'chatagent', scope: 'events' } as const satisfies { id: string; scope: AugmentationScope };
