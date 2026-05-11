#!/usr/bin/env bash
# install-linux.sh — End-user installer for Screenie (Linux)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/phash/screenie/main/scripts/install-linux.sh | bash
#   bash install-linux.sh --uninstall
#
# Supports: Debian/Ubuntu (.deb), Fedora/RHEL (.rpm), Arch (AppImage), others (AppImage)

set -euo pipefail

GITHUB_REPO="phash/screenie"
APP_NAME="screenie"
INSTALL_BIN="/usr/local/bin/$APP_NAME"
DESKTOP_FILE="/usr/share/applications/$APP_NAME.desktop"

# ── Helpers ────────────────────────────────────────────────────────────────────

info()    { echo "[screenie] $*"; }
success() { echo "[screenie] ✓ $*"; }
warn()    { echo "[screenie] ⚠ $*" >&2; }
err()     { echo "[screenie] ✗ $*" >&2; exit 1; }

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
    warn "Please install: webkit2gtk-4.1, libvpx manually before running Screenie."
  fi
  success "Dependencies installed."
}

# ── Fetch latest release info ──────────────────────────────────────────────────

get_latest_version() {
  if command -v gh &>/dev/null; then
    gh release view --repo "$GITHUB_REPO" --json tagName -q .tagName 2>/dev/null || echo "v0.1.0"
  else
    curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/latest" \
      2>/dev/null | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/' || echo "v0.1.0"
  fi
}

download_asset() {
  local asset_name="$1"
  local dest="$2"
  info "Downloading $asset_name..."
  if command -v gh &>/dev/null; then
    gh release download --repo "$GITHUB_REPO" --pattern "$asset_name" --output "$dest" 2>/dev/null && return 0
  fi
  local url="https://github.com/$GITHUB_REPO/releases/download/$VERSION/$asset_name"
  curl -fsSL -o "$dest" "$url" || return 1
  return 0
}

# ── Install ────────────────────────────────────────────────────────────────────

install_deb() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local deb_file="$tmpdir/screenie.deb"
  # Try versioned name pattern; fall back to generic
  local asset_name="screenie_${VERSION#v}_amd64.deb"
  download_asset "$asset_name" "$deb_file" || err "Could not download $asset_name from GitHub release $VERSION."
  info "Installing .deb package..."
  $SUDO dpkg -i "$deb_file" || $SUDO apt-get install -f -y
  rm -rf "$tmpdir"
  success "Screenie installed via .deb"
}

install_rpm() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local rpm_file="$tmpdir/screenie.rpm"
  local asset_name="screenie-${VERSION#v}-1.x86_64.rpm"
  download_asset "$asset_name" "$rpm_file" || err "Could not download $asset_name from GitHub release $VERSION."
  info "Installing .rpm package..."
  if command -v dnf &>/dev/null; then
    $SUDO dnf localinstall -y "$rpm_file"
  else
    $SUDO rpm -U "$rpm_file"
  fi
  rm -rf "$tmpdir"
  success "Screenie installed via .rpm"
}

install_appimage() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  local appimage_file="$tmpdir/screenie.AppImage"
  local asset_name="screenie_${VERSION#v}_amd64.AppImage"
  download_asset "$asset_name" "$appimage_file" || err "Could not download $asset_name from GitHub release $VERSION."
  chmod +x "$appimage_file"
  $SUDO mv "$appimage_file" "$INSTALL_BIN"
  success "Screenie installed as AppImage at $INSTALL_BIN"

  # Create a minimal .desktop entry
  $SUDO tee "$DESKTOP_FILE" > /dev/null <<EOF
[Desktop Entry]
Name=Screenie
Comment=Sicheres Screen-Sharing mit Fernsteuerung
Exec=$INSTALL_BIN
Icon=screenie
Terminal=false
Type=Application
Categories=Network;RemoteAccess;
EOF
  $SUDO update-desktop-database /usr/share/applications/ 2>/dev/null || true
}

# ── Uninstall ──────────────────────────────────────────────────────────────────

do_uninstall() {
  info "Uninstalling Screenie..."
  need_sudo
  detect_distro

  if is_debian_based && dpkg -l screenie &>/dev/null 2>&1; then
    $SUDO dpkg -r screenie && success "Removed .deb package." || true
  elif is_fedora_based && rpm -q screenie &>/dev/null 2>&1; then
    $SUDO rpm -e screenie && success "Removed .rpm package." || true
  fi

  # Clean up AppImage / symlink / manual install
  [[ -f "$INSTALL_BIN" ]]   && $SUDO rm -f "$INSTALL_BIN"   && success "Removed $INSTALL_BIN"
  [[ -f "$DESKTOP_FILE" ]]  && $SUDO rm -f "$DESKTOP_FILE"  && success "Removed $DESKTOP_FILE"
  $SUDO update-desktop-database /usr/share/applications/ 2>/dev/null || true
  success "Screenie uninstalled."
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
  info "Done! Launch Screenie:"
  info "  → From your app menu: search for 'Screenie'"
  info "  → Or run: screenie"
  info ""
  info "Viewer (Helfer-Seite): https://screenie.mr-development.de"
}

main "$@"
