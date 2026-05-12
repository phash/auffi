#!/usr/bin/env bash
# install-linux.sh — End-user installer for Auffi (Linux)
# Usage:
#   curl -fsSL https://auffi.app/download/install-linux.sh | bash
#   bash install-linux.sh --uninstall
#
# Binaries are hosted on auffi.app/download/ (not on GitHub Releases).
# The script reads /download/latest.txt to discover the current version,
# then fetches the matching .deb / .rpm / .AppImage asset.
#
# Supports: Debian/Ubuntu (.deb), Fedora/RHEL (.rpm), Arch (AppImage), others (AppImage)

set -euo pipefail

DOWNLOAD_BASE_URL="${AUFFI_DOWNLOAD_BASE:-https://auffi.app/download}"
APP_NAME="auffi"
INSTALL_BIN="/usr/local/bin/$APP_NAME"
DESKTOP_FILE="/usr/share/applications/$APP_NAME.desktop"

# ── Helpers ────────────────────────────────────────────────────────────────────

info()    { echo "[auffi] $*"; }
success() { echo "[auffi] ✓ $*"; }
warn()    { echo "[auffi] ⚠ $*" >&2; }
err()     { echo "[auffi] ✗ $*" >&2; exit 1; }

need_sudo() {
  if [[ $EUID -ne 0 ]]; then
    SUDO="sudo"
    command -v sudo &>/dev/null || err "sudo not found — please run as root."
  else
    SUDO=""
  fi
}

# ── Detect distro ──────────────────────────────────────────────────────────────

detect_distro() {
  ID=""
  ID_LIKE=""
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    source /etc/os-release
  fi
  DISTRO_ID="${ID:-unknown}"
  DISTRO_LIKE="${ID_LIKE:-}"
}

is_debian_based() {
  [[ "$DISTRO_ID" == "debian" || "$DISTRO_ID" == "ubuntu" || "$DISTRO_ID" == "linuxmint" ]] ||
    echo "$DISTRO_LIKE" | grep -qE '(debian|ubuntu)'
}

is_fedora_based() {
  [[ "$DISTRO_ID" == "fedora" || "$DISTRO_ID" == "rhel" || "$DISTRO_ID" == "centos" || "$DISTRO_ID" == "rocky" || "$DISTRO_ID" == "almalinux" ]] ||
    echo "$DISTRO_LIKE" | grep -qE '(fedora|rhel)'
}

is_arch_based() {
  [[ "$DISTRO_ID" == "arch" || "$DISTRO_ID" == "manjaro" || "$DISTRO_ID" == "endeavouros" ]] ||
    echo "$DISTRO_LIKE" | grep -qw 'arch'
}

# ── Install dependencies ───────────────────────────────────────────────────────

install_deps() {
  info "Installing runtime dependencies..."
  if is_debian_based; then
    $SUDO apt-get update -qq
    $SUDO apt-get install -y libwebkit2gtk-4.1-0 libvpx-dev 2>/dev/null || \
      $SUDO apt-get install -y libwebkit2gtk-4.0-37 libvpx-dev
  elif is_fedora_based; then
    $SUDO dnf install -y webkit2gtk4.1 libvpx 2>/dev/null || \
      $SUDO dnf install -y webkit2gtk3 libvpx
  elif is_arch_based; then
    $SUDO pacman -Sy --noconfirm webkit2gtk-4.1 libvpx
  else
    warn "Unknown distro '$DISTRO_ID' — skipping automatic dependency install."
    warn "Please install: webkit2gtk-4.1, libvpx manually before running Auffi."
  fi
  success "Dependencies installed."
}

# ── Fetch latest release info ──────────────────────────────────────────────────

# Custom UA so the cluster Caddy bot-filter does not block these requests
# (default `curl/X.Y` matches the scraper regex).
INSTALLER_UA="auffi-installer/0.2.0"

# Reads /download/latest.txt from the auffi.app server. Returns "v<semver>".
get_latest_version() {
  local v
  v="$(curl -fsSL -A "$INSTALLER_UA" "$DOWNLOAD_BASE_URL/latest.txt" 2>/dev/null | tr -d '\r\n[:space:]')"
  if [[ -z "$v" ]]; then
    err "Could not read latest version from $DOWNLOAD_BASE_URL/latest.txt"
  fi
  # Normalise to v-prefixed for downstream `${VERSION#v}` stripping.
  [[ "$v" =~ ^v ]] && echo "$v" || echo "v$v"
}

