// LLM's strings on the launch path (client/index.tsx): the titles of its Settings pages, shown in the menu before
// its chunk loads. By language code, English the fallback; fr has the keys of en.

export interface LlmLaunch {
  /** Settings → Providers (where the models are, with which key). */
  providersTitle: string;
  /** Settings → Default models (which model each feature calls). */
  routesTitle: string;
}

export const launch: Readonly<Record<string, LlmLaunch>> = {
  en: { providersTitle: 'Providers', routesTitle: 'Default models' },
  fr: { providersTitle: 'Fournisseurs', routesTitle: 'Modèles par défaut' },
};
