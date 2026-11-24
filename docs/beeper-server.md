# beeper-server: build, first sign-in, operation

beeper-server is the official headless Beeper (the Linux build of Beeper Desktop without its interface): it keeps the
Beeper account's session, the end-to-end encryption keys and the bridges, and serves the Desktop API on port 23373.
Klatchly only talks to it, with a token (the "Beeper token") read from a secret file.

This guide covers what is done once (build, sign in to the account, verify the device, create the token file) and
what is done again (check, back up, restore, upgrade, troubleshoot). The Compose side (`.env`, reverse proxy, first
passkey) is in [self-hosting.md](self-hosting.md).

Legend:

- **verified**: observed on the image `beeper-server:4.3.284` in a throwaway container without network
  (`--network none`, empty data directory), or read in the repository's code and configuration;
- **to verify on reinstall**: written from the API specification (`GET /v1/spec`, unchanged on these points between
  4.3.229 and 4.3.284) and the notes of a first installation, without being replayable offline: signing in and
  verifying necessarily talk to Beeper's servers. Corrections are welcome.

> **Security rule 1.** A beeper-server that is **not yet signed in** lets anyone who reaches its port sign it in to
> **their own** account; once signed in, its token is the account's access token. Port 23373 is therefore never
> published and never put behind a proxy: only the Compose network reaches it (see the header of `compose.yml`).
> Every command below goes through that network, from a throwaway container.

> **Rule 2.** No command in this guide prints the token, the code received by e-mail or the recovery key. Secret
> files are named, never `cat`-ed, never pasted into an issue.

## 1. Requirements

| What | Detail |
|---|---|
| Docker with Compose v2 | The commands use `docker compose`. |
| Linux x86-64 | The official build is `linux-x64`; the base image needs glibc ≥ 2.34 (Debian 13 in `server/Dockerfile`). |
| Memory | `mem_limit: 1536m` in `compose.yml`; the database grows with the history and the media. |
| A Beeper account | Or an e-mail address to create one (step 4). |
| Another device already signed in to the account (Beeper Desktop or mobile) | For the emoji verification (step 5). Otherwise, the account's recovery key. |
| An otherwise unused uid for the containers | `KLATCHLY_UID` / `KLATCHLY_GID` in `.env` (default `10001`). They give `user:` and the build arguments of `compose.yml`; the beeper-server image runs as that uid too. |
| `python3` on the host | To extract the token from the response without printing it (step 4). |

Compose project name: `COMPOSE_PROJECT_NAME` in `.env` (default `klatchly`). Volumes and the network take it as a prefix:
`klatchly_beeper-data`, `klatchly_default`. If you chose another name, replace `klatchly_` everywhere below.

## 2. Build the image (verified)

`server/Dockerfile` downloads the official archive `beeper-server-<version>-linux-x64.tar.gz`, checks its sha256
(`ADD --checksum`) and installs the binary, unmodified and owned by root. The binary is a single Node executable: on
its **first start** it unpacks its embedded application into `$XDG_CACHE_HOME/BeeperServer/<version key>/` (marked
with a `.complete` file), and reuses it on every later start. The image sets `XDG_CACHE_HOME=/cache` and
`compose.yml` mounts the named volume `beeper-cache` there, so the unpack (about 380 MB, about ten seconds) happens
once and survives restarts and container recreations. Everything else stays as it is: the container runs with a
read-only file system (`read_only: true`), and `/data` (volume `beeper-data`), `/cache` and a `/tmp` tmpfs are the
only writable places.

```sh
docker compose build beeper-server      # image beeper-server:<version>, tag set in compose.yml
```

What the image sets (verified in the container):

| Setting | Value | Role |
|---|---|---|
| `BEEPER_SERVER_DATA_DIR` | `/data` | Data: session, E2EE keys, SQLite databases, media, logs. Volume `beeper-data`. |
| `HOME` | `/data` | |
| `HOST`, `PORT` | `0.0.0.0`, `23373` | Listening; reachable only from the Compose network. |
| `XDG_CACHE_HOME` | `/cache` | Where the binary unpacks its application on first start. Volume `beeper-cache`. |
| User | `KLATCHLY_UID:KLATCHLY_GID` | `/data` and `/cache` created 0700 for it (a new named volume inherits that). |
| `HEALTHCHECK` | TCP connection to port 23373 | "healthy" means "listening", **not** "signed in" (see § 7). |
| `ENTRYPOINT` | `/opt/beeper/beeper-server` | |

