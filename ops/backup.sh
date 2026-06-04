#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Auffi — Tägliches Backup von SQLite-DB + Caddy-Cert-Volume
#
# Was gesichert wird:
#   1. /var/lib/auffi/auffi.db (accounts, devices, sessions, pairings,
#      connection_log, audit_log) — konsistenter Snapshot via
#      better-sqlite3 .backup() Online-Backup-API.
#   2. Cluster-Caddy-Volumes `caddyserver_caddy_data` und
#      `caddyserver_caddy_config` (Let's-Encrypt-Account + ausgestellte
#      TLS-Certs für auffi.app — UND die anderer Tenants auf dem
#      shared Cluster-Caddy, was beim Host-Restore Bonus ist).
#      Hintergrund: im Cluster-Modus läuft NICHT `auffi-caddy` aus
#      docker-compose.prod.yml, sondern der externe `caddy-proxy`,
#      siehe CLAUDE.md "Cluster-Ops Footguns". `screenie_caddy-data`
#      ist in dieser Topologie ein totes Volume.
#
# Was NICHT gesichert wird (alles reproduzierbar):
#   - viewer-static, dashboard-dist  → fallen aus ./ops/deploy.sh.
#   - turn-certs                     → wird vom turn-cert-stage-Sidecar
#                                       aus caddy-data abgeleitet.
#   - Container-Images               → liegen in der GH-Release.
#
# Usage:
#   ./ops/backup.sh                            # manuell ausführen
#   0 3 * * * /opt/screenie/ops/backup.sh >> /opt/backup/auffi/backup.log 2>&1
#
# Env-Variablen (optional):
#   BACKUP_DIR             — Zielverzeichnis (default: /opt/backup/auffi)
#   BACKUP_RETENTION_DAYS  — Tage bis Löschung (default: 7)
#   BACKUP_REMOTE_TARGET   — rsync-Ziel (z.B. user@host:/backups/auffi/)
#   BACKEND_CONTAINER      — Docker-Container (default: auffi-backend)
#   CADDY_DATA_VOLUME      — Cluster-Caddy data-Volume
#                             (default: caddyserver_caddy_data)
#   CADDY_CONFIG_VOLUME    — Cluster-Caddy config-Volume
#                             (default: caddyserver_caddy_config)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Konfiguration ──────────────────────────────────────────────────────────
BACKEND_CONTAINER="${BACKEND_CONTAINER:-auffi-backend}"
CADDY_DATA_VOLUME="${CADDY_DATA_VOLUME:-caddyserver_caddy_data}"
CADDY_CONFIG_VOLUME="${CADDY_CONFIG_VOLUME:-caddyserver_caddy_config}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backup/auffi}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
REMOTE_TARGET="${BACKUP_REMOTE_TARGET:-}"

TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
# RUN_ID koppelt PID an Timestamp, damit zwei Runs in derselben Sekunde
# (manueller Trigger während des Cron-Slots) sich nicht gegenseitig die
# In-Container-Tmp-Datei klauen.
RUN_ID="${TIMESTAMP}-$$"
DB_FILENAME="auffi-db_${TIMESTAMP}.db.gz"
CADDY_FILENAME="auffi-caddy_${TIMESTAMP}.tar.gz"
DB_FILEPATH="${BACKUP_DIR}/${DB_FILENAME}"
CADDY_FILEPATH="${BACKUP_DIR}/${CADDY_FILENAME}"

# ─── Farben (nur im Terminal) ───────────────────────────────────────────────
if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; NC=''
fi

# Eigene log-Funktionen (statt ops/lib.sh::log_info/log_warn/log_error),
# damit dieses Script standalone via cron läuft, ohne lib.sh sourcen zu
# müssen. Format-Parität mit den Nachbar-Tenant-Backup-Scripts.
log()  { echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] ${GREEN}INFO${NC}  $*"; }
warn() { echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] ${YELLOW}WARN${NC}  $*"; }
err()  { echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] ${RED}ERROR${NC} $*"; }

# ─── Voraussetzungen ────────────────────────────────────────────────────────
log "Backup gestartet — Container: ${BACKEND_CONTAINER}, Caddy-Volumes: ${CADDY_DATA_VOLUME} + ${CADDY_CONFIG_VOLUME}"

