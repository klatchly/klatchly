import type { ChatSources } from '#core/sdk.js';
import type { AccountsSource, AccountStats, RecentChat, StatsResult } from '../shapes.js';
import { addChats, cleanAccount, recentOf } from './derive.js';

// AccountsSource on the core's ModuleContext.chatSources (every connector that is on: its accounts with the
// status it reports, every chat's figures, an account's chat list), handed to the space at start and dropped at
// stop. Answers are kept a moment: the badge, the list and the dashboard ask the same.

const ACCOUNTS_TTL = 15_000;
const STATS_TTL = 60_000;

/** One call in flight at a time, its answer kept for `ttl` (a failure is not kept). */
function cached<T>(ttl: number, load: () => Promise<T>): { get: () => Promise<T>; reset: () => void } {
  let value: { at: number; v: T } | undefined;
  let pending: Promise<T> | undefined;
  let gen = 0;
  return {
    get: () => {
      if (value && Date.now() - value.at < ttl) return Promise.resolve(value.v);
      const mine = gen;
      return (pending ??= load()
        .then((v) => {
          // A reset meanwhile (the package went off): the answer is not kept.
          if (mine === gen) value = { at: Date.now(), v };
          return v;
        })
        .finally(() => {
          if (mine === gen) pending = undefined;
        }));
    },
    reset: () => {
      gen++;
      value = undefined;
      pending = undefined;
    },
  };
}

let sources: ChatSources | undefined;

/** The core's capability, when the space starts; none once it stops. */
export function useSources(s: ChatSources | undefined): void {
  sources = s;
  accounts.reset();
  stats.reset();
}

const need = (): ChatSources => {
  if (!sources) throw new Error('accounts: not started');
  return sources;
};

const accounts = cached(ACCOUNTS_TTL, async () => {
  const r = await need().accounts();
  return { accounts: r.accounts.flatMap((a) => cleanAccount(a) ?? []), sources: r.sources };
});

const stats = cached(STATS_TTL, async (): Promise<StatsResult> => {
  const r = await need().chats();
  const byAccount: Record<string, AccountStats> = {};
  addChats(byAccount, r.chats);
  return { byAccount, complete: r.complete, at: new Date().toISOString() };
});

const lastQR = new Map<string, string>();

export const source: AccountsSource = {
  listAccounts: () => accounts.get(),
  accountStats: () => stats.get(),
  async recentChats(accountID: string, n: number): Promise<RecentChat[]> {
    return recentOf(await need().recentChats(accountID, n), n);
  },
  async loginQR(sourceID: string) {
    const q = await need().loginQR(sourceID);
    // Signed out or back in (and while a sign-in is being confirmed): the accounts are read again, not from the
    // last 15 s.
    if (q && (q.status !== lastQR.get(sourceID) || q.status === 'logged_in')) accounts.reset();
    if (q) lastQR.set(sourceID, q.status);
    return q;
  },
};
