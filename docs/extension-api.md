# Klatchly extension API: reference and changelog

The extension API is what packages build on. Its version is `EXTENSION_API` in `web/server/extension.ts`
(**2.0.0** today). It covers:

- `web/server/sdk.ts`, imported by a package's server code as `#core/sdk.js` (section 3);
- `web/client/src/sdk.ts`, imported by a package's client code (section 4; since 1.15);
- the module contracts: `web/server/extension.ts`, `web/server/registry.ts`, `web/server/connector.ts`,
  `web/server/agentruntime.ts` (since 1.17, through the sdk), `web/client/src/extension.ts`, and every declaration
  of the core they refer to.

`web/test/contract.test.ts` keeps a fingerprint of all of it in `web/test/contract.json`: an addition needs a minor
bump, a removal or a changed signature a major bump, or `npm test` fails. How to write a package:
[extensions.md](extensions.md). This page is the reference; the source files' doc comments are the full
contract.

## 1. Changelog

Every 1.x version added to the one before, so a package written for `^1.N` worked with any later 1.x. 2.0.0 is the
one exception so far: the field `beep` was renamed `klatchly` with the app (no version has both); a package moves by
renaming the field and asking for `^2.0`. Otherwise the rule stands: additions bump the minor.

| Version | Klatchly | What it added |
|---|---|---|
| 2.0.0 | 0.26.0 | **The app is renamed Klatchly (formerly beep).** Change: `PackageInfo.beep` is now **`PackageInfo.klatchly`** (and `PackageDetails.klatchly`); nothing else. A package moves by renaming the field and widening its range to `'^2.0'`. |
| 1.26.0 | unreleased (after 0.25.1) | **Reads that stop with the browser.** Addition: **`upstreamSignal()`** (server sdk): the `AbortSignal` of the browser read a connector's call runs for (the relay's GET of the chat list, a search, a chat, its messages, one message), aborted once every browser request waiting on that read has gone; a connector passes it to its upstream calls for reads, never to writes; undefined outside such a read. Changes in behaviour, no signature changed: identical concurrent reads through the relay share one connector call (keyed by the whole request: method, path, query), and the first page of a chat list is kept a second (forgotten on any write through the API and on any source event; errors never kept); a source's `'ready'` recounts the badge from `unreadChats()` at once only when the last recount is at least 5 minutes old (then every 5 minutes, a failed one retried a minute later); the core drops a browser socket, and the Beeper connector its upstream sockets, after two pings in a row left unanswered instead of one (`LiveSession.ping` should tolerate one late answer). The beeper package passes the signal to its Desktop API reads, shares one chat scan for `unreadChats` (a minute, kept current by its chat upserts, read again after a read, a flag change or a reconnect) and asks `^1.26`. |
| 1.25.0 | unreleased (after 0.24.0) | **No default connector: every connector is one like any other.** Additions: **`ConnectorShape.longReactionKey(key)`** (a reaction key over 64 characters, up to 255 without whitespace or control characters, is one of its own, e.g. an image reaction's media URI; absent: 400), **`ConnectorShape.accountsPending()`** (it has not learnt its accounts yet, e.g. a first start before its upstream has listed them: meanwhile the account ids no connector claims are its own, so a network filter or a per-account setting still reaches it), client **`ConnectorTraits.mediaQuery(url)`** (the `/api/media` parameters naming one of its media references; the core adds the path, the type hint and the download name) and **`ConnectorTraits.displaysMarkdown(chat)`** (one of its chats that lists no formatting still displays Markdown). Changes in behaviour, no signature changed: `owns` absent is a deprecated legacy catch-all for chat and account routing only (still at most one per build); `/api/upload` without a chat goes to the one connector on with a plain `upload` (several: 400 `chat_required`; none: 409), and an upload ID the core does not know fits that connector only; `POST /api/inbox/low-priority/read-all` asks every connector on that can and adds up their counts (all failing: the first one's status; none: 409); the start rule is "at least one connector on", and `PackageDetails.keep` is only `'no-connector'` (`'default-connector'` is no longer produced); a long reaction key goes only to a connector whose `longReactionKey` takes it; the core's client defaults for a chat that no connector UI claims are neutral (no low-priority inbox, no relayed media or image reactions, no cached delivery ticks, no Markdown without listed formatting): the connector declares them (`lowPriority`, `fullDelivery`, `mediaQuery`, `thumb`, `displaysMarkdown`). The beeper package declares `owns` (Matrix room ids, `!…`), `ownsAccount` (the accounts it listed, kept in `beeper-accounts.json`; `accountsPending` until beeper-server first lists them), `longReactionKey` and a client half with these traits. |
| 1.24.0 | 0.23.0 | **A space's device API: `ServerSpace.bearerRoutes`** (a `Hono<Env>` mounted at `/api/bearer/<id>/` before the origin check and the session guard, for callers that are not a browser: the core reads no cookie there, refuses a request without an `Authorization: Bearer <token>` header of 16 to 256 URL-safe characters with 400 `bad_token`, caps the body at 64 KB, answers 404 while the package is off and to any other path under `/api/bearer/`; the package checks its own tokens). **Sending on its own: `ServerSpace.sends`**, **`ModuleContext.sender`** and the type **`ChatSender`** (`canSend(chatID)`, `send(chatID, text)`: a plain text message the way the composer sends it, in any chat of a connector that is on, logged with the package id, the connector id and the length, never the text; ConnectorError 400 / 404 for a bad id or text, a chat of no connector that is on, or once off). **`PackageDetails.sends`** and **`bearer`** (Settings → Extensions says so). **`ServerSpace.signedOutPage`** (its home page, `path` itself, opens the app's shell signed out too, then returns there with its query after sign-in; decided from the build's declarations only, no module code runs and on/off does not change the answer; every other page stays a 302 to `/`). **`SourceChat.isReadOnly`** (nothing can be sent there). Client sdk: **`prefillDraft(chatID, text)`** (text added to a chat's unsent draft, shown by its composer when the chat opens; never sent by itself). The reserved id `bearer`. Core, outside the contract: after sign-in the app returns to the page it showed over (an allow-list: a chat, a Settings page, a space's page), across an OIDC sign-in too (kept in the tab's sessionStorage, 10 minutes); the manifest's `share_target` (GET `/share`, only in a build with the share package). First user: the share package. |
| 1.23.0 | 0.22.0 | **`ChatReader.readAudio(chatID, messageID, index)`** and **`ReadAudio`** (`mime`, `data`, `duration?`, `voiceNote?`), **`READ_AUDIO_MAX`** (25 MB): a message's sound (a voice note or another audio attachment) read by the server, for the user who asked to transcribe it; 'too_large' beyond the cap, null when there is no such sound (the same semantics as `readImage`). Client: **`MessageMenuSlotProps.audio`** (the menu is about an audio attachment: its index) and **`AugmentationUI.audioMenu`** (its `message.Menu` also in the menu of an audio attachment without text; absent: text and pictures only, as before). First user: the transcribe package. |
| 1.22.0 | 0.21.3 | **Client sdk: `withStepUp(fn)` and `<StepUpPrompt />`**: for an action (not a settings page) whose server route uses `requireStepUp`. `withStepUp` runs it and, on a `step_up` refusal, opens the confirmation (the page renders `<StepUpPrompt />` once), then runs it again; closing the prompt rejects with the refusal. First user: the deck package (create a project, sign Claude in, take everything offline, restart or resume a session). |
| 1.21.0 | 0.21.0 | **`ChatReader.readRange(chatID, range)`**: a chat's messages over a period, oldest first (`since` / `until` ISO times, `fromMessageID`, or `afterOwn`: after the user's last own message), read page by page backwards, at most `max` (`READ_RANGE_MAX`, 2000); `truncated` when the period holds more (the newest kept), `reached` false when its start was not found. Client sdk: **`useChatSummary(chatID)`** (the chat's title and network, from the conversation's own query). First user: the ask package. |
| 1.20.0 | unreleased (after 0.19.1) | **Agent runtime: `jobsControl`** (optional, absent = false): with `jobs`, `AgentRuntime.pauseJob(agent, id)` and `resumeJob(agent, id)` pause and resume a task the runtime listed for that agent and resolve to the `RuntimeJob` as it is now (status 404: not one of its listed tasks). Nothing else of a task (run now, edit, remove) is in the contract. |
| 1.19.0 | unreleased (after 0.19.1) | **Agent runtime: optional capabilities** (all optional members, absent = false): `AgentRuntimeFeatures.otherSources` with `RuntimeConversations.listOther(agent)` (conversations started elsewhere, each with its `source`, read-only for the consumer; `history` reads them too), `jobs` with `AgentRuntime.jobs(agent)` and the new type `RuntimeJob` (`id`, `name`, `schedule`, `state`, `lastRun`, `lastStatus`, `nextRun`: a scheduled task, never its prompt), `readSync` with `RuntimeConversations.markRead(agent, id, read)` (the consumer's read state, best effort). |
| 1.18.0 | unreleased (after 0.19.1) | **`SpaceInfo.formerPaths`**: the homes a renamed space had before (`['/old']`), for notification links only. `/push-links.js` lists them (`former`) and the service worker opens a link to `/old` or `/old/<place>` at the same place under the space's `path` (a local translation, checked like any target). Nothing is served at a former path: no page, no API, no redirect. The registry refuses a former path that is not a plain `/<id>`, is reserved, is the space's own or another space's home, or is listed twice. |
| 1.17.0 | unreleased (after 0.19.1) | **Agent runtime contract** (`server/agentruntime.ts`, sdk types): `AgentRuntime` (a provider that runs agents: `features`, `configure`, `agents`, `agentsStatus`, `probe`, `isUp`, `usable`, `complete`, optional `disclosure`, `conversations`, `allowedHelpers`, `onInbound`, `onFollowUp`), `AgentRuntimeFeatures`, `RuntimeAgent`, `RuntimeAgentStatus`, `RuntimeConversation` (with `source?`), `RuntimeConversations`, `ConversationItem`, `RuntimeMessage`, `RunEvent`, `RunApproval`, `RuntimeRun`, `InboundMessage`, `InboundResult`, `RuntimeFollowUp`, `RuntimeText`. **`ServerSpace.shown`** (a space that does not show now: no button, no page, no API) and `hidden` in `PackageStatus.modules`. |
| 1.16.0 | unreleased (after 0.19.1) | **Capability declarations**: `PackageInfo.network`, `listen`, `files`, `spawns`; `PackageCapabilities`, `capabilitiesOf`, `PackageDetails.capabilities`. The registry refuses an entry that is neither a declared variable, a host name, `'*'` (network) nor `'data'` (files); `test/boundary.test.ts` checks the declaration against the server code. |
| 1.15.0 | unreleased (after 0.19.1) | **Client entry point** `client/src/sdk.ts`: named re-exports of the client contracts and of the core's client helpers packages use (requests, strings, lazy chunks, formats, navigation, UI pieces, step-up). A package's client code imports the core through it only. |
| 1.14.0 | 0.19.0 | Settings sub-pages and counts: `SettingsSection.segment`, `SettingsSection.useBadge`, `SettingsBodyProps` (`sub`); a space without a button: `SpaceModule.button: false`. |
| 1.13.0 | 0.18.16 | `ComposerApi.network` (`ComposerNetwork`: the chat's network name and its formatting support levels, `SupportLevel`), so a rewrite can shape its Markdown. |
| 1.12.0 | 0.18.15 | `ComposerSlots.inEdit`: an augmentation's ✨ section also in the inline message editor. |
| 1.11.0 | 0.18.13 | Contacts found by `ConnectorShape.newChat.searchContacts` may carry `inChats` and `chatID` (their direct chat, opened instead of starting one). Documented in `connector.ts`; outside the fingerprint, as the method returns `unknown[]`. |
| 1.10.0 | 0.18.10 | A source's sign-in QR code: `ConnectorShape.loginQR`, `LoginQR`, `ChatSources.loginQR`, `SourceInfo.qr`; sdk export `LoginQR`. |
| 1.9.0 | 0.18.9 | `ChatReader.readImage` and `ReadImage` (a picture of a message, read by the server); `MessageMenuSlotProps.image`; sdk export `ReadImage`. |
| 1.8.0 | 0.18.7 | `ChatInfo.replies` (whether the chat takes quoted replies). |
| 1.7.0 | 0.18.4 | `ReceiptSupport.replyTells` (replying always tells the network; the core sends the receipt after a reply in a discreetly read chat). |
| 1.6.0 | 0.18.1 | `ReceiptSupport.readAllLowPriorityByChat` (discreet reading per chat). |
| 1.5.0 | 0.18.0 | Discreet reading: `ConnectorShape.receipts`, `ReceiptSupport` (`readQuietly`, `send`, `sendAvailable`, `replyMayTell`, `readAllLowPriority`, `byDefault`, `note`); sdk export `ReceiptSupport`. |
| 1.4.0 | 0.17.1 | `ConnectorShape.uploadFor(chatID, file, signal)`: an upload bound to its chat, preferred over `upload` when there is one. |
| 1.3.0 | 0.17.0 | Step-up for sensitive settings: sdk `requireStepUp`, `stepUpState`, `StepUpState`. |
| 1.2.0 | 0.15.7 | `SettingsSection.icon` (Settings became a menu; an off package's pages are no longer listed, so `off` is no longer shown). |
| 1.1.0 | 0.15.6 | `ModuleContext.chatSources` for a space that declares `ServerSpace.chatSources: true` (`ChatSources`, `SourceAccount`, `SourceChat`, `SourceInfo`); `PackageDetails.chatSources`; account status in the connector contract: `Account.status` / `statusText` / `bridge` / `user` / `capabilities`, `AccountStatus`, `ConnectorShape.accountStatus`, `ConnectorShape.reconnectHint`. |
| 1.0.0 | 0.15.5 | First versioned API and its fingerprint. `PackageInfo.version`, `beep`, `requires` (an object of ranges), `enhances`, `optionalConfig`, `order`; `PackageAbout`, `ServerPackage.about`; `byOrder`, `EXTENSION_API`, `OffCause`, `PackageDetails`, `ExtensionsDetails`, `DependencyStatus`; `ClientPackage` extends `PackageInfo`; `ModuleContext.provider` also gives enhanced packages' providers; `ModuleContext.push`. |

Before 1.0.0 (Klatchly 0.15.0 to 0.15.4) the package contracts were unversioned: 0.15.1 brought providers and
augmentations (`ctx.provider`, `ctx.chats`), 0.15.2 frames (`toBrowsers`), `events` augmentations (`onEvent`,
`ctx.actor`) and provider listeners (`ctx.listen`), 0.15.3 the connector contract (`ConnectorShape`,
`ctx.feed`), 0.15.4 a second connector and the merged lists.

## 2. `PackageInfo` (`package.ts`)

What both halves of a package share (`server/extension.ts`). Spread into `definePackage` by both halves.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | `[a-z][a-z0-9-]{0,31}`; also its folder `ext/<id>/` and its Settings namespace. |
| `version` | `string` | `x.y.z`. The major changes when what other packages use of it (`api.ts`) loses or changes something. |
| `klatchly` | `string` | The extension API versions it works with, an npm-style range (`'^2.0'`). Off otherwise. Called `beep` before 2.0.0 (app 0.26.0): rename it. |
| `requires?` | `Record<string, string>` | Packages it needs, with ranges (`{ llm: '^1.1' }`). Off unless they are on and match. |
| `enhances?` | `Record<string, string>` | Packages it works better with: used when on and matching, started before it, never a reason to be off. |
| `config?` | `readonly string[]` | Environment variables it needs (names). Off while one is unset or empty. |
| `optionalConfig?` | `readonly string[]` | Variables it reads that have a default or are optional. |
| `order?` | `number` | Its place among the other packages' (spaces, slots, ✨ sections, connectors' merge order, Settings): lower first, then id. Default 100. The whole-build test requires it. |
| `network?` | `readonly string[]` | (1.16) Where it connects: declared variables holding addresses, host names, or `'*'`. |
| `listen?` | `readonly string[]` | (1.16) Where it listens (`ctx.listen`): declared variables holding `host:port`. |
| `files?` | `readonly string[]` | (1.16) Files it reads or writes: `'data'` and declared variables holding a path. |
| `spawns?` | `boolean` | (1.16) It starts other programs or threads. |

The server half adds `about?: PackageAbout` (`name` and `description` by language code, English the fallback) and
`modules`. The client half adds `modules`, `settings?` and `events?`.

`SpaceInfo` (also in `package.ts`, shared by both halves of a space): `id`; `path` (`'/<id>'`); `segment?`, a
pattern for the one segment after `path` that names a place; `formerPaths?` (1.18), its homes before a rename, for
notifications delivered before it (the service worker translates them; never served).

## 3. Server sdk: `#core/sdk.js`

`web/server/sdk.ts`, the only core module a package's server code imports.

**Package and modules**

| Export | Kind | What it is |
|---|---|---|
| `definePackage` | function | Typed constructor of the server entry's default export (`ServerPackage`). |
| `space`, `connector`, `augmentation`, `provider` | functions | Typed constructors of the four module types. |
| `ServerPackage`, `ServerModule`, `ServerSpace`, `ConnectorModule`, `AugmentationModule`, `ProviderModule`, `ModuleContext` | types | The module contracts (section 6). |
| `PackageInfo`, `SpaceInfo`, `ModuleType`, `AugmentationScope`, `ModuleInfo` | types | Shared declarations (`server/extension.ts`). |

**Requests and responses**

| Export | Kind | What it is |
|---|---|---|
| `Env` | type | The Hono environment of the app's routes: `new Hono<Env>()`. |
| `jsonObject(c)` | function | The request body as a JSON object, else `null`. |
| `validId(v)` | function | The core's id check for path and query parameters. |
| `fail(c, e, route, source?)` | function | The answer to an upstream error (its status, logged without content; not logged once the browser has gone). |
| `upstreamSignal()` | function | (1.26) The signal of the browser read a connector's call runs for, aborted once every browser request waiting on it has gone: pass it to upstream calls for reads, never writes. Undefined outside such a read. |
| `clientIp(c)` | function | The client's IP as the core sees it (trusted proxies applied). |
| `RateLimiter` | class | Fixed-window limiter: `new RateLimiter(windowMs, perKey, global)`. |
| `requireStepUp` | middleware | (1.3) Refuses a sensitive change with 403 `{ error: 'step_up' }` without a recent sign-in or confirmation. |
| `stepUpState(c)`, `StepUpState` | function, type | (1.3) Time left and the methods the session can confirm with. |

**State, logs, notifications, strings**

| Export | Kind | What it is |
|---|---|---|
| `dataPath(name)` | function | Path of a JSON file of the data volume; a plain `*.json` name, never a path. |
| `log(scope, msg, extra?)` | function | A log line; no user content in it. |
| `pushAll(payload, sessionHash?)`, `Payload` | function, type | Web Push to the signed-in devices. Packages prefer `ctx.push`, which stops once the package is off. |
| `spaceViewedBy(session, space)` | function | Whether that device is looking at the space now (spare it the space's own pushes). |
| `suppressedFor(session, chatID)` | function | Whether that device already sees this chat (or the app in the foreground). |
| `pick(catalog, lang?)` | function | A catalog's entry for a language, English the fallback. |
| `toPlainText(s)` | function | Message text as the user reads it (rich bodies to plain text). |
| `senderLabel(name, id, member)` | function | A sender's label as the core shows it. |
| `BrowserFrame` | type | A frame for the browsers (`ctx.toBrowsers`). |

**Chat access (types only; the objects come in `ModuleContext`)**

| Export | What it is |
|---|---|
| `ChatReader`, `ReadMessage`, `ReadImage`, `ReadAudio`, `ReadRange`, `ReadRangeResult`, `READ_RANGE_MAX`, `READ_AUDIO_MAX` | `ctx.chats` of an augmentation: `readMessage`, `recentMessages`, `readImage` (1.9), `readRange` (1.21), `readAudio` (1.23), declared fields only, each call logged with the package id. |
| `ChatActor`, `ChatEvent`, `ChatInfo`, `EventMessage` | An `'events'` augmentation's stream (`onEvent`) and `ctx.actor`: `recentMessages`, `chat`, `canSend`, `send`. |
| `ChatSources`, `SourceAccount`, `SourceChat`, `SourceInfo` | (1.1) `ctx.chatSources` of a space that declares it: `accounts`, `chats`, `recentChats`, `loginQR` (1.10); content-free; `SourceChat.isReadOnly` since 1.24. |
| `ChatSender` | (1.24) `ctx.sender` of a space that declares `sends: true`: `canSend(chatID)`, `send(chatID, text)` (plain text, the composer's path, each send logged with the package id, the connector id and the length, never the text). |

**Agent runtimes** (`server/agentruntime.ts`, since 1.17; types only)

| Export | What it is |
|---|---|
| `AgentRuntime` | A provider that runs agents (section 6), for the package that shows them. |
| `AgentRuntimeFeatures` | What it can do beyond the core operations: `conversations`, `streaming`, `stop`, `organize`, `images`, `approvals`, `helpers`, `inbound`, `tools`, `mainAgent`; optional (1.19): `otherSources`, `jobs`, `readSync`; (1.20): `jobsControl`. |
| `RuntimeAgent`, `RuntimeAgentStatus`, `RuntimeText` | An agent as its consumer configures it (`id`, `label`, `description`, `helpers`, `space`, `inbox`, `instructions`), with `up`; a text by language. |
| `RuntimeConversations`, `RuntimeConversation`, `ConversationItem` | Capability `conversations`: list, create, get, update (`organize`), remove, history, send, `listOther` (`otherSources`, 1.19), `markRead` (`readSync`, 1.19); a conversation (`source?`: its origin, set on every conversation of `listOther`); a history line. |
| `RuntimeJob` | (1.19) Capability `jobs`: a scheduled task of an agent as a user sees it (`id`, `name`, `schedule`, `state`, `lastRun`, `lastStatus`, `nextRun`), never its prompt; what `pauseJob` / `resumeJob` resolve to (`jobsControl`, 1.20). |
| `RuntimeMessage`, `RuntimeRun`, `RunEvent`, `RunApproval` | A turn (text, data-URL images) and its run: normalized events (`delta`, `text`, `tool`, `approval`, `status`, `error`), `stop` and `approve` per capability. |
| `InboundMessage`, `InboundResult`, `RuntimeFollowUp` | What an agent posts itself (`inbound`) and the consumer's answer; helpers' late results (`helpers`). |

**Connectors** (`server/connector.ts`)

| Export | What it is |
|---|---|
| `ConnectorShape` | The connector contract (section 6). |
| `ConnectorError` | Thrown with a chosen status and code (e.g. 409 `forbidden_message`); else `failure` or 502. |
| `Account`, `AccountStatus`, `Attachment`, `Chat`, `ChatFlag`, `ChatSearchQuery`, `Message`, `Page`, `MediaRef`, `MediaTab`, `NewChatCaps`, `UploadOutcome`, `Failure`, `LoginQR` | The canonical model (the Desktop API's shapes) and the method types. |
| `SourceEvent`, `SourceFeed` | What a connector sends through `ctx.feed`: `ready`, `closed`, `chat.upserted`, `message.upserted`, and browser frames. |
| `LiveSession`, `LiveSink` | A per-browser live feed (`openLive`). |
| `ReceiptSupport` | (1.5) Discreet reading. |
| `contentDisposition`, `mediaSecurityHeaders`, `mediaType` | The core's media relay headers (sandbox CSP, nosniff), type allowlist and disposition. |
| `rangedRelay`, `RangeCache`, `Upstream` | Range served over a source that may ignore it. |
| `isMime`, `sanitizeFileName`, `MAX_UPLOAD_BYTES` | The core's upload checks and cap. |
| `MAX_GROUP`, `MAX_TITLE` | The bounds of a new group chat. |

## 4. Client sdk: `client/src/sdk.ts`

Since 1.15. Imported by a package's client code as `'../../../client/src/sdk'`; named re-exports only. A package's
launch entry (`client/index.tsx`) should import only what the shell needs before its chunk (`definePackage`, the
constructors, `lazyChunk`).

| Group | Exports | What they are |
|---|---|---|
| Module contracts | `definePackage`, `space`, `augmentation`, `connector` | Typed constructors of the client entry. |
| | `ClientPackage`, `ClientModule`, `SpaceModule`, `AugmentationUI`, `ConnectorUI`, `ConnectorTraits` | The client modules (section 6). |
| | `SpaceListProps`, `SpaceMainProps`, `SpaceControllerProps` | Props of a space's list, pane and controller. |
| | `ComposerApi`, `ComposerNetwork`, `ComposerSlots`, `ComposerMenuProps`, `ComposerToolsProps`, `RewriteNote` | The composer's slots and what it hands an augmentation. |
| | `ConversationSlotProps`, `ConversationPanelProps`, `MessageSlotProps`, `MessageMenuSlotProps`, `Message` | Conversation and message slots. |
| | `SettingsSection`, `SettingsBodyProps` | A Settings page. |
| | `PackageFrame`, `ModuleInfo` | A frame from the server half; the server half's public values. |
| Lazy chunks | `lazyChunk(load, name)`, `Chunk` | A component loaded on first use: `lazyChunk(() => import('./X'), 'X')`. |
| Requests | `request(method, path, body?)`, `qs(o)`, `HttpError` | Calls to `/api` with the session cookie and CSRF header; a query string; a refusal (`status`, `code`). |
| Strings | `useT()`, `Messages`, `useCatalog(catalog)`, `localized(catalog, code?)`, `useLang()`, `lang()` | The core's typed catalog; a package's catalog by language (English fallback); the UI language. |
| Server info | `useModuleInfo(pkg, type, id)` | The module's `info` from `GET /api/extensions`, while its package is on. |
| Formats | `relativeTime`, `dateTimeOf`, `timeOf`, `fileSize`, `looseText` | Dates, times and sizes in the UI language; a message's text as one plain line. |
| Navigation | `backToList`, `fromListState`, `replaceKeepState`, `phoneLayout` | Navigation inside a space as the core's lists do it; the one-pane layout (under 800 px). |
| UI pieces | `ConnBar`, `ChatsSkeleton`, `MessagesSkeleton`, `NetworkBadge`, `networkName`, `useToast`, `useSheetDrag`, `useDismiss`, `autosize` | Connection banner, skeletons, a network's mark and name, the toast line, a sheet's drag to close, a popover's outside click and Escape, an auto-growing field. |
| Chat | `useChatSummary` | (1.21) The chat's title and network, for a component in a conversation. |
| Drafts | `prefillDraft(chatID, text)` | (1.24) Adds text to a chat's unsent draft (after what is there, mentions kept), shown by its composer when the chat opens: a shared link, never sent by itself. |
| Step-up | `useStepUp`, `stepUpLocked`, `StepUpBox`, `StepUpLeft`, `isStepUpError` | The core's confirmation box for a sensitive Settings page (with the server's `requireStepUp`). |

## 5. What Settings → Extensions reads

`GET /api/extensions` (signed in): `ExtensionsReply`, one `PackageStatus` per package (`id`, `active`, `reason?`,
`modules` with their type, id, a space's `path` and `segment`, and `info` while on).

`GET /api/extensions/details`: `ExtensionsDetails` (`api`: this build's `EXTENSION_API`; `packages`:
`PackageDetails`, with version, `klatchly` and `apiOk`, `about`, `state` (`on` / `off` / `disabled`), `cause`
(`OffCause`), modules with an augmentation's `scope`, `chatSources`, `capabilities`, `requires` / `enhances`
(`DependencyStatus`), `requiredBy`, `enhancedBy`, `dependants`, `canDisable` / `keep` (since 1.25 only
`'no-connector'`: the last connector on), `canEnable`, `needs`; since 1.24 `sends` and `bearer`).

`PUT /api/extensions/<id>` `{ enabled, withRequired? }` turns a package off or on for the whole server.

## 6. Module contracts

**Every module** (`ModuleBase`, `server/registry.ts`): `id`; `check?()` (readiness beyond `config`, evaluated once
at startup; a reason keeps the package off until a restart); `start?(ctx)`; `stop?()` (must leave nothing
running); `routes?` (a `Hono<Env>` at `/api/<id>/`); `mounts?` (more `/api/<key>/` prefixes, for modules moved
out of the core); `info?()` (public values for the client half); `logPath?(path)` (a log template hiding its ids).

**`ModuleContext`** (given to `start`):

| Member | Who gets it | What it is |
|---|---|---|
| `provider(id)` | all | An active provider of a package it requires or enhances (or its own); look it up when needed. |
| `push(payload)` | all | Web Push, ignored once the package is off. |
| `toBrowsers(frame)` | all | A content-free frame over `/api/ws`, of type `<module id>` or `<module id>.<x>`. |
| `chats` | augmentations | `ChatReader`: what the user acts on. |
| `actor` | `'events'` augmentations | `ChatActor`: acting in chats on its own, each call logged. |
| `chatSources` | spaces with `chatSources: true` | `ChatSources`: accounts and chat figures, content-free. |
| `sender` | spaces with `sends: true` | (1.24) `ChatSender`: plain text messages in the user's name, the composer's path, logged without content. |
| `listen(host, port, handler)` | providers | A listener of its own on a specific IPv4 address; closed after `stop`. |
| `feed` | connectors | `SourceFeed`: events into the core, frames to the browsers. |

**Space** (`ServerSpace` + `SpaceModule`): server side `SpaceInfo`, `chatSources?` and `shown?()` (1.17: false hides
it while its package is on: no button, no page, its API 404; its notification targets stay listed), `sends?` (1.24:
`ctx.sender`), `bearerRoutes?` (1.24: its device API at `/api/bearer/<id>/`, a Bearer token the only way in, the
token the package's own; never 401/403) and `signedOutPage?` (1.24: its home opens the app's shell signed out, for a
page whose query carries what the user brought, never one that shows data); client side `label`,
`icon`, `List`, `Main`, `Controller?`, `useBadge?`, `badgeLabel?`, `listPlaces?`, `button?` (1.14). The sidebar
button is `open-<id>`, its colour class `sec-<id>`.

**Connector** (`ConnectorShape`, `server/connector.ts`): required `capabilities` (`actorSend`, `flags`),
`accounts`, `listChats`, `searchChats`, `searchMessages`, `chat`, `messages`, `message`, `send`, `markRead`,
`unreadChats`; optional `owns` / `ownsAccount` (every connector declares them; without `owns`: a legacy catch-all,
deprecated since 1.25), `accountsPending` (1.25: accounts not learnt yet, the unclaimed ones are its own), `failure`, `edit`, `deleteMessage`, `react` / `unreact`, `longReactionKey` (1.25), `archive`,
`update` (flags), `readAllLowPriority`, `mediaMessages`, `upload`,
`uploadFor` (1.4), `media` (`params`, `parse`, `fetch`), `mediaRoutes`, `attachmentSource`, `newChat`, `openLive`,
`receipts` (1.5), `accountStatus` and `reconnectHint` (1.1), `loginQR` (1.10). What a connector lacks, the core
answers with 409 `unsupported`. Client side, `ConnectorUI` (`ConnectorTraits`: `id`, `name`, `networks`, `owns`,
`lowPriority`, `textOnly`, `fullDelivery`, `mediaURL`, `thumb`, `mediaQuery` and `displaysMarkdown` (1.25); and
`icon`).

**Augmentation** (`AugmentationModule` + `AugmentationUI`): server side `scope: 'on-demand'` (no `onEvent`) or
`scope: 'events'` with `onEvent(ev)`; client side `composer?` (`Menu`, `Tools?`, `useAvailable?`, `hint?`,
`inEdit?`), `Header?`, `Conversation?`, `message?` (`Actions?`, `Below?`, `Menu?`), `audioMenu?` (1.23: its `Menu` also on an audio attachment, with `MessageMenuSlotProps.audio`).

**Provider** (`ProviderModule`): `status()` (`{ ready, detail? }`), `reserves?()` (hosts of its listener, refused to
the app whatever the package's state). Its own type is exported by its package's public entry, `ext/<id>/api.ts`
(types only), fingerprinted in `ext/<id>/contract.json` against the package's `version`.

**Agent runtime** (`AgentRuntime`, 1.17): a provider whose type is the core's, for contracts several packages
implement and one consumes (as `ConnectorShape` for connectors). Core operations: `features`, `configure(list |
null)` (the consumer's agents for it; null: its own list), `agents()`, `agentsStatus()`, `probe`, `isUp`, `usable`,
`complete(agent, messages)` (stateless). Optional, per capability: `disclosure(agent)` (who receives the messages),
`conversations` (`conversations`; `update` with `organize`), `allowedHelpers` and `onFollowUp` (`helpers`),
`onInbound` (`inbound`); a run's `stop` (`stop`) and `approve` (`approvals`); since 1.19 `conversations.listOther`
(`otherSources`: conversations started elsewhere, read-only for the consumer), `jobs(agent)` (`jobs`: scheduled tasks,
read-only) and `conversations.markRead` (`readSync`: the consumer's read state, best effort); since 1.20 `pauseJob` and
`resumeJob` (`jobsControl`: a listed task paused or resumed, nothing else). Errors carry a numeric `status` (404,
409, 503…). The consumer finds a runtime with `ctx.provider(<id>)`, so it `enhances` the runtime's package. In this
tree: `hermes` (its `HermesProvider` is `AgentRuntime`), and the `agents` package's own runtime on `llm`.

**Client package** (`ClientPackage`): `PackageInfo` spread in, `modules`, `settings?` (`SettingsSection`: `id`,
`title`, `Body`, `icon?` (1.2), `segment?` and `useBadge?` (1.14), `off?` unused), `events?` (frame handlers by
type).
