import type { PackageInfo, SpaceInfo } from '#core/extension.js';

// The example package: a small, working reference for package authors. Copy this folder to ext/<your id>/, rename
// the ids, and keep the shape. It is not in the owner's list (ext/packages.json); build it in with
// KLATCHLY_PACKAGES=beeper,example (or add "example" to your own list). Its own tests run with `npm test` either way.
//
// A package is a folder with:
//   package.ts         this file: what BOTH halves share (plain data, types only from the core's pure modules);
//   server/index.ts    its server half (definePackage from '#core/sdk.js', the ONLY core import of server code);
//   client/index.tsx   its client half, optional (definePackage from client/src/sdk.ts, the ONLY core import of
//                      client code); it is on the launch path, so it stays tiny and loads the rest lazily;
//   locales/           its strings, one file per language (en.ts is the reference, fr.ts must match it);
//   test/              its unit tests (*.test.ts, run by `npm test`) and end-to-end scripts (*.e2e.cjs).
//
// What it shows: a space (a sidebar button, a page, one server route), an 'on-demand' augmentation (an entry of the
// composer's ✨ menu that counts the draft's words in the browser), a Settings page (one preference, kept by the
// server in the data volume), two languages. test/boundary.test.ts checks the rules on every folder of ext/.

export const examplePackage = {
  // Lower-case, also its folder name and its URL namespace in Settings (/settings/ext/example/…).
  id: 'example',
  // Its own version (x.y.z): bump the major when what other packages use of it (an api.ts) changes.
  version: '1.0.0',
  // The extension API versions it works with (server/extension.ts EXTENSION_API): 1.15 brought client/src/sdk.ts,
  // 1.16 the capability declarations (network / listen / files / spawns, below).
  // Out of range, the package stays off with the reason in Settings → Extensions; the rest of the app starts.
  klatchly: '^2.0',
  // Environment variables it reads: `config` for those it needs (off while one is unset), `optionalConfig` for
  // those with a default. Every process.env read in the package must be declared here (boundary test).
  config: [],
  optionalConfig: ['KLATCHLY_EXAMPLE_GREETING'],
  // Capabilities (1.16): one file of its own in the data volume (example.json); no connection, no listener, no
  // program. A package that connects somewhere names the variable holding the address: network: ['KLATCHLY_X_URL'].
  files: ['data'],
  // Where its button, ✨ section and Settings page go among the other packages' (lower first, then by id).
  order: 90,
} as const satisfies PackageInfo;

/**
 * The space's URLs, shared by the server (the page it serves, notification targets) and the client (routing):
 * the sidebar button is `open-example`, its colour class `sec-example`, its API /api/example/. No `segment`: the
 * space has its home page only (a `segment` pattern would add /example/<place> pages).
 */
export const exampleSpace = {
  id: 'example',
  path: '/example',
} as const satisfies SpaceInfo;

/** The augmentation's module id (unique among augmentations; it has no routes of its own). */
export const exampleWords = { id: 'example-words', scope: 'on-demand' } as const;

/** Its Settings page: one URL segment, written as a literal in client/index.tsx too (the boundary test reads it). */
export const EXAMPLE_SETTINGS = 'prefs';
