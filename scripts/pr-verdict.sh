#!/usr/bin/env bash
# pr-verdict.sh — publish a local CI verdict onto a pull request.
#
#   scripts/pr-verdict.sh preflight <pr>
#   scripts/pr-verdict.sh report    <pr> pass|fail "<one-line description>"
#
# GitHub Actions is retired on this repo for cost, so a PR's check box no
# longer says anything about whether the code works — it says `0/10` from the
# runs that died on the billing failure, and nothing at all once the workflows
# are disabled. `scripts/ci-local.sh` runs the leg on an operator's machine;
# this is how that verdict gets back onto the PR where a reviewer can see it.
#
# TWO MARKS, and the difference between them is the whole design:
#
#   * a LABEL, "Passed local CI". Repo-level, so it is visible in the PR list
#     and in search — and it is NOT pinned to a commit. Push once after a green
#     run and the label goes on claiming a result for a tree nobody tested.
#   * a COMMIT STATUS on the PR's head sha, context `local-ci (<uname -s>)`.
#     Per-sha by construction: a new commit carries no status, so the check box
#     goes quiet the moment the label starts lying. That is the mark to trust,
#     and the label's description in the tracker says so.
#
# The context names the PLATFORM on purpose. One operator machine is one of
# the three legs ci.yml used to run (ubuntu + macOS at two node versions, plus
# a native Windows suite), and prd-25's whole deliverable is the third of
# those. A row reading `local-ci (Darwin)` with no Linux or Windows row beside
# it states that silence rather than hiding it. Never write "CI passed".
#
# PREFLIGHT REFUSES rather than reporting something it cannot stand behind:
# a PR that is not open, a HEAD that is not the PR's head sha, or a dirty
# working tree. All three produce a green run whose verdict belongs to a
# different tree than the one the reader will look at. It runs BEFORE the leg
# (see `ci-local.sh`) so the refusal costs a second rather than a full suite.
set -uo pipefail

LABEL="Passed local CI"
CONTEXT="local-ci ($(uname -s))"

die() { echo "pr-verdict: $1" >&2; exit "${2:-2}"; }

usage() {
  sed -n '2,6p' "$0"
  exit 2
}

command -v gh >/dev/null 2>&1 || die "gh is not on PATH — nothing can be reported without it"

# Resolves the PR and asserts the three conditions above. Echoes the head sha
# on success so the caller can pin its own reporting to the same commit.
preflight() {
  pr="$1"

  # One call, one line, two fields — `--jq` rather than parsing the JSON with
  # sed, which reads the LAST match of a greedy `.*` and so silently picks the
  # wrong key the day another one is added to the list.
  view=$(gh pr view "$pr" --json state,headRefOid --jq '.state + " " + .headRefOid' 2>&1) \
    || die "gh could not read PR #$pr: $view"

  state=${view%% *}
  head=${view##* }

  printf '%s' "$head" | grep -qE '^[0-9a-f]{40}$' \
    || die "gh returned no usable headRefOid for PR #$pr (got: $view)"
  [ "$state" = "OPEN" ] || die "PR #$pr is $state, not OPEN — a verdict on a closed PR marks nothing"

  local_head=$(git rev-parse HEAD 2>/dev/null) || die "not in a git repo"
  if [ "$local_head" != "$head" ]; then
    die "HEAD is $local_head but PR #$pr is at $head — the verdict would name a tree you did not run"
  fi

  dirty=$(git status --porcelain 2>/dev/null)
  if [ -n "$dirty" ]; then
    die "the working tree is dirty — $head is not what you are about to test:
$dirty"
  fi

  echo "$head"
}

# Posts the commit status and moves the label. `state` is the caller's verdict,
# not a re-derivation: this script never decides whether the leg passed.
report() {
  pr="$1"; verdict="$2"; description="$3"

  case "$verdict" in
    pass) status="success" ;;
    fail) status="failure" ;;
    *)    die "verdict must be 'pass' or 'fail', got '$verdict'" ;;
  esac

  sha=$(preflight "$pr") || exit $?

  # GitHub caps a status description at 140 characters and 422s past it, which
  # would turn a green leg into a failed report. Cut here rather than find out.
  description=$(printf '%s' "$description" | cut -c1-140)

  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) \
    || die "gh could not resolve the repository"

  gh api -X POST "repos/$repo/statuses/$sha" \
    -f "state=$status" \
    -f "context=$CONTEXT" \
    -f "description=$description" >/dev/null \
    || die "could not post the $status status for $sha"
  echo "pr-verdict: $CONTEXT = $status on $sha"

  if [ "$verdict" = "pass" ]; then
    gh pr edit "$pr" --add-label "$LABEL" >/dev/null \
      || die "posted the status, but could not add the '$LABEL' label"
    echo "pr-verdict: labelled #$pr '$LABEL'"
  else
    # Removing on red is not tidiness. A PR labelled green from an earlier sha
    # whose leg has since gone red is the exact lie the status exists to catch,
    # and the label is the half a reader sees first. `|| true`: the label being
    # absent already is the normal case, and gh treats it as an error.
    gh pr edit "$pr" --remove-label "$LABEL" >/dev/null 2>&1 || true
    echo "pr-verdict: cleared '$LABEL' from #$pr"
  fi
}

[ $# -ge 1 ] || usage

case "$1" in
  preflight)
    [ $# -eq 2 ] || usage
    preflight "$2"
    ;;
  report)
    [ $# -eq 4 ] || usage
    report "$2" "$3" "$4"
    ;;
  *) usage ;;
esac
