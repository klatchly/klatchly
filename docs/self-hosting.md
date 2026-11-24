# Self-hosting Klatchly

How to run Klatchly (beeper-server + Klatchly) on your own server with Docker Compose: requirements, configuration, the
first run, passkeys and the optional OIDC sign-in, a reverse proxy, updates, backups and troubleshooting. Building
beeper-server, signing it in to your Beeper account and creating the token file are detailed in
[beeper-server.md](beeper-server.md); this guide links to it at the right step.

Klatchly is an unofficial project: it uses the official headless Beeper Server, which you download from Beeper when you
build its image, under Beeper's terms. Nothing from Beeper is redistributed here.

## Requirements

| What | Detail |
|---|---|
| A Linux x86-64 host | The official beeper-server build is `linux-x64`. About 2 GB of memory for both containers (limits: 1.5 GB and 256 MB in `compose.yml`), and disk for the history and media. |
| Docker Engine with Compose v2 | `docker compose version`. The images are built locally (`pull_policy: never`). |
| A domain name and HTTPS | Passkeys need a secure origin: a public `https://` address served by a reverse proxy (Caddy, nginx…) or Cloudflare Tunnel. For a local test only, `http://localhost` works. |
| A Beeper account | And another device already signed in to it (Beeper Desktop or mobile) to verify the server's device, or the account's recovery key. |
| An otherwise unused uid/gid | Both containers run as `KLATCHLY_UID:KLATCHLY_GID` (default `10001`) and own their volumes and secret files. |
| `python3` on the host | Only for the sign-in step of beeper-server (the token is extracted without being printed). |
| A passkey authenticator | A phone, a password manager or a security key, on the devices you will use Klatchly from. |

## Files

Everything sits at the root of the repository, next to `compose.yml`:

| File | Committed | What it is |
|---|---|---|
| `compose.yml` | yes | The two services, beeper-server and Klatchly, with their hardening (read-only root, all capabilities dropped, `no-new-privileges`, memory and pid limits, no published port for beeper-server, Klatchly published on `127.0.0.1` only). The only writable places are the data volumes, `/tmp`, and beeper-server's cache volume, where the official binary unpacks its own application on first start ([beeper-server.md](beeper-server.md), § 2). It reads every instance value from variables. Do not edit it: upgrades replace it. |
| `.env` | no | Your values. Start from `.env.example`. |
| `compose.override.yml` | no | Optional. Anything specific to your host: extra networks, extra services, extra secrets, packages from another folder. Docker Compose reads it automatically and merges it over `compose.yml`. |
| `secrets/` | no | One file per secret, mode 0400, owned by `KLATCHLY_UID`. Never put a secret value in `.env`. |
| `deploy/Caddyfile.example` | yes | A reverse-proxy example for Caddy on the host. |

```sh
cp .env.example .env            # then edit it (below)
docker compose config           # check the resolved configuration; changes nothing
```

