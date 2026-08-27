# syntax=docker/dockerfile:1.7
# Standalone-Caddy mit dem mholt/caddy-ratelimit-Plugin.
#
# caddy/Caddyfile nutzt die `rate_limit`-Directive — die steckt NICHT im
# offiziellen caddy-Image, sondern muss via xcaddy einkompiliert werden.
# Ohne dieses Build crash-loopt der Standalone-Stack an der unbekannten
# Directive (der Cluster-Proxy ist aus demselben Grund ein Custom-Build
# `caddy-custom:2.11.2-ratelimit`, siehe docs/footguns.md § Cluster-Ops).
# Version 2.11.2 absichtlich identisch zum Cluster-Build gepinnt.
#
# Gebaut wird das Image von `docker compose up` (build:-Stanza in
# docker-compose.prod.yml) und von ops/lib.sh::caddy_validate_local.
# Nach einer Änderung an DIESER Datei auf einem laufenden Host:
#   docker compose -f docker-compose.prod.yml build caddy
FROM caddy:2.11.2-builder-alpine AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2.11.2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
