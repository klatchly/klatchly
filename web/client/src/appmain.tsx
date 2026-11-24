// First: the interface catalogs, registered before any module of the app reads them.
import './catalogs';
import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { persist, restore } from './persist';
import { retryDelay, shouldRetry } from './retry';
import './styles.css';

// The private entry: the app (App, Shell, the registry and every package's client code) and its stylesheet. Imported
// by the public boot entry (boot.tsx) once signed in, or at launch on a device that was signed in (its code then comes
// from the service worker's cache, alongside the session check). The server serves its files to a session only
// (server/appassets.ts); the boot renders AppRoot into its React root.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Back online, the live socket reconnects and reads again what may have changed (realtime.ts 'ready'): no
      // second refetch of every stale query on screen.
      refetchOnReconnect: false,
      staleTime: 60_000,
      // Prefetched and restored conversations stay until used (persist.ts, prefetch.ts).
      gcTime: 24 * 3600_000,
      // Not again and again when the server says it is busy or down (retry.ts).
      retry: shouldRetry,
      retryDelay,
    },
  },
});

// The stored copy is read alongside the first render, never before it: until it is in (usually a few ms) or the
// session is known, App shows the same splash as index.html. Restored late, it still shows at once if the
// session check is slower; the server copy is never overwritten by it (hydrate keeps the newer data).
const restoring = restore(queryClient);
persist(queryClient);

export interface AppRootProps {
  /** The boot's sign-in or enrolment screen has just signed this device in: go to the page it showed over. */
  signedInNow?: boolean;
}

export function AppRoot({ signedInNow = false }: AppRootProps) {
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let live = true;
    void restoring.then((r) => live && r && setRestored(true));
    return () => {
      live = false;
    };
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <App restored={restored} signedInNow={signedInNow} />
    </QueryClientProvider>
  );
}
