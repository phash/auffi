#!/usr/bin/env bash
# ops/tests/lib-ssh-pin.test.sh — the ops scripts must verify the VPS host
# key against the committed ops/known_hosts, never trust-on-first-use.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

# shellcheck source=../lib.sh
source "${OPS_DIR}/lib.sh"

OPTS="${SSH_OPTS[*]}"
assert_contains "${OPTS}" "-o StrictHostKeyChecking=yes" "host key mismatch or unknown host is fatal"
assert_not_contains "${OPTS}" "accept-new" "no trust-on-first-use"
assert_contains "${OPTS}" "-o UserKnownHostsFile=${OPS_DIR}/known_hosts" "pinned known_hosts file next to lib.sh"
assert_contains "${OPTS}" "-o BatchMode=yes" "no interactive prompts (cron/CI)"

echo "# the committed file pins the default deploy target"
assert_eq "true" "$([[ -s "${OPS_DIR}/known_hosts" ]] && echo true || echo false)" "ops/known_hosts exists and is non-empty"
assert_eq "true" "$(ssh-keygen -F musikersuche.org -f "${OPS_DIR}/known_hosts" >/dev/null && echo true || echo false)" "entry for the default host present"
hashed="$(grep -c '^|1|' "${OPS_DIR}/known_hosts" || true)"
assert_eq "0" "${hashed}" "entries are plain (auditable), not hashed"

echo "# self-hosters can point at their own file"
OPTS_OVERRIDE="$(DEPLOY_KNOWN_HOSTS=/elsewhere/known_hosts bash -c "source '${OPS_DIR}/lib.sh'; echo \"\${SSH_OPTS[*]}\"")"
assert_contains "${OPTS_OVERRIDE}" "-o UserKnownHostsFile=/elsewhere/known_hosts" "DEPLOY_KNOWN_HOSTS overrides the file"
assert_contains "${OPTS_OVERRIDE}" "-o StrictHostKeyChecking=yes" "override keeps strict checking"

echo "# ... also from ops/.env.deploy, which is sourced after lib.sh"
stage_ops "${TMP}/repo"
printf 'DEPLOY_KNOWN_HOSTS=/from/env-deploy/known_hosts\n' > "${TMP}/repo/ops/.env.deploy"
printf '#!/usr/bin/env bash\nsource "$(dirname "$0")/lib.sh"\nload_deploy_env >/dev/null\necho "${SSH_OPTS[*]}"\n' > "${TMP}/repo/ops/probe.sh"
OPTS_ENV_DEPLOY="$(bash "${TMP}/repo/ops/probe.sh")"
assert_contains "${OPTS_ENV_DEPLOY}" "-o UserKnownHostsFile=/from/env-deploy/known_hosts" "DEPLOY_KNOWN_HOSTS from .env.deploy is honoured"

finish
