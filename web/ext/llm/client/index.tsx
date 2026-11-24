import { definePackage, lazyChunk } from '../../../client/src/sdk';
import { launch, type LlmLaunch } from '../locales/launch';
import { llmPackage } from '../package';

// LLM's client half, on the launch path: no module of its own (a provider is server-only), its two Settings pages
// (lazy, from the Llm chunk) and their titles.

const load = () => import('./Llm');
const by = (f: (m: LlmLaunch) => string) => Object.fromEntries(Object.entries(launch).map(([lang, m]) => [lang, f(m)]));

export default definePackage({
  ...llmPackage,
  modules: [],
  settings: [
    { id: 'providers', title: by((m) => m.providersTitle), Body: lazyChunk(load, 'Providers'), icon: ProvidersIcon },
    { id: 'models', title: by((m) => m.routesTitle), Body: lazyChunk(load, 'DefaultModels'), icon: ModelsIcon },
  ],
});

/** Its Settings entry (Providers): a plug. */
function ProvidersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M9 3v4M15 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Its Settings entry (Default models): a spark, as before on writing's page. */
function ModelsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
