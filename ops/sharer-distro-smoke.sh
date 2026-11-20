#!/usr/bin/env bash
# Install the Linux sharer packages on clean distro containers and check that
# every shared library the binary needs resolves.
#
#   ops/sharer-distro-smoke.sh v0.7.5            # download the release assets
#   ops/sharer-distro-smoke.sh --dir <bundles>   # use local .deb/.rpm/.AppImage
#
# Catches what a build-host test cannot: a package that installs cleanly but
# whose binary does not start, because a library soname (libvpx) or the glibc
# floor of the build host does not exist on the target distro. v0.7.4 shipped
# a .deb that did not start on Ubuntu 26.04 and Debian 12 that way.
#
# Needs docker. Pulls the distro images on first use. Run it on testbox via
# tb-run (CLAUDE.md § Testbox).
set -euo pipefail

DEB_IMAGES=(debian:13 ubuntu:24.04 ubuntu:26.04)
# No RHEL/Alma: webkit2gtk4.1 is not in their base repos, so the rpm does
# not install there and the download page does not claim it.
RPM_IMAGES=(fedora:42 fedora:43)
APPIMAGE_IMAGES=(debian:13 ubuntu:24.04 ubuntu:26.04 fedora:43)

usage() { echo "Aufruf: $0 vX.Y.Z | --dir <bundle-dir>" >&2; exit 2; }

[[ $# -ge 1 ]] || usage
if [[ "$1" == --dir ]]; then
  [[ $# -eq 2 && -d "$2" ]] || usage
  DIR="$(cd "$2" && pwd)"
else
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
  DIR="$(mktemp -d)"
  trap 'rm -rf "$DIR"' EXIT
  gh release download "$1" --repo phash/auffi --dir "$DIR" \
    --pattern '*.deb' --pattern '*.rpm' --pattern '*.AppImage' --pattern SHA256SUMS
  ( cd "$DIR" && sha256sum --ignore-missing --check SHA256SUMS )
fi

one() { find "$DIR" -maxdepth 1 -name "$1" -printf '%f\n' | head -1; }
DEB="$(one '*.deb')"; RPM="$(one '*.rpm')"; APPIMAGE="$(one '*.AppImage')"
[[ -n "$DEB" && -n "$RPM" && -n "$APPIMAGE" ]] || { echo "deb/rpm/AppImage fehlt in $DIR" >&2; exit 1; }

# Prints the unresolved libraries (or glibc version errors) of a binary;
# empty output means everything resolves.
LDD_CHECK='ldd "$BIN" 2>&1 | grep -E "not found" | sed -E "s/^[[:space:]]+//" | sort -u'

fail=0
report() {  # <kind> <image> <output>
  if [[ "$3" == OK ]]; then
    printf '  ok    %-9s %s\n' "$1" "$2"
  else
    printf '  FAIL  %-9s %s\n%s\n' "$1" "$2" "$(sed 's/^/          /' <<<"$3")"
    fail=1
  fi
}

run() {  # <image> <script>
  # Pull first: an implicit pull writes its progress into the captured output,
  # and a fresh image then reads as a failed package.
  docker pull -q "$1" >/dev/null 2>&1 || true
  docker run --rm -v "$DIR:/p:ro" "$1" bash -c "$2" 2>&1 || true
}

echo "== Linux-Sharer-Pakete aus $DIR"
for img in "${DEB_IMAGES[@]}"; do
  out="$(run "$img" "export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq /p/$DEB >/tmp/i.log 2>&1 || { echo install failed:; tail -5 /tmp/i.log; exit 0; }
    BIN=/usr/bin/auffi-sharer; m=\$($LDD_CHECK); [ -z \"\$m\" ] && echo OK || echo \"\$m\"")"
  report deb "$img" "$out"
done
for img in "${RPM_IMAGES[@]}"; do
  out="$(run "$img" "dnf install -y -q /p/$RPM >/tmp/i.log 2>&1 || { echo install failed:; tail -5 /tmp/i.log; exit 0; }
    BIN=/usr/bin/auffi-sharer; m=\$($LDD_CHECK); [ -z \"\$m\" ] && echo OK || echo \"\$m\"")"
  report rpm "$img" "$out"
done
# The AppImage brings its own libraries but still needs the host's glibc and
# the desktop stack (GL, X11) every desktop install has; the setup lines pull
# that stack in through WebKitGTK. Extract instead of mounting (no FUSE in
# docker).
for img in "${APPIMAGE_IMAGES[@]}"; do
  case "$img" in
    fedora:*) setup='dnf install -y -q webkit2gtk4.1 gtk3 libayatana-appindicator-gtk3 >/dev/null 2>&1' ;;
    *) setup='export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq libwebkit2gtk-4.1-0 libayatana-appindicator3-1 >/dev/null 2>&1' ;;
  esac
  out="$(run "$img" "$setup
    cd /tmp && /p/$APPIMAGE --appimage-extract >/dev/null 2>&1 || { cp /p/$APPIMAGE a && chmod +x a && ./a --appimage-extract >/dev/null; }
    export LD_LIBRARY_PATH=/tmp/squashfs-root/usr/lib
    BIN=/tmp/squashfs-root/usr/bin/auffi-sharer; m=\$($LDD_CHECK); [ -z \"\$m\" ] && echo OK || echo \"\$m\"")"
  report AppImage "$img" "$out"
done

(( fail == 0 )) && echo "== alle Pakete ok" || { echo "== FEHLER (s. oben)"; exit 1; }
