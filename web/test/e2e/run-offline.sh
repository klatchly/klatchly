#!/bin/sh
# Runs the E2E scripts against offline instances (offline/server.mjs: the app on fake backends — the Desktop API and
# the web of link previews from the core, each package's own fake service from ext/<id>/test/offline.mjs — all
# canned) in the pinned Playwright image, without any network: nothing real is read or written. Build first (from
# web/: npm test && npm run build); the instances run the packages of that build, and the scripts are the core's
# (test/e2e/*.e2e.js) plus those of each of its packages (ext/<id>/test/*.e2e.cjs). To run another list, build it
# (KLATCHLY_PACKAGES=… npm test && KLATCHLY_PACKAGES=… npm run build) and pass the same KLATCHLY_PACKAGES here: the run checks
# that the build has it. Several scripts run at a time (JOBS, default 5), each on an instance of its own pool,
# starting from the same canned data, with its log in $SHOTS/<name>.log; a script still running after
# SCRIPT_TIMEOUT seconds (600) is killed and counted as failed; exits 1 when any script failed (offline/run.mjs).
# Usage (repo root): sh web/test/e2e/run-offline.sh                   # every script of the build
#                    sh web/test/e2e/run-offline.sh composer.e2e.js …  # the ones named (paths from web/test/e2e)
#                    JOBS=1 sh web/test/e2e/run-offline.sh …           # one at a time
#                    KLATCHLY_PACKAGES=beeper,accounts,llm,writing,example sh web/test/e2e/run-offline.sh
set -eu
SHOTS=${SHOTS:-$PWD/web/test/e2e/shots}
JOBS=${JOBS:-5}
mkdir -p "$SHOTS"
docker run --rm --network none --name "klatchly-test-offline-$$" --label klatchly-test=1 -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e R_ROOT=/web -e SHOTS=/shots -e SCRIPT_TIMEOUT="${SCRIPT_TIMEOUT:-}" -e KLATCHLY_PACKAGES="${KLATCHLY_PACKAGES:-}" \
  -v "$PWD/web":/web -v "$SHOTS":/shots -w /web/test/e2e \
  mcr.microsoft.com/playwright:v1.48.0-jammy node offline/run.mjs "$JOBS" "$@"
