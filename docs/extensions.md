# Writing a Klatchly package

This guide is for people who write a **package**: a feature plugged into Klatchly at build time, from its own
folder, without touching the core. It covers what a package is, the security model, the rules the tests hold
every package to, configuration, strings, Settings pages, tests, how a package gets into an image, and versions.
It ends with a walkthrough that builds a tiny package.

The API reference and the changelog of the extension API are in [extension-api.md](extension-api.md). The
reference package is [`web/ext/example/`](../web/ext/example/): every snippet below comes from it unless said
otherwise. Read its files alongside this guide; they are commented for authors.

Paths are relative to `web/` unless they start with `docs/` or the repository root.

## 1. What a package is

A package is a folder `ext/<id>/`:

| File | What it holds |
|---|---|
| `package.ts` | What both halves share: id, version, the extension API range it accepts, dependencies, configuration, capabilities, order. Plain data. |
| `server/index.ts` | Its **server half**: the default export, `definePackage({ … })` from `#core/sdk.js`. Required. |
| `client/index.tsx` | Its **client half**, optional: the default export, `definePackage({ … })` from `client/src/sdk.ts`. |
| `locales/` | Its strings, one file per language (`en.ts` is the reference), an `index.ts` that lists them, and `launch.ts` for the few strings shown before its chunk loads. |
| `api.ts` | Optional: its **public entry**, the types other packages may import (a provider's API). |
| `test/` | Its unit tests (`*.test.ts`), its end-to-end scripts (`*.e2e.cjs`), and, if it talks to a service, its offline fake (`offline.mjs`) and whole-build configuration (`build-env.ts`). |

The id matches `[a-z][a-z0-9-]{0,31}` and is also the folder name.

Nothing is loaded at run time. Two generated files, `ext/packages.server.ts` and `ext/packages.client.ts`, import
the packages of the build; they are the only files of `ext/` the core imports. `scripts/compose-packages.mjs`
writes them from a list of ids (section 8), and `npm run typecheck`, `npm test` and `npm run build` run it first.

### Modules

A package holds one or more **modules**, each of one of four types (`server/registry.ts`,
`client/src/extension.ts`):

| Type | What it does | What it gets from the core |
|---|---|---|
| **space** | A separate area of the app: a button in the section tabs, its list and pane, its URLs, its routes under `/api/<id>/`. | `ctx.chatSources` (accounts and chat figures of every source, no content), only if it declares `chatSources: true`; `ctx.sender` (plain text messages sent in the user's name, the composer's way), only if it declares `sends: true` (1.24). It may have a device API, `bearerRoutes` (1.24, below). |
| **connector** | A chat source: accounts, chats, messages, sending, media… (contract: `ConnectorShape`, `server/connector.ts`). No connector is privileged: each declares the chats (`owns`) and accounts (`ownsAccount`) that are its own (below). | `ctx.feed`: its events into the badge, the notifications and the browsers. |
| **augmentation** | Actions inside conversations: a section of the composer's ✨ menu, the message menu, slots in the conversation. Declares its `scope`: `'on-demand'` or `'events'`. | `ctx.chats` (reads of what the user acts on); for `'events'` only, its stream of new messages (`onEvent`) and `ctx.actor` (sending in the user's name). |
| **provider** | A server-side service other packages use (an LLM, an agent runtime). Server only. Its type is its package's `api.ts`, or a core contract several packages implement (`AgentRuntime`, since 1.17). | `ctx.listen`: a listener of its own. Others find it with `ctx.provider(id)`. |

A module's lifecycle is the same for every type. `check()` (optional) runs once when the registry is built at
startup and can keep the whole package off with a reason. `start(ctx)` runs when the package goes on: at startup,
and again each time it is turned back on in Settings → Extensions. `stop()` runs when it goes off or the app stops,
and **must leave nothing running** (timers, sockets, subscriptions): `ext/build.test.ts` turns every package of the
build off and on twice and compares the process's active resources.

The registry starts providers, then connectors, then spaces and augmentations, each after what it requires or
enhances. At least one connector must be on (any one), or the server refuses to start.

### Connectors

Every connector adapts its network to the canonical model of `server/connector.ts` (the Desktop API's shapes:
`Chat`, `Message`, `Account`…), and none is special (since API 1.25):

- **Ownership.** `owns(chatID)` and `ownsAccount(accountID)` say which chats and accounts are its own; ids never
  overlap between connectors. `ownsAccount` must stay stable while its upstream is down (e.g. the accounts it listed,
  kept in the data volume), so per-account settings keep resolving. One that learns its accounts from its upstream
  says so with `accountsPending()` until it first has (e.g. a first start, no file yet): meanwhile the account ids
  no connector claims are its own. A chat or account no connector claims answers 404; one of a connector that is
  off too. A connector without `owns` is a deprecated legacy catch-all (at most one
  per build): it still gets the chat and account ids no other connector claims, for routing only, and nothing else.
- **Unscoped routes.** `/api/media` and `/api/thumb` ask each connector's `media.parse` with exactly its
  `media.params` (a reference none accepts: 400). `/api/upload` without a chat goes to the one connector on with a
  plain `upload` (several: 400 `chat_required`, the browser names the chat; none: 409); an upload ID from before a
  restart fits that connector's chats only. `POST /api/inbox/low-priority/read-all` asks every connector on that has
  `readAllLowPriority` (or its `receipts` version), one after the other, and adds up their counts.
