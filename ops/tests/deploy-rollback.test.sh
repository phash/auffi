#!/usr/bin/env bash
# ops/tests/deploy-rollback.test.sh — `deploy.sh --rollback` must put the
# frontend dists and the bind-mounted configs back to the previous SHA, not
# only the backend image. Runs deploy.sh end-to-end against a fake remote
# (ssh/rsync/docker/curl stubs from harness.sh, DEPLOY_PATH in a temp dir).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

stage_ops "${TMP}/repo"
install_stubs "${TMP}/bin"

REMOTE="${TMP}/remote"

# Arrange a host that ran deploy A, then deploy B (B is live everywhere).
# A and B fixtures differ in size: rsync -a skips same-size files whose
# mtime matches, and the fixtures are written within the same second.
seed_remote() {
  rm -rf "${REMOTE}"
  mkdir -p "${REMOTE}"/{viewer-dist,dashboard-dist,nginx,coturn,caddy}
  printf 'build-B' > "${REMOTE}/viewer-dist/index.html"
  printf 'B-only' > "${REMOTE}/viewer-dist/new-in-b.js"
  printf 'build-B' > "${REMOTE}/dashboard-dist/index.html"
  printf 'build-B' > "${REMOTE}/nginx/auffi-viewer.conf"
  printf 'build-B' > "${REMOTE}/coturn/turnserver.conf.tmpl"
  printf 'build-B' > "${REMOTE}/caddy/Caddyfile"
  printf 'APP_VERSION=bbbbbbb\nTURN_SHARED_SECRET=x\n' > "${REMOTE}/.env.prod"
  printf '2026-09-01T00:00:00Z\taaaaaaa\tme@box\t\n2026-09-02T00:00:00Z\tbbbbbbb\tme@box\t\n' > "${REMOTE}/.deploy-log"
}

seed_snapshot_a() {
  local rel="${REMOTE}/releases/aaaaaaa"
  mkdir -p "${rel}"/{viewer-dist,dashboard-dist,nginx,coturn,caddy}
  printf 'A' > "${rel}/viewer-dist/index.html"
  printf 'A' > "${rel}/dashboard-dist/index.html"
  printf 'A' > "${rel}/nginx/auffi-viewer.conf"
  printf 'A' > "${rel}/coturn/turnserver.conf.tmpl"
  printf 'A' > "${rel}/caddy/Caddyfile"
}

run_rollback() {
  : > "${STUB_LOG}"
  env -i PATH="${TMP}/bin:${PATH}" HOME="${HOME}" \
    STUB_LOG="${STUB_LOG}" REAL_RSYNC="${REAL_RSYNC}" \
    DEPLOY_SSH="deploy@remote.invalid" DEPLOY_PATH="${REMOTE}" \
    DEPLOY_DOMAIN="deploy.invalid" DEPLOY_LOCK_FILE="${TMP}/lock" \
    "$@" \
    bash "${TMP}/repo/ops/deploy.sh" --rollback --yes
}

