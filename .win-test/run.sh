#!/usr/bin/env bash
# Windows-Installer-Smoke für ein Auffi-Release im QEMU-Windows (dockur).
#
#   .win-test/run.sh v0.7.1                 # Assets holen, prüfen, VM (neu)starten, auf Ergebnis warten
#   .win-test/run.sh v0.7.1 --fresh         # vorher VM-Disk verwerfen → frisches Windows (ISO-Download, ~30–60 min)
#   .win-test/run.sh v0.7.1 --keep-running  # letzte App-Instanz für noVNC (http://127.0.0.1:8007) offen lassen
#   .win-test/run.sh v0.7.1 --no-download   # share/ ist schon bestückt (z. B. lokaler Build)
#
# Warm (VM-Disk vorhanden): Neustart der VM → Logon-Task führt oem/smoke.bat aus → ~3–5 min.
# Der Smoke selbst liest die Version aus share/version.txt; oem/ ist zusätzlich unter
# /data/oem in die Freigabe gemountet, damit smoke.bat ohne Neuinstallation aktuell ist.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

TAG="${1:-}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Aufruf: $0 vX.Y.Z [--fresh] [--keep-running] [--no-download]" >&2; exit 2; }
VER="${TAG#v}"
shift
FRESH=0; KEEP=0; DOWNLOAD=1
for a in "$@"; do
  case "$a" in
    --fresh) FRESH=1 ;;
    --keep-running) KEEP=1 ;;
    --no-download) DOWNLOAD=0 ;;
    *) echo "unbekannte Option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Vorprüfung"
[[ -c /dev/kvm ]] || { echo "/dev/kvm fehlt — kein KVM, kein Windows." >&2; exit 1; }
avail_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
vm_state="$(docker inspect -f '{{.State.Status}}' auffi-win-test 2>/dev/null || echo missing)"
# Eine laufende VM hat ihre 4G schon; die Schwelle gilt nur für den Start.
if [[ "$vm_state" != running ]] && (( avail_mb < 4600 )); then
  echo "Nur ${avail_mb} MB frei — dockur drosselt RAM_SIZE unter 4G frei und die OOBE bleibt hängen. Erst Platz schaffen (z. B. andere VMs stoppen)." >&2
  exit 1
fi
echo "  ${avail_mb} MB frei, KVM da, VM: $vm_state"

ASSETS=("Auffi_${VER}_x64_en-US.msi" "Auffi_${VER}_x64-setup.exe" "Auffi_${VER}_x64_portable.exe")

if (( DOWNLOAD )); then
  say "Assets $TAG laden + prüfen"
  gh release download "$TAG" --repo phash/auffi --dir share --clobber \
    --pattern 'Auffi_*_x64*' --pattern SHA256SUMS
  ( cd share && sha256sum --ignore-missing --check SHA256SUMS )
fi
for a in "${ASSETS[@]}"; do
  [[ -s "share/$a" ]] || { echo "share/$a fehlt — ohne vollständige, geprüfte Assets nicht booten (halb übertragene MSI ⇒ msiexec 1619)." >&2; exit 1; }
done
# Prüfsumme auch ohne Download erzwingen, wenn SHA256SUMS da liegt.
if (( ! DOWNLOAD )) && [[ -f share/SHA256SUMS ]]; then
  ( cd share && sha256sum --ignore-missing --check SHA256SUMS )
fi

say "Freigabe vorbereiten"
printf '%s\r\n' "$VER" > share/version.txt
rm -f share/install-result.txt share/first-boot.txt
if (( KEEP )); then touch share/keep-running; else rm -f share/keep-running; fi
echo "  version.txt=$VER keep-running=$KEEP"

say "VM"
if (( FRESH )); then
  echo "  --fresh: VM-Disk verwerfen (Windows wird neu installiert)"
  docker compose down -v
fi
state="$(docker inspect -f '{{.State.Status}}' auffi-win-test 2>/dev/null || echo missing)"
case "$state" in
  running)
    echo "  läuft → Neustart, damit der Logon-Task den Smoke anstößt"
    docker compose restart windows
    ;;
  missing|exited|created|dead)
    echo "  Zustand: $state → starten"
    docker compose up -d
    ;;
  *)
    echo "  Zustand: $state → docker compose up -d"
    docker compose up -d
    ;;
esac
if docker volume inspect auffi-wintest_auffi-win-data >/dev/null 2>&1 && (( ! FRESH )); then
  deadline=$(( $(date +%s) + 30*60 ))
  echo "  VM-Disk vorhanden — warmer Start, Ergebnis in wenigen Minuten"
else
  deadline=$(( $(date +%s) + 90*60 ))
  echo "  Frische Installation — ISO-Download + Setup, das dauert (30–60 min). Mitschauen: http://127.0.0.1:8007"
fi

say "Warten auf share/install-result.txt"
while :; do
  if [[ -f share/install-result.txt ]] && grep -q "^RESULT=" share/install-result.txt \
     && grep -q "Auffi ${VER} Windows-Installer-Smoke" share/install-result.txt; then
    break
  fi
  if (( $(date +%s) > deadline )); then
    echo "Zeit abgelaufen — kein Ergebnis. noVNC: http://127.0.0.1:8007 · docker logs auffi-win-test" >&2
    [[ -f share/first-boot.txt ]] && cat share/first-boot.txt
    exit 1
  fi
  sleep 20
done

say "Ergebnis"
cat share/install-result.txt
grep -q "^RESULT=PASS" share/install-result.txt