if ! docker ps --format '{{.Names}}' | grep -q "^${BACKEND_CONTAINER}$"; then
  err "Container '${BACKEND_CONTAINER}' läuft nicht!"
  exit 1
fi

for vol in "${CADDY_DATA_VOLUME}" "${CADDY_CONFIG_VOLUME}"; do
  if ! docker volume inspect "${vol}" >/dev/null 2>&1; then
    err "Docker-Volume '${vol}' existiert nicht!"
    exit 1
  fi
done

mkdir -p "${BACKUP_DIR}"

# BACKUP_DIR muss vom aktuellen User beschreibbar sein, sonst scheitert
# entweder gzip auf der DB oder die find -delete-Retention.
if ! ( touch "${BACKUP_DIR}/.write-test.$$" && rm -f "${BACKUP_DIR}/.write-test.$$" ) 2>/dev/null; then
  err "BACKUP_DIR '${BACKUP_DIR}' ist nicht beschreibbar für $(id -un)!"
  exit 1
fi

# HOST_UID/HOST_GID werden weiter unten in einen sh -c " ... chown X:Y ..."
# String im alpine-Container interpoliert. id -u/-g sind auf jedem Unix
# numerisch, aber ein Sanity-Check kostet nichts.
HOST_UID=$(id -u)
HOST_GID=$(id -g)
if ! [[ "${HOST_UID}" =~ ^[0-9]+$ && "${HOST_GID}" =~ ^[0-9]+$ ]]; then
  err "id -u/-g lieferte non-numerisches Ergebnis: uid=${HOST_UID} gid=${HOST_GID}"
  exit 1
fi