echo "# standalone rollback with a snapshot of the previous SHA"
seed_remote
seed_snapshot_a
RC=0; OUT="$(run_rollback CLUSTER_PROXY= 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf "%s\n" "${OUT}"
assert_eq 0 "${RC}" "rollback exits 0"
assert_file_eq "${REMOTE}/viewer-dist/index.html" "A" "viewer-dist restored to A"
assert_eq "false" "$([[ -e "${REMOTE}/viewer-dist/new-in-b.js" ]] && echo true || echo false)" "file that only existed in B is gone"
assert_file_eq "${REMOTE}/dashboard-dist/index.html" "A" "dashboard-dist restored to A"
assert_file_eq "${REMOTE}/nginx/auffi-viewer.conf" "A" "nginx config restored to A"
assert_file_eq "${REMOTE}/coturn/turnserver.conf.tmpl" "A" "coturn template restored to A"
assert_file_eq "${REMOTE}/caddy/Caddyfile" "A" "standalone Caddyfile restored to A"
assert_contains "$(grep '^APP_VERSION=' "${REMOTE}/.env.prod")" "APP_VERSION=aaaaaaa" ".env.prod points at A"
CALLS="$(cat "${STUB_LOG}")"
assert_contains "${CALLS}" "docker tag auffi-backend:aaaaaaa auffi-backend:latest" "image retagged"
assert_contains "${CALLS}" "docker restart auffi-dashboard" "dashboard sidecar restarted (single-file bind mount)"
assert_contains "${CALLS}" "docker restart auffi-coturn" "coturn restarted for its restored template"
assert_contains "${CALLS}" "docker restart auffi-caddy" "standalone caddy restarted"
assert_not_contains "${CALLS}" "docker restart auffi-viewer" "no auffi-viewer container in standalone mode"
assert_not_contains "${CALLS}" "docker restart auffi-turn-cert-stage" "no cert-stage sidecar in standalone mode"
assert_contains "${CALLS}" "screenie_viewer-static:/data" "standalone viewer volume repopulated"
assert_contains "${CALLS}" "https://deploy.invalid/robots.txt" "smoke checks ran after rollback"
assert_contains "$(tail -n 1 "${REMOTE}/.deploy-log")" "ROLLBACK" "rollback logged"

echo "# cluster rollback restarts the viewer sidecar instead of caddy"
seed_remote
seed_snapshot_a
RC=0; OUT="$(run_rollback CLUSTER_PROXY=caddy-proxy STUB_SMOKETEST_STATUS=404 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf "%s\n" "${OUT}"
assert_eq 0 "${RC}" "rollback exits 0"
assert_file_eq "${REMOTE}/viewer-dist/index.html" "A" "viewer-dist restored to A"
assert_file_eq "${REMOTE}/caddy/Caddyfile" "build-B" "cluster mode never touches caddy/ (hand-maintained on the host)"
CALLS="$(cat "${STUB_LOG}")"
assert_contains "${CALLS}" "docker restart auffi-viewer" "viewer sidecar restarted"
assert_contains "${CALLS}" "docker restart auffi-turn-cert-stage" "cert-stage sidecar restarted for its restored script"
assert_not_contains "${CALLS}" "docker restart auffi-caddy" "no auffi-caddy container in cluster mode"
assert_not_contains "${CALLS}" "screenie_viewer-static" "no volume copy in cluster mode"

echo "# without a snapshot the rollback stays backend-only and says so"
seed_remote
RC=0; OUT="$(run_rollback CLUSTER_PROXY= 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf "%s\n" "${OUT}"
assert_eq 0 "${RC}" "rollback exits 0"
assert_file_eq "${REMOTE}/viewer-dist/index.html" "build-B" "viewer-dist untouched"
assert_contains "${OUT}" "NUR das Backend-Image" "operator is warned that only the backend was rolled back"
assert_contains "$(grep '^APP_VERSION=' "${REMOTE}/.env.prod")" "APP_VERSION=aaaaaaa" ".env.prod points at A"
assert_not_contains "$(cat "${STUB_LOG}")" "docker restart" "backend-only rollback restarts no bind-mount sidecar"