download_asset() {
  local asset_name="$1"
  local dest="$2"
  info "Downloading $asset_name from $DOWNLOAD_BASE_URL ..."
  curl -fsSL -A "$INSTALLER_UA" -o "$dest" "$DOWNLOAD_BASE_URL/$asset_name" || return 1
  return 0
}

# ── Install ────────────────────────────────────────────────────────────────────

install_deb() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local deb_file="$tmpdir/auffi.deb"
  # Try versioned name pattern; fall back to generic
  local asset_name="auffi_${VERSION#v}_amd64.deb"
  download_asset "$asset_name" "$deb_file" || err "Could not download $asset_name from GitHub release $VERSION."
  info "Installing .deb package..."
  $SUDO dpkg -i "$deb_file" || $SUDO apt-get install -f -y
  rm -rf "$tmpdir"
  success "Auffi installed via .deb"
}

install_rpm() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local rpm_file="$tmpdir/auffi.rpm"
  local asset_name="auffi-${VERSION#v}-1.x86_64.rpm"
  download_asset "$asset_name" "$rpm_file" || err "Could not download $asset_name from GitHub release $VERSION."
  info "Installing .rpm package..."
  if command -v dnf &>/dev/null; then
    $SUDO dnf localinstall -y "$rpm_file"
  else
    $SUDO rpm -U "$rpm_file"
  fi
  rm -rf "$tmpdir"
  success "Auffi installed via .rpm"
}

install_appimage() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local appimage_file="$tmpdir/auffi.AppImage"
  local asset_name="auffi_${VERSION#v}_amd64.AppImage"
  download_asset "$asset_name" "$appimage_file" || err "Could not download $asset_name from GitHub release $VERSION."
  chmod +x "$appimage_file"
  $SUDO mv "$appimage_file" "$INSTALL_BIN"
  success "Auffi installed as AppImage at $INSTALL_BIN"

  # Create a minimal .desktop entry
  $SUDO tee "$DESKTOP_FILE" > /dev/null <<EOF
[Desktop Entry]
Name=Auffi
Comment=Sicheres Screen-Sharing mit Fernsteuerung
Exec=$INSTALL_BIN
Icon=auffi
Terminal=false
Type=Application
Categories=Network;RemoteAccess;
EOF
  $SUDO update-desktop-database /usr/share/applications/ 2>/dev/null || true
}

# ── Uninstall ──────────────────────────────────────────────────────────────────

do_uninstall() {
  info "Uninstalling Auffi..."
  need_sudo
  detect_distro

  # Remove current package, plus any leftover screenie package from pre-rebrand installs.
  if is_debian_based; then
    for pkg in auffi screenie; do
      if dpkg -l "$pkg" &>/dev/null 2>&1; then
        $SUDO dpkg -r "$pkg" && success "Removed .deb package $pkg." || true
      fi
    done
  elif is_fedora_based; then
    for pkg in auffi screenie; do
      if rpm -q "$pkg" &>/dev/null 2>&1; then
        $SUDO rpm -e "$pkg" && success "Removed .rpm package $pkg." || true
      fi
    done
  fi

  # Clean up AppImage / symlink / manual install (current + legacy paths)
  for bin in "$INSTALL_BIN" /usr/local/bin/screenie; do
    [[ -f "$bin" ]] && $SUDO rm -f "$bin" && success "Removed $bin"
  done
  for desktop in "$DESKTOP_FILE" /usr/share/applications/screenie.desktop; do
    [[ -f "$desktop" ]] && $SUDO rm -f "$desktop" && success "Removed $desktop"
  done
  $SUDO update-desktop-database /usr/share/applications/ 2>/dev/null || true
  success "Auffi uninstalled."
}

# ── Main ───────────────────────────────────────────────────────────────────────

main() {
  if [[ "${1:-}" == "--uninstall" ]]; then
    do_uninstall
    exit 0
  fi

  need_sudo
  detect_distro
  install_deps

  VERSION="$(get_latest_version)"
  info "Latest release: $VERSION"

  if is_debian_based; then
    install_deb
  elif is_fedora_based; then
    install_rpm
  else
    # Arch and everything else: use AppImage
    install_appimage
  fi

  info ""
  info "Done! Launch Auffi:"
  info "  → From your app menu: search for 'Auffi'"
  info "  → Or run: auffi"
  info ""
  info "Viewer (Helfer-Seite): https://auffi.app"
}

main "$@"
