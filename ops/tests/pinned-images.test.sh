#!/usr/bin/env bash
# ops/tests/pinned-images.test.sh — no ops script may run a floating
# (:latest) helper image on prod. `busybox` without a tag resolves to a
# mutable upstream image and runs with the served assets or the TURN key
# volume mounted.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

# A helper image name that starts a line (continuation lines of a `docker
# run … \` command) or follows `docker run` inline, with no `:tag`.
unpinned="$(grep -nE '(^\s*|docker run .*\s)(busybox|alpine|nginx|caddy)(\s|$)' "${OPS_DIR}"/*.sh || true)"
assert_eq "" "${unpinned}" "ops/*.sh: every helper image carries an explicit tag"

finish
