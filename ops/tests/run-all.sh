#!/usr/bin/env bash
# ops/tests/run-all.sh — syntax-check every ops script and run every
# *.test.sh in this directory. Needs bash, git, rsync, ssh-keygen, python3;
# everything remote (ssh/rsync/docker/curl/npm) is stubbed by harness.sh, so
# this never touches a real host.
#
#   ops/tests/run-all.sh
set -euo pipefail
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"

for script in "${OPS_DIR}"/*.sh "${TESTS_DIR}"/*.sh; do
  bash -n "${script}"
done
echo "syntax ok: $(ls "${OPS_DIR}"/*.sh "${TESTS_DIR}"/*.sh | wc -l) scripts"

failed=()
for test in "${TESTS_DIR}"/*.test.sh; do
  printf '\n\033[1m==> %s\033[0m\n' "$(basename "${test}")"
  if ! bash "${test}"; then
    failed+=("$(basename "${test}")")
  fi
done

echo
if [[ ${#failed[@]} -gt 0 ]]; then
  printf '\033[31mFAILED:\033[0m %s\n' "${failed[*]}" >&2
  exit 1
fi
echo "all ops tests passed"
