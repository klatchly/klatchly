# Testing Klatchly: three tiers, none against a real service

Everything runs in throwaway containers (`--rm`, no network). A release goes out after the three tiers: unit tests,
all the offline end-to-end scripts, then the image. No test reaches a real beeper-server, a real messaging network or
a real model: each backend is a fake, invented and deterministic, running in the same process.

## 1. On every change (≈ 20 s): typecheck, unit tests, build

From `web/`:

```sh
docker run --rm --network none -u $(id -u):$(id -g) -v "$PWD":/src -w /src -e HOME=/tmp node:24.22.1-trixie-slim \
  sh -c 'npm run typecheck && npm test && npm run build'
```

(`npm ci` first, once, with network: `docker run --rm -u $(id -u):$(id -g) -v "$PWD":/src -w /src -e HOME=/tmp
node:24.22.1-trixie-slim npm ci`.)

`npm test` compiles the tests into `build-test/`, then runs `node --test` with one process per file, in parallel
(each process takes a free port for its fake beeper-server, `test/env.ts`). It covers: the core's routes on a fake
connector, the packages on fake backends, the safeguards (session, origin, CSRF, notification links, SSRF of link
previews, media validation), the boundary between the core and the packages (`test/boundary.test.ts`), the contract
fingerprints (`test/contract.json`, `ext/*/contract.json`; `npm run contracts` records them again, on purpose, after
an intended version bump), the string catalogues (`test/i18n.test.ts`, `ext/build.test.ts`) and the whole build
(`ext/build.test.ts`: each package removed or turned off in turn, nothing left running).

### On any package list

The tests hold for any package list (`web/scripts/compose-packages.mjs`: `KLATCHLY_PACKAGES`, else `ext/packages.json`).
No core test (`test/`, `ext/*.test.ts`) names a particular package: `ext/build.test.ts` configures each package
through its own `ext/<id>/test/build-env.ts` (dead addresses, made-up keys) and only checks what holds for any list;
what holds for one package only is in that package's tests (`ext/<id>/test/`). `npm test` goes through
`scripts/run-tests.mjs`, which runs the core and whole-build tests, all the tests of the listed packages, and, for a
package present in the tree but not listed, those that do not load the build (`ext/packages.server.ts`) or say
`// klatchly-test: any-list` (the example package). For another list, the same command with `-e KLATCHLY_PACKAGES=…`:

```sh
docker run --rm --network none -u $(id -u):$(id -g) -v "$PWD":/src -w /src -e HOME=/tmp \
  -e KLATCHLY_PACKAGES=beeper,accounts,llm,writing,example node:24.22.1-trixie-slim \
  sh -c 'npm run typecheck && npm test && npm run build'
```

A list need not hold beeper: any connector will do (API 1.25: no connector is privileged). A package test that reads
Beeper's canned Desktop API through the build says so and is skipped on a build without it
(`{ skip: packages.some((p) => p.id === 'beeper') ? false : 'the build has no beeper package' }`, as in
`ext/accounts/test/package.test.ts`); one that only needs some connector next to its own adds a made-up one that claims
its chats (`fakeSource({ owns, ownsAccount })` of `test/fakesource.ts`).

The build keeps the last list it composed: run again without `KLATCHLY_PACKAGES` to go back to the tree's list. A
package of your own, from another folder, is tested the same way once it is in the list ([extensions.md](extensions.md),
"Testing").

## Personal data

No real identifier in the repository (code, comments, tests): no name, no Matrix ID, no phone number, no network ID,
no production domain. Tests use the synthetic identities of `web/test/fixtures/identities.ts` (the same people as the
offline fake beeper-server); when a test checks the shape of a real ID, the value has that shape with invented digits.
A case seen in production becomes invented data of the same shape (like `test/fixtures/callevent.ts`); real data, if
ever needed, only through a local file ignored by git or an environment variable, the test skipping without it —
never committed.

`test/privacy.test.ts` (part of `npm test`) walks `server`, `client`, `ext`, `test` and `scripts`: it refuses phone
numbers and network IDs that do not look synthetic (synthetic: `000`, `1234` or `555` in the digits), and personal
strings listed outside the repository, one per line, in `web/test/.privacy-denylist` (ignored by git; `/…/` for a
regular expression) or in `KLATCHLY_PRIVACY_DENYLIST` (comma-separated; pass it to the container with `-e`). Without
either, that part is skipped. Put your own name, domain and account ids there before you send a change.

## Continuous integration (GitHub Actions)

`.github/workflows/ci.yml`, with no secret, a read-only token and no deployment: it can run on any copy of the
repository (a fork included).

