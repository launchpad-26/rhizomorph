#!/usr/bin/env bash
#
# prd-milestones.sh — regenerates .swarm/prd-milestones.txt, the committed
# manifest packages/server/src/prd-location-law.test.ts reads instead of
# calling `gh` itself.
#
# WHY A COMMITTED MANIFEST AND NOT A LIVE CALL (prd56 ruling 1, operator-decided
# 2026-09-11): the location law runs inside `npm test`, which must stay
# runnable offline — this repo's own sibling laws already derive tracker facts
# from `git log` rather than `gh` for exactly that reason, CI runs the suite on
# ten legs, and a review seat this week could not run the suite at all because
# its sandbox denied `gh`'s subprocess and socket access. A law that needs a
# token is a law that gets skipped.
#
# WHAT THAT COSTS, NAMED RATHER THAN HIDDEN: the manifest can itself go stale —
# a milestone closes on GitHub and this file does not know until someone reruns
# this script. prd-location-law.test.ts answers that with a STALENESS BOUND
# (see its own doc comment for the two candidates weighed and why the bound
# won), not by regenerating in CI. Re-running this script and committing the
# result is a normal step before landing anything that opens or closes a `prdNN`
# milestone.
#
# NOT wired into CI, deliberately, the same call `prd-reconcile.sh` makes for
# the same reason: this script's whole job is to CHANGE a committed file, and
# whether that change is needed is the operator's judgement, not a build step.
#
# Usage:
#   scripts/dev/prd-milestones.sh
#
# Writes .swarm/prd-milestones.txt from every `prd<NN>` milestone in this repo
# (open and closed alike — the law only acts on closed ones, but a manifest
# that only ever named closed milestones could not distinguish "open" from
# "never fetched"). `charter-laws` and any other non-numeric milestone are
# excluded by construction: the filter is `^prd[0-9]+$`, anchored, not a
# digit-anywhere-in-the-title match — the exact glob hazard this manifest's own
# reader (prd-location-law.test.ts) must also avoid when it later reads
# `docs/prds/*.md` filenames, where `reconciliation-2026-08-22.md` and
# `retained-prds-review-2026-08-22.md` carry digits that are dates, not PRD
# numbers.
#
# Exit: 0 written · 1 gh/network failure · 2 usage/precondition.
set -uo pipefail

die()  { echo "prd-milestones: $1" >&2; exit 2; }
netdie() { echo "prd-milestones: $1" >&2; exit 1; }
command -v gh >/dev/null 2>&1 || die "gh not found on PATH"

[ $# -eq 0 ] || die "usage: prd-milestones.sh (no arguments — it regenerates the whole manifest)"

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
out="$root/.swarm/prd-milestones.txt"

errfile=$(mktemp) || die "cannot create a temp file"
trap 'rm -f "$errfile"' EXIT

# state=all: a closed milestone drops out of the default (open-only) listing,
# and a manifest that cannot see a closed milestone is the one violation this
# whole law exists to catch.
#
# `-X GET` is not decoration: `gh api` defaults to POST the moment a `-f` is
# present, and a POST to this endpoint is "create a milestone" — it fails
# ("`title` wasn't supplied") rather than lists, and the fix is the explicit
# method, not a different flag on `-f`.
if ! rows=$(gh api repos/:owner/:repo/milestones -X GET -f state=all --paginate \
       -q '.[] | select(.title | test("\\Aprd[0-9]+\\z")) | "\(.title)\t\(.state)\t\(.closed_at // "-")"' \
       2>"$errfile"); then
  gh_err=$(cat "$errfile" 2>/dev/null)
  netdie "gh api milestones failed${gh_err:+ — gh said: $gh_err}"
fi

# `prd25` -> `25`, so the manifest sorts and reads numerically. `-n` on the
# whole line would sort lexically on `prdNN...` (correct here since every row
# shares the `prd` prefix and equal-length numbers would sort fine either way,
# but the prefix is stripped anyway because the law reads a bare number, not a
# `prdNN`-prefixed key — matching the PRD filename's own `prd-NN-` capture).
# A SUCCESSFUL gh call that matched nothing is not a reason to write an empty
# manifest over a good one. The failing path above is guarded; this is its
# sibling, and it is the one that lost data: with `rows` empty, `printf '%s\n' ""`
# yields a single blank line, `grep -c '^'` reported "1 prdNN milestones", the
# committed manifest was destroyed, and the script exited 0. A repo with zero
# prdNN milestones is not a state this repo can reach, so treat it as a failed
# read rather than as truth. `set -uo pipefail` has no `-e`, so a sed/sort
# failure lands here too and is caught by the same guard.
if [ -z "${rows//[[:space:]]/}" ]; then
  netdie "gh returned no prdNN milestones — refusing to overwrite $out. Re-run; if the tracker really has none, delete the manifest by hand."
fi

TAB=$(printf '\t')
body=$(printf '%s\n' "$rows" | sed -E 's/^prd([0-9]+)/\1/' | sort -n -t"$(printf '\t')" -k1,1)

if [ -z "${body//[[:space:]]/}" ]; then
  netdie "the milestone rows did not survive the sed/sort pipeline — refusing to overwrite $out"
fi

# Every line must be the shape the reader's own row grammar accepts. Emptiness was
# guarded above; MALFORMEDNESS is its sibling and was not, which is the defect this
# check closes: a milestone titled "prd57\n" passed the old `$`-anchored jq filter
# (Oniguruma's `$` matches before a final newline), rendered as TWO lines — "prd57"
# and a headless "\topen\t-" — and both non-empty guards waved it through. The
# manifest was overwritten with rows that prd-location-law.test.ts then skips
# silently, so nothing anywhere went red. The anchor is now \A..\z, and this
# asserts the OUTPUT rather than trusting the filter that produces it.
while IFS= read -r line; do
  # A LITERAL tab, not \t: POSIX leaves \t undefined in an ERE and grep reads it
  # as a plain `t`, so the backslash form matched nothing and rejected every
  # valid row. Measured under bash, which is what runs this script.
  printf '%s' "$line" | grep -qE "^[0-9]+${TAB}(open|closed)${TAB}[^[:space:]]+$" \
    || netdie "refusing to overwrite $out: a generated row is not <number><tab><open|closed><tab><date|-> — got: $(printf '%s' "$line" | cat -v)"
done <<EOF
$body
EOF

{
  echo "# PRD milestone manifest — generated by scripts/dev/prd-milestones.sh."
  echo "#"
  echo "# Read by packages/server/src/prd-location-law.test.ts so that law can run"
  echo "# offline (prd56 ruling 1). DO NOT HAND-EDIT: regenerate with this script"
  echo "# before landing anything that opens or closes a prdNN milestone, and commit"
  echo "# the result in the same change."
  echo "#"
  echo "# generated-at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "#"
  echo "# <PRD number>	<open|closed>	<closed_at, or - if still open>"
  printf '%s\n' "$body"
} > "$out"

echo "wrote $out ($(printf '%s\n' "$body" | grep -c . ) prdNN milestones)"
