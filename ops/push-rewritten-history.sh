#!/usr/bin/env bash
# One-shot publication of the history rewrite that redacted a leaked IP.
#
# Force-pushing is not something to do from memory four commands at a time:
# the failure mode is a half-published rewrite where `main` is clean but a tag
# still pins the old commit — and an unreachable-but-tagged commit keeps the
# unredacted address alive on GitHub, which is the whole thing this is meant to
# undo. So: check first, push main and every affected tag together, verify the
# remote afterwards, and only then drop the local safety net.
#
# Safe to re-run. Every step is idempotent and it stops at the first failure.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# The address itself is deliberately NOT in this file: a tracked script naming
# it would commit the very thing this rewrite removes straight back into the
# repo. Pass it regex-escaped via the environment, e.g.
#   AUFFI_LEAKED_IP='1\.2\.3\.4' ops/push-rewritten-history.sh
LEAKED_IP="${AUFFI_LEAKED_IP:?AUFFI_LEAKED_IP (regex-escaped) muss gesetzt sein}"
TAGS=(v0.6.8 v0.6.9 v0.7.0)
# What the remote must still be for the push to be safe. If someone else pushed
# in the meantime this differs and --force-with-lease refuses rather than
# silently discarding their work.
EXPECTED_REMOTE_MAIN="e39e56baca23d5f37daef9cd089806ae5062a8f0"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
fail() { printf '  \033[31mFEHLER\033[0m %s\n' "$1"; exit 1; }

say "Vorprüfung"

[[ -z "$(git status --porcelain)" ]] || fail "Arbeitsbaum nicht sauber — erst committen oder stashen"
ok "Arbeitsbaum sauber"

[[ "$(git branch --show-current)" == "main" ]] || fail "nicht auf main"
ok "auf main"

# The point of the exercise: the address must be gone from everything that
# stays reachable after the push. A tag left behind would resurrect it.
for ref in main "${TAGS[@]}"; do
  hits=0
  while read -r c; do
    git cat-file -e "$c:Textdokument (neu).txt" 2>/dev/null || continue
    n=$(git show "$c:Textdokument (neu).txt" | grep -c "$LEAKED_IP" || true)
    hits=$((hits + n))
  done < <(git rev-list "$ref")
  [[ "$hits" -eq 0 ]] || fail "$ref enthält die IP noch ($hits Treffer)"
done
ok "IP in main und allen Tags getilgt"

remote_main="$(git ls-remote origin main | cut -f1)"
if [[ "$remote_main" == "$(git rev-parse main)" ]]; then
  ok "Remote ist bereits aktuell — nichts zu pushen"
  PUSH_NEEDED=0
elif [[ "$remote_main" != "$EXPECTED_REMOTE_MAIN" ]]; then
  fail "Remote-main steht auf $remote_main, erwartet $EXPECTED_REMOTE_MAIN.
        Da hat jemand anders gepusht. NICHT mit --force drübergehen —
        erst klären, was dazugekommen ist."
else
  ok "Remote steht wie erwartet auf ${EXPECTED_REMOTE_MAIN:0:7}"
  PUSH_NEEDED=1
fi

if [[ "$PUSH_NEEDED" -eq 1 ]]; then
  say "Push"
  # --force-with-lease, nicht --force: schlägt fehl statt fremde Commits zu
  # überschreiben, falls sich der Remote zwischen Prüfung und Push bewegt.
  git push --force-with-lease="main:$EXPECTED_REMOTE_MAIN" origin main
  ok "main"
  git push --force origin "${TAGS[@]}"
  ok "Tags: ${TAGS[*]}"
fi

say "Nachprüfung am Remote"

[[ "$(git ls-remote origin main | cut -f1)" == "$(git rev-parse main)" ]] \
  || fail "Remote-main stimmt nicht mit lokal überein"
ok "main angekommen"

for t in "${TAGS[@]}"; do
  # ls-remote gibt bei annotated tags das Tag-Objekt; ^{} löst auf den Commit auf.
  remote_commit="$(git ls-remote origin "refs/tags/$t^{}" | cut -f1)"
  [[ "$remote_commit" == "$(git rev-parse "$t^{commit}")" ]] \
    || fail "$t zeigt am Remote auf $remote_commit statt auf $(git rev-parse "$t^{commit}")"
  ok "$t angekommen"
done

say "Lokale Altlasten"

# filter-branch hebt die Originale unter refs/original auf. Solange die da sind,
# liegt die ungekürzte IP weiter in diesem Klon — deshalb erst jetzt, nachdem
# der Remote nachweislich sauber ist und wir das Netz nicht mehr brauchen.
if git for-each-ref refs/original | grep -q .; then
  git for-each-ref --format='delete %(refname)' refs/original | git update-ref --stdin
  ok "refs/original gelöscht"
else
  ok "refs/original bereits weg"
fi

git reflog expire --expire=now --all
git gc --prune=now --quiet
ok "reflog und lose Objekte aufgeräumt"

remaining=$(git rev-list --all | while read -r c; do
  git cat-file -e "$c:Textdokument (neu).txt" 2>/dev/null && git show "$c:Textdokument (neu).txt"
done | grep -c "$LEAKED_IP" || true)
[[ "$remaining" -eq 0 ]] || fail "IP noch in $remaining Stellen lokal erreichbar"
ok "lokal keine Treffer mehr"

say "Fertig"
cat <<'EOT'
  Was noch NICHT erledigt ist:

  GitHub gibt die alten Objekte nicht sofort frei. Sie bleiben über ihre
  direkte SHA-URL erreichbar, bis GitHub sammelt — ein Zeitpunkt, den man
  nicht steuern kann. Wenn die Adresse wirklich weg sein muss, gehört
  jetzt eine Anfrage an den GitHub-Support dazu, mit der Bitte um
  Garbage-Collection des Repos.

  Das Backup vor dem Eingriff liegt als Bundle im Scratchpad dieser
  Session und enthält die ungekürzte IP. Nach Gebrauch löschen.
EOT
