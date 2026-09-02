#!/usr/bin/env bash
# ops/tests/no-head-after-git-log.test.sh — under `set -euo pipefail` a
# `git log … | head -N` kills the whole script the moment git has more than N
# lines to say: head closes the pipe, git dies of SIGPIPE (141), pipefail makes
# the pipeline fail, set -e exits. Nothing is printed, and a caller that tails
# the output sees exit 0. deploy.sh did exactly that on the first deploy with
# more than 30 commits (0.7.1). Truncate with --max-count instead.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

piped="$(grep -nE 'git (-C [^ ]+ )?(log|rev-list|diff)[^|]*\| *head' "${OPS_DIR}"/*.sh || true)"
assert_eq "" "${piped}" "ops/*.sh: no git log/rev-list/diff is piped into head (SIGPIPE under pipefail)"

grep -q -- '--max-count=30' "${OPS_DIR}/deploy.sh"
assert_eq "0" "$?" "deploy.sh: the diff preview truncates via --max-count"

finish
