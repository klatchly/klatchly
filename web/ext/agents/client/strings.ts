import { useMemo } from 'react';
import { localized, useCatalog, useT as useCoreT } from '../../../client/src/sdk';
import type { Messages } from '../../../client/src/sdk';
import { agentsCatalog, type AgentsMessages } from '../locales/index';

// The package's components read the core strings and their own (`t.agentSpace`, `t.chatAgent`), as when they were
// one catalog.
export type T = Messages & AgentsMessages;

export function useT(): T {
  const t = useCoreT();
  const own = useCatalog(agentsCatalog);
  return useMemo(() => ({ ...t, ...own }), [t, own]);
}

/** Outside React (a toast line built in a promise): the current language's strings. */
export const agentsT = (): AgentsMessages => localized(agentsCatalog);
