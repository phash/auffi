#!/usr/bin/env bash
# ops/tests/health-check.test.sh — the MRD status post must send
# {"status": {...}} (the API's contract, see ~/.claude/CLAUDE.md gotcha),
# keep the other projects' entries in that record, and surface a non-2xx
# body instead of swallowing it.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

stage_ops "${TMP}/repo"
printf 'MRD_API_KEY=test-key\nMRD_CLUSTER_ID=cluster-1\nSMTP_PASS=we$ird"chars\n' > "${TMP}/repo/.env.prod"

mkdir -p "${TMP}/bin"
export STUB_LOG="${TMP}/bin/calls.log"
export PUT_BODY_FILE="${TMP}/put-body.json"
# curl stub: probes answer per STUB_PROBE_FAIL, the MRD GET returns a record
# that already holds another project's status, the MRD PUT records its body.
cat > "${TMP}/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "${STUB_LOG}"
method=GET; data=""; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) data="$2"; shift 2 ;;
    -H|--max-time|-o|-w) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "${url}" == *mr-development.de* ]]; then
  if [[ "${method}" == "PUT" ]]; then
    printf '%s' "${data}" > "${PUT_BODY_FILE}"
    printf '%s\n%s' "${STUB_PUT_BODY:-{\}}" "${STUB_PUT_STATUS:-200}"
  else
    printf '{"data":{"id":"cluster-1","status":{"chords":"LIVE since 2026-08-07"}}}'
  fi
  exit 0
fi
if [[ -n "${STUB_PROBE_FAIL:-}" ]]; then exit 22; fi
printf '{"status":"ok"}\n'
STUB
chmod +x "${TMP}/bin/curl"

run_health() {
  : > "${STUB_LOG}"; rm -f "${PUT_BODY_FILE}"
  env -i PATH="${TMP}/bin:${PATH}" HOME="${HOME}" STUB_LOG="${STUB_LOG}" PUT_BODY_FILE="${PUT_BODY_FILE}" \
    DEPLOY_DOMAIN="deploy.invalid" "$@" bash "${TMP}/repo/ops/health-check.sh"
}

# pf <python-statement> — runs the statement with `d` = the recorded PUT body.
pf() {
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); $1" "${PUT_BODY_FILE}"
}

echo "# all probes ok → operational, wrapped in status, other project kept"
RC=0; OUT="$(run_health 2>&1)" || RC=$?
assert_eq 0 "${RC}" "exit 0 when probes pass"
assert_eq "true" "$([[ -f "${PUT_BODY_FILE}" ]] && echo true || echo false)" "a PUT was sent"
assert_eq "['status']" "$(pf 'print(sorted(d))')" "payload has exactly one top-level key: status"
assert_eq "dict" "$(pf 'print(type(d["status"]).__name__)')" "status is an object, not a string"
assert_contains "$(pf 'print(d["status"]["auffi"])')" "operational" "auffi entry says operational"
assert_contains "$(pf 'print(d["status"]["auffi"])')" "checked " "auffi entry carries the check timestamp"
assert_eq "LIVE since 2026-08-07" "$(pf 'print(d["status"]["chords"])')" "other project's entry preserved"
assert_contains "${OUT}" "MRD-API status posted: operational" "success logged"

echo "# a failed probe → degraded"
RC=0; OUT="$(run_health STUB_PROBE_FAIL=1 2>&1)" || RC=$?
assert_eq 1 "${RC}" "exit 1 when a probe fails"
assert_contains "$(pf 'print(d["status"]["auffi"])')" "degraded" "auffi entry says degraded"

echo "# non-2xx from MRD → body is logged, still non-fatal"
RC=0; OUT="$(run_health STUB_PUT_STATUS=400 'STUB_PUT_BODY={"error":"VALIDATION_ERROR"}' 2>&1)" || RC=$?
assert_eq 0 "${RC}" "MRD failure stays non-fatal"
assert_contains "${OUT}" "HTTP 400" "status code logged"
assert_contains "${OUT}" "VALIDATION_ERROR" "response body logged so a contract drift is visible"

finish
