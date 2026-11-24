import { useMemo } from 'react';
import { useCatalog, useT as useCoreT } from '../../../client/src/sdk';
import type { Messages } from '../../../client/src/sdk';
import { accountsCatalog, type AccountsMessages } from '../locales/index';

// The space's components read the core strings and their own under `t.accounts`.
export type T = Messages & { accounts: AccountsMessages };

export function useT(): T {
  const t = useCoreT();
  const accounts = useCatalog(accountsCatalog);
  return useMemo(() => ({ ...t, accounts }), [t, accounts]);
}