Do not start everything yet: Klatchly needs the Beeper token file, which only exists once beeper-server is signed in
([First run](#first-run)).

## Variables (`.env`)

Required:

| Variable | Example | Meaning |
|---|---|---|
| `KLATCHLY_ORIGIN` | `https://klatchly.example.com` | The exact public address (scheme, host, optional port; no path). Cookies, WebAuthn, origin checks and notification links rely on it, never on `Host` or `X-Forwarded-*`. |
| `KLATCHLY_RP_ID` | `klatchly.example.com` | The WebAuthn relying-party ID: the origin's host or a parent domain. A passkey made for one RP ID does not work for another. |
| `BEEPER_TOKEN_PATH` | `./secrets/beeper-token` | The Beeper token file ([beeper-server.md](beeper-server.md)), mounted at `/run/secrets/beeper_token`. |

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `KLATCHLY_ALT_ORIGINS` | empty | Other origins still served, comma-separated (an old address after a move). Each is its own RP ID (its host): a passkey made on one address only works there. Notifications and links use `KLATCHLY_ORIGIN`. |
| `COMPOSE_PROJECT_NAME` | `klatchly` | Compose project name, the prefix of the volumes (`<project>_klatchly-data`…) and of the default network. |
| `KLATCHLY_TZ` | `UTC` | Time zone of both containers. |
| `KLATCHLY_UID`, `KLATCHLY_GID` | `10001` | The uid/gid both containers run as, which owns their volumes. Pick an otherwise unused uid. They are also build arguments: rebuild after a change, and give the secret files to that uid. |
| `KLATCHLY_PORT` | `8080` | Host port of Klatchly, always on `127.0.0.1`. |
| `KLATCHLY_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | Proxies (CIDR) whose client-IP header is believed. A proxy on the host reaches the container from the Compose network's gateway, not from 127.0.0.1: add it (`docker network inspect <project>_default --format '{{json .IPAM.Config}}'`). |

Sign-in through an OIDC provider (optional; empty issuer: passkeys only, nothing changes):

| Variable | Default | Meaning |
|---|---|---|
| `KLATCHLY_OIDC_ISSUER` | empty | The provider's issuer (`https://`; discovery at `/.well-known/openid-configuration`). Adds "Continue with <label>" next to the passkeys. At the provider, register the redirect URI `KLATCHLY_ORIGIN` + `/api/auth/oidc/callback` (authorization code, PKCE S256, scope `openid`). |
| `KLATCHLY_OIDC_CLIENT_ID` | empty | Required with the issuer. |
| `KLATCHLY_OIDC_CLIENT_SECRET_FILE` | empty (public client, PKCE only) | Path of the client secret in the container, e.g. `/run/secrets/oidc_client_secret` (the secret itself: `compose.override.yml`, below). Never the value in `.env`. |
| `KLATCHLY_OIDC_LABEL` | the issuer's host | The button's label. |
| `KLATCHLY_OIDC_SCOPES` | `openid` | `openid` is always added. |
| `KLATCHLY_OIDC_ALLOWED_SUB` | empty | A subject (`sub`) pinned here. Otherwise pin your account with an enrollment code: `cli.js enroll`, open `/enroll`, "Link a <label> account". Only the pinned issuer + subject signs in, never by e-mail. |

A half-done setup (a client id without an issuer, an unreadable secret file) stops the start. Keep a passkey as a
fallback for when the provider is down.

Packages:

| Variable | Default | Meaning |
|---|---|---|
| `KLATCHLY_PACKAGES` | empty (the tree's list) | Packages built in, comma-separated ids. Rebuild after a change. |
| `KLATCHLY_LLM_URL`, `KLATCHLY_LLM_MODEL` | empty | `llm` + `writing`: the server's own OpenAI-compatible provider (others can be added in Settings). Empty URL: none. |
| `KLATCHLY_LLM_FALLBACK` | empty | Default fallback model. |
| `KLATCHLY_LLM_LABEL` | empty | Who answers, shown in the writing menu's privacy line: a name, or `{"en": …, "fr": …}` (`en` required). |
| `KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE` | empty | `transcribe`: the path, in the container, of the NVIDIA API key file (a secret, below) for the server's own speech-to-text provider, NVIDIA's hosted Riva models. Empty: none (providers can still be added in Settings → Transcription). Set but missing or empty: the package stays off with its reason. |
| `KLATCHLY_TRANSCRIBE_NVIDIA_MODEL` | `whisper-large-v3` | `transcribe`: its model: `whisper-large-v3`, `parakeet-1.1b-rnnt-multilingual`, `canary-1b`, `parakeet-ctc-0.6b-vi`, or an NVCF function id. |
| `KLATCHLY_TRANSCRIBE_NVIDIA_LANGUAGE` | empty | `transcribe`: its language. Empty: automatic detection (Whisper, Parakeet multilingual); otherwise a code such as `fr-FR` (required by `canary-1b` and `parakeet-ctc-0.6b-vi`: without it the package stays off with that reason). |
| `KLATCHLY_AGENTS_FILE` | empty | `agents`: the path, in the container, of its manifest (below, [Agents manifest](#agents-manifest)), e.g. `/config/agents.json`. Empty: the agents come from their runtimes (`KLATCHLY_HERMES_AGENTS`), with nothing declared about them, plus those made in Settings → Agents (LLM). |
| `KLATCHLY_AGENTS_OWNER_NAME` | empty | `agents`: on whose behalf the agent writes when the manifest has no `owner` (empty: the user's name in the chat). |
| `KLATCHLY_AGENTS_LABEL` | empty | `agents`, without a manifest only: where a chat's messages go at each call, shown in every agent's privacy line. |

Values with spaces or JSON go in single quotes: `KLATCHLY_LLM_LABEL='{"en":"OpenAI","fr":"OpenAI"}'`. A variable set in
your shell wins over `.env`.

## `compose.override.yml`

Anything that only exists on your host. Lists (secrets, volumes, networks) are appended to those of `compose.yml`,
maps (environment) are merged. Examples:

The LLM provider's key (required as soon as `KLATCHLY_LLM_URL` is set):

```yaml
services:
  klatchly:
    secrets: [llm_key]
secrets:
  llm_key:
    file: ./secrets/llm-key
```

The NVIDIA API key of the `transcribe` package's server provider (with
`KLATCHLY_TRANSCRIBE_NVIDIA_KEY_FILE=/run/secrets/transcribe_nvidia_key` in `.env`; the file readable by `KLATCHLY_UID` only):

```yaml
services:
  klatchly:
    secrets: [transcribe_nvidia_key]
secrets:
  transcribe_nvidia_key:
    file: ./secrets/transcribe-nvidia-key
```

Voice notes are sent to the provider only when a user taps Transcribe under one; the text is kept in
`/data/transcripts.json` (Settings → Transcription → Clear forgets them all).

The OIDC client's secret (with `KLATCHLY_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc_client_secret` in `.env`):

```yaml
services:
  klatchly:
    secrets: [oidc_client_secret]
secrets:
  oidc_client_secret:
    file: ./secrets/oidc-client-secret
```

Packages from another folder (`<id>/` folders, and an optional `packages.json` that replaces the list):

```yaml
services:
  klatchly:
    build:
      additional_contexts: {extra: ../my-packages}
```

A package runs inside the Klatchly server with its full rights: read its code before you build it in. Writing a
package, its security model and how to test it: [extensions.md](extensions.md); the API and its versions:
[extension-api.md](extension-api.md).

An extra network, for example one shared with a model router running in another Compose project:

```yaml
services:
  klatchly:
    networks:
      llm: {}
networks:
  llm:
    external: true
```

Keep `default` in the service's networks: `compose.yml` lists it, so an override only adds to it.

The agents manifest (with `KLATCHLY_AGENTS_FILE=/config/agents.json` in `.env`; the file is not a secret, it only has to
be readable by `KLATCHLY_UID`):

```yaml
services:
  klatchly:
    volumes:
      - ./agents.json:/config/agents.json:ro
```

## First run

1. **Configure.** `cp .env.example .env`, then set at least `KLATCHLY_ORIGIN`, `KLATCHLY_RP_ID` and `KLATCHLY_PORT`, and pick
   `KLATCHLY_UID` / `KLATCHLY_GID`. `docker compose config` must succeed.
2. **Build the images.** `docker compose build` (beeper-server downloads Beeper's archive and checks its sha256;
   Klatchly compiles the app with the packages of `KLATCHLY_PACKAGES`). A few minutes the first time.
3. **Sign in beeper-server.** Start it alone (`docker compose up -d beeper-server`; on this first start the binary
   unpacks its application into the `beeper-cache` volume, about ten seconds, then reuses it), sign it in to your Beeper
   account, verify its device and write the token file without ever printing it: [beeper-server.md](beeper-server.md),
   § 3 to § 6. Until it is signed in, never publish its port (anyone reaching it could sign it in to their account).
4. **Start Klatchly.** `docker compose up -d klatchly`, then `docker compose logs klatchly | tail -n 20`: the
   packages it announces, no token error. `curl -fsS http://127.0.0.1:$KLATCHLY_PORT/healthz` answers `ok`.
5. **Set up the reverse proxy** ([Reverse proxy](#reverse-proxy)) so that `KLATCHLY_ORIGIN` reaches Klatchly over HTTPS.
6. **Enroll your first passkey** ([Passkeys](#passkeys)).

Local test without a proxy (the origin must be the browser's address):
`KLATCHLY_ORIGIN=http://localhost:8080 KLATCHLY_RP_ID=localhost docker compose up -d` (a variable set in your shell wins over
`.env`). On an `http://` origin, browsers refuse `__Host-` cookies, so the session cookie is then called `sid` (still
`Secure`, `HttpOnly`, `SameSite=Strict`); on `https://` it is always `__Host-sid`. A passkey created for `localhost`
does not work for your domain, and the reverse.

## Passkeys

Klatchly has no password: you sign in with a passkey (and optionally through an OIDC provider, below). A new device is
enrolled with a one-time code from the server:

1. `docker compose exec klatchly /nodejs/bin/node /app/dist/cli.js enroll` prints a 20-character code (100 bits),
   valid 10 minutes, single use (only its SHA-256 is stored).
2. Open `KLATCHLY_ORIGIN/enroll` (e.g. `https://klatchly.example.com/enroll`), type the code, then confirm with your
   authenticator. You are signed in at once.
3. Repeat for each device, or, from a device already signed in: Settings → General → Sign-in → "Manage…" → "Add a
   passkey". The other devices are told (a notification "New passkey added" if they have notifications on, and a
   mark in Settings), so an unknown passkey can be removed there, followed by "Sign out all other devices".

The command line works whatever the state, so you cannot be locked out while you have shell access to the host:

```sh
X="docker compose exec klatchly /nodejs/bin/node /app/dist/cli.js"
$X enroll                 # enrollment code (adds a passkey, or links the OIDC provider's account)
$X codes revoke-all       # cancels every unused enrollment code
$X sessions list          # active sessions (hash prefix, dates, end, device)
$X sessions revoke <prefix>
$X sessions revoke-all    # signs everyone out (sockets closed within 30 s, push subscriptions removed)
$X passkeys list          # passkeys (id, label, dates, device it was added from)
$X passkeys rename <id> <label>
$X passkeys remove <id>   # the last one only with --force (nobody can sign in again before enroll)
$X push list              # push subscriptions (no URL, no keys)
$X push clear
$X auth status            # passkeys, OIDC provider (issuer, linked account, pinned subject)
$X auth oidc unlink       # unlinks the provider's account (its sessions stay: sessions revoke-all)
$X health                 # used by the healthcheck
```

The CLI and the server write `state.json` under the same lock, so an emergency command such as
`sessions revoke-all` cannot be undone by a concurrent write of the server.

## Sign-in with an OIDC provider

Optional: Klatchly can delegate the proof of identity to an OpenID Connect provider you already run (Pocket ID,
Authelia, authentik, Keycloak, Kanidm…); the provider decides how people authenticate (passkey, password + TOTP,
social login…). Without any `KLATCHLY_OIDC_*` variable, nothing changes.

1. **At the provider**, create an OIDC client ("application") for Klatchly:
   - redirect URI: `KLATCHLY_ORIGIN` + `/api/auth/oidc/callback`, exactly, e.g.
     `https://klatchly.example.com/api/auth/oidc/callback`;
   - "authorization code" flow, PKCE S256; a confidential client (with a secret) or a public one (PKCE only);
   - scope `openid` is enough (Klatchly reads neither the e-mail nor the profile).
2. **In Klatchly**, set the `KLATCHLY_OIDC_*` variables of `.env` (table above), with the client secret as a file mounted by
   `compose.override.yml` (example above; a `KLATCHLY_OIDC_CLIENT_SECRET` variable is refused), then
   `docker compose up -d klatchly`. The issuer must be `https://`. The start log says
   `oidc=<host> oidcPinned=true|false`.
3. **Pin your account**, or the provider lets nobody in (the callback page explains it):
   - **with an enrollment code** (recommended): `cli.js enroll`, open `/enroll`, type the code, "Link a <label>
     account", sign in at the provider: Klatchly stores the issuer + subject it returns and opens the session;
   - **from the environment**: `KLATCHLY_OIDC_ALLOWED_SUB=<subject>` (the provider's `sub`, not the e-mail). A refused
     attempt logs the subject (`oidc rejected reason=not_allowed … sub=…`): you can copy it from there.

   Another account of the same provider (family, a colleague) is refused, even with the same e-mail address.
4. **Sign in**: "Continue with <label>" on the sign-in page.

Sensitive settings ask a session opened through the provider to sign in there again (`prompt=login`, `max_age=0`);
a provider that ignores these parameters and returns an old sign-in is refused. Keep at least one passkey: if the
provider is down, passkeys still work. On iPhone, the installed app (PWA) may open the provider outside the app
depending on the iOS version; the passkey is the simplest way there.

Provider examples (check the exact labels in your provider's version):

- **Pocket ID**: Administration → OIDC Clients → Add; Callback URL `https://klatchly.example.com/api/auth/oidc/callback`;
  "Public client" for a client without secret (PKCE). `KLATCHLY_OIDC_ISSUER` = Pocket ID's address.
- **Authelia** (`configuration.yml`):

  ```yaml
  identity_providers:
    oidc:
      clients:
        - client_id: Klatchly
          client_name: Klatchly
          client_secret: '$pbkdf2-sha512$…'      # the secret's hash; the plain secret goes in Klatchly's secret file
          redirect_uris: ['https://klatchly.example.com/api/auth/oidc/callback']
          scopes: ['openid']
          grant_types: ['authorization_code']
          response_types: ['code']
          require_pkce: true
          pkce_challenge_method: S256
          token_endpoint_auth_method: client_secret_basic
          authorization_policy: two_factor
  ```

  Authelia's subject is an opaque id per user: pinning with an enrollment code avoids looking it up.
- **authentik**: Applications → Providers → Create → "OAuth2/OpenID Provider", client type "Confidential", redirect
  URI as above (strict); then an Application using that provider (slug `klatchly`).
  `KLATCHLY_OIDC_ISSUER=https://authentik.example.com/application/o/klatchly/` (the "OpenID Configuration Issuer" shown by the
  provider).

## Agents

The `agents` package shows the agents of **your** instance: an agent that can sit in a chat (its Agent panel) and,
with a runtime that keeps conversations, the Agents space. An agent runs on a **runtime**:

| Runtime | Package | What its agents can do |
|---|---|---|
| `hermes` | `hermes` (Hermes Agent's api_server) | Everything: tools (as its profile allows), conversations in the Agents space, streamed replies, stop, approvals, images, group conversations, messages it posts itself. |
| `llm` | built into `agents`, on the `llm` package | Answer from a model with its instructions: no tools, no memory, no conversations (so no Agents space), chats only. Its access is `limited` for sure. |

With `agents` and `llm` alone (no `hermes`), there is no Agents space button; the agent in a chat works with the
`llm` runtime's agents. Where they come from:

- **Settings → Agents (LLM)**, for the `llm` runtime: name, colour, description and instructions (a persona), made
  and changed by you, each change behind a recent sign-in or confirmation; kept in the data volume
  (`agents-llm.json`). Each agent is listed in Settings → Default models (`Agent: <name>`), where its model is
  chosen (the server's default models until then). Its privacy line names that model's provider (`KLATCHLY_LLM_LABEL`
  for the server's own models, the provider's name otherwise).
- **The manifest** (below), for the agents you host: Hermes profiles, or `llm` agents you prefer to declare in a file
  (shown read-only in the Settings page). An agent of the Settings page never takes an id of the manifest's.

## Agents manifest

Which hosted agents exist, and what Klatchly shows and says about each one, is written in one JSON file, the manifest:
the code names no agent. Start from `web/ext/agents/agents.example.json`; the reference is the comment at the top of
`web/ext/agents/server/manifest.ts`.

```json
{
  "version": 1,
  "owner": "Alex",
  "chatDefault": "chat",
  "agents": [
    { "id": "default", "label": "Main agent", "access": "full", "accessNote": "files, code, browser…",
      "disclosure": "Hermes on this server, then the model provider", "helpers": ["assistant"] },
    { "id": "assistant", "label": "Assistant", "color": "#2f8a7a", "access": "extended", "inbox": "Mail recaps" },
    { "id": "chat", "label": "Agent", "offer": ["chat"], "access": "limited", "accessNote": "web search only, no memory" }
  ]
}
```

Top level:

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | `1`. |
| `agents` | yes | 1 to 32 agents, in display order. |
| `owner` | no | On whose behalf an agent writes in a chat (it writes from your account). Else `KLATCHLY_AGENTS_OWNER_NAME`, else your name in that chat. |
| `chatDefault` | no | The agent first offered in a chat's Agent panel. Else the first agent offered in chats with `access` `limited`, else the first offered only in chats, else the first offered in chats. |

Per agent:

| Key | Default | Meaning |
|---|---|---|
| `id` | required | Stable id in Klatchly (conversations, chats' settings): `[a-z0-9][a-z0-9_-]{0,31}`, for `llm` `[a-z][a-z0-9-]{0,31}`. With Hermes, the profile name; `default` is Hermes' own profile, always in the Agents space and never with an inbox (Hermes applies this itself). |
| `runtime` | `hermes` | `hermes` or `llm` (see [Agents](#agents)). An agent whose runtime is not in the build, or is off, is not offered. |
| `profile` | the `id` | The runtime's name for it; for now it must be the `id`. |
| `instructions` | none | `llm` only: its standing instructions (a persona), 4000 characters at most. |
| `label` | the `id` | Shown name (40 characters at most); also the default mention word and the `[label]` prefix of its messages in a chat. |
| `color` | picked from the `id` | `#rrggbb`. Picked colours depend on the id only (adding an agent never changes another's), but two agents may get the same one. |
| `description` | none | Shown under its name (200 characters at most). |
| `offer` | `["space", "chat"]` (`llm`: `["chat"]`) | Where it is offered: the Agents space, a chat's Agent panel, or both. `llm`: chats only. |
| `helpers` | none | Agents it may hand work to when it leads a conversation (other agents of the same runtime offered in the space). Not for `llm`. Hermes needs the same profiles in the lead's `delegation.backends.profile_routes`. |
| `inbox` | none | Title of the pinned conversation that receives the messages the agent posts itself (the `klatchly` platform in its Hermes profile). Not for `llm`. |
| `access` | none | What **you, the host, declare** the agent can reach: `limited`, `extended` or `full`. Klatchly cannot check it (Hermes does not expose a profile's tools) and shows it as is. `llm`: always `limited` (Klatchly guarantees it: no tools), nothing else accepted. |
| `accessNote` | none | What that access means for this agent ("web search only, no memory"), shown next to it (120 characters at most). |
| `disclosure` | none | Where a chat's messages go when the agent is called, completing the privacy line "The last 20 messages of this chat are sent to the agent (…) at each call" (200 characters at most). `llm`: absent, the provider of its model. |

Texts (`description`, `accessNote`, `disclosure`) are a string for every language or an object by language code,
`{"en": "…", "fr": "…"}`: the language shown, else English, else the first one. Keys that start with `//` are
comments, anywhere (JSON has no comments).

What `access` changes, in a chat's Agent panel (where other people's messages are read by the agent):

| `access` | Shown |
|---|---|
| `limited` | "limited: <accessNote>" next to the agent, no warning. |
| `extended` | A warning: it has more tools than the limited agent (<accessNote>). |
| `full` | A warning: it has a terminal and all its tools (<accessNote>). |
| absent | The strongest warning: you did not say what it can reach, assume a terminal and all its tools. Never the reverse: Klatchly never treats an undeclared agent as limited. |

A missing `disclosure` makes the privacy line say that you did not say where the agent passes the messages on.
Write it as what really happens: the runtime, and the model provider behind it.

Checks: the manifest is read when Klatchly starts. An unknown key, a wrong type or value, a duplicate id, a helper
or a `chatDefault` that names no suitable agent, an unreadable file, or a `.yaml` file (YAML is not read yet) turns
the `agents` package **off**; Settings → Extensions and the log say which field. Nothing is guessed. Restart
Klatchly after editing the file.

With Hermes: each agent is a Hermes profile served by one multiplexed gateway (`gateway.multiplex_profiles: true`),
reached with its own key: the secret `hermes_key` for `default`, `hermes_key_<id>` beside it for the others (and
`hermes_inbound_key_<id>` for an agent with an `inbox`). An agent without a key, or whose profile does not answer,
is shown as unavailable and nothing is sent to it. Hermes' own profile is always there: left out of the manifest,
it is added to the Agents space (not offered in chats) with nothing declared.

Without a manifest, the agents come from `KLATCHLY_HERMES_AGENTS` (a JSON list of `{name, label, description, helpers,
space, inbox}`), every one offered in chats, with nothing declared about access (so the strongest warnings), and
`KLATCHLY_AGENTS_LABEL` as every agent's disclosure; the agents of Settings → Agents (LLM) come after them.

The Agents space shows only while a runtime that keeps conversations (Hermes) is on and offers an agent there: turn
`hermes` off in Settings → Extensions and the space button goes, the agent in a chat stays.

With Hermes, the space also lists each agent's conversations started elsewhere (agents 3.1, hermes 2.1), read-only
with their source and a "Continue in Klatchly" action: Telegram, WhatsApp, Discord, Slack, Signal, Matrix, e-mail, SMS
and Hermes' terminal (`cli`, hidden until the list's filter shows it). Hermes filters its sessions by one source at a
time, so Klatchly asks once per source (cached a minute); `KLATCHLY_HERMES_EXTRA_SOURCES` adds sources (comma-separated, e.g.
a platform plugin's name). Scheduled tasks are never listed as conversations: an "Automations" entry shows them
(`GET /api/jobs`), their results still arrive in the agent's inbox conversation. Since agents 3.2 / hermes 2.2 a task can
be paused and resumed there (a confirmation names the task and what pausing stops; Hermes' `POST
/api/jobs/{id}/pause` and `/resume`, without a body, only for a task Klatchly listed); running, editing or removing a task
stays in Hermes (Klatchly's allowlist refuses those calls). Klatchly keeps its own unread
counts and tells Hermes its read state (`PATCH /api/sessions/{id}` with `{"unread": …}`, best effort).

## Reverse proxy

Klatchly listens on `127.0.0.1:KLATCHLY_PORT` in plain HTTP. Something in front must terminate TLS for `KLATCHLY_ORIGIN`.
Everything that matters (cookies, WebAuthn, origin checks for CSRF and the WebSocket, notification links) relies on
`KLATCHLY_ORIGIN`, never on `Host`, `X-Forwarded-Proto` or the URL the server sees. Klatchly sets its own security headers
(CSP, HSTS…); the proxy passes them as they are.

Whatever the proxy:

- do not buffer `/api/ws` (WebSocket) or `/api/media` (streamed media, `Range` requests);
- allow request bodies up to 101 MB on `/api/upload` (Klatchly caps uploads at 100 MB), and keep it out of any web
  application firewall that caps bodies lower (many reject anything over a few MB);
- mask the `url` query parameter of `/api/media` in access logs (it identifies a media file);
- declare the proxy in `KLATCHLY_TRUSTED_PROXIES`, or every visitor gets the proxy's address (rate limits, session and
  device lists).

Authentication is Klatchly's own: an unauthenticated request gets 200 (the app) or a 302 to `/`, never 401/403; a refused
WebSocket gets 400. Since 0.24.0 the app's own code is private too: a signed-out visitor gets the sign-in screen's
files only, and any other file under `/assets/` is a 302 to `/` (`Cache-Control: no-store`, like every signed-out redirect) without a session, served with
`Cache-Control: private, max-age=31536000, immutable` with one. A cache in front (a CDN, Cloudflare) must honour the
origin's `Cache-Control` on `/assets/`: never add a rule that caches those files for everyone. The device APIs under `/api/bearer/` (a package's API for scripts and shortcuts) answer a missing or bad
token with 400 `{"error":"bad_token"}` and too many requests with 429; a firewall in front must let their JSON bodies
through (a few KB at most) and must not add authentication of its own there (a Shortcut sends no cookie).

### Caddy on the host

`deploy/Caddyfile.example`: replace `klatchly.example.com` with your domain and `8080` with `KLATCHLY_PORT`; Caddy gets the
certificate itself. Caddy reaches the container through the published port, so Klatchly sees the connection coming from
the Compose network's gateway, not from 127.0.0.1. Find it and add it:

```sh
docker network inspect klatchly_default --format '{{json .IPAM.Config}}'   # e.g. [{"Subnet":"172.18.0.0/16","Gateway":"172.18.0.1"}]
```

```sh
KLATCHLY_TRUSTED_PROXIES=127.0.0.1/32,::1/128,172.18.0.1/32
```

Any other proxy (nginx, Traefik, HAProxy) works with the same rules: `X-Forwarded-For` is read from trusted peers
only, walked from the right.

### Cloudflare Tunnel

TLS ends at Cloudflare, and `cloudflared` forwards plain HTTP to the local port.

1. **Origin**: `KLATCHLY_ORIGIN=https://klatchly.example.com` and `KLATCHLY_RP_ID=klatchly.example.com` (or the parent domain),
   exactly the public address.
2. **Ingress** (`config.yml` of cloudflared), over HTTP to the local port:

   ```yaml
   ingress:
     - hostname: klatchly.example.com
       service: http://localhost:8080
     - service: http_status:404
   ```

   The tunnel carries the WebSocket with no setting.
3. **Client address**: cloudflared sets `Cf-Connecting-Ip` and `X-Forwarded-For`.
   - cloudflared → Caddy → Klatchly: nothing changes on Klatchly's side (Caddy is the trusted proxy, as above); for Caddy to
     pass on the real client, make it trust cloudflared (`trusted_proxies static 127.0.0.1/32` and
     `client_ip_headers Cf-Connecting-Ip` in Caddy's global `servers` options), otherwise every visitor has
     cloudflared's address;
   - cloudflared → Klatchly directly: set `KLATCHLY_CLIENT_IP_HEADER=cf-connecting-ip` and add, in `KLATCHLY_TRUSTED_PROXIES`,
     the address cloudflared comes from: the Compose network's gateway if cloudflared runs on the host (as above), or
     the shared network's block if cloudflared is itself a container on a network shared with Klatchly (e.g.
     `172.19.0.0/16`). `compose.yml` does not pass `KLATCHLY_CLIENT_IP_HEADER`: add it in `compose.override.yml`:

     ```yaml
     services:
       klatchly:
         environment:
           KLATCHLY_CLIENT_IP_HEADER: cf-connecting-ip
     ```

   A header is only believed from a declared peer: never publish Klatchly's port anywhere but `127.0.0.1`.
4. **TLS up to Klatchly** (optional, for Cloudflare's "Full (strict)"): give Klatchly a certificate (a Cloudflare origin
   certificate or another) with `KLATCHLY_TLS_CERT` and `KLATCHLY_TLS_KEY` (both together: paths of secret files mounted by
   `compose.override.yml`, the variables set in its `environment`; Klatchly then listens in HTTPS), and point the
   ingress at `https://localhost:8080` with `originRequest: { originServerName: klatchly.example.com }`. HTTP stays the
   default.
5. **Cloudflare Access** (optional): an Access application in front adds a gate before the sign-in page. When its
   session expires, the installed app can neither update nor open a notification until it goes through Access
   again. Klatchly keeps its own passkeys and sessions.

## Updates

**Klatchly** (both services' configuration and Klatchly's code): fetch the new version of this repository (pull, or check
out the release tag you want), read its release notes, then rebuild and restart:

```sh
docker compose config >/dev/null && docker compose up -d --build klatchly
docker compose logs klatchly | tail -n 20
```

The installed app updates by itself (its service worker). Since 0.24.0, the worker fetches the new version's private
code ahead while the device is signed in; a device that opens the app offline right after an update whose code it could
not fetch yet says to connect once, then reloads by itself when the network is back.

`compose.yml` and `.env.example` may gain variables: compare `.env.example` with your `.env`. Your `.env`,
`compose.override.yml` and `secrets/` are never touched by an update. The `klatchly` image tag in `compose.yml` is the
project's version; the previous image stays until you remove it, to roll back (check out the previous version, then
`docker compose up -d klatchly`).

### Upgrading from beep (0.25.x and older)

The app was called beep (service `beep-web`) before 0.26.0. Once, when moving to 0.26.0:

1. **`.env`**: rename the variables (`BEEP_*` became `KLATCHLY_*`); compose reads only the new names:
   `sed -i 's/^BEEP_/KLATCHLY_/' .env`. Do the same in your `compose.override.yml` (the service is now `klatchly`).
   If you never set `COMPOSE_PROJECT_NAME`, set it to `beep` to keep your volumes' names (`beep_beeper-data`…), or
   copy them to the new prefix (step 2 for each).
2. **Data volume**: `beep-web-data` is now `klatchly-data`. With the old container stopped, copy it (same owner):
   ```sh
   P=beep   # your COMPOSE_PROJECT_NAME
   docker compose stop beep-web 2>/dev/null; docker stop beep-web 2>/dev/null
   docker volume create ${P}_klatchly-data
   docker run --rm -v ${P}_beep-web-data:/from:ro -v ${P}_klatchly-data:/to alpine cp -a /from/. /to/
   ```
3. **Start**: `docker compose up -d --build --remove-orphans` (removes the old `beep-web` container, which would
   still hold the port). Passkeys and sessions are in the copied volume: nobody signs in again. Browsers move what
   they kept (`beep.*` keys become `klatchly.*`) and refill the stored chat copy at the next launch.
4. **Packages of your own**: rename the `beep` field of each `package.ts` to `klatchly` and ask for `'^2.0'`
   (extension API 2.0.0, [extension-api.md](extension-api.md)).

Keep the old volume until the new install has run for a while, then `docker volume rm ${P}_beep-web-data`.

0.26.1 renamed what was left (nothing to do): new agent conversations get `klatchly_…` ids, those made before
(`beep_…`) keep working; known-device cookies signed before stay valid; a list filter saved in the browser that hides
the old `beep` source is read as `klatchly`. If your Hermes posts to Klatchly with a platform plugin, its name is
yours to choose: Klatchly only checks the inbound key.

**beeper-server**: a new Beeper Server version means a new `BEEPER_VERSION` and checksum in `server/Dockerfile` and a
new tag in `compose.yml` (done by a Klatchly release, or by you): [beeper-server.md](beeper-server.md), § 9. Back up its
volume before restarting it. The new version unpacks itself into the `klatchly_beeper-cache` volume on its first start
(about ten seconds); the old version's copy stays there until you delete that volume (§ 9 of the same page).

**Base images**: they are pinned by digest in the Dockerfiles, so `docker compose build --pull` does not move them; a
Klatchly release updates them (or update the digests yourself and rebuild).

## Licenses and SBOM

The Klatchly image carries its license material, generated at build time and offline by `web/scripts/licenses.mjs`
(part of `npm run build`):

- `/app/NOTICE` and `/app/THIRD_PARTY_LICENSES.txt`, also in `/usr/share/doc/klatchly/`: Klatchly's notice, then
  every third-party component the image ships with its version, license, copyright lines and full license text (the
  server's npm packages, the packages bundled into the web app and its service worker, the pdf.js data files,
  libvips and the libraries bundled with it through sharp, with where to get their source; pointers for Node.js and
  the Debian packages of the base image).
- `/usr/share/doc/klatchly/sbom.cdx.json`: a CycloneDX 1.6 SBOM of the same npm and native components.

They are inside the image only (never served). To read them (the runtime image has no shell):

```sh
id=$(docker create klatchly:<tag>) && docker cp "$id":/usr/share/doc/klatchly ./klatchly-doc; docker rm "$id"
```

The build fails if a shipped package has no detectable license, or one outside the allowlist of
`web/scripts/licenses.mjs` (permissive licenses, MPL-2.0; LGPL-3.0-or-later only for sharp's dynamically loaded
libvips); CI runs the same check (`node scripts/licenses.mjs --check`).

**Publishing an image**: build it with BuildKit's attestations, so the registry also carries an SBOM of the whole image
(Debian packages of the base included) and its build provenance:

```sh
docker buildx build --sbom=true --provenance=true \
  --label org.opencontainers.image.source=<repository URL> --label org.opencontainers.image.revision=$(git rev-parse HEAD) \
  -t <registry>/klatchly:<version> --push web/
```

Attach `THIRD_PARTY_LICENSES.txt` and `sbom.cdx.json` (copied out as above) to the release as well. Never publish a
`beeper-server` image ([beeper-server.md](beeper-server.md)).

## Backups

What to back up, all of it secret:

| What | Where | How |
|---|---|---|
| beeper-server's data (Beeper session, end-to-end encryption keys) | volume `klatchly_beeper-data` | A cold `tar` with the beeper-server image: [beeper-server.md](beeper-server.md), § 8. Never run two copies at once. |
| Klatchly's data (`state.json`: passkeys, hashed sessions and enrollment codes; settings; packages' files) | volume `klatchly_klatchly-data` | The same way, with Klatchly stopped (below). |
| Your configuration | `.env`, `compose.override.yml`, `secrets/`, the reverse-proxy configuration | Copy them: they are in no repository. |

Not `klatchly_beeper-cache`: it only holds the application beeper-server unpacks from its own binary, and is rebuilt on
the next start if lost.

For Klatchly's volume (`BACKUPS`: a directory of your choice, root-only):

```sh
docker compose stop klatchly
docker run --rm --network none -u 0 --entrypoint tar -v klatchly_klatchly-data:/data:ro -v "$BACKUPS":/b \
  beeper-server:4.3.284 --numeric-owner -C /data -czf /b/klatchly-data-$(date +%Y%m%d-%H%M%S).tar.gz .
docker compose start klatchly
```

A lost Klatchly volume costs only the passkeys, sessions and settings (enroll again with `cli.js enroll`); a lost
beeper-server volume means signing in again and verifying a new device, and messages encrypted for the old device may
stay unreadable.

## Troubleshooting

| Symptom | Lead |
|---|---|
| `docker compose` stops at once: "set KLATCHLY_ORIGIN in .env" | `.env` is missing or incomplete; `docker compose config` shows what is resolved. |
| Klatchly restarts: "token file missing or empty (KLATCHLY_TOKEN_FILE)" | The token file is missing, empty or unreadable by `KLATCHLY_UID`: [beeper-server.md](beeper-server.md), § 6. |
| Klatchly starts but the lists stay empty, or 401 from beeper-server | beeper-server is not `ready` yet, or its token changed: [beeper-server.md](beeper-server.md), § 5 and § 10. |
| The passkey prompt fails, or origin errors | `KLATCHLY_ORIGIN` is not exactly the address in the browser (scheme, host, port), or `KLATCHLY_RP_ID` is not its host or a parent domain. A passkey made for another RP ID does not work. |
| Signed out at once on a local `http://` test | Use `localhost` (a secure context), not an IP address or another name; in production use `https://`. |
| Live updates do not arrive (new messages only after a reload) | The proxy buffers or blocks the WebSocket `/api/ws`, or a firewall in front refuses the upgrade. |
| Videos do not seek, media are slow | The proxy buffers `/api/media` or drops `Range`. |
| Uploads over a few MB fail with 403 or 413 | A WAF or a proxy body limit in front of `/api/upload` (Klatchly allows 100 MB). |
| Every device shows the same address, rate limits hit everyone | The proxy is not in `KLATCHLY_TRUSTED_PROXIES` (Caddy on the host: the Compose gateway), or the client-IP header is not the one the proxy sets. |
| Klatchly does not start after setting OIDC variables | A half-done setup (a client id without issuer, an unreadable secret file, a non-`https://` issuer) stops the start on purpose: the log says which. |
| "Continue with …" lets nobody in | No account pinned: [Sign-in with an OIDC provider](#sign-in-with-an-oidc-provider), step 3. |
| A package is off in Settings → Extensions | Its configuration is incomplete (e.g. `KLATCHLY_LLM_URL` without model or key): the reason is shown there and in the log. |
| Permission denied on a volume or a secret file | Volumes and secret files belong to `KLATCHLY_UID`; after changing it, rebuild both images and give the files to the new uid. |

Logs: `docker compose logs klatchly`; beeper-server's useful logs are inside its volume
([beeper-server.md](beeper-server.md), § 10).