echo "# standalone rollback to a snapshot with an older caddy/Dockerfile rebuilds the caddy image"
seed_remote
seed_snapshot_a
printf 'FROM caddy:B\n' > "${REMOTE}/caddy/Dockerfile"
(cd "${REMOTE}" && sha256sum caddy/Dockerfile | awk '{print $1}' > .caddy-image-dockerfile.sha256)
printf 'FROM caddy:A-old\n' > "${REMOTE}/releases/aaaaaaa/caddy/Dockerfile"
RC=0; OUT="$(run_rollback CLUSTER_PROXY= 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf "%s\n" "${OUT}"
assert_eq 0 "${RC}" "rollback exits 0"
assert_file_eq "${REMOTE}/caddy/Dockerfile" "FROM caddy:A-old" "caddy/Dockerfile restored to A"
CALLS="$(cat "${STUB_LOG}")"
assert_contains "${CALLS}" " build caddy" "caddy image rebuilt from the restored Dockerfile"
BUILD_LINE="$(grep -n ' build caddy' "${STUB_LOG}" | head -n 1 | cut -d: -f1 || true)"
UP_LINE="$(grep -n ' up -d --remove-orphans' "${STUB_LOG}" | head -n 1 | cut -d: -f1 || true)"
assert_eq "true" "$([[ ${BUILD_LINE:-0} -gt 0 && ${BUILD_LINE} -lt ${UP_LINE:-0} ]] && echo true || echo false)" "rebuild runs before compose up"

echo "# standalone rollback whose snapshot has the same caddy/Dockerfile does not rebuild"
seed_remote
seed_snapshot_a
printf 'FROM caddy:B\n' > "${REMOTE}/caddy/Dockerfile"
(cd "${REMOTE}" && sha256sum caddy/Dockerfile | awk '{print $1}' > .caddy-image-dockerfile.sha256)
cp "${REMOTE}/caddy/Dockerfile" "${REMOTE}/releases/aaaaaaa/caddy/Dockerfile"
RC=0; OUT="$(run_rollback CLUSTER_PROXY= 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf "%s\n" "${OUT}"
assert_eq 0 "${RC}" "rollback exits 0"
assert_not_contains "$(cat "${STUB_LOG}")" " build caddy" "unchanged Dockerfile → no caddy rebuild"

# app_version — the SHA .env.prod points at after a run.
app_version() { grep '^APP_VERSION=' "${REMOTE}/.env.prod" | cut -d= -f2; }

echo "# a second rollback in a row walks further back, never forward to the release it backed out of"
seed_remote
printf 'APP_VERSION=ccccccc\nTURN_SHARED_SECRET=x\n' > "${REMOTE}/.env.prod"
printf '2026-09-03T00:00:00Z\tccccccc\tme@box\t\n' >> "${REMOTE}/.deploy-log"
RC=0; OUT="$(run_rollback CLUSTER_PROXY= 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf "%s\n" "${OUT}"
assert_eq "bbbbbbb" "$(app_version)" "first rollback: C → B"
RC=0; OUT="$(run_rollback CLUSTER_PROXY= 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf "%s\n" "${OUT}"
assert_eq 0 "${RC}" "second rollback exits 0"
assert_eq "aaaaaaa" "$(app_version)" "second rollback: B → A, not back to the bad C"
RC=0; OUT="$(run_rollback CLUSTER_PROXY= 2>&1)" || RC=$?
assert_eq 1 "${RC}" "third rollback refuses: nothing older than A is in the log"
assert_eq "aaaaaaa" "$(app_version)" "a refused rollback leaves A running"

echo "# rollback after a failed deploy, then once more"
seed_remote
printf 'APP_VERSION=ddddddd\nTURN_SHARED_SECRET=x\n' > "${REMOTE}/.env.prod"
RC=0; OUT="$(run_rollback CLUSTER_PROXY= 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf "%s\n" "${OUT}"
assert_eq "bbbbbbb" "$(app_version)" "failed deploy D (never logged) → last logged B"
RC=0; OUT="$(run_rollback CLUSTER_PROXY= 2>&1)" || RC=$?
[[ ${RC} -eq 0 ]] || printf "%s\n" "${OUT}"
assert_eq "aaaaaaa" "$(app_version)" "then B → A"

echo "# --help describes the live-stack rollback, not the old log-position rule"
HELP="$(bash "${TMP}/repo/ops/deploy.sh" --help)"
assert_not_contains "${HELP}" "second-to-last" "--help does not promise the second-to-last logged SHA"
assert_contains "${HELP}" "--rollback" "--help still documents --rollback"

finish
