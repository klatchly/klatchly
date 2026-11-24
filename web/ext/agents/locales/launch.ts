// The agents package's strings on the launch path (client/index.tsx): the sidebar button, shown by the core
// before the package's chunk loads, and its Settings page's title. By language code, English the fallback; fr has the keys of en.

export interface AgentsLaunch {
  /** The Agents button's label, and the same with the count of unread conversations. */
  agents: string;
  agentsUnread: (n: number) => string;
  /** The title of its Settings page (Settings → Agents (llm)). */
  llmAgentsTitle: string;
}

const plural = (lang: string, n: number, one: string, other: string) => (new Intl.PluralRules(lang).select(n) === 'one' ? one : other);

export const launch: Readonly<Record<string, AgentsLaunch>> = {
  en: {
    agents: 'Agents',
    agentsUnread: (n: number) => plural('en', n, `Agents: ${n} unread conversation`, `Agents: ${n} unread conversations`),
    llmAgentsTitle: 'Agents (LLM)',
  },
  fr: {
    agents: 'Agents',
    agentsUnread: (n: number) => plural('fr', n, `Agents : ${n} conversation non lue`, `Agents : ${n} conversations non lues`),
    llmAgentsTitle: 'Agents (LLM)',
  },
};
