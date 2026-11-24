import { useQuery } from '@tanstack/react-query';
import { request } from '../../../client/src/sdk';
import type { OverviewReply } from '../shapes';

// What the launch path needs from the package (index.tsx): the button's mark and its count of accounts in trouble.
// The overview call is the space's own (one GET of the accounts, no chat list): the space reuses its cache.

export const overviewKey = ['networks', 'overview'] as const;

export const overview = () => request<OverviewReply>('GET', '/networks/overview');

/** Two linked rings: accounts joined into one place. */
export function AccountsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="7" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="17" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M9.6 8.6l1.2 5.6M14.4 8.6l-1.2 5.6M10 7h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Accounts in trouble: the count on the button, asked again every 5 minutes while the button is there. The core
 * shows the button only while the package is on: turned off, the polling stops with it; on again, the button
 * asks at once rather than showing the count it had before.
 */
export function useAccountsTrouble(): number {
  return useQuery({ queryKey: overviewKey, queryFn: overview, staleTime: 60_000, refetchInterval: 5 * 60_000, refetchOnMount: 'always' }).data?.trouble ?? 0;
}
