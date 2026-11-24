import { augmentation, definePackage, lazyChunk, space } from '../../../client/src/sdk';
import { launch } from '../locales/launch';
import { agentsPackage, chatAgentModule, agentsSpace } from '../package';
import { AgentsIcon, useAgentsUnread, useChatAgentHere } from './launch';
import './space.css';

// The agents package's client half, on the launch path: the Agents button and the space's routes (shown only while
// the server says the space shows: a runtime that keeps conversations), the slots of the agent inside a chat, and
// its Settings page. Everything else is in two chunks: the space's (list, panes), loaded when the button
// is pressed, and the chat agent's (header chip, panel, drafts, ✨ entry), loaded with a conversation.

const spaceChunk = () => import('./AgentsSpace');
const inChat = () => import('./AgentInChat');
const settingsChunk = () => import('./LlmAgents');
/** A launch string by language code. */
const by = <V,>(f: (m: (typeof launch)[string]) => V) => Object.fromEntries(Object.entries(launch).map(([lang, m]) => [lang, f(m)]));

export default definePackage({
  ...agentsPackage,
  modules: [
    space({
      ...agentsSpace,
      label: by((m) => m.agents),
      badgeLabel: by((m) => m.agentsUnread),
      icon: AgentsIcon,
      useBadge: useAgentsUnread,
      // The agents home and the Automations page over the list, on a phone: a conversation opened from them is a
      // list entry.
      listPlaces: ['overview', 'automations'],
      List: lazyChunk(spaceChunk, 'AgentsList'),
      Main: lazyChunk(spaceChunk, 'AgentsMain'),
    }),
    augmentation({
      id: chatAgentModule.id,
      // "Ask the agent", only in chats where an agent sits.
      composer: { Menu: lazyChunk(inChat, 'AgentMenu'), useAvailable: (chatID) => !!useChatAgentHere(chatID) },
      Header: lazyChunk(inChat, 'AgentHeader'),
      Conversation: lazyChunk(inChat, 'AgentConversation'),
    }),
  ],
  // Settings → Agents (llm): the agents of its runtime on the llm package (made there, offered in chats).
  settings: [{ id: 'llm-agents', title: by((m) => m.llmAgentsTitle), Body: lazyChunk(settingsChunk, 'LlmAgents'), icon: AgentsIcon }],
  // Content-free pings from the server half: what to refetch.
  events: {
    // A message from Hermes, or a turn that started or ended somewhere (another device too).
    'agents.inbound': (_, qc) => void qc.invalidateQueries({ queryKey: ['agents-space'] }),
    'agents.run': (_, qc) => void qc.invalidateQueries({ queryKey: ['agents-space'] }),
    // Settings, drafts or activity of a chat's agent changed.
    chatagent: (f, qc) => {
      if (typeof f.chatID === 'string') void qc.invalidateQueries({ queryKey: ['chatagent', f.chatID] });
    },
  },
});
