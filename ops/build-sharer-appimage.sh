#!/usr/bin/env bash
# ops/build-sharer-appimage.sh — wrap `npm run tauri:build` with the
# Linux-AppImage workarounds we discovered on 2026-05-14.
#
# Two issues bite Tauri 2 on a modern Arch (and increasingly any
# rolling-release distro):
#
# 1. linuxdeploy ships its own `strip` binary (build 10 from
#    2024-07-26). That binary doesn't know the `.relr.dyn` ELF
#    section type DT_RELR that modern binutils emits for system
#    libraries (libxkbcommon, libxml2, libxslt, libyuv, libzstd …).
#    Strip fails → linuxdeploy errors out → Tauri reports
#    "failed to run linuxdeploy" → no AppImage. The opt-out is
#    `NO_STRIP=1` (documented in linuxdeploy README).
#
# 2. Tauri places the app icon at
#    `Auffi.AppDir/usr/share/icons/hicolor/*/apps/auffi-sharer.png`
#    but appimagetool expects it at `Auffi.AppDir/auffi-sharer.png`
#    (next to the .desktop file). When linuxdeploy hands off to
#    appimagetool, the latter errors out. We `cp` the icon to the
#    expected location before the final bundle step.
#
# Both upstream bugs — re-evaluate whenever Tauri or linuxdeploy
# tag a new release.
#
# Usage:
#   ./ops/build-sharer-appimage.sh          # full clean build
#   ./ops/build-sharer-appimage.sh --finish # only re-bundle the
#                                           # existing AppDir (faster
#                                           # iteration on workarounds)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SHARER="${REPO_ROOT}/sharer"
APPIMAGE_DIR="${SHARER}/src-tauri/target/release/bundle/appimage"
APPDIR="${APPIMAGE_DIR}/Auffi.AppDir"
LINUXDEPLOY="${HOME}/.cache/tauri/linuxdeploy-x86_64.AppImage"

# ── log helpers ──────────────────────────────────────────────────
_CYAN=$'\033[0;36m'; _GREEN=$'\033[0;32m'; _YELLOW=$'\033[1;33m'; _RED=$'\033[0;31m'; _RESET=$'\033[0m'
log_info()  { printf "%s[appimage]%s  %s\n" "$_CYAN"   "$_RESET" "$*"; }
log_ok()    { printf "%s[appimage]%s  %s\n" "$_GREEN"  "$_RESET" "$*"; }
log_warn()  { printf "%s[appimage]%s  %s\n" "$_YELLOW" "$_RESET" "$*" >&2; }
log_error() { printf "%s[appimage]%s  ERROR: %s\n" "$_RED" "$_RESET" "$*" >&2; }

FINISH_ONLY=false
[[ "${1:-}" == "--finish" ]] && FINISH_ONLY=true

# ── 1. Tauri-Build (deb + rpm + AppDir; AppImage-Schritt darf
#       fehlschlagen wegen #1/#2 oben) ─────────────────────────────
if [[ "${FINISH_ONLY}" == "false" ]]; then
  log_info "Tauri build (NO_STRIP=1 für linuxdeploy)…"
  cd "${SHARER}"
  # `|| true` weil der AppImage-Step beim ersten Lauf wegen #2 (Icon)
  # zuverlässig fehlschlägt; wir reparieren das danach.
  NO_STRIP=1 npm run tauri:build || true
fi

# ── 2. AppDir-Sanity ─────────────────────────────────────────────
if [[ ! -d "${APPDIR}" ]]; then
  log_error "AppDir nicht gefunden: ${APPDIR}"
  log_error "Tauri-Build muss erst die deb/rpm-Stufe durchgelaufen sein."
  exit 1
fi
if [[ ! -x "${LINUXDEPLOY}" ]]; then
  log_error "linuxdeploy nicht gefunden bei ${LINUXDEPLOY}"
  log_error "Erwartet via Tauri-Cache. Ggf. erst einmal `npm run tauri:build` laufen lassen."
  exit 1
fi

# ── 3. Workaround #2: Icon ans Root des AppDir kopieren ──────────
ICON_SRC="${APPDIR}/usr/share/icons/hicolor/256x256@2/apps/auffi-sharer.png"
ICON_DEST="${APPDIR}/auffi-sharer.png"
if [[ -f "${ICON_SRC}" ]]; then
  cp "${ICON_SRC}" "${ICON_DEST}"
  log_info "Icon kopiert: $(realpath --relative-to="${REPO_ROOT}" "${ICON_DEST}")"
else
  log_warn "Icon-Source fehlt (${ICON_SRC}). Build wird trotzdem versucht."
fi

# ── 4. linuxdeploy direkt aufrufen, mit NO_STRIP=1 ───────────────
log_info "linuxdeploy --appdir Auffi.AppDir --output appimage (NO_STRIP=1)…"
cd "${APPIMAGE_DIR}"
NO_STRIP=1 "${LINUXDEPLOY}" --appdir Auffi.AppDir --output appimage

# ── 5. Rename Auffi-x86_64.AppImage → Auffi_<ver>_amd64.AppImage ─
# Tauris .deb/.rpm tragen "<version>_amd64" / "<version>-1.x86_64";
# der direkte linuxdeploy-Output heißt "<name>-x86_64.AppImage".
# Auf der Download-Seite verlinken wir die Tauri-Namens-Konvention,
# also vereinheitlichen.
VERSION="$(grep -E '^version' "${SHARER}/src-tauri/Cargo.toml" | head -1 | sed 's/^version = "\(.*\)"/\1/')"
SRC="${APPIMAGE_DIR}/Auffi-x86_64.AppImage"
DEST="${APPIMAGE_DIR}/Auffi_${VERSION}_amd64.AppImage"
if [[ -f "${SRC}" ]]; then
  mv -f "${SRC}" "${DEST}"
  log_ok "→ $(realpath --relative-to="${REPO_ROOT}" "${DEST}") ($(du -h "${DEST}" | cut -f1))"
else
  log_error "linuxdeploy ist durchgelaufen, aber ${SRC} fehlt. Bundle gescheitert."
  exit 1
fi
