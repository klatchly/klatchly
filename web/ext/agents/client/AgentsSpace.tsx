import { useSearch } from 'wouter';
import type { SpaceListProps, SpaceMainProps } from '../../../client/src/sdk';
import { AgentsHome, AgentsPane, AutomationsView } from './Agents';
import { ConversationView } from './SpaceView';
import './agents.css';

// The Agents space's chunk: its list and pane (index.tsx names them), with its strings and styles. Loaded when
// the Agents button is pressed (or a link opens the space).

/** A conversation: Klatchly's ("klatchly_…", "beep_…" before 0.26.1) or one started elsewhere, read-only ("ext_…"). */
const SESSION = /^((?:klatchly|beep)_[0-9a-z_]{1,60}|ext_[0-9A-Za-z][0-9A-Za-z_-]{0,79})$/;
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The space's list: its conversations, the open one marked; the home or Automations row while it is shown. */
export function AgentsList({ place, here, ...rest }: SpaceListProps) {
  const session = place && SESSION.test(place) ? place : undefined;
  return <AgentsPane activeID={session} homeActive={here && (place === undefined || place === 'overview')} automationsActive={here && place === 'automations'} {...rest} />;
}

/**
 * The right pane: a conversation (/agents/<id>), a new one (/agents/new?agent=<id>, made on the first message;
 * without an agent, the space's main one; `from`: a conversation started elsewhere whose context it starts with),
 * the scheduled tasks (/agents/automations), else the agents home (/agents on a wide screen, /agents/overview over
 * the list on a phone).
 */
export function AgentsMain({ place }: SpaceMainProps) {
  const search = new URLSearchParams(useSearch());
  const session = place && SESSION.test(place) ? place : undefined;
  if (session) return <ConversationView sessionId={session} />;
  if (place === 'new') {
    const from = search.get('from') ?? '';
    return <ConversationView newAgent={PROFILE.exec(search.get('agent') ?? '')?.[0]} seedFrom={SESSION.test(from) && from.startsWith('ext_') ? from : undefined} />;
  }
  if (place === 'automations') return <AutomationsView />;
  return <AgentsHome />;
}
