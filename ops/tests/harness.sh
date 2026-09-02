#!/usr/bin/env bash
# ops/tests/harness.sh — shared helpers for the ops shell tests.
#
# Source from a test file. Provides:
#   TMP                       — per-test scratch dir, removed on exit
#   assert_eq / assert_contains / assert_file_eq / assert_not_contains
#   stage_ops <dir>           — copy ops/*.sh into <dir>/ops without any
#                               ops/.env.deploy, so a developer's real deploy
#                               target can never leak into a test run
#   install_stubs <bindir>    — fake ssh / rsync / docker / curl on PATH that
#                               run "remote" commands locally and log every
#                               call to ${STUB_LOG}
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

FAILED=0

_fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$1" >&2
  FAILED=$(( FAILED + 1 ))
}

_ok() {
  printf '  \033[32mok\033[0m   %s\n' "$1"
}

assert_eq() {
  local expected="$1" actual="$2" msg="$3"
  if [[ "${expected}" == "${actual}" ]]; then _ok "${msg}"; else _fail "${msg} — expected [${expected}] got [${actual}]"; fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then _ok "${msg}"; else _fail "${msg} — [${needle}] not found in:"$'\n'"${haystack}"; fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then _ok "${msg}"; else _fail "${msg} — [${needle}] unexpectedly found"; fi
}

assert_file_eq() {
  local file="$1" expected="$2" msg="$3"
  if [[ -f "${file}" ]]; then assert_eq "${expected}" "$(cat "${file}")" "${msg}"; else _fail "${msg} — ${file} missing"; fi
}

finish() {
  if [[ ${FAILED} -gt 0 ]]; then
    printf '\033[31m%d assertion(s) failed\033[0m\n' "${FAILED}" >&2
    exit 1
  fi
  printf '\033[32mall assertions passed\033[0m\n'
}

stage_ops() {
  local dest="$1"
  mkdir -p "${dest}/ops"
  cp "${OPS_DIR}"/*.sh "${dest}/ops/"
}

install_stubs() {
  local bin="$1"
  mkdir -p "${bin}"
  export STUB_LOG="${bin}/calls.log"
  : > "${STUB_LOG}"
  REAL_RSYNC="$(command -v rsync)"
  export REAL_RSYNC

  # ssh: drop -tt / -o pairs, then run the remote command string locally.
  cat > "${bin}/ssh" <<'STUB'
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    -tt) shift ;;
    -o) shift 2 ;;
    *) break ;;
  esac
done
target="$1"; shift
printf 'ssh %s %s\n' "${target}" "$*" >> "${STUB_LOG}"
exec bash -c "$*"
STUB

  # rsync: strip the -e transport and the user@host: prefix, then run the
  # real rsync so file semantics (--delete, trailing slashes) stay real.
  cat > "${bin}/rsync" <<'STUB'
#!/usr/bin/env bash
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -e) shift 2 ;;
    --progress) shift ;;
    *)
      arg="$1"
      if [[ "${arg}" =~ ^[^/:@]+@[^/:]+:(.*)$ ]]; then arg="${BASH_REMATCH[1]}"; fi
      args+=("${arg}"); shift ;;
  esac
done
printf 'rsync %s\n' "${args[*]}" >> "${STUB_LOG}"
exec "${REAL_RSYNC}" "${args[@]}"
STUB

  cat > "${bin}/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "${STUB_LOG}"
exit 0
STUB

  # curl: every URL is healthy. The deploy's random-path probe answers
  # STUB_SMOKETEST_STATUS (default 200 = standalone SPA fallback; a cluster
  # test sets 404).
  cat > "${bin}/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "${STUB_LOG}"
url="${*: -1}"
if [[ "$*" == *'%{http_code}'* ]]; then
  if [[ "${url}" == *smoketest* ]]; then printf '%s' "${STUB_SMOKETEST_STATUS:-200}"; else printf '200'; fi
else
  printf '{"status":"ok"}\n'
fi
exit 0
STUB

  chmod +x "${bin}"/ssh "${bin}"/rsync "${bin}"/docker "${bin}"/curl
}
