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
# Das Plugin hat nur ein Release (v0.1.0, 2024); gepinnt ist der Commit
# 5625512 (2026-06-12, Upstream-HEAD) als Go-Pseudo-Version. Dependabot sieht
# das `--with`-Argument nicht — Bump von Hand
# (Guard: ops/tests/caddy-toolchain-pinned.test.sh).
#
# Gebaut wird das Image von `docker compose up` (build:-Stanza in
# docker-compose.prod.yml), von ops/deploy.sh sobald sich DIESE Datei
# gegenüber dem Host geändert hat, und von ops/lib.sh::caddy_validate_local.
FROM caddy:2.11.9-builder-alpine AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit@v0.1.1-0.20260612195517-5625512f24f6

FROM caddy:2.11.9-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
