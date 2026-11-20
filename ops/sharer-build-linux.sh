#!/usr/bin/env bash
# ops/sharer-build-linux.sh — build the Linux sharer packages (.deb, .rpm,
# .AppImage) on the testbox, without GitHub Actions.
#
# Mirrors the build-linux job of .github/workflows/build-sharer.yml: same
# distro (ubuntu:24.04 — its glibc 2.39 is the floor every package runs on,
# see the 0.7.5 postmortem), Rust 1.99.1, Node 22, static libvpx check.
# The build runs on a clean `git archive` of <ref>, never on a dirty tree.
#
# Usage (on the testbox, via tb-run):
#   ops/sharer-build-linux.sh <git-ref> <out-dir>
# Cargo registry and target dir live in docker volumes so a rebuild is
# incremental.
set -euo pipefail

ref="${1:?Aufruf: sharer-build-linux.sh <git-ref> <out-dir>}"
out="${2:?<out-dir> fehlt}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

src="$(mktemp -d)"
trap 'rm -rf "$src"' EXIT
git -C "$repo" archive "$ref" | tar -x -C "$src"

NODE_VERSION=22.23.5
RUST_VERSION=1.99.1

docker run --rm \
  -v "$src:/src:ro" \
  -v "$out:/out" \
  -v auffi-linux-cargo:/root/.cargo \
  -v auffi-linux-rustup:/root/.rustup \
  -v auffi-linux-build:/build \
  -e NODE_VERSION="$NODE_VERSION" -e RUST_VERSION="$RUST_VERSION" \
  -e APPIMAGE_EXTRACT_AND_RUN=1 -e NO_STRIP=1 \
  ubuntu:24.04 bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
      ca-certificates curl xz-utils file rsync binutils build-essential pkg-config \
      libwebkit2gtk-4.1-dev libvpx-dev libssl-dev libgtk-3-dev \
      libayatana-appindicator3-dev librsvg2-dev libxdo-dev libxtst-dev \
      libx11-dev libxrandr-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev >/dev/null
    if [ ! -x /root/.cargo/bin/rustup ]; then
      curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "$RUST_VERSION"
    fi
    export PATH=/root/.cargo/bin:$PATH
    rustup toolchain install "$RUST_VERSION" --profile minimal >/dev/null
    rustup default "$RUST_VERSION" >/dev/null
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
      | tar -xJ -C /opt
    export PATH=/opt/node-v$NODE_VERSION-linux-x64/bin:$PATH
    # Fresh sources each run, but keep the cargo target dir for speed.
    rsync -a --delete --exclude sharer/src-tauri/target /src/ /build/ws/
    cd /build/ws/sharer
    npm ci --no-audit --no-fund
    npm run tauri:build
    bin=src-tauri/target/release/auffi-sharer
    if readelf -d "$bin" | grep -q libvpx; then
      echo "FEHLER: auffi-sharer linkt libvpx dynamisch" >&2
      readelf -d "$bin" | grep NEEDED >&2
      exit 1
    fi
    b=src-tauri/target/release/bundle
    cp "$b"/deb/*.deb "$b"/rpm/*.rpm "$b"/appimage/*.AppImage /out/
  '
ls -l "$out"
