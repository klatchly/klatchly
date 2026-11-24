import { request } from '../../../client/src/sdk';
import type { ExamplePrefs, HelloReply } from '../shapes';

// The package's calls to its own routes (server/routes.ts). request() adds the session cookie and the CSRF header,
// prefixes /api, and throws an HttpError on a refusal. The reply types are shared with the server (../shapes.ts).

export const exampleApi = {
  hello: () => request<HelloReply>('GET', '/example/hello'),
  prefs: () => request<ExamplePrefs>('GET', '/example/prefs'),
  setPrefs: (p: ExamplePrefs) => request<ExamplePrefs>('PUT', '/example/prefs', p),
};

/** React Query keys of the package: namespaced by its id, so they never meet the core's or another package's. */
export const keys = {
  hello: ['example', 'hello'] as const,
  prefs: ['example', 'prefs'] as const,
};
