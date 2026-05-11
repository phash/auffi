#!/bin/sh
set -eu

: "${TURN_SHARED_SECRET:?TURN_SHARED_SECRET must be set}"
: "${TURN_REALM:?TURN_REALM must be set}"

CONF_OUT=/tmp/turnserver.conf

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

exec turnserver -c "${CONF_OUT}" "$@"