The binary has **no `--help` or `--version` option**: it ignores its arguments and starts the server (verified). The
version is read from `GET /v1/info` or the `X-Beeper-Desktop-Version` response header.

## 3. First start (verified)

Start **beeper-server alone**: Klatchly cannot start until the token file exists (the `beeper_token` secret of
`compose.yml` points at `BEEPER_TOKEN_PATH` in `.env`, and the `beeper` package refuses to start without a token:
"token file missing or empty (KLATCHLY_TOKEN_FILE)").

```sh
docker compose up -d beeper-server
docker compose ps beeper-server         # wait for "healthy" (port open in ~10 s on the very first start, which
                                        # unpacks the application into /cache; ~4 s afterwards)
```

On its first start, beeper-server creates in `/data`: `account.db`, `index.db`, `migration-version`, `media/`,
`sdk-tmp/`, `logs/` (`beeper-server/`, `sdk/`, `sqlite_worker-*/`), `worker-log.log` and an anonymous telemetry id
(`rudderstack-anonymous-id.txt`), and in `/cache`: `BeeperServer/<version key>/` (the unpacked application, no
data). The named volumes inherit the image's ownership (`KLATCHLY_UID`, 0700). With a host
directory instead of the volume, give it to that uid first
(`sudo install -d -o "$KLATCHLY_UID" -g "$KLATCHLY_GID" -m 0700 <directory>`).

### Calling the API

The port is not published, so the API is reached from a throwaway container attached to the Compose network. Define,
in your shell, from the repository root:

```sh
NET=klatchly_default
BS=http://beeper-server:23373
CURL=curlimages/curl:8.11.1
# Without the token (before signing in): reads a request body from standard input when needed.
bs_anon() { docker run --rm -i --network "$NET" "$CURL" -sS "$@"; }
# With the token: the file is mounted read-only and read inside the container, never passed as an argument on the host.
bs() { docker run --rm -i --network "$NET" -u "$(id -u):$(id -g)" -v "$PWD/secrets/beeper-token.admin:/t:ro" \
  --entrypoint sh "$CURL" -c 'exec curl -sS -H "Authorization: Bearer $(cat /t)" "$@"' sh "$@"; }
```

Check (verified):

```sh
bs_anon "$BS/v1/info"         # {"app":{"name":"Beeper","version":"4.3.284",…},"server":{"status":"running",…}}
bs_anon "$BS/v1/app/setup"    # {"state":"needs-login",…}: not signed in yet
bs_anon "$BS/v1/accounts"     # 401 {"code":"unauthorized"}: every other route needs the token
```

Both functions were tried against a throwaway beeper-server on an `--internal` network: `bs` with a fake token gets
`401 {"message":"Invalid token"}` (the token is sent), and `POST /v1/app/setup/email` with an empty body answers
`400 VALIDATION_ERROR` without asking for a token. The Python extractor of step 4.3 was tried on made-up responses
(unknown account, wrong code, success, file already present).

`GET /v1/app/setup` is public **before** signing in (that is how an app finds out it must sign in); afterwards it
needs the token.

## 4. Sign in to the Beeper account (to verify on reinstall)

The `POST /v1/app/setup/*` routes need no token (hence rule 1). They chain: start a request, receive a code by
e-mail, send it back. The final response holds the account's token **once** (`matrix.accessToken`, "returned once
for first-party app setup"): it is written straight to `secrets/beeper-token.admin` without being printed.

```sh
# 4.1 Start a request: keeps setupRequestID, prints the offered sign-in methods.
REQ=$(bs_anon -X POST "$BS/v1/app/setup/start" | python3 -c \
  'import json,sys; r=json.load(sys.stdin); print(r["signInMethods"], file=sys.stderr); print(r["setupRequestID"])')

# 4.2 Receive a code by e-mail (204 expected).
read -r -p "Beeper account e-mail: " EMAIL
printf '{"setupRequestID":"%s","email":"%s"}' "$REQ" "$EMAIL" | \
  bs_anon -X POST -H 'Content-Type: application/json' --data-binary @- -w '%{http_code}\n' "$BS/v1/app/setup/email"

# 4.3 Send the code back (typed without echo); the token goes to secrets/beeper-token.admin (0600). Nothing else is
#     printed but the user, the device and the state.
install -d -m 700 secrets
read -rs -p "Code received by e-mail: " CODE; echo
printf '{"setupRequestID":"%s","response":"%s"}' "$REQ" "$CODE" | \
  bs_anon -X POST -H 'Content-Type: application/json' --data-binary @- "$BS/v1/app/setup/response" | \
  python3 -c '
import json, os, sys
r = json.load(sys.stdin)
if r.get("registrationRequired"):
    sys.exit("No account for this address: see 4.4 (registration). Nothing was written.")
m = r.get("matrix") or {}
if not m.get("accessToken"):
    sys.exit("Response without a token (wrong or expired code?): keys received " + ",".join(sorted(r)))
os.umask(0o077)
with open("secrets/beeper-token.admin", "x") as f:   # refuses to overwrite an existing token
    f.write(m["accessToken"])
print("signed in:", m.get("userID"), "device", m.get("deviceID"), "state", (r.get("session") or {}).get("state"))
'
unset CODE
```

