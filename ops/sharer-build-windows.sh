#!/usr/bin/env bash
# ops/sharer-build-windows.sh — build the Windows sharer packages (NSIS
# setup.exe, MSI, portable .exe) in a tb-win VM on the testbox, without
# GitHub Actions.
#
#   ops/sharer-build-windows.sh <git-ref> <out-dir>
#       Release build. Needs a golden disk that carries the toolchain.
#   ops/sharer-build-windows.sh --toolchain <git-ref> <out-dir>
#       One-time: installs the toolchain (ops/winbuild/toolchain.cmd) in a
#       copy of the golden disk, does a warm build of <ref>, and promotes the
#       copy to the new golden disk. The old golden is kept as a reflink
#       backup (/srv/win/golden.bak-<timestamp>, costs no space until it
#       diverges). Affects every project's later tb-win runs.
#
# Sources reach the VM as a clean `git archive` of <ref> on the run's share.
set -euo pipefail

toolchain=0
[ "${1:-}" = "--toolchain" ] && { toolchain=1; shift; }
ref="${1:?Aufruf: sharer-build-windows.sh [--toolchain] <git-ref> <out-dir>}"
out="${2:?<out-dir> fehlt}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
name=auffi-winbuild
work="$HOME/work/$name"

say() { printf '[winbuild] %s\n' "$*" >&2; }
die() { say "FEHLER: $*"; exit 1; }

sudo rm -rf "$work"
mkdir -p "$work/oem" "$work/share/src" "$out"
out="$(cd "$out" && pwd)"
git -C "$repo" archive "$ref" | tar -x -C "$work/share/src"

# cmd.exe needs CRLF for labels.
crlf() { sed 's/\r$//; s/$/\r/' "$1" > "$2"; }
crlf "$repo/ops/winbuild/build.cmd" "$work/oem/build.cmd"
if [ $toolchain = 1 ]; then
  crlf "$repo/ops/winbuild/toolchain.cmd" "$work/oem/toolchain.cmd"
  printf '@echo off\r\ncall \\\\host.lan\\Data\\oem\\toolchain.cmd\r\n' > "$work/oem/install.bat"
  until_f=toolchain-result.txt; timeout=300; keep=--keep
else
  printf '@echo off\r\ncall \\\\host.lan\\Data\\oem\\build.cmd\r\n' > "$work/oem/install.bat"
  until_f=build-result.txt; timeout=120; keep=
fi

rc=0
tb-win run "$name" "$work" --until "$until_f" --timeout "$timeout" --ram 8G $keep || rc=$?
grep -q 'RESULT=PASS' "$work/share/$until_f" 2>/dev/null || {
  say "Log-Ende:"; tail -40 "$work/share/build.log" "$work/share/toolchain.log" 2>/dev/null || true
  [ $toolchain = 1 ] && tb-win stop "$name"
  die "Build fehlgeschlagen (rc=$rc)"
}

if [ $toolchain = 1 ]; then
  say "warte, bis Windows heruntergefahren ist …"
  for _ in $(seq 60); do
    docker inspect -f '{{.State.Running}}' "tbwin-$name" 2>/dev/null | grep -q true || break
    sleep 5
  done
  docker inspect -f '{{.State.Running}}' "tbwin-$name" 2>/dev/null | grep -q true \
    && { docker stop -t 120 "tbwin-$name" >/dev/null; }
  others=$(docker ps --format '{{.Names}}' | grep '^tbwin-' || true)
  [ -z "$others" ] || { tb-win stop "$name"; die "andere tb-win-VMs laufen ($others) — golden nicht ersetzt"; }
  stamp=$(date +%Y%m%d-%H%M)
  sudo cp -a --reflink=always /srv/win/golden "/srv/win/golden.bak-$stamp"
  sudo cp -a --reflink=always "/srv/win/runs/$name/." /srv/win/golden/
  sudo chmod -R a+rX /srv/win/golden
  tb-win stop "$name"
  say "golden ersetzt (Backup: /srv/win/golden.bak-$stamp)"
fi

cp "$work"/share/out/* "$out/"
ls -l "$out"