- **What moved into the connector.** What used to be one source's behaviour by default is declared by the connector
  that has it: client side, `ConnectorTraits.mediaQuery` (its media references relayed by `/api/media`), `thumb`,
  `lowPriority`, `fullDelivery` (absent: cached delivery ticks are kept for its chats), `displaysMarkdown`; server
  side, `longReactionKey` (reaction keys over 64 characters, e.g. an image reaction's media URI). A chat that no
  connector UI claims gets none of these: no low-priority inbox, no relayed media, no cached ticks. The low-priority
  tab shows while a connector that keeps that inbox is on (turned off in Settings → Extensions, the tab goes).
- **Reads under load (since API 1.26).** The relay shares identical concurrent reads (the chat list, searches, a
  chat, its messages, one message): one connector call for every browser request asking the same thing, and the
  first page of a chat list is kept a second (forgotten on any write and any source event, errors never kept). A
  connector passes `upstreamSignal()` (from `#core/sdk.js`) to its upstream calls for those reads: it is aborted once
  every browser request waiting on the read has gone, so a slow upstream is not left with work nobody reads. Never
  for writes (a send must not be cut halfway). `unreadChats()` serves both the badge's recount (on `'ready'`, at most
  every 5 minutes) and the accounts page's figures: a source whose list is costly may share one read between them
  for a short while. `LiveSession.ping` should tolerate one late answer.
- **Conventions of the canonical model kept by the core.** They are the contract's own encoding, so a connector
  converts to them, and they do nothing for one that never produces them: mentions as
  `[Name](https://matrix.to/#/<participant id>)` in `Outgoing.text` (offered only where the chat's capabilities
  allow user links, or list none), rich text as HTML (`server/richtext.ts`), a `senderName` that is missing or a raw
  `@local:server` id meaning "unknown" (`server/names.ts`), empty `capabilities` meaning "no restrictions known",
  and the `org.matrix.msc3245.voice` capability key for voice notes.

### Server half

From `ext/example/server/index.ts`:

```ts
import { augmentation, definePackage, space, type ModuleInfo } from '#core/sdk.js';
import { exampleAbout } from '../locales/index.js';
import { examplePackage, exampleSpace, exampleWords } from '../package.js';
import { exampleRoutes, greeting, started, stopped } from './routes.js';

export default definePackage({
  ...examplePackage,
  about: exampleAbout,
  modules: [
    space({
      ...exampleSpace,
      routes: exampleRoutes,
      info: (): ModuleInfo => {
        const g = greeting();
        return g ? { greeting: g } : {};
      },
      start: () => started(),
      stop: () => stopped(),
    }),
    augmentation({ ...exampleWords }),
  ],
});
```

A module's `routes` (a `Hono<Env>`) are mounted at `/api/<module id>/`, after the core's routes, behind the
session and the origin check, and answer only while the package is on (404 otherwise). `info()` publishes public
values for the client half in `GET /api/extensions` (anyone signed in reads them: never a secret).

### Client half

`client/index.tsx` is on the app's **launch path**: every listed package's entry is in the main bundle. It holds
only what the shell needs before the package's own chunk arrives (ids and URLs from `package.ts`, labels, icons)
and lazy components for the core's slots. From `ext/example/client/index.tsx`:

```tsx
const load = () => import('./Example');

export default definePackage({
  ...examplePackage,
  modules: [
    space({
      ...exampleSpace,
      label: by((m) => m.label),
      icon: ExampleIcon,
      List: lazyChunk(load, 'ExampleList'),
      Main: lazyChunk(load, 'ExampleMain'),
    }),
    augmentation({
      id: exampleWords.id,
      composer: {
        Menu: lazyChunk(load, 'ExampleMenu'),
        hint: () => by((m) => m.hint),
      },
    }),
  ],
  settings: [{ id: 'prefs', title: by((m) => m.settings), Body: lazyChunk(load, 'ExampleSettings'), icon: ExampleIcon }],
});
```

The client shows a module only while the server says its package is on. A space whose URLs differ between the two
halves stays off, and so does one whose server half says it does not show now (`ServerSpace.shown`, since 1.17: the
Agents space without a runtime that keeps conversations). A provider has no client module (it may still have Settings pages, as `llm` does).

The client slots, in short (details in [extension-api.md](extension-api.md)):

- a **space**: `List` (left column; the page itself on a phone), `Main` (right pane: its home or one of its
  places), optional `Controller` (mounted beside the panes from the first visit), `useBadge` and `badgeLabel` (a
  count on its button), `listPlaces`, `button: false` (no button, since 1.14);
- an **augmentation**: `composer` (`Menu`, the ✨ section; `Tools`, mounted beside ✨; `useAvailable(chatID)`;
  `hint`; `inEdit`), `Header`, `Conversation` (mounted per chat above the composer), `message` (`Actions` in the
  hover row, `Below` under the text, `Menu` entries of the message menu), `audioMenu` (since 1.23: its `Menu` also in
  the menu of a voice note or another audio attachment, `MessageMenuSlotProps.audio` its index);
