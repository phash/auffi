#!/usr/bin/env bash
# build-linux-release.sh — Builds Auffi Sharer for Linux and collects artifacts
# Usage: ./scripts/build-linux-release.sh [--clean]
# Idempotent: safe to run multiple times.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist/linux"
SHARER_DIR="$REPO_ROOT/sharer"
BUNDLE_DIR="$SHARER_DIR/src-tauri/target/release/bundle"

# --clean flag: remove dist/linux before building
if [[ "${1:-}" == "--clean" ]]; then
  echo "==> --clean: removing $DIST_DIR"
  rm -rf "$DIST_DIR"
fi

mkdir -p "$DIST_DIR"

# Ensure Rust toolchain is on PATH
if command -v rustup &>/dev/null; then
  export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"
fi

echo "==> Installing npm dependencies for sharer..."
cd "$SHARER_DIR"
npm ci

echo "==> Building Tauri release bundle..."
npm run tauri:build

echo "==> Collecting artifacts into $DIST_DIR..."
FOUND=0

# AppImage
while IFS= read -r -d '' f; do
  cp -v "$f" "$DIST_DIR/"
  FOUND=1
done < <(find "$BUNDLE_DIR/appimage" -name "*.AppImage" -print0 2>/dev/null || true)

# .deb
while IFS= read -r -d '' f; do
  cp -v "$f" "$DIST_DIR/"
  FOUND=1
done < <(find "$BUNDLE_DIR/deb" -name "*.deb" -print0 2>/dev/null || true)

# .rpm
while IFS= read -r -d '' f; do
  cp -v "$f" "$DIST_DIR/"
  FOUND=1
done < <(find "$BUNDLE_DIR/rpm" -name "*.rpm" -print0 2>/dev/null || true)

if [[ $FOUND -eq 0 ]]; then
  echo "WARNING: No bundle artifacts found under $BUNDLE_DIR" >&2
  echo "  Check that Tauri build succeeded and bundle targets are configured."
  exit 1
fi

echo "==> Generating SHA256SUMS..."
cd "$DIST_DIR"
sha256sum ./* > SHA256SUMS
echo ""
echo "==> Artifacts in $DIST_DIR:"
ls -lh "$DIST_DIR"
echo ""
echo "==> SHA256SUMS:"
cat "$DIST_DIR/SHA256SUMS"
echo ""
echo "Build complete."
