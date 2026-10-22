#!/bin/sh
set -eu

: "${TURN_SHARED_SECRET:?TURN_SHARED_SECRET must be set}"
: "${TURN_REALM:?TURN_REALM must be set}"

# Paths are overridable only so ops/tests/coturn-entrypoint.test.sh can run
# this script against a scratch dir; production uses the defaults.
CONF_TMPL="${COTURN_CONF_TMPL:-/etc/coturn/turnserver.conf.tmpl}"
CONF_OUT="${COTURN_CONF_OUT:-/tmp/turnserver.conf}"
CERT="${TURN_CERT_FILE:-/var/lib/turn/cert.pem}"
KEY="${TURN_KEY_FILE:-/var/lib/turn/key.pem}"
POLL_SEC="${TURN_CERT_POLL_SEC:-300}"

log() {
  echo "[coturn-entrypoint] $*" >&2
}

# Use sed for substitution — envsubst (from gettext) is not available in the
# coturn/coturn Alpine image.  Escape any forward slashes in the secret values
# so they are safe as sed replacement strings.
secret_escaped="$(printf '%s' "${TURN_SHARED_SECRET}" | sed 's/[&/\\]/\\&/g')"
realm_escaped="$(printf '%s' "${TURN_REALM}" | sed 's/[&/\\]/\\&/g')"

sed \
  -e "s/\${TURN_SHARED_SECRET}/${secret_escaped}/g" \
  -e "s/\${TURN_REALM}/${realm_escaped}/g" \
  "${CONF_TMPL}" \
  > "${CONF_OUT}"

# Optional binding overrides. When set, substitute the value; when unset,
# strip the line so coturn falls back to its auto-detection.
if [ -n "${TURN_LISTENING_IP:-}" ]; then
  listen_escaped="$(printf '%s' "${TURN_LISTENING_IP}" | sed 's/[&/\\]/\\&/g')"
  sed -i -e "s/\${TURN_LISTENING_IP}/${listen_escaped}/g" "${CONF_OUT}"
else
  sed -i -e '/^listening-ip=/d' "${CONF_OUT}"
fi
if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
  ext_escaped="$(printf '%s' "${TURN_EXTERNAL_IP}" | sed 's/[&/\\]/\\&/g')"
  sed -i -e "s/\${TURN_EXTERNAL_IP}/${ext_escaped}/g" "${CONF_OUT}"
else
  sed -i -e '/^external-ip=/d' "${CONF_OUT}"
fi

cert_sum() {
  if [ -s "${CERT}" ] && [ -s "${KEY}" ]; then
    cat "${CERT}" "${KEY}" | cksum
  fi
}

# The smoke template has no cert= line at all — there TLS is not wanted and
# a cert showing up must not trigger anything.
tls_wanted=false
grep -q '^cert=' "${CONF_OUT}" && tls_wanted=true

# If the cert pair the sidecar should have staged is missing (cert not yet
# issued by Caddy, or cluster sidecar disabled), strip the TLS lines so
# coturn still serves plain UDP/TCP TURN on 3478. The watcher below restarts
# the container once a cert shows up.
tls_active=false
if [ "${tls_wanted}" = true ]; then
  if [ -n "$(cert_sum)" ]; then
    tls_active=true
  else
    log "No TLS cert at ${CERT} — disabling TURNS (5349); TURN/UDP 3478 remains active."
    sed -i \
      -e '/^tls-listening-port=/d' \
      -e '/^cert=/d' \
      -e '/^pkey=/d' \
      "${CONF_OUT}"
  fi
fi

# coturn reads cert/key only at startup; a renewed cert (Caddy renews it,
# the turn-cert-stage sidecar copies it here) would otherwise stay unused
# until somebody restarts the container — prod served an expired TURNS cert
# from 2026-10-09 until a manual restart on 2026-10-22. SIGUSR2 makes coturn
# reload cert+key into its TLS context (mainrelay.c reload_ssl_certs).
# A change is acted on only once the pair has been stable for one full poll,
# so a sidecar caught between copying cert and key never hands coturn a
# mismatched pair.
watch_certs() {
  loaded="$(cert_sum)"
  seen="${loaded}"
  while :; do
    sleep "${POLL_SEC}"
    current="$(cert_sum)"
    if [ -z "${current}" ] || [ "${current}" = "${loaded}" ]; then
      seen="${current}"
      continue
    fi
    if [ "${current}" != "${seen}" ]; then
      seen="${current}"
      continue
    fi
    if [ "${tls_active}" = true ]; then
      log "TLS cert changed — reloading via SIGUSR2"
      kill -USR2 "${turn_pid}"
      loaded="${current}"
    else
      # A listener that was never started cannot be enabled by a reload;
      # stop coturn and let the restart policy bring it back with TLS.
      log "TLS cert appeared — restarting coturn to enable TURNS (5349)"
      kill -TERM "${turn_pid}"
      return
    fi
  done
}

turnserver -c "${CONF_OUT}" "$@" &
turn_pid=$!

watch_pid=""
if [ "${tls_wanted}" = true ]; then
  watch_certs &
  watch_pid=$!
fi

# Background jobs of a non-interactive shell ignore SIGINT, so both signals
# are forwarded as SIGTERM — coturn's own clean-shutdown signal.
trap 'kill -TERM "${turn_pid}" 2>/dev/null || true' TERM INT

# `wait` returns early when a trapped signal arrives; keep waiting until
# turnserver itself has exited, then pass its status on.
status=0
while :; do
  wait "${turn_pid}" && status=0 || status=$?
  kill -0 "${turn_pid}" 2>/dev/null || break
done

[ -n "${watch_pid}" ] && kill "${watch_pid}" 2>/dev/null || true
exit "${status}"
