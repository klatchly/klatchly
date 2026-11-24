import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { qs, request } from '../../../client/src/sdk';
import type { ChatAgentChoices, ChatAgentState, SpaceSession } from './api';
import { agentsSpace } from '../package';

// What the launch path needs from the package (index.tsx): the Agents button's mark and count, and the chat's
// agent state that tells whether its ✨ section is there. The rest stays in the package's chunks.

/** The calls of the launch path (api.ts has them too, with the chunks' own). */
export const launchApi = {
  spaceSessions: () => request<{ sessions: SpaceSession[]; main: string | null; active: string[]; down: string[] }>('GET', '/agents/sessions'),
  chatAgents: () => request<ChatAgentChoices>('GET', '/chatagent/agents'),
  chatAgent: (chatID: string) => request<ChatAgentState>('GET', `/chatagent/chat${qs({ chatID })}`),
};

export const agentKeys = {
  agents: ['agents-space', 'agents'] as const,
  sessions: ['agents-space', 'sessions'] as const,
};

/** Winged sandal-ish mark for Hermes (abstract: a circle with a wing). */
export function AgentsIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle cx="9" cy="14" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M13 11c2-4 5-6 8-6-1 2-2 3-4 4 1 0 2 0 3-.5-1 2-3 3-5 3.5M13.5 13c1.5-.2 3-.7 4-1.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Agent conversations with something unread (not the one on screen): the count on the Agents button. Only Klatchly's:
 * a conversation started elsewhere (read-only) shows its count in the list, not on the button.
 */
export function useAgentsUnread(): number {
  const [path] = useLocation();
  const open = path.startsWith(`${agentsSpace.path}/`) ? path.slice(agentsSpace.path.length + 1) : undefined;
  const q = useQuery({ queryKey: agentKeys.sessions, queryFn: launchApi.spaceSessions, staleTime: 10_000 });
  return (q.data?.sessions ?? []).filter((x) => x.unread > 0 && !x.readOnly && x.id !== open).length;
}

/** The agent state of a chat (settings, drafts, recent activity). */
export function useChatAgent(chatID: string): ChatAgentState | undefined {
  return useQuery({ queryKey: ['chatagent', chatID], queryFn: () => launchApi.chatAgent(chatID), staleTime: 30_000 }).data;
}

export function useAgentChoices(enabled: boolean) {
  return useQuery({ queryKey: ['chatagent', '#agents'], queryFn: launchApi.chatAgents, enabled, staleTime: 60_000 }).data;
}

/** Display name of an agent (profile name until the list is loaded). */
export function useAgentLabel(agent: string | undefined): string | undefined {
  const choices = useAgentChoices(!!agent);
  return agent ? (choices?.agents.find((a) => a.name === agent)?.label ?? agent) : undefined;
}

/** The chat's agent, when one sits in it: its display name. */
export function useChatAgentHere(chatID: string): { label: string } | undefined {
  const st = useChatAgent(chatID);
  const cfg = st?.config?.enabled ? st.config : null;
  const label = useAgentLabel(cfg?.agent);
  return cfg ? { label: label ?? cfg.agent } : undefined;
}
