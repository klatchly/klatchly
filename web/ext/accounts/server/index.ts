import { definePackage, space } from '#core/sdk.js';
import { accountsPackage, networksSpace } from '../package.js';
import { accountsAbout } from '../locales/index.js';
import { accountsRoutes } from './routes.js';
import { source, useSources } from './source.js';

// The accounts package's server half: the Accounts space's read-only API at /api/networks/*, on what the core
// lets it read of the chat sources (ModuleContext.chatSources, which it declares). No config: on whenever it is
// built in, with whatever connectors are on.

export default definePackage({
  ...accountsPackage,
  about: accountsAbout,
  modules: [
    space({
      ...networksSpace,
      chatSources: true,
      routes: accountsRoutes(source),
      logPath: (p) => p.replace(/^\/api\/networks\/account\/[^/]+/, '/api/networks/account/:id'),
      start: (ctx) => useSources(ctx.chatSources),
      stop: () => useSources(undefined),
    }),
  ],
});
