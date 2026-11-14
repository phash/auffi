# syntax=docker/dockerfile:1.7
# Standalone-Caddy mit dem mholt/caddy-ratelimit-Plugin.
#
# caddy/Caddyfile nutzt die `rate_limit`-Directive — die steckt NICHT im
# offiziellen caddy-Image, sondern muss via xcaddy einkompiliert werden.
# Ohne dieses Build crash-loopt der Standalone-Stack an der unbekannten
# Directive (der Cluster-Proxy ist aus demselben Grund ein Custom-Build
# `caddy-custom:<version>-ratelimit`, siehe docs/footguns.md § Cluster-Ops).
# Builder- und Runtime-Tag, das Image-Tag in docker-compose.prod.yml und
# ops/lib.sh::caddy_validate_local laufen im Gleichschritt (Guard:
# ops/tests/caddy-version-lockstep.test.sh). Dependabot bumpt nur die
# FROM-Zeilen (`auffi-*` ist in .github/dependabot.yml ignoriert) — in
# seinem caddy-PR Compose-Tag und lib.sh-Fallback von Hand nachziehen.
# Der Cluster-Proxy wird von keiner Datei hier gebaut: er bleibt auf seiner
# Version (Stand docs/footguns.md § Cluster-Ops), bis er auf dem
# Cluster-Host von Hand neu gebaut wird — Standalone und Cluster können
# also auseinanderlaufen.
#
# Gebaut wird das Image von `docker compose up` (build:-Stanza in
# docker-compose.prod.yml) und von ops/lib.sh::caddy_validate_local.
# Nach einer Änderung an DIESER Datei auf einem laufenden Host:
#   docker compose -f docker-compose.prod.yml build caddy
FROM caddy:2.11.9-builder-alpine AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2.11.9-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