# Cleanup-Trap VOR dem ersten docker exec: räumt host-tmp UND
# container-tmp auf, auch bei Ctrl-C / cron-Timeout / SIGTERM. Signale
# rufen explizit `exit` mit konventionellem Code (128+signum), das
# triggert dann den EXIT-trap.
DB_TMP_INSIDE="/tmp/auffi-backup-${RUN_ID}.db"
DB_TMP_HOST="$(mktemp -t auffi-backup-XXXXXX.db)"
cleanup() {
  rm -f "${DB_TMP_HOST}"
  docker exec "${BACKEND_CONTAINER}" rm -f "${DB_TMP_INSIDE}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# ─── 1) SQLite-DB-Backup ────────────────────────────────────────────────────
# better-sqlite3 .backup() ist das Pendant zu sqlite3 .backup — nimmt ein
# konsistentes Snapshot OHNE den laufenden Writer zu blockieren. WAL-Inhalt
# wird mit in das Snapshot eingerechnet, kein separater Checkpoint nötig.
log "1/2 SQLite-DB → ${DB_FILENAME}"

# .backup() macht ein konsistentes Online-Snapshot der Live-DB +
# pending WAL, danach PRAGMA integrity_check auf das Snapshot.
# Korruption (sqlite-Page-Defekt, abgebrochener vorheriger Run) wird
# hier abgefangen, BEVOR wir das Backup mit dem retention-keep verewigen.
if ! docker exec "${BACKEND_CONTAINER}" node -e "
  const Database = require('better-sqlite3');
  const src = new Database('/var/lib/auffi/auffi.db', { readonly: true });
  src.backup('${DB_TMP_INSIDE}').then(() => {
    const snap = new Database('${DB_TMP_INSIDE}', { readonly: true });
    const result = snap.pragma('integrity_check', { simple: true });
    snap.close();
    if (result !== 'ok') {
      console.error('integrity_check failed: ' + result);
      process.exit(2);
    }
    console.log('snapshot ok');
    process.exit(0);
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
"; then
  err "better-sqlite3 .backup() oder integrity_check fehlgeschlagen!"
  exit 1
fi

if ! docker cp "${BACKEND_CONTAINER}:${DB_TMP_INSIDE}" "${DB_TMP_HOST}"; then
  err "docker cp aus '${BACKEND_CONTAINER}' fehlgeschlagen!"
  exit 1
fi

if ! gzip -c "${DB_TMP_HOST}" > "${DB_FILEPATH}"; then
  err "gzip fehlgeschlagen!"
  rm -f "${DB_FILEPATH}"
  exit 1
fi

chmod 600 "${DB_FILEPATH}"
DB_SIZE=$(du -h "${DB_FILEPATH}" | cut -f1)
log "DB-Snapshot OK — ${DB_SIZE} (integrity_check ok, gzip ok)"

# ─── 2) Caddy-Cert-Volumes (Cluster-shared) ─────────────────────────────────
# Read-only Bind in einen ephemeren Container, der beide Volumes (data +
# config) zusammen als tar packt. Im resultierenden Archiv liegen die
# Volume-Inhalte unter `./data/` bzw. `./config/`. alpine statt busybox,
# weil busybox-tar nicht zuverlässig mit gz umgehen kann.
#
# Restore-Hinweis: das Archiv enthält Certs aller Cluster-Tenants. Für
# einen auffi-spezifischen Restore nur die `auffi.app/`-Subordner aus
# data/caddy/certificates/.../ rauspacken.
log "2/2 Caddy-Volumes → ${CADDY_FILENAME}"

# tar läuft als root im Container, weil Caddy-Cert-Files 0600 root sind.
# Nach dem tar chown'en wir das Resultat auf HOST_UID/HOST_GID (oben in
# der Pre-flight bereits gesetzt + validiert), damit die find -mtime
# -delete-Retention weiter unten (läuft unprivileged) die alten Files
# entfernen kann.
if ! docker run --rm \
    -v "${CADDY_DATA_VOLUME}:/src/data:ro" \
    -v "${CADDY_CONFIG_VOLUME}:/src/config:ro" \
    -v "${BACKUP_DIR}:/dst" \
    alpine:3.20 \
    sh -c "tar czf '/dst/${CADDY_FILENAME}' -C /src . && chown ${HOST_UID}:${HOST_GID} '/dst/${CADDY_FILENAME}'" ; then
  err "tar der Caddy-Volumes fehlgeschlagen!"
  rm -f "${CADDY_FILEPATH}"
  exit 1
fi

if ! gzip -t "${CADDY_FILEPATH}" 2>/dev/null; then
  err "gzip-Integritätsprüfung fehlgeschlagen — Datei beschädigt: ${CADDY_FILEPATH}"
  rm -f "${CADDY_FILEPATH}"
  exit 1
fi

chmod 600 "${CADDY_FILEPATH}"
CADDY_SIZE=$(du -h "${CADDY_FILEPATH}" | cut -f1)
log "Caddy-Volumes OK — ${CADDY_SIZE} (gzip verifiziert)"

# ─── Alte Backups löschen ────────────────────────────────────────────────────
DB_DELETED=$(find "${BACKUP_DIR}" -name "auffi-db_*.db.gz" -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
CADDY_DELETED=$(find "${BACKUP_DIR}" -name "auffi-caddy_*.tar.gz" -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
TOTAL_DELETED=$((DB_DELETED + CADDY_DELETED))
if [ "${TOTAL_DELETED}" -gt 0 ]; then
  log "Retention: ${TOTAL_DELETED} Backup-Datei(en) älter als ${RETENTION_DAYS} Tage gelöscht (${DB_DELETED} DB, ${CADDY_DELETED} Caddy)"
fi

# ─── Remote-Sync (optional) ─────────────────────────────────────────────────
if [ -n "${REMOTE_TARGET}" ]; then
  log "Remote-Sync → ${REMOTE_TARGET}"
  # timeout 600s: zwei Files mit zusammen ~50KB sind in <1s durch, aber
  # ein langsamer Uplink + andere parallele Backups (5 Tenants laufen
  # zwischen 03:00 und 04:15) können legitim mehr brauchen.
  if rsync -az --timeout=600 "${DB_FILEPATH}" "${CADDY_FILEPATH}" "${REMOTE_TARGET}"; then
    log "Remote-Sync OK"
  else
    warn "Remote-Sync fehlgeschlagen (Exit $?) — lokale Backups bleiben erhalten"
  fi
else
  log "Kein BACKUP_REMOTE_TARGET gesetzt — überspringe Remote-Sync"
fi

# ─── Zusammenfassung ─────────────────────────────────────────────────────────
DB_COUNT=$(find "${BACKUP_DIR}" -name "auffi-db_*.db.gz" | wc -l)
CADDY_COUNT=$(find "${BACKUP_DIR}" -name "auffi-caddy_*.tar.gz" | wc -l)
log "Fertig — ${DB_COUNT} DB- + ${CADDY_COUNT} Caddy-Backup(s) in ${BACKUP_DIR}"
