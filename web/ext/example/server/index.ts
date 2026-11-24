import { augmentation, definePackage, space, type ModuleInfo } from '#core/sdk.js';
import { exampleAbout } from '../locales/index.js';
import { examplePackage, exampleSpace, exampleWords } from '../package.js';
import { exampleRoutes, greeting, started, stopped } from './routes.js';

// The example package's server half: what the registry (server/registry.ts) needs to know of it. Server code
// imports the core through '#core/sdk.js' only (server/sdk.ts lists what is there); Node's modules and the app's
// dependencies (hono…) are fine. The default export is the package; ext/packages.server.ts imports it when the
// package is listed (scripts/compose-packages.mjs writes that file from the list). package.ts is spread in first,
// and no field of it is written again here (the boundary test checks both halves).

export default definePackage({
  ...examplePackage,
  about: exampleAbout,
  modules: [
    // A space: its page /example is served (the client routes it), its API is /api/example/*.
    space({
      ...exampleSpace,
      routes: exampleRoutes,
      // Values the client half may read (GET /api/extensions, useModuleInfo): public, never a secret.
      info: (): ModuleInfo => {
        const g = greeting();
        return g ? { greeting: g } : {};
      },
      // start/stop: called when the package goes on (startup, or turned on in Settings → Extensions) and off.
      // stop() must leave nothing running (timers, sockets, listeners): ext/build.test.ts checks every package.
      start: () => started(),
      stop: () => stopped(),
    }),
    // An augmentation: actions inside conversations (its UI is the client half's ✨ section). 'on-demand' means it
    // only sees what the user hands it, and Settings → Extensions says so; this one even counts in the browser and
    // never calls the server. An 'events' augmentation (every new message) is a heavier promise: avoid it.
    augmentation({ ...exampleWords }),
  ],
});
