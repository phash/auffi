#!/usr/bin/env bash
# ops/tests/caddy-version-lockstep.test.sh — the standalone Caddy version is
# written in four places: both FROM lines of caddy/Dockerfile, the
# auffi-caddy image tag in docker-compose.prod.yml and the stock-image
# fallback in ops/lib.sh::caddy_validate_local. Dependabot only bumps the
# FROM lines (auffi-* is ignored in .github/dependabot.yml), so this guard
# turns its caddy PR red until the other two are edited by hand.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

REPO_DIR="$(cd "${OPS_DIR}/.." && pwd)"

builder="$(sed -nE 's/^FROM caddy:([0-9.]+)-builder-alpine.*/\1/p' "${REPO_DIR}/caddy/Dockerfile")"
runtime="$(sed -nE 's/^FROM caddy:([0-9.]+)-alpine$/\1/p' "${REPO_DIR}/caddy/Dockerfile")"
compose="$(sed -nE 's/^\s*image: auffi-caddy:([0-9.]+)-ratelimit\s*$/\1/p' "${REPO_DIR}/docker-compose.prod.yml")"
fallback="$(sed -nE 's/^\s*image="caddy:([0-9.]+)-alpine"\s*$/\1/p' "${OPS_DIR}/lib.sh")"

if [[ -z "${builder}" ]]; then _fail "caddy/Dockerfile: builder FROM caddy:<version>-builder-alpine found"; fi
assert_eq "${builder}" "${runtime}" "caddy/Dockerfile: runtime FROM matches the builder"
assert_eq "${builder}" "${compose}" "docker-compose.prod.yml: auffi-caddy tag matches caddy/Dockerfile"
assert_eq "${builder}" "${fallback}" "ops/lib.sh: caddy_validate_local fallback matches caddy/Dockerfile"

finish
