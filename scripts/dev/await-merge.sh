#!/usr/bin/env bash
# await-merge.sh <pr> [--wait] [--timeout SECONDS] [--interval SECONDS]
#
# Answer "has PR <n> merged yet, and where did it land on main?" without a human
# having to say so.
#
# Why this exists. The pipeline's stop points are correct — a lane stops at
# built, a wave stops at opened, and merges are performed by a human on GitHub.
# But "stop" was implemented as "go mute": nothing told a stopped lane how to
# observe the event it was stopped for, so the only channel that existed was the
# operator's keyboard. Measured over 2026-09-07..09: eight operator messages in
# that run carried nothing but a merge fact ("wave 1 merged", "371 is now
# merged", "378 is merged"), and three lanes unblocked within forty seconds of
# each other because the operator was working down a list by hand. The waits
# ahead of them ran 137, 154, 174 and 181 minutes. `gh` knew the whole time.
#
# This does NOT merge anything, and must never learn how. Merges in this repo
# are manual, on GitHub, by a human, after review. This only watches.
#
#   0  merged      (merge commit printed, and its ancestry on origin/main — or,
#                   when GitHub has not published that commit yet, exactly that)
#   1  closed without merging
#   2  still open (single-shot), or the deadline passed (--wait)
#   3  usage or dependency error (gh unusable, or it never answered at all)
set -euo pipefail

REPO=${REPO:-launchpad-26/rhizomorph}
PR=${1:-}
[ -n "$PR" ] || { echo "usage: await-merge.sh <pr> [--wait] [--timeout N] [--interval N]" >&2; exit 3; }
shift

WAIT=0
TIMEOUT=1800
INTERVAL=60

# Every argument failure exits 3, and it takes a named check to get there.
#
# The first draft used `${2:?msg}` and let `set -e` do the rest. That reads like
# validation and is not: the shell aborts with status 1, and 1 is this script's
# documented "the PR was closed without merging". A stopped lane polling on the
# exit code — the only reason this script exists — would read a typo'd flag as
# "your work was rejected" and abandon it. One sibling was handled (`*)` exits 3)
# and five were not, which is this repo's most common defect shape exactly.
#
# Worse, `--timeout 5x` failed the arithmetic, printed to stderr, and CARRIED ON
# with DEADLINE unset — so on a merged PR it exited 0 having never had a deadline
# at all, silently voiding the "bounded even in --wait" guarantee that is the
# whole point of the script. Values are checked before use, not on use.
die()    { echo "await-merge.sh: $1" >&2; exit 3; }
is_num() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

is_num "$PR" || die "PR must be a whole number, got '$PR'"

while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT=1 ;;
    --timeout)
      [ $# -ge 2 ] || die "--timeout needs a value"
      is_num "$2"  || die "--timeout wants whole seconds, got '$2'"
      TIMEOUT=$2; shift ;;
    --interval)
      [ $# -ge 2 ]   || die "--interval needs a value"
      is_num "$2"    || die "--interval wants whole seconds, got '$2'"
      [ "$2" -ge 1 ] || die "--interval must be at least 1 second, got '$2'"
      INTERVAL=$2; shift ;;
    *) die "unknown argument '$1'" ;;
  esac
  shift
done

command -v gh  >/dev/null || { echo "await-merge.sh: needs gh"  >&2; exit 3; }
command -v jq  >/dev/null || { echo "await-merge.sh: needs jq"  >&2; exit 3; }
command -v git >/dev/null || { echo "await-merge.sh: needs git" >&2; exit 3; }

# A deadline, always, even in --wait mode. This is the whole difference between
# this script and the idiom it replaces: `tail -f` on a gate's temp output and
# unbounded `until` loops were backgrounded twice in that same run, outlived the
# files they were watching (`tail -f` does not exit when its target is deleted),
# and surfaced to the operator as "why is there a background task hung?" — twice,
# from two different lanes. Run this backgrounded and the LOOP ends on its own
# whatever the PR does, which is the property `tail -f` lacks.
#
# Stated precisely, because an overstated guarantee is exactly what this repo
# keeps catching: the deadline bounds THIS SCRIPT's waiting — its sleeps and its
# poll count. It does not bound `gh pr view`, which carries no timeout of its
# own, so a wedged network call can still outlive it. That is a far narrower
# hole than an orphaned `tail -f` — it needs a hung connection, not merely a
# deleted file — but it is not zero, and the honest fix if it ever bites is a
# timeout around `gh`, not a broader claim here.
DEADLINE=$(( $(date +%s) + TIMEOUT ))