Notes:

- `secrets/` is ignored by git (`.gitignore`). `open(…, "x")` fails if `secrets/beeper-token.admin` already exists:
  move it away first if this is an intentional reinstall.
- If the token is lost after this step, it is not given again: start over from an empty volume (step 3) and sign in
  again, which creates a new device (remove the old one in Beeper Desktop → Settings → Devices). The API also offers
  an OAuth2 PKCE flow (`/oauth/authorize`, `/oauth/token`, scopes `read` / `write`) meant for MCP clients; it has
  not been tried here.
- Note the device id printed (`deviceID`): it is the one you will find in the account's device list, and the one to
  compare during verification.

### 4.4 Create an account (to verify)

If 4.3 answers `registrationRequired`, the response carries a `leadToken`, `usernameSuggestions` and a text (`copy`);
registration ends with `POST /v1/app/setup/register` and
`{"setupRequestID", "leadToken", "username", "acceptTerms": true}` (accepting Beeper's terms), which returns the same
shape as 4.3 (`matrix.accessToken` + `session`): apply the same Python extractor. The simplest remains to create the
account in the official Beeper app, then follow 4.1–4.3.

## 5. Device verification (to verify on reinstall)

Without verification, beeper-server cannot decrypt encrypted messages. Follow the state:

```sh
bs "$BS/v1/app/setup" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["state"], r.get("matrix",{}).get("deviceID"), r["e2ee"])'
```

Possible states, in order: `needs-login` → `initializing` → `needs-cross-signing-setup` (account without cross-signing:
create it, see below) → `needs-verification` → `needs-secrets` → `needs-first-sync` → `ready`.

### 5.1 By comparing emojis with another device

The method used on the first installation: compare emojis with a Beeper device already signed in. With the API:

```sh
# Ask for verification from beeper-server (the account's other devices show the request).
bs -X POST -H 'Content-Type: application/json' -d '{"purpose":"login"}' "$BS/v1/app/setup/verifications"
# … or, if the request comes from the other device, find it and accept it:
bs "$BS/v1/app/setup/verifications"                      # items[].id, state, direction, availableActions
V=<verification id>
bs -X POST "$BS/v1/app/setup/verifications/$V/accept"     # only if direction = incoming

# When state = ready: start the comparison, read the emojis.
bs -X POST "$BS/v1/app/setup/verifications/$V/sas/start"
bs "$BS/v1/app/setup/verifications/$V" | python3 -c 'import json,sys; v=json.load(sys.stdin)["verification"]; print(v["state"], v.get("sas"))'
# The emojis (sas.emojis) must be the same, in the same order, as on the other device. Only then:
bs -X POST "$BS/v1/app/setup/verifications/$V/sas/confirm"
# and confirm on the other device too. state becomes done.
```

The emojis are not secret; if they differ, cancel (`POST …/$V/cancel`) and start again: someone else may be
answering the request. Choosing `"purpose":"login"` rather than `"device"` (the default) is to be confirmed: the
specification only says "why this verification is being started". A QR-code verification is also described
(`qr/scan`, `qr/confirm-scanned`), but it needs reading a QR code shown by the other device.

### 5.2 With the recovery key (to verify)

If no other device is available, the account's recovery key unlocks the secrets. Type it without echo and pass it on
standard input:

```sh
read -rs -p "Recovery key: " RK; echo
python3 -c 'import json,sys; print(json.dumps({"recoveryKey": sys.argv[1]}))' "$RK" | \
  bs -X POST -H 'Content-Type: application/json' --data-binary @- "$BS/v1/app/setup/verification/recovery-key" | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["session"]["state"])'
unset RK
```

`…/recovery-key/reset` then `…/reset/confirm` create a **new** key when the old one is lost: the response contains it,
so it is shown once; copy it at once into a password manager, never into a file of the repository. It is also the way
out of the `needs-cross-signing-setup` state.

### 5.3 Done

Wait for `ready` (the first sync can take several minutes with many chats); then `bs "$BS/v1/accounts"` lists the
messaging accounts. Beeper's "cloud" accounts arrive by themselves; a local bridge (for example Signal,
`local-signal`) is connected afterwards from Klatchly (Settings → Networks) or through
`/v1/bridges/{id}/login-sessions` (a QR step `display_and_wait` must be submitted with
`POST …/login-sessions/{sid}/steps/{stepID}` `{"type":"display_and_wait"}`, a long call, or the bridge never
finishes; Signal's QR code expires in ~60 s: create it only when you are ready to scan it).

## 6. The token file for Klatchly (verified in the configuration)

Klatchly runs as `KLATCHLY_UID` and cannot read `secrets/beeper-token.admin` (0600, owned by the administrator).
`compose.yml` gives it a **copy** as a Docker secret (path in `.env`):

```sh
BEEPER_TOKEN_PATH=./secrets/beeper-token     # mounted at /run/secrets/beeper_token
```

```sh
sudo install -o "$KLATCHLY_UID" -g "$KLATCHLY_GID" -m 0400 secrets/beeper-token.admin secrets/beeper-token
ls -l secrets/                                # 0600 you / 0400 KLATCHLY_UID; never print the contents
```

(`KLATCHLY_UID` and `KLATCHLY_GID` are those of `.env`; set them in your shell, e.g. `KLATCHLY_UID=10001 KLATCHLY_GID=10001`.)

Klatchly reads this file once (`web/ext/beeper/server/upstream.ts`: `KLATCHLY_TOKEN_FILE`, default
`/run/secrets/beeper_token`, surrounding whitespace removed) and reaches beeper-server at `KLATCHLY_UPSTREAM` (default
`http://beeper-server:23373`). The token only goes into the `Authorization` header of its calls to beeper-server:
never into a response, a log or a page.

Then start Klatchly and enroll the first passkey ([self-hosting.md](self-hosting.md), "First run"):

```sh
docker compose up -d klatchly
docker compose logs klatchly | tail -n 20    # packages announced at start, no token error
```

If the token changes (a new sign-in), make the copy again, then `docker compose up -d --force-recreate klatchly`.

## 7. Checks

| What | Command | Expected |
|---|---|---|
| The container listens | `docker compose ps beeper-server` | `healthy` (TCP test only) |
| Version | `bs_anon "$BS/v1/info"` | `app.version` = the image tag |
| Signed in and verified | `bs "$BS/v1/app/setup"` | `"state":"ready"`, `e2ee.verified: true` |
| The token is accepted | `bs -o /dev/null -w '%{http_code}\n' "$BS/v1/accounts"` | `200` (`401`: wrong token) |
| No published port | `docker compose port beeper-server 23373` | nothing (an error) |
| Klatchly | `curl -fsS http://127.0.0.1:<KLATCHLY_PORT>/healthz` | `ok` |

## 8. Backing up and restoring the volume

The `klatchly_beeper-data` volume holds the account's session and the encryption keys: it is the equivalent of a signed-in
device. Treat it as a secret (root, 0600, outside the repository). Below, `BACKUPS` is a directory of your choice, for
example `BACKUPS=/srv/backups/klatchly`.

### Backup (cold)

```sh
docker compose stop klatchly beeper-server
sudo install -d -m 700 "$BACKUPS"
docker run --rm --network none -u 0 --entrypoint tar -v klatchly_beeper-data:/data:ro -v "$BACKUPS":/b \
  beeper-server:4.3.284 --numeric-owner -C /data -czf /b/beeper-data-$(date +%Y%m%d-%H%M%S).tar.gz .
sudo sh -c "chmod 600 '$BACKUPS'/beeper-data-*.tar.gz"
docker compose start beeper-server klatchly
```

The beeper-server image is used as the tool (`tar` and `gzip` are in it), without network. A hot copy risks an
inconsistent SQLite database (`account.db-wal`): stop first. Logs (`logs/`) can be left out with `--exclude=./logs`.

Also back up, with the same care: `secrets/`, `.env`, `compose.override.yml` if you have one, your reverse-proxy
configuration, and the Klatchly volume (`klatchly_klatchly-data`: passkeys, hashed sessions, settings) the same way.

### Restore (to verify on reinstall)

```sh
docker compose stop klatchly beeper-server
docker volume create klatchly_beeper-data            # an empty volume (or empty it after a backup)
docker run --rm --network none -u 0 --entrypoint tar -v klatchly_beeper-data:/data -v "$BACKUPS":/b:ro \
  beeper-server:4.3.284 --numeric-owner -C /data -xpzf /b/beeper-data-<date>.tar.gz
docker compose up -d beeper-server && bs "$BS/v1/app/setup"     # ready, same deviceID as before
```

Precautions:

- The token stays the backup's: `secrets/beeper-token.admin` and its copy must come from the same time.
- Never run two beeper-servers on two copies of the same volume: it would be the same Matrix device twice, with
  encryption keys that diverge.
- Restoring an old backup can lose the keys of messages received since (unreadable messages): prefer the latest.

## 9. Upgrading

1. Find the new version in Beeper's update feed:
   `https://api.beeper.com/desktop/update-feed.json?bundleID=com.automattic.beeper.server&platform=linux&channel=stable&arch=x64`
   (it gives the archive's URL and its `sha512` in base64).
2. Change `BEEPER_VERSION` and the sha256 of the `ADD --checksum` in `server/Dockerfile` (compute it from the
   downloaded archive and check it against the feed's sha512), and the `image:` tag of `beeper-server` in
   `compose.yml`.
3. `docker compose build beeper-server`, stop, **back up** (§ 8), then `docker compose up -d --no-deps beeper-server`.
   Keep the old image to roll back.

The session and the token survive an upgrade (same volume). The new version unpacks itself on its first start into a
new directory of the `beeper-cache` volume; the previous version's directory (about 380 MB) stays there, unused. To
reclaim it, with beeper-server stopped: `docker compose rm -f beeper-server && docker volume rm klatchly_beeper-cache`,
then `docker compose up -d beeper-server` (it unpacks again; nothing else is lost). After the upgrade, run the checks of § 7; the new
version's API specification is at `GET /v1/spec` (`bs "$BS/v1/spec"`): compare it with the previous one before
relying on a changed route. Klatchly's Matrix rooms (joining, leaving: [self-hosting.md](self-hosting.md#matrix-rooms))
use `/_matrix/client/v3/join/{roomIdOrAlias}` and `/_matrix/client/v3/rooms/{roomId}/leave`, which Beeper does not
document: check that the new specification still lists them.

## 10. Troubleshooting

`docker logs` shows almost nothing: the useful logs are in the volume.

```sh
docker compose exec beeper-server sh -c 'ls -l /data/logs/beeper-server/'
docker compose exec beeper-server sh -c 'tail -n 200 /data/logs/beeper-server/*.log'
docker compose exec beeper-server sh -c 'grep -h error_internal /data/logs/beeper-server/*.log | tail -n 20'
```

The other directories of `/data/logs/` (`sdk/`, `sqlite_worker-*/`) are for the bridges and the database. Logs can
contain names and message excerpts: do not publish them as they are.

| Symptom | Lead |
|---|---|
| Klatchly does not start: "token file missing or empty (KLATCHLY_TOKEN_FILE)" | `secrets/beeper-token` missing, empty or unreadable by `KLATCHLY_UID` (§ 6). |
| Klatchly answers but everything fails with 401 from beeper-server | Token replaced or device removed from the account: `bs "$BS/v1/app/setup"`; make the copy again, or sign in again (§ 4). |
| `healthy` but Klatchly is empty | Not `ready` yet (first sync, verification pending): § 5. |
| `needs-verification` that does not move | Request declined or expired on the other device: `GET /v1/app/setup/verifications`, cancel, start again (§ 5.1). |
| "Unable to decrypt" messages | Device not verified or secrets missing (`e2ee.secrets`): recovery key (§ 5.2). |
| A media upload refused with no visible error | Look for `error_internal` / `failed to reupload media` in the logs; such a case was fixed once by upgrading beeper-server (§ 9). |
| First start slow, or `/cache` errors in `docker logs` | The binary unpacks its application into `/cache` on first start (§ 2): the `beeper-cache` volume must be mounted and writable by `KLATCHLY_UID`. Deleting the volume is harmless: the next start unpacks again. |
| The server starts when given `--help` | Normal: the binary ignores its arguments (§ 2). Stop it. |

To debug by hand: `docker compose exec beeper-server bash` (there is no `curl` in the image; use `bs` / `bs_anon`).
Publishing the port, even on `127.0.0.1`, is only for a short while, from `compose.override.yml`, and never before
signing in (rule 1).
