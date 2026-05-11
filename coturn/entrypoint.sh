#!/bin/sh
set -eu

: "${TURN_SHARED_SECRET:?TURN_SHARED_SECRET must be set}"
: "${TURN_REALM:?TURN_REALM must be set}"

CONF_OUT=/tmp/turnserver.conf
CERT=/var/lib/turn/cert.pem
KEY=/var/lib/turn/key.pem

# Use sed for substitution — envsubst (from gettext) is not available in the
# coturn/coturn Alpine image.  Escape any forward slashes in the secret values
# so they are safe as sed replacement strings.
secret_escaped="$(printf '%s' "${TURN_SHARED_SECRET}" | sed 's/[&/\\]/\\&/g')"
realm_escaped="$(printf '%s' "${TURN_REALM}" | sed 's/[&/\\]/\\&/g')"

sed \
  -e "s/\${TURN_SHARED_SECRET}/${secret_escaped}/g" \
  -e "s/\${TURN_REALM}/${realm_escaped}/g" \
  /etc/coturn/turnserver.conf.tmpl \
  > "${CONF_OUT}"

# If the cert pair the sidecar should have staged is missing (cert not yet
# issued by Caddy, or cluster sidecar disabled), strip the TLS lines so
# coturn still serves plain UDP/TCP TURN on 3478. The TLS listener will be
# re-enabled on next restart once the cert exists.
if [ ! -s "${CERT}" ] || [ ! -s "${KEY}" ]; then
  echo "[coturn-entrypoint] No TLS cert at ${CERT} — disabling TURNS (5349); TURN/UDP 3478 remains active." >&2
  sed -i \
    -e '/^tls-listening-port=/d' \
    -e '/^cert=/d' \
    -e '/^pkey=/d' \
    "${CONF_OUT}"
fi

exec turnserver -c "${CONF_OUT}" "$@"