report_merged() {
  sha=$1

  # A FOURTH unknown, and F9's shape one door over. GitHub reports `state`
  # MERGED before it reports `mergeCommit`, so --wait — which fires on the
  # instant of that flip — is the likeliest caller in the repo to be handed a
  # null. The `// "-"` in the jq below anticipated the null and then routed it
  # into a sentence written for a different case: "MERGED as -", followed by
  # "- is not present locally — fetch before citing it", an instruction no fetch
  # can ever satisfy. Three unknowns had sentences and the fourth borrowed one.
  #
  # Exit 0 still, because the fact the caller is blocked on is the merge and the
  # merge is real. What changes is that nothing is claimed about a commit we were
  # never given: no fetch, no ancestry, no sha to cite.
  if [ -z "$sha" ] || [ "$sha" = "-" ]; then
    echo "await-merge: PR #$PR is MERGED, but GitHub has not reported its merge commit yet"
    echo "await-merge: nothing to cite yet — re-run in a moment for the sha and its ancestry"
    return 0
  fi

  echo "await-merge: PR #$PR MERGED as $sha"
  # AGENTS.md: close an issue against a commit on main, not against a merge —
  # "if a closure comment cannot name main, the work is still in flight". Say
  # which of those two this is, rather than leaving the caller to assume.
  git fetch origin --quiet 2>/dev/null || echo "await-merge: (could not fetch; ancestry unchecked)"

  # Three distinct unknowns, three distinct sentences. Collapsing them is how a
  # check starts lying: "NOT an ancestor of origin/main" is a loud, specific
  # accusation, and printing it because the local ref is merely ABSENT would
  # send a reader hunting a prd-44-shaped bug that isn't there. Say which of
  # these it is, and never assert ancestry that was not actually computed.
  if ! git rev-parse --verify --quiet "$sha^{commit}" >/dev/null 2>&1; then
    echo "await-merge: $sha is not present locally — fetch before citing it"
  elif ! git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    echo "await-merge: no local origin/main ref — ancestry UNCHECKED, not confirmed"
  elif git merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
    echo "await-merge: $sha is an ancestor of origin/main — safe to cite"
  else
    echo "await-merge: WARNING $sha is NOT an ancestor of origin/main."
    echo "await-merge: the PR merged into something other than main. Check its base"
    echo "await-merge: before closing anything against it."
  fi
}

# The exit status is the finding here, not only the row. Before this, every
# non-zero was one status and the caller could not tell "you are not logged in"
# from "the resolver blinked" — so the loop treated both as fatal, which is the
# wrong call for exactly one of them.
#
#   0   read it
#   4   gh's own exit status for an auth failure — fatal, no wait fixes it
#   90  gh answered with something jq could not parse — fatal for the same reason
#   *   anything else: a transport failure, and the one thing --wait should outlive
#
# 90 rather than jq's own 5, because 5 is inside the range gh itself can return
# and this needs to stay one unambiguous fact.
poll_once() {
  GH_RC=0
  RAW=$(gh pr view "$PR" --repo "$REPO" --json state,mergedAt,mergeCommit,baseRefName 2>/dev/null) \
    || GH_RC=$?
  [ "$GH_RC" -eq 0 ] || return "$GH_RC"
  printf '%s' "$RAW" | jq -r '[.state, (.mergeCommit.oid // "-"), .baseRefName] | @tsv' || return 90
}

# A transport blip is the single failure --wait exists to outlive, and it used to
# be the one that ended the watch. Every non-zero from poll_once exited 3 — "usage
# or dependency error" — so one `error connecting to api.github.com` killed a
# thirty-minute watch after a single poll and handed the lane a status that reads
# as "you called me wrong". Worth weighing rather than dismissing: on WSL the
# resolver mangles concurrent A+AAAA lookups and gh fails intermittently, so a
# backgrounded watch is likely to meet this and not merely able to.
#
# Auth and unparseable output stay fatal. Retrying an unauthenticated gh in a
# loop spends the whole deadline learning nothing, which is worse than failing.
#
# SAW_STATE is what keeps the retry honest. Exit 2 says "still open" — a fact —
# so it may only be returned by a run that actually read the PR at least once. A
# deadline reached having never had an answer is a dependency failure and exits 3;
# reporting "still open" there would be inventing the very fact the caller asked
# for.
SAW_STATE=0
while :; do
  RC=0
  ROW=$(poll_once) || RC=$?

  if [ "$RC" -eq 0 ]; then
    SAW_STATE=1
    STATE=$(printf '%s' "$ROW" | cut -f1)
    SHA=$(printf   '%s' "$ROW" | cut -f2)
    BASE=$(printf  '%s' "$ROW" | cut -f3)

    case "$STATE" in
      MERGED)
        report_merged "$SHA"
        [ "$BASE" = "main" ] || echo "await-merge: NOTE base was '$BASE', not main"
        exit 0 ;;
      CLOSED)
        echo "await-merge: PR #$PR was CLOSED without merging" >&2
        exit 1 ;;
    esac

    if [ "$WAIT" -eq 0 ]; then
      echo "await-merge: PR #$PR is still OPEN (base $BASE)"
      exit 2
    fi
  else
    case "$RC" in
      4)  echo "await-merge: gh cannot read PR #$PR — not authenticated" >&2; exit 3 ;;
      90) echo "await-merge: gh could not read PR #$PR — unparseable response" >&2; exit 3 ;;
    esac
    [ "$WAIT" -eq 1 ] || { echo "await-merge: gh could not read PR #$PR" >&2; exit 3; }
    echo "await-merge: gh could not read PR #$PR (status $RC) — retrying until the deadline" >&2
  fi

  NOW=$(date +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then
    if [ "$SAW_STATE" -eq 0 ]; then
      echo "await-merge: deadline reached after ${TIMEOUT}s and gh never answered." >&2
      echo "await-merge: nothing was learned about PR #$PR — a dependency failure, not a state." >&2
      echo "await-merge: check gh and the network, then re-run." >&2
      exit 3
    fi
    echo "await-merge: deadline reached after ${TIMEOUT}s; PR #$PR still open." >&2
    echo "await-merge: this is not a failure — re-run when you next have a reason to." >&2
    exit 2
  fi
  REMAIN=$(( DEADLINE - NOW ))
  [ "$INTERVAL" -lt "$REMAIN" ] && SLEEP=$INTERVAL || SLEEP=$REMAIN
  sleep "$SLEEP"
done
