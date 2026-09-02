#!/usr/bin/env bash
# ops/tests/workflows-pinned.test.sh — every GitHub Action is pinned to a
# full commit SHA (a moving tag on a third-party action would run with the
# release token + the Tauri signing key), and every workflow declares a
# least-privilege top-level `permissions:` block.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/harness.sh"

WORKFLOWS_DIR="${OPS_DIR}/../.github/workflows"

for wf in "${WORKFLOWS_DIR}"/*.yml; do
  name="$(basename "${wf}")"
  # Local reusable workflows (uses: ./.github/...) carry no version.
  unpinned="$(grep -nE '^\s*(- )?uses:\s*[^./][^@ ]*@' "${wf}" | grep -vE '@[0-9a-f]{40}(\s|$|\s+#)' || true)"
  assert_eq "" "${unpinned}" "${name}: every remote action pinned to a 40-hex commit SHA"
  missing_comment="$(grep -nE '@[0-9a-f]{40}\s*$' "${wf}" || true)"
  assert_eq "" "${missing_comment}" "${name}: every SHA pin carries a '# vX.Y.Z' comment for Dependabot/humans"
  assert_eq "true" "$(grep -qE '^permissions:' "${wf}" && echo true || echo false)" "${name}: top-level permissions block present"
done

# release.yml is the only workflow that needs write scopes, and only in the
# jobs that actually publish.
RELEASE="${WORKFLOWS_DIR}/release.yml"
assert_eq "contents: read" "$(awk '/^permissions:/{p=1; next} p && /^  /{print; exit}' "${RELEASE}" | sed 's/^ *//')" "release.yml: top-level permissions are read-only"
assert_eq "true" "$(awk '/^  docker:/{j=1} j && /packages: write/{print "true"; exit}' "${RELEASE}" | grep -q true && echo true || echo false)" "release.yml: packages: write scoped to the docker job"
assert_eq "true" "$(awk '/^  release:/{j=1} j && /contents: write/{print "true"; exit}' "${RELEASE}" | grep -q true && echo true || echo false)" "release.yml: contents: write scoped to the release job"

finish
