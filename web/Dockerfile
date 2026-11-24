# syntax=docker/dockerfile:1
# klatchly: SPA + backend (Hono) in front of beeper-server. Multi-stage, runtime = distroless Node 24 (no shell).
# Build args: KLATCHLY_PACKAGES (the package list, ids separated by commas; default ext/packages.json), KLATCHLY_UID /
# KLATCHLY_GID (the runtime user and the owner of /data; default 10001, compose.yml passes KLATCHLY_UID/KLATCHLY_GID from .env).
# Packages from elsewhere: a build context named `extra` (folders <id>/, optionally a packages.json) replaces the
# empty stage below: docker build --build-context extra=../my-ext web/ (compose: build.additional_contexts).
ARG KLATCHLY_UID=10001
ARG KLATCHLY_GID=10001

# Empty unless replaced by --build-context extra=… (its content lands in ext/, over the packages of the tree).
FROM scratch AS extra

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY scripts/build-server.mjs scripts/compose-packages.mjs scripts/licenses.mjs ./scripts/
COPY scripts/licenses ./scripts/licenses
# Read by scripts/licenses.mjs (the runtime base image, named in THIRD_PARTY_LICENSES.txt and the SBOM) and shipped.
COPY Dockerfile NOTICE ./
COPY server ./server
COPY client ./client
# Packages (ext/<id>/): the tree's, then the extra context's. The list (KLATCHLY_PACKAGES, else ext/packages.json)
# decides which are built: scripts/compose-packages.mjs writes ext/packages.*.ts (server halves built to dist/ext/,
# client halves into the bundle).
COPY ext ./ext
COPY --from=extra / ./ext/
ARG KLATCHLY_PACKAGES=
# npm run build ends with scripts/licenses.mjs (dist/licenses/: THIRD_PARTY_LICENSES.txt, sbom.cdx.json; fails on an
# unknown or disallowed license); after the prune, --installed checks that what is left is exactly what they list.
RUN npm run typecheck && npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && node scripts/licenses.mjs --installed \
 && mkdir -p /out/data /out/doc \
 && mv dist/licenses/THIRD_PARTY_LICENSES.txt dist/licenses/sbom.cdx.json NOTICE /out/doc/ \
 && rm -rf dist/licenses

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8
ARG KLATCHLY_UID
ARG KLATCHLY_GID
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# License material (docs/license-obligations.fr.md § 4): klatchly's NOTICE, the third-party notices and license texts,
# the CycloneDX SBOM of the npm and native components. Inside the image only, never served.
COPY --from=build /out/doc/ /usr/share/doc/klatchly/
COPY --from=build /out/doc/NOTICE /out/doc/THIRD_PARTY_LICENSES.txt ./
# Empty /data owned by the runtime uid so a fresh named volume inherits that ownership.
COPY --from=build --chown=${KLATCHLY_UID}:${KLATCHLY_GID} /out/data /data
ENV NODE_ENV=production PORT=8080 KLATCHLY_DATA_DIR=/data KLATCHLY_TOKEN_FILE=/run/secrets/beeper_token
USER ${KLATCHLY_UID}:${KLATCHLY_GID}
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/cli.js", "health"]
CMD ["/app/dist/index.js"]
