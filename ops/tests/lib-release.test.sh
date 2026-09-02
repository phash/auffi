#!/usr/bin/env bash
# ops/tests/lib-release.test.sh — release_snapshot / release_restore round
# trip from ops/lib.sh, with `remote` running through the ssh stub locally.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

install_stubs "${TMP}/bin"
export PATH="${TMP}/bin:${PATH}"
export DEPLOY_SSH="deploy@remote.invalid"
export DEPLOY_PATH="${TMP}/remote"
# shellcheck source=../lib.sh
source "${OPS_DIR}/lib.sh"

seed_live() {
  rm -rf "${DEPLOY_PATH}"
  mkdir -p "${DEPLOY_PATH}"/{viewer-dist/assets,dashboard-dist,nginx,coturn,caddy}
  printf 'viewer-1' > "${DEPLOY_PATH}/viewer-dist/index.html"
  printf 'chunk-1' > "${DEPLOY_PATH}/viewer-dist/assets/app-1.js"
  printf 'dash-1' > "${DEPLOY_PATH}/dashboard-dist/index.html"
  printf 'nginx-1' > "${DEPLOY_PATH}/nginx/auffi-viewer.conf"
  printf 'coturn-1' > "${DEPLOY_PATH}/coturn/turnserver.conf.tmpl"
  printf 'caddy-1' > "${DEPLOY_PATH}/caddy/Caddyfile"
}

echo "# standalone: snapshot covers caddy/, restore brings every asset back"
seed_live
CLUSTER_PROXY= release_snapshot "sha1111"
assert_file_eq "${DEPLOY_PATH}/releases/sha1111/viewer-dist/index.html" "viewer-1" "viewer-dist snapshotted"
assert_file_eq "${DEPLOY_PATH}/releases/sha1111/viewer-dist/assets/app-1.js" "chunk-1" "nested viewer asset snapshotted"
assert_file_eq "${DEPLOY_PATH}/releases/sha1111/dashboard-dist/index.html" "dash-1" "dashboard-dist snapshotted"
assert_file_eq "${DEPLOY_PATH}/releases/sha1111/nginx/auffi-viewer.conf" "nginx-1" "nginx snapshotted"
assert_file_eq "${DEPLOY_PATH}/releases/sha1111/coturn/turnserver.conf.tmpl" "coturn-1" "coturn snapshotted"
assert_file_eq "${DEPLOY_PATH}/releases/sha1111/caddy/Caddyfile" "caddy-1" "standalone caddy snapshotted"

# Deploy 2 lands: new content, a new chunk, the old chunk gone.
printf 'viewer-2-longer' > "${DEPLOY_PATH}/viewer-dist/index.html"
rm "${DEPLOY_PATH}/viewer-dist/assets/app-1.js"
printf 'chunk-2' > "${DEPLOY_PATH}/viewer-dist/assets/app-2.js"
printf 'dash-2-longer' > "${DEPLOY_PATH}/dashboard-dist/index.html"
printf 'nginx-2-longer' > "${DEPLOY_PATH}/nginx/auffi-viewer.conf"

CLUSTER_PROXY= release_restore "sha1111"
assert_file_eq "${DEPLOY_PATH}/viewer-dist/index.html" "viewer-1" "viewer-dist restored"
assert_file_eq "${DEPLOY_PATH}/viewer-dist/assets/app-1.js" "chunk-1" "old chunk is back"
assert_eq "false" "$([[ -e "${DEPLOY_PATH}/viewer-dist/assets/app-2.js" ]] && echo true || echo false)" "chunk that only deploy 2 shipped is gone (--delete)"
assert_file_eq "${DEPLOY_PATH}/dashboard-dist/index.html" "dash-1" "dashboard-dist restored"
assert_file_eq "${DEPLOY_PATH}/nginx/auffi-viewer.conf" "nginx-1" "nginx restored"

echo "# cluster: caddy/ is neither snapshotted nor restored"
seed_live
CLUSTER_PROXY=caddy-proxy release_snapshot "sha2222"
assert_eq "false" "$([[ -e "${DEPLOY_PATH}/releases/sha2222/caddy" ]] && echo true || echo false)" "no caddy/ in cluster snapshot"
assert_file_eq "${DEPLOY_PATH}/releases/sha2222/nginx/auffi-viewer.conf" "nginx-1" "nginx still snapshotted in cluster mode"
printf 'caddy-2-longer' > "${DEPLOY_PATH}/caddy/Caddyfile"
mkdir -p "${DEPLOY_PATH}/releases/sha2222/caddy"
printf 'caddy-stale' > "${DEPLOY_PATH}/releases/sha2222/caddy/Caddyfile"
CLUSTER_PROXY=caddy-proxy release_restore "sha2222"
assert_file_eq "${DEPLOY_PATH}/caddy/Caddyfile" "caddy-2-longer" "cluster restore leaves caddy/ alone even if a snapshot dir exists"

echo "# missing snapshot is reported by remote_release_exists"
assert_eq "1" "$(remote_release_exists "nope" && echo 0 || echo 1)" "remote_release_exists → 1 for unknown sha"
assert_eq "0" "$(remote_release_exists "sha2222" && echo 0 || echo 1)" "remote_release_exists → 0 for a snapshot"

finish