- a **connector's UI side** (`ConnectorUI`): its networks' names and mark, which chats are its own, and traits of
  its chats and media; since 2.1, entries of its own in the core's UI: `newChat` (in New chat, for some of its
  accounts), `links` (links in messages it opens in the app, with a dialog) and `chatActions` (entries in the menu of
  its chats, each with a dialog);
- **frames**: `ClientPackage.events`, by frame type, what to refresh when the server half calls
  `ctx.toBrowsers({ type: '<module id>' | '<module id>.<x>', … })`. A frame is a content-free ping ("this changed,
  refetch"); any other type is dropped and logged.

### Settings pages

Any package can add pages to Settings (`ClientPackage.settings`, one `SettingsSection` per page). The core's
entries always come first; the packages' pages go below, grouped under the package's name (`about.name`), packages
by `order` then id, pages in the order of the array.

- URL: `/settings/ext/<package id>/<page id>`. The page id is one segment, `[a-z][a-z0-9-]{0,39}`, unique in the
  package, and **written as a literal** in `client/index.tsx` (the boundary test reads it). A page can never hide a
  core page or another package's.
- Test ids: the menu entry is `settings-item-<package id>-<page id>`, the page `settings-<page id>`.
- `title` (by language) and `icon` (an inline 20 px SVG in `currentColor`; a generic one without) are on the
  launch path. `Body` is lazy, loaded when the page opens; it can reuse the core's rows (`.set-row`, `.set-text`,
  `.set-label`, `.set-control`).
- **Sub-places** (since 1.14): `segment` is a pattern a sub must match in full
  (`/settings/ext/<package>/<page>/<sub>`; the core also limits a sub to `[A-Za-z0-9_-]{1,600}`). `Body` gets
  `SettingsBodyProps.sub`. A sub that does not match is replaced by the page itself.
- **Badges** (since 1.14): `useBadge()` returns a count shown on the menu entry; while it is not zero, the Settings
  button shows a dot.
- Only pages of packages that are on are listed. A package turned off leaves the menu at once, and its open page
  gives way to the menu.
- **Sensitive settings** (a key, where data goes): guard the server route with the sdk's `requireStepUp` (403
  `{ error: 'step_up' }` without a recent sign-in or confirmation) and show the core's confirmation box on the page
  (`useStepUp`, `StepUpBox`, `isStepUpError` from `client/src/sdk.ts`).

## 2. Security model

Read this before installing a package, and state it in your package's README.

