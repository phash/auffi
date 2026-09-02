#!/usr/bin/env bash
# ops/tests/deploy-fresh-host.test.sh — a full deploy.sh run against a fake
# remote. On a host without .env.prod the deploy must stop before bringing
# the stack up (an example file with an empty TURN_SHARED_SECRET would start
# a stack whose coturn restart-loops and whose /healthz still says 200); with
# .env.prod present it must complete, snapshot the release and prune old
# snapshots along with the images.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

stage_fake_repo "${TMP}/repo"
install_stubs "${TMP}/bin"
REMOTE="${TMP}/remote"
SHA="$(git -C "${TMP}/repo" rev-parse --short HEAD)"

run_deploy() {
  : > "${STUB_LOG}"
  env -i PATH="${TMP}/bin:${PATH}" HOME="${HOME}" \
    STUB_LOG="${STUB_LOG}" REAL_RSYNC="${REAL_RSYNC}" \
    DEPLOY_SSH="deploy@remote.invalid" DEPLOY_PATH="${REMOTE}" \
    DEPLOY_DOMAIN="deploy.invalid" DEPLOY_LOCK_FILE="${TMP}/lock" CLUSTER_PROXY= \
    bash "${TMP}/repo/ops/deploy.sh" --yes --skip-tests --notes "test"
}

echo "# fresh host: no .env.prod → example placed, hard stop before compose up"
rm -rf "${REMOTE}"; mkdir -p "${REMOTE}"
RC=0; OUT="$(run_deploy 2>&1)" || RC=$?
assert_eq 1 "${RC}" "deploy exits 1"
assert_eq "true" "$([[ -f "${REMOTE}/.env.prod" ]] && echo true || echo false)" ".env.prod.example placed as .env.prod for editing"
assert_contains "${OUT}" "TURN_SHARED_SECRET" "operator told what to fill in"
assert_not_contains "$(cat "${STUB_LOG}")" "docker compose" "no compose up on a stack without secrets"
assert_not_contains "$(cat "${STUB_LOG}")" "docker build" "stopped before spending build time"
assert_eq "false" "$([[ -e "${REMOTE}/viewer-dist" ]] && echo true || echo false)" "nothing rsynced yet"

echo "# .env.prod present → full deploy, snapshot written"
printf 'APP_VERSION=old\nTURN_SHARED_SECRET=s3cret\nALLOWED_ORIGINS=https://deploy.invalid\n' > "${REMOTE}/.env.prod"
mkdir -p "${REMOTE}/releases/stale111/viewer-dist" "${REMOTE}/releases/stale222/viewer-dist"
RC=0; OUT="$(run_deploy 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf '%s\n' "${OUT}"
assert_eq 0 "${RC}" "deploy exits 0"
assert_contains "$(cat "${STUB_LOG}")" "docker compose --env-file .env.prod -f docker-compose.prod.yml  up -d --remove-orphans" "compose up ran"
assert_contains "$(grep '^APP_VERSION=' "${REMOTE}/.env.prod")" "APP_VERSION=${SHA}" ".env.prod pinned to the deployed SHA"
assert_file_eq "${REMOTE}/viewer-dist/index.html" "viewer build" "viewer-dist rsynced"
assert_file_eq "${REMOTE}/dashboard-dist/index.html" "dashboard build" "dashboard-dist rsynced"
assert_file_eq "${REMOTE}/releases/${SHA}/viewer-dist/index.html" "viewer build" "release snapshot holds viewer-dist"
assert_file_eq "${REMOTE}/releases/${SHA}/dashboard-dist/index.html" "dashboard build" "release snapshot holds dashboard-dist"
assert_eq "true" "$([[ -f "${REMOTE}/releases/${SHA}/nginx/auffi-viewer.conf" ]] && echo true || echo false)" "release snapshot holds nginx/"
assert_eq "true" "$([[ -f "${REMOTE}/releases/${SHA}/caddy/Caddyfile" ]] && echo true || echo false)" "standalone snapshot holds caddy/"
assert_contains "$(tail -n 1 "${REMOTE}/.deploy-log")" "${SHA}" "deploy logged"
assert_eq "false" "$([[ -e "${REMOTE}/releases/stale111" ]] && echo true || echo false)" "snapshot of a SHA outside the keep list pruned"
assert_eq "false" "$([[ -e "${REMOTE}/releases/stale222" ]] && echo true || echo false)" "second stale snapshot pruned"
assert_eq "clean" "$([[ -z "$(git -C "${TMP}/repo" status --porcelain)" ]] && echo clean || echo dirty)" "a deploy leaves the checkout clean"

finish
