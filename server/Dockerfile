# syntax=docker/dockerfile:1
# Beeper Server (headless Beeper, Desktop API on :23373), official Linux build.
# Update: change BEEPER_VERSION and BEEPER_SHA256 (feed:
# https://api.beeper.com/desktop/update-feed.json?bundleID=com.automattic.beeper.server&platform=linux&channel=stable&arch=x64).
ARG BEEPER_VERSION=4.3.284
# Runtime user and owner of /data and /cache (default 10001; compose.yml passes KLATCHLY_UID/KLATCHLY_GID from .env).
ARG KLATCHLY_UID=10001
ARG KLATCHLY_GID=10001

# Debian 13 (bookworm is LTS-only since 2026-07). glibc >= 2.34 and libstdc++ (GLIBCXX_3.4.29) needed.
FROM debian:trixie-20261027-slim@sha256:26c37952d274874448dd4f0943fc79bfb7c3d9cc8c8004ac4dc987489ca931be AS fetch
ARG BEEPER_VERSION
ADD --checksum=sha256:598dfb44c18d8e26bc60d6b9fd0bce103d6f00334d13d4ce968a9a0f90c7425c \
    https://beeper-desktop.download.beeper.com/builds/beeper-server-${BEEPER_VERSION}-linux-x64.tar.gz /tmp/beeper-server.tar.gz
RUN mkdir -p /out \
 && tar -xzf /tmp/beeper-server.tar.gz -C /tmp \
 && mv /tmp/beeper-server-${BEEPER_VERSION}-linux-x64/beeper-server /out/beeper-server

FROM debian:trixie-20261027-slim@sha256:26c37952d274874448dd4f0943fc79bfb7c3d9cc8c8004ac4dc987489ca931be
ARG KLATCHLY_UID
ARG KLATCHLY_GID
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g ${KLATCHLY_GID} beeper && useradd -u ${KLATCHLY_UID} -g ${KLATCHLY_GID} -M -d /data -s /usr/sbin/nologin beeper \
 && install -d -m 700 -o ${KLATCHLY_UID} -g ${KLATCHLY_GID} /data /cache
# The binary stays owned by root. It is a single Node executable: on first start it unpacks its embedded app into
# $XDG_CACHE_HOME/BeeperServer/<version key>/ (marked .complete) and reuses it afterwards. /cache is the only
# writable place besides /data and /tmp: compose.yml mounts a named volume there, so this happens once.
COPY --from=fetch --chown=0:0 /out/beeper-server /opt/beeper/beeper-server
ENV XDG_CACHE_HOME=/cache \
    BEEPER_SERVER_DATA_DIR=/data \
    HOME=/data \
    HOST=0.0.0.0 \
    PORT=23373
USER ${KLATCHLY_UID}:${KLATCHLY_GID}
VOLUME ["/data", "/cache"]
EXPOSE 23373
# start-period also covers the first start's unpack (about ten seconds).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/23373"]
ENTRYPOINT ["/opt/beeper/beeper-server"]