- The Klatchly server holds the Beeper token (the account's Matrix token: every message, every network) and the
  sign-in state (`/data/state.json`: passkeys, sessions). **A package's server half runs in that process, with
  those rights.** Installing a package means trusting it as much as the core.
- The client half runs in the page with the user's session: it can call the whole API.
- The guard rails (`#core/sdk.js` only, `ctx.chats` limited to declared fields, an augmentation's `scope`, a log
  line for every read, capability declarations) constrain an **honest** package and make its access visible. They
  are **not a sandbox**: nothing stops Node code from importing `node:fs` or calling `fetch` in a way the scan does
  not see.
- What Settings → Extensions shows is what the package **declares**. The declarations are checked against the code
  by `test/boundary.test.ts` when the test suite runs on that tree. The Docker image build runs `typecheck` and
  `build` only, not the tests: run `npm test` on your build's tree (section 7) before building the image.

A space's **device API** (`bearerRoutes`, API 1.24) is the one way in that is not the browser session: the core
mounts it at `/api/bearer/<space id>/`, before the origin check and the session guard, for callers such as an iOS
Shortcut. There the core never reads the session cookie (`c.get('session')` is undefined), refuses a request without
an `Authorization: Bearer <token>` header of a sane form (400 `bad_token`), caps the body at 64 KB, answers 404 while
the package is off, and answers 404 to any other path under `/api/bearer/`, so that a request with a Bearer header
never reaches a cookie route; the cookie routes never read that header. Everything else is the package's: issue its
own tokens (only after a step-up, shown once, kept hashed), compare them in constant time, limit the rate per token and
per address for refused tokens only (a global cap over every request would let junk from many addresses lock the
owner out), keep the scope minimal, answer a bad token with 400 (never 401/403: the reverse proxy's ban rules
count those), log each action without content. Settings → Extensions says that a package has one (`bearer`) and that
it sends (`sends`). `web/test/bearer.test.ts` shows what the core enforces.

Signed out, every space page is a 302 to `/`, except the home of a space that declares `signedOutPage: true` (API
1.24): that one opens the app's shell, which signs in and then shows the page with its query. The core decides from
the build's declarations alone (no module code runs for an anonymous visitor). Use it only for a page whose query
carries what the user brought (the share target), never for one that shows data.

What reduces the risk: nothing is loaded at run time (only what the host built in runs); the image is read-only;
the container drops all capabilities; pin a third-party package to a commit and read its `server/`; do not
install an `'events'` augmentation without a reason (it reads every new message).

## 3. Boundary rules (enforced by tests)

`test/boundary.test.ts` reads the sources of **every folder of `ext/`**, listed or not. A violation fails
`npm test` with the file and what to change.

**Imports**

- A package's server code (`ext/<id>/server/`) imports the core through `#core/sdk.js` only (`server/sdk.ts`).
  Node modules and the app's dependencies (`hono`…) are fine.
- A package's client code (`ext/<id>/client/`) imports the core through `client/src/sdk.ts` only, types
  included, and no server code except types. Its dynamic imports are its own files (`import('./X')`).
- Shared files (`package.ts`, `locales/`) take only types, and only from the core's pure modules
  (`#core/extension.js`, `#core/locales/<code>.js`).
- A package never imports another package, except types (`import type`) from the public entry
  (`ext/<id>/api.ts`) of a package it `requires` or `enhances`. That entry takes only types, from `#core/sdk.js`.
- A package's tests (`ext/<id>/test/`) may import the core directly (`#core/app.js`, `#core/registry.js`…) and the
  core's test helpers (`test/fakesource.ts`, `test/catalogs.ts`).

**Declarations**

- Both halves spread the same `package.ts` declaration first (`definePackage({ ...examplePackage, … })`) and never
  write one of its fields again; spaces are spread from `package.ts` too (`space({ ...exampleSpace, … })`) and never
  override their `id`, `path` or `segment`; both halves declare the same spaces.
- Every environment variable read in the package (`process.env.X`, outside `test/`) is declared in `config` or
  `optionalConfig`, and every declared variable is read. A computed name (`process.env[x]`) is refused.
- Capabilities (section 4): what the server code uses is declared, and nothing declared goes unused.

**Ownership**

- CSS classes in client code: the core's (`client/src/styles.css`: `.space-*`, `.set-*`, `.assist-*`…; the colour
  tokens and `.text-btn` are in `client/src/boot.css`, the signed-out screens' stylesheet) or the package's own
  stylesheets, never another package's, never a class defined nowhere. Prefix your classes with your id
  (`.example-greeting`). Shared pieces belong in the core's stylesheet.
- Strings: the core's catalogs or the package's own, never another package's `locales/`.
- Conventions not checked by the scan but expected: test ids (`data-testid`) and React Query keys prefixed with the
  package id (`['example', 'hello']`), data files named after it (`example.json`), no text written in a
  component.

**Ids and URLs** (checked by the registry when it is built; a malformed list throws)

- Package and module ids: `[a-z][a-z0-9-]{0,31}`; a module id is unique among the modules of its type, and among
  those with routes (their `/api/<id>/`).
- A space's `path` is `/<its id>`. Its places are one segment after it, matched by `segment` (a pattern for that
  segment alone, e.g. `[a-f0-9]{12}|machine`; `.`, `^`, `$`, `\` and `/` are refused): the core builds the whole
  match, so no pattern can reach another path.
- Renaming a space changes its URLs: declare the old home in `formerPaths` (1.18, e.g. `['/old']`) so that the
  notifications already delivered still open the same place (the service worker translates `/old/<place>` to
  `/<id>/<place>`). The old path is not served (no page, no API, no redirect): move any state file yourself at
  start (the agents package moves `data/hermes.json` to `data/agents-space.json`), and bump your package's major.
- Reserved ids (the core's sections, paths and API): `chats`, `chat`, `lowpriority`, `archive`, `archives`,
  `inbox`, `settings`, `enroll`, `healthz`, `assets`, `splash`, `pdfjs`, `api`, `accounts`, `auth`, `extensions`,
  `forward`, `media`, `messages`, `notify`, `preview`, `preview-img`, `push`, `push-links`, `session`, `thumb`,
  `upload`, `ws`, `bearer`. No module may take the name of the core's frames either: `ready`, `keepalive`, `error`,
  `subscriptions`, `chat`, `message`, `visibility`, `extensions`.
- An augmentation's `scope` and `onEvent` must agree (`'events'` with a function, `'on-demand'` without).
  `chatSources`, `sends` and `bearerRoutes` are for spaces only. At most one legacy connector without `owns` per
  build (deprecated); every connector of the tree declares `owns` and `ownsAccount` (`ext/contracts.test.ts`).
- `mounts` (more `/api/<key>/` prefixes for a module) exist for modules moved out of the core; a new module puts
  everything under `routes`.

## 4. Capability declarations

Since extension API 1.16, `package.ts` says what the server half reaches outside the app's own work. All fields are
optional; absent means none.

| Field | Meaning | Entries |
|---|---|---|
| `network` | Where it connects (outbound). | A declared variable holding the address (`'KLATCHLY_LLM_URL'`: a URL, host or socket path), a host name (`'api.example.com'`), or `'*'`: addresses given at run time (set in its Settings, read from a message). |
| `listen` | Where it listens (`ctx.listen`, providers only). | A declared variable holding `host:port`. |
| `files` | Files it reads or writes. | `'data'` (its own files in the data volume, `dataPath`) and declared variables holding a path (a key file, and files beside it). |
| `spawns` | It starts other programs or threads. | `true`. |

An address or a path is always named by its variable, never written with its value, so the declaration is the same
on every server. The registry refuses any other entry. A connection made for the package by a package it requires
is that package's (`writing` goes through `llm`).

From `ext/llm/package.ts`:

```ts
optionalConfig: ['KLATCHLY_LLM_URL', 'KLATCHLY_LLM_MODEL', 'KLATCHLY_LLM_KEY_FILE', 'KLATCHLY_LLM_FALLBACK', 'KLATCHLY_LLM_LABEL'],
network: ['KLATCHLY_LLM_URL', '*'],
files: ['data', 'KLATCHLY_LLM_KEY_FILE'],
```

The boundary test scans the package's server-side sources (everything but `client/`, `test/`, `locales/` and
`*.test.ts`), comments left out:

- `network`: a non-type import of `node:net`, `tls`, `http`, `https`, `http2`, `dgram`, `dns` (with or without
  `node:`), of a known npm client (`ws`, `undici`, `node-fetch`, `axios`, `got`, `eventsource`,
  `@beeper/desktop-api`; a new one is added to the test's list), a call to the global `fetch`, `new WebSocket` /
  `new EventSource`;
- `files`: `node:fs` or `node:fs/promises`;
- `listen`: a `.listen(` call;
- `spawns`: `node:child_process`, `node:worker_threads`, `node:cluster`.

An undeclared use, or a declaration the code does not use, fails with the line to write. It is an import and
identifier scan: it keeps an honest package's declaration true, it does not stop a malicious one. The client half
runs in the page under the app's CSP (`default-src 'self'`) and declares nothing.

Settings → Extensions shows the declaration under what the package reads ("Connects to: KLATCHLY_LLM_URL",
"No connection of its own", "Listens on: …", "Files: its own data, …", "⚠ Starts other programs"; `'*'` as a
warning), and `GET /api/extensions/details` returns it (`PackageDetails.capabilities`). A package that uses these
fields asks for `klatchly: '^2.0'`.

## 5. Configuration

- `config`: environment variables the package needs. While one is unset or empty at startup, the package stays off
  with the reason (`package off reason=missing config KLATCHLY_X` in the log, "missing configuration KLATCHLY_X" in
  Settings → Extensions); the rest of the app starts.
- `optionalConfig`: variables it reads that have a default or are optional. Listed for the record, and checked by
  the boundary test like `config`.
- Names match `[A-Z][A-Z0-9_]{0,63}`; by convention `KLATCHLY_<ID>_…`. Treat values as input: trim and bound them
  (the example's `greeting()` does). The example reads its variable when asked, so a change needs no restart of the
  module; reading at startup is fine too.
- **Secrets are files, never values in variables.** Declare a variable holding the path (`KLATCHLY_X_KEY_FILE`, also in
  `files`), mounted as a Compose secret at `/run/secrets/…`, and read it with `node:fs`. A `check()` can keep the
  package off while the file is missing or empty (`hermes`: "key file missing or empty (KLATCHLY_HERMES_KEY_FILE)").
- **State** goes in the data volume through `dataPath(name)`: a plain `*.json` name (`[a-z0-9][a-z0-9._-]*\.json`,
  no path), one file per need, named after the package. Write then rename, mode `0600` (as the example's
  `savePrefs`). Check what you read back: drop unknown fields, fall back to defaults.
- Settings → Extensions also has a server-wide switch for every package (kept in `/data/extensions.json`): turning
  a package off turns off what requires it, at once, without a restart.

## 6. Strings and languages

Every visible string comes from a typed catalog, one file per language. English (`en.ts`) is the reference: it
defines the shape, and a missing language falls back to English.

- `locales/en.ts`: the default export is the catalog (`messages satisfies ExampleMessages`, with
  `export type ExampleMessages = Widen<typeof messages>`), plus `about` (name and one-line description).
- `locales/<code>.ts`: the same keys and kinds (`satisfies ExampleMessages` checks them at build time).
- `locales/index.ts`: lists the language files and builds the catalog by language code and `about`
  (`PackageAbout`), read by the server half.
- `locales/launch.ts`: the strings shown before the chunk loads (a space's button, a Settings entry's title, the ✨
  tooltip line), all languages in one file, so the launch path does not carry the whole catalog.
- In components: `useCatalog(exampleCatalog)` for the package's strings, `useT()` for the core's (`t.shell.settings`,
  `t.common.back`…, typed). Outside a component: `localized(catalog)`. On the server: `pick(catalog, lang)`.
- A sentence with variables is one function; plurals go through `Intl.PluralRules` of the file's language; dates
  and sizes through the sdk's formats (`relativeTime`, `dateTimeOf`, `fileSize`) or `Intl` with `lang()`.

`ext/build.test.ts` checks, for every package of the build: `locales/` exists with **`en.ts` and `fr.ts`**, every
language file has the shape of English, `index.ts` lists exactly those files, `launch.ts` has the keys of English
in every language, and `about` has an `en` and an `fr` name and a description of one line (140 characters at most).
Adding a language (e.g. `de`): copy `fr.ts` to `de.ts` in every catalog folder (`web/server/locales/`,
`web/client/src/locales/<chunk>/`, and each package's `locales/`) and translate it; in a package, import it in
`locales/index.ts` (`languages`) and add a `de` entry to `locales/launch.ts`. The language picker (Settings →
General) lists `web/server/locales/`; a package not translated yet stays in English for that language.

## 7. Testing

### Unit tests

`ext/<id>/test/*.test.ts` run with `npm test` (Node's test runner, one process per file). Build a registry with the
core's fake chat source as the connector every started registry needs, and call the app (from
`ext/example/test/package.test.ts`):

```ts
const registry = new Registry([fake.pkg, example]);
const app = createApp(registry);
await registry.start();
```

Keep logic in pure functions that Node can test without a browser (`words.ts` and `test/words.test.ts`).

`npm test` runs, through `scripts/run-tests.mjs`: the core's tests, the whole-build tests (`ext/*.test.ts`), every
test of the listed packages, and, for a package of the tree that is not listed, only its tests that do not load the
build (`ext/packages.server.ts`), or that say they hold for any list with a line `// klatchly-test: any-list` (as the
example's `package.test.ts`, which adds itself to the build's list when it is not there).

The whole-build tests (`ext/build.test.ts`) apply to every listed package: a version, an `order`, `about` in `en`
and `fr`, every range satisfied, the package on once configured, removed from the build or turned off without
breaking the app, nothing left running after `stop()`. A package with required `config` gives its configuration
against nothing real in `test/build-env.ts` (dead endpoints, made-up keys), read before the build is imported. From
`ext/llm/test/build-env.ts`:

```ts
export default async function buildEnv({ key }: { dir: string; key: string }): Promise<Record<string, string>> {
  return { KLATCHLY_LLM_URL: 'http://127.0.0.1:9/v1', KLATCHLY_LLM_MODEL: 'test-model', KLATCHLY_LLM_KEY_FILE: key };
}
```

### Contract snapshots

A provider's public entry (`api.ts`) is fingerprinted in `ext/<id>/contract.json` and checked by
`ext/contracts.test.ts` against the package's `version` (section 9).

### End to end, offline

The offline instance (`test/e2e/offline/server.mjs`) runs the compiled app with every package of the build, each on
a fake service in the same process. A package that talks to a service brings its fake, `ext/<id>/test/offline.mjs`:

- `start({ dir, index, reset })` returns `{ env }`, the variables applied before the app is imported;
- optionally `reset()`, called before each script to put the fake back to its starting state, and
  `patchApp(built)`, called after the app is compiled and before it starts.

The example needs none (it calls no service). `ext/llm/test/offline.mjs` and `ext/hermes/test/offline.mjs` are
public examples.

End-to-end scripts are `ext/<id>/test/*.e2e.cjs` (Playwright, the core's helpers from `test/e2e/lib`), run with the
core's scripts when the package is in the build. Every script sees the same data whatever the order. A script that
changes the instance for everyone declares it on one of its first lines and gets an instance of its own:

```js
// e2e-instance: alone R_ACCOUNTS=1
```

(`alone`, optionally followed by `NAME=value` variables for that instance).

### Running the suite on your list

From `web/` ([tests.md](tests.md), tier 1), with your package in the list:

```sh
docker run --rm --network none -u $(id -u):$(id -g) -v "$PWD":/src -w /src -e HOME=/tmp \
  -e KLATCHLY_PACKAGES=beeper,accounts,llm,writing,example node:24.22.3-trixie-slim \
  sh -c 'npm run typecheck && npm test && npm run build'
```

Then, from the repository root, the end-to-end scripts on that build (tier 2):

```sh
KLATCHLY_PACKAGES=beeper,accounts,llm,writing,example sh web/test/e2e/run-offline.sh
```

`run-offline.sh` refuses a build composed from another list. The build keeps the last list composed: run again
without `KLATCHLY_PACKAGES` to go back to `ext/packages.json`.


## 8. Plugging a package into a build

The list of packages, first found wins: `KLATCHLY_PACKAGES` (ids separated by commas or spaces; also a Docker build
argument), the JSON file named by `KLATCHLY_PACKAGES_FILE`, else `ext/packages.json`. Each id needs
`ext/<id>/server/index.ts`; its client half is listed only when `ext/<id>/client/index.tsx` exists. Keep a
connector (any one: `beeper` or another): the server refuses to start without one.

Three ways to get the package's folder into `ext/`:

1. **Copy it into the tree**: `web/ext/<id>/`, then add the id to the list.
2. **Docker, from another folder**: a build context named `extra` is copied into `ext/` after the tree's packages.
   It holds `<id>/` folders and, optionally, a `packages.json` that replaces the default list (`KLATCHLY_PACKAGES`
   still wins).

   ```sh
   docker build --build-context extra=../my-packages web/
   ```

   With Compose, in `compose.override.yml` ([self-hosting.md](self-hosting.md)):

   ```yaml
   services:
     klatchly:
       build:
         additional_contexts: {extra: ../my-packages}
   ```

   Use an id that is not in the tree: a folder of the same name is copied over the tree's.
3. **Outside Docker**: `KLATCHLY_EXT_DIRS` (folders separated by `:`, each a package folder or a folder of packages).
   `compose-packages.mjs` **copies** them to `ext/<id>/` (tsc and the `#core/*` imports must see them inside
   `web/`) with a `.klatchly-extra` marker, refreshes its copies on each run, and refuses to overwrite a folder of the
   tree.

   ```sh
   KLATCHLY_EXT_DIRS=../my-packages KLATCHLY_PACKAGES=beeper,llm,writing,mypkg npm run build
   ```

Then open Settings → Extensions: the package's state, the reason if it is off, what it reads and reaches, and its
switch (server-wide, no restart).

Distributing a package: a git repository whose root is the package folder, a tag per version, and a README that says
what the package reads, where it sends data, and its `klatchly` range. A package is not a standalone npm module: it is
compiled with the core.

## 9. Versions

Two kinds of version:

- **`EXTENSION_API`** (`server/extension.ts`, today 2.1.0) versions what packages build on: `server/sdk.ts`,
  `client/src/sdk.ts` (since 1.15), and the module contracts (`server/extension.ts`, `server/registry.ts`,
  `server/connector.ts`, `client/src/extension.ts`, and every declaration they refer to).
- **A package's `version`** (`x.y.z`) versions what other packages use of it: its `api.ts`.

A package states what it works with in `package.ts`, as npm-style ranges (`^`, `~`, `>=`, `<`, exact, `1.x`, spaces
for AND, `||`; `server/semver.ts`):

- `klatchly: '^2.0'`: the extension API versions it accepts;
- `requires: { llm: '^1.1' }`: packages it needs; missing, off or at another version, it stays off;
- `enhances: { … }`: packages it works better with: used when on and matching (their provider through
  `ctx.provider`, their `api.ts` types), started before it, never a reason to be off.

Out of range, a package stays off with its reason (`requires extension API ^2 (present 1.16.0)`), and so does what
requires it; the rest of the app starts.

The rules:

- an **addition** (an optional field, an export, a member) is a **minor** bump; a **removal or a changed
  signature** is a **major** bump;
- `test/contract.test.ts` keeps a fingerprint of the extension API in `test/contract.json` (every exported
  declaration and those it uses, member by member, signatures only; `export *` is refused). A change without the
  right bump fails `npm test` and says which one ("That needs a minor bump: 1.0.0 -> 1.1.0 in
  server/extension.ts"); after the bump, `npm run contracts` records the new snapshot on purpose. The same holds for a
  package's `api.ts` against its `version` (`ext/<id>/contract.json`, `ext/contracts.test.ts`);
- after a major, widen the ranges of the packages that follow: `ext/build.test.ts` fails while a range of the build
  is not satisfied.

Since 2.0.0 every package asks for `^2.0` (a later minor once a 2.x version adds what it uses). Changes per version:
[extension-api.md](extension-api.md).

## 10. Walkthrough: a tiny package

A space with one server route that counts calls, in English and French. Five files, then a test. (This package was
built and run through tier 1 with `KLATCHLY_PACKAGES=beeper,llm,writing,hello` when this guide was written.)

**1. Start from the example.** Copy `web/ext/example/` to `web/ext/hello/` if you want its comments at hand, then
reduce it to the files below. Every id, file name, class and test id that says `example` must become yours.

**2. `ext/hello/package.ts`**: the shared declaration.

```ts
import type { PackageInfo, SpaceInfo } from '#core/extension.js';

export const helloPackage = {
  id: 'hello',
  version: '0.1.0',
  klatchly: '^2.0',
  order: 95,
} as const satisfies PackageInfo;

/** The space's URLs: button open-hello, API /api/hello/, page /hello. */
export const helloSpace = { id: 'hello', path: '/hello' } as const satisfies SpaceInfo;
```

No `config`, no capabilities: it reads no variable, touches no file, connects nowhere.

**3. `ext/hello/locales/`**: `en.ts`, `fr.ts`, `index.ts`, `launch.ts`.

```ts
// en.ts
import type { Widen } from '#core/locales/en.js';

const messages = {
  title: 'Hello',
  calls: (n: number) => (n === 1 ? 'The server answered once.' : `The server answered ${n} times.`),
};

export type HelloMessages = Widen<typeof messages>;
export default messages satisfies HelloMessages;

export const about = { name: 'Hello', description: 'A tiny space with one server route.' };
export type HelloAbout = Widen<typeof about>;
```

```ts
// fr.ts
import type { HelloAbout, HelloMessages } from './en.js';

export default {
  title: 'Bonjour',
  calls: (n: number) => (n === 1 ? 'Le serveur a répondu une fois.' : `Le serveur a répondu ${n} fois.`),
} satisfies HelloMessages;

export const about = { name: 'Bonjour', description: 'Un petit espace avec une route du serveur.' } satisfies HelloAbout;
```

```ts
// index.ts
import type { PackageAbout } from '#core/extension.js';
import * as en from './en.js';
import type { HelloAbout, HelloMessages } from './en.js';
import * as fr from './fr.js';

const languages: Readonly<Record<string, { default: HelloMessages; about: HelloAbout }>> = { en, fr };
const byLang = <V>(f: (l: { default: HelloMessages; about: HelloAbout }) => V): Readonly<Record<string, V>> =>
  Object.fromEntries(Object.entries(languages).map(([code, l]) => [code, f(l)]));

export const helloCatalog = byLang((l) => l.default);
export const helloAbout: PackageAbout = { name: byLang((l) => l.about.name), description: byLang((l) => l.about.description) };
```

```ts
// launch.ts
export const launch: Readonly<Record<string, { label: string }>> = {
  en: { label: 'Hello' },
  fr: { label: 'Bonjour' },
};
```

**4. `ext/hello/server/index.ts`**: the server half.

```ts
import { Hono } from 'hono';
import { definePackage, space, type Env } from '#core/sdk.js';
import { helloAbout } from '../locales/index.js';
import { helloPackage, helloSpace } from '../package.js';

let calls = 0;
// Mounted at /api/hello/, behind the session and the origin check, while the package is on.
const routes = new Hono<Env>().get('/ping', (c) => c.json({ calls: ++calls }));

export default definePackage({
  ...helloPackage,
  about: helloAbout,
  modules: [space({ ...helloSpace, routes, start: () => void (calls = 0), stop: () => void (calls = 0) })],
});
```

**5. `ext/hello/client/index.tsx` and `client/Hello.tsx`**: the client half and its lazy chunk.

```tsx
// index.tsx: on the launch path, tiny.
import { definePackage, lazyChunk, space } from '../../../client/src/sdk';
import { launch } from '../locales/launch';
import { helloPackage, helloSpace } from '../package';

const load = () => import('./Hello');
const label = Object.fromEntries(Object.entries(launch).map(([lang, m]) => [lang, m.label]));

export default definePackage({
  ...helloPackage,
  modules: [space({ ...helloSpace, label, icon: HelloIcon, List: lazyChunk(load, 'HelloList'), Main: lazyChunk(load, 'HelloMain') })],
});

function HelloIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
```

```tsx
// Hello.tsx: the chunk, loaded when the space first shows.
import { useQuery } from '@tanstack/react-query';
import { request, useCatalog, useT, type SpaceListProps, type SpaceMainProps } from '../../../client/src/sdk';
import { helloCatalog } from '../locales/index';

export function HelloList({ tabs, onSettings, settingsIcon }: SpaceListProps) {
  const t = useT();
  return (
    <header className="list-header space-header sections-header">
      {tabs}
      <span className="header-actions">
        <button type="button" className="icon-btn" aria-label={t.shell.settings} data-testid="open-settings" onClick={onSettings}>
          {settingsIcon}
        </button>
      </span>
    </header>
  );
}

export function HelloMain(_: SpaceMainProps) {
  const t = useCatalog(helloCatalog);
  const ping = useQuery({ queryKey: ['hello', 'ping'], queryFn: () => request<{ calls: number }>('GET', '/hello/ping') });
  return (
    <div className="conversation space-main" data-testid="hello-main">
      <header className="conv-header">
        <span className="conv-name">{t.title}</span>
      </header>
      {ping.data && <p className="space-note" data-testid="hello-calls">{t.calls(ping.data.calls)}</p>}
    </div>
  );
}
```

`request()` prefixes `/api`, adds the session cookie and the CSRF header, and throws an `HttpError` on a refusal.
Only core classes are used here; your own go in a stylesheet of the package, prefixed `hello-`. The space's colour
is a CSS variable behind the class `sec-hello` (see `ext/example/client/space.css`).

**6. `ext/hello/test/hello.test.ts`**: a unit test.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '#core/app.js';
import { sessions, store } from '#core/context.js';
import { Registry } from '#core/registry.js';
import { fakeSource } from '../../../test/fakesource.js';
import hello from '../server/index.js';

test('GET /api/hello/ping counts, and the route goes when the package is off', async () => {
  const registry = new Registry([fakeSource().pkg, hello]);
  const app = createApp(registry);
  await registry.start();
  const sid = store.mutate((s) => sessions.create(s));
  const ping = () => app.request('/api/hello/ping', { headers: { cookie: `sid=${sid}` } });
  assert.deepEqual(await (await ping()).json(), { calls: 1 });
  await registry.setEnabled('hello', false);
  assert.equal((await ping()).status, 404);
  await registry.stop();
});
```

It does not load the build, so it runs with `npm test` whether or not `hello` is listed.

**7. Build and test it.** From `web/`, tier 1 with the package in the list:

```sh
docker run --rm --network none -u $(id -u):$(id -g) -v "$PWD":/src -w /src -e HOME=/tmp \
  -e KLATCHLY_PACKAGES=beeper,llm,writing,hello node:24.22.3-trixie-slim \
  sh -c 'npm run typecheck && npm test && npm run build'
```

Typical failures and what they mean: "a field of package.ts written again" (a half repeats `id`, `order`…); "reads
KLATCHLY_X: add it to config" (an undeclared variable); "node:fs without a declaration: add files" (a capability);
"`.x` is defined nowhere" (a CSS class); "en and fr" (a missing catalog); "That needs a minor bump" (you changed
the core's API, not your package).

**8. Next steps.** Add a Settings page (the example's `settings` and `ExampleSettings`), an `'on-demand'`
augmentation (`ExampleMenu`), an end-to-end script (`ext/example/test/example.e2e.cjs`), and, if the package talks
to a service, its configuration, capability declaration, `test/build-env.ts` and `test/offline.mjs`.
