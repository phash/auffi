#!/usr/bin/env bash
# ops/tests/lib-rsync-viewer-dist.test.sh — the viewer-dist rsync shared by
# deploy.sh and update.sh must --delete stale build output but keep the
# flat-hosted legacy files under /download/ (install-linux.sh, latest.txt,
# old installers) that still live on the host and are still linked.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

install_stubs "${TMP}/bin"
export PATH="${TMP}/bin:${PATH}"
export DEPLOY_SSH="deploy@remote.invalid"
export DEPLOY_PATH="${TMP}/remote"
# shellcheck source=../lib.sh
source "${OPS_DIR}/lib.sh"

SRC="${TMP}/viewer/dist"
DEST="${DEPLOY_PATH}/viewer-dist"
mkdir -p "${SRC}/download" "${SRC}/assets" "${DEST}/download" "${DEST}/assets"
printf 'new index' > "${SRC}/index.html"
printf 'new download page' > "${SRC}/download/index.html"
printf 'new chunk' > "${SRC}/assets/app-2.js"
printf 'old index (longer)' > "${DEST}/index.html"
printf 'old download page (longer)' > "${DEST}/download/index.html"
printf 'stale chunk' > "${DEST}/assets/app-1.js"
printf 'deb' > "${DEST}/download/auffi_0.4.0_amd64.deb"
printf 'rpm' > "${DEST}/download/auffi-0.4.0-1.x86_64.rpm"
printf 'appimage' > "${DEST}/download/auffi_0.4.0_amd64.AppImage"
printf 'msi' > "${DEST}/download/Auffi_0.4.0_x64_en-US.msi"
printf 'exe' > "${DEST}/download/Auffi_0.4.0_x64-setup.exe"
printf 'installer' > "${DEST}/download/install-linux.sh"
printf '0.4.0' > "${DEST}/download/latest.txt"

rsync_viewer_dist "${SRC}/" "${DEST}/"

assert_file_eq "${DEST}/index.html" "new index" "index.html updated"
assert_file_eq "${DEST}/download/index.html" "new download page" "download page updated"
assert_file_eq "${DEST}/assets/app-2.js" "new chunk" "new chunk synced"
assert_eq "false" "$([[ -e "${DEST}/assets/app-1.js" ]] && echo true || echo false)" "stale chunk deleted"
for legacy in auffi_0.4.0_amd64.deb auffi-0.4.0-1.x86_64.rpm auffi_0.4.0_amd64.AppImage Auffi_0.4.0_x64_en-US.msi Auffi_0.4.0_x64-setup.exe install-linux.sh latest.txt; do
  assert_eq "true" "$([[ -e "${DEST}/download/${legacy}" ]] && echo true || echo false)" "legacy /download/${legacy} survives --delete"
done

finish