- **Tier 1** (Node 24) on every push to `main` and every pull request (except Markdown-only or `docs/`-only
  changes): `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, then the license check of what the image
  ships (`node scripts/licenses.mjs --check`: no GPL, AGPL or unknown license; [self-hosting.md](self-hosting.md),
  "Licenses and SBOM"). Without `web/test/.privacy-denylist`, the
  personal-strings part of `test/privacy.test.ts` is skipped. (A step for tests of components outside `web/` runs
  only where they exist in the tree.)
- **`npm audit`** (also every Monday, alone, for new advisories on unchanged dependencies):
  `npm audit --omit=dev --audit-level=high` **blocks** (production dependencies run in the process that holds the
  Beeper token), then a full `npm audit` as a report only (the build chain `vite-plugin-pwa` → `workbox-build`
  carries known low and moderate advisories, never in the image).
- **Offline end to end**: on demand only ("Run workflow", the `e2e` box, and optionally the scripts wanted): tier 1,
  the Playwright 1.48.0 client, then `run-offline.sh` in the pinned Playwright image; logs and screenshots uploaded
  as an artifact when a script fails.

`.github/dependabot.yml`: npm packages of `web/`, Docker base images (`web/Dockerfile`, `server/Dockerfile`: tag and
digest), GitHub actions (pinned by commit); weekly, minor and patch updates grouped; Node stays on 24. By hand: the
Playwright image of `run-offline.sh` and its client, the `node:24.x` image of this guide.

## 2. Before a release (a few minutes): every end-to-end script, offline

After tier 1 (it needs `build-test/` and `dist/`), from the repository root:

```sh
sh web/test/e2e/run-offline.sh                   # every script of the build, 5 at a time
sh web/test/e2e/run-offline.sh composer.e2e.js   # only those named (paths from web/test/e2e)
JOBS=1 sh web/test/e2e/run-offline.sh            # one at a time
KLATCHLY_PACKAGES=beeper,accounts,llm,writing,example sh web/test/e2e/run-offline.sh   # checks the build has this list
```

The Playwright client must be in `web/test/e2e/node_modules` (`npm install --no-save playwright@1.48.0` there, once,
with network); the scripts themselves run in the pinned Playwright image without network.

The instances run the build's packages (the list tier 1 compiled `build-test/` and `dist/` with: for another list,
tier 1 with `-e KLATCHLY_PACKAGES=…`, then `run-offline.sh` with the same variable, which refuses a build composed
otherwise). The scripts are the core's (`test/e2e/*.e2e.js`; they name no package: spaces are read from
`/api/extensions`) and those of each package of the build (`ext/<id>/test/*.e2e.cjs`). Order: the longest first, from
the durations of the last run (`$SHOTS/.durations.json`), else by size.

One offline instance per runner (`test/e2e/offline/server.mjs`): the compiled app, every package of the list on, each
on a fake service of the same process. The core's fakes, in `test/e2e/offline/`:

- `beeper.mjs` — the Desktop API (beeper-server): Beeper, WhatsApp, Telegram, Discord and LINE accounts; about fifteen
  chats (one-to-one, a group of five with a scheduled call, a long history, albums, a video, a voice note, PDFs, a
  reply to a photo, a LINE image reaction, unread, low-priority and archived chats, a busy archived group of 300
  messages for `scrollup.e2e.js` (its per-frame recorder, `scrollrec.js`, is shared with the Zalo package's
  `scrollzalo.e2e.cjs`): photos and stickers with and without their size, albums, link previews, voice notes,
  replies, reactions, several days); the test chat
  `!test:beeper.local` (archived, long, read and delivered receipts, an edit, a deletion, a reply, a voice note, a PDF,
  a link, a captioned album). Reads, searches (chats, messages, media), media (with `Range`), upload, send (Markdown
  rendered as rich text, chat unarchived), edit, delete, reactions, read state, archive, flags, contacts, bridge
  capabilities; its websocket (`/v1/ws`) carries the events of those writes. Test hooks: `POST /__reset`,
  `/__inject` (an incoming message in the test chat), `/__inject/group` (the same in the WhatsApp group),
  `/__inject/react` (a reaction "from another device"), `GET /__calls` (the reads the Desktop API received since the
  last `__reset`, plus what the packages' fakes add: discreet reading checks that no receipt goes out) and
  `POST /__<name>`, the hooks the packages' fakes register (`offline/harness.mjs`: `hook()`, `track()`). It stays in
  the core (not in `ext/beeper/`): the core's e2e scripts run on Beeper's chats (so an e2e build lists beeper),
  and `run.mjs` goes through its hooks;
- `web.mjs` — the web of link previews (example.com, example.org, github.com, over HTTP and HTTPS on their usual
  ports, with a certificate made for the session) behind the real SSRF guard: only its name resolution is replaced;
- `oidc.mjs` — an OIDC provider (`test/fakeidp.ts` compiled by `npm test`, on `127.0.0.1`: another site than the
  app), only with `R_OIDC=1` (`oidc.e2e.js`): its authorization page offers "the owner" or "someone else".

Each package of the list brings its own, `ext/<id>/test/offline.mjs` (found from the build, `offline/packages.mjs`):
`start({ dir, index, reset })` returns `{ env }` (set before the app is imported), and when needed `reset()` (before
each script) and `patchApp(built)`. For example, `llm` brings an OpenAI-compatible model (invented models, answers
derived from the prompt: corrections, translations, a test), and on the same port a second, OpenRouter-like provider
(`/second/api/v1`: a public list with names, `/key`, its own key) and an address that redirects (`/redirect/v1`), for
Settings → Providers. `agents` brings no service: with `hermes` in the build it writes a manifest for the hermes fake's
profiles; without it, none (no Agents space then), and it clears the agents a script made in Settings → Agents (LLM)
before each script; its scripts that need the Agents space say "skipped" on such a build. The `hermes` fake (`ext/hermes/test/offline.mjs`) keeps, besides Klatchly's conversations, sessions started elsewhere (Telegram, WhatsApp, a terminal one, an extra source set through `KLATCHLY_HERMES_EXTRA_SOURCES`, scheduled runs that are never listed) and three scheduled tasks; it tracks the read marks Klatchly sends (`hermesReadMarks` in `GET /__calls`) and `POST /__inject/hermes-telegram` adds a message to a Telegram session (`agentsources.e2e.cjs`); it pauses and
resumes its tasks as Hermes does (`hermesJobControls` in `GET /__calls`), `POST /__hermes-jobs-fail` makes the next one
fail and `POST /__hermes-jobs-control` with `off` turns the app's `jobsControl` capability off (`agentjobs.e2e.cjs`). A connector package brings a fake of its gateway the same way, with its own `/__inject/<id>`
hooks (the `zalo` fake also holds a busy archived chat for `scrollzalo.e2e.cjs`, `juicechat.mjs`: ≈ 550 messages over
34 days, long texts, photos with and without their size, expired photos and files it answers 404 for, stickers,
reactions, receipts); how to write one: [extensions.md](extensions.md), "End to end, offline".

Before each script, `offline/run.mjs` resets every fake service to its starting state: each script sees the same
data, whatever the order. A script that changes the instance for everyone says so on its first line,
`// e2e-instance: alone [NAME=value…]`, and gets an instance of its own: `extensions.e2e.js`, `auth.e2e.js`,
`oidc.e2e.js` (`R_OIDC=1`: the fake OIDC provider), `providers.e2e.cjs` (`ext/llm/test/`: it adds and removes
providers) and `accounts.e2e.cjs` (`R_ACCOUNTS=1`: four accounts, one to reconnect). On one instance, the scripts
share a passkey (`SESSION_FILE`): enrollment is limited to 5 per 10 minutes, even offline.

One line per script (duration, number of checks), a summary, exit code 1 if a script failed; a script that does not
finish within `SCRIPT_TIMEOUT` seconds (600) is killed and counted as failed; logs and screenshots in
`web/test/e2e/shots/` (`SHOTS=` for elsewhere). The longest, `reactions`, takes ≈ 2 min; `media` ≈ 1 min. In the
scripts, wait for a state (the list still, the animation over, the video moving) rather than a fixed delay: under the
load of five scripts at once, a pause ends too early (or too late: the 2 s video already over), and the speed of a
gesture is measured in the page (a fast swipe is sent in one go, not paced by the script). A few scripts measure
timings (`scroll`, `persist`): on a loaded machine, run a failed one again alone (`JOBS=1`) before calling it a
failure.

What cannot be simulated: the real behaviour of the networks (bridges, delays, the exact format of a new kind of
message), of a real model or a real agent runtime. A format difference seen in production becomes a case of the fake
service (like `test/fixtures/callevent.ts`).

Debugging a script: `JOBS=1 sh web/test/e2e/run-offline.sh <script>` (log and screenshots in `web/test/e2e/shots/`).

## 3. The image

```sh
docker build -t klatchly:review web
```

Run a `--network none` container with a fake token file: check `/healthz` and the packages announced at start, then
remove the container and the `klatchly:review` tag (and the untagged image the build left).

## After a deployment (optional, read-only)

Without a passkey or a browser: the version served and the health.

```sh
B=https://klatchly.example.org
curl -fsS "$B/healthz"; echo                                   # ok
# the version (public since 0.24.0 in the worker's private-cache script, e.g. `VERSION = '0.25.4'`; the app's own
# chunks are served to a session only)
curl -fsS "$B/sw-app.js" | grep -o "VERSION = '[0-9]*\.[0-9]*\.[0-9]*'"
```

No test script reaches a production beeper-server or reads `secrets/`. A difference that only shows with the real
networks becomes a case of the fake services.
