#!/usr/bin/env bash
# ops/tests/deploy-dirty-tree.test.sh — deploy.sh must refuse a dirty working
# tree: APP_VERSION is the git short SHA, and Step 5 skips build + transfer
# when auffi-backend:<sha> already exists on prod. With uncommitted changes
# that yields a deploy where the frontends carry the edits and the backend
# does not, logged under a SHA matching neither.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

stage_fake_repo "${TMP}/repo"

run_dry() {
  env -i PATH="${PATH}" HOME="${HOME}" \
    DEPLOY_SSH="deploy@remote.invalid" DEPLOY_PATH="${TMP}/remote" DEPLOY_DOMAIN="deploy.invalid" \
    bash "${TMP}/repo/ops/deploy.sh" --dry-run "$@"
}

echo "# clean tree → dry-run proceeds"
RC=0; OUT="$(run_dry 2>&1)" || RC=$?
assert_eq 0 "${RC}" "clean tree deploys (dry-run exit 0)"
assert_contains "${OUT}" "deploy complete (dry run)" "dry-run reached the end"

echo "# modified tracked file → refused before anything else"
printf 'hotfix' >> "${TMP}/repo/nginx/auffi-viewer.conf"
RC=0; OUT="$(run_dry 2>&1)" || RC=$?
assert_eq 1 "${RC}" "dirty tree aborts with exit 1"
assert_contains "${OUT}" "working tree not clean" "reason named"
assert_contains "${OUT}" "--allow-dirty" "escape hatch named"
assert_not_contains "${OUT}" "Deploying auffi" "aborted before the deploy banner"

echo "# untracked file counts as dirty too (it ends up in the image/dist)"
git -C "${TMP}/repo" checkout -q -- nginx/auffi-viewer.conf
printf 'new' > "${TMP}/repo/backend/new-route.ts"
RC=0; OUT="$(run_dry 2>&1)" || RC=$?
assert_eq 1 "${RC}" "untracked file aborts"

echo "# --allow-dirty overrides, loudly"
RC=0; OUT="$(run_dry --allow-dirty 2>&1)" || RC=$?
assert_eq 0 "${RC}" "--allow-dirty proceeds"
assert_contains "${OUT}" "working tree not clean" "still warns"
assert_contains "${OUT}" "deploy complete (dry run)" "and completes"

echo "# an explicit --version is checked too (the skip heuristic uses the tag)"
RC=0; OUT="$(run_dry --version hotfix-1 2>&1)" || RC=$?
assert_eq 1 "${RC}" "--version does not bypass the check"

finish
