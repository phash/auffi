#!/usr/bin/env bash
# ops/tests/caddy-toolchain-pinned.test.sh — the standalone Caddy build must be
# reproducible: every xcaddy `--with` module carries an exact version.
# Dependabot cannot see that argument, so nothing else would catch a floating
# plugin. The Caddy version lockstep lives in caddy-version-lockstep.test.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

ROOT="${OPS_DIR}/.."
DOCKERFILE="${ROOT}/caddy/Dockerfile"

echo "# xcaddy plugins carry an exact module version"
WITH_ARGS="$(grep -oE -- '--with [^ ]+' "${DOCKERFILE}" | awk '{print $2}')"
assert_contains "${WITH_ARGS}" "github.com/mholt/caddy-ratelimit" "rate-limit plugin is built in"
while read -r mod; do
  [[ -n "${mod}" ]] || continue
  assert_eq "pinned" "$([[ "${mod}" =~ @v[0-9]+\.[0-9]+\.[0-9]+ ]] && echo pinned || echo floating)" "${mod%@*} pinned to an exact version"
done <<<"${WITH_ARGS}"

finish
