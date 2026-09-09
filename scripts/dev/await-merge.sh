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
#   0  merged      (merge commit printed; ancestry on origin/main reported)
#   1  closed without merging
#   2  still open (single-shot), or the deadline passed (--wait)
#   3  usage or dependency error
set -euo pipefail

REPO=${REPO:-launchpad-26/rhizomorph}
PR=${1:-}
[ -n "$PR" ] || { echo "usage: await-merge.sh <pr> [--wait] [--timeout N] [--interval N]" >&2; exit 3; }
shift

WAIT=0
TIMEOUT=1800
INTERVAL=60
while [ $# -gt 0 ]; do
  case "$1" in
    --wait)     WAIT=1 ;;
    --timeout)  TIMEOUT=${2:?--timeout needs a value}; shift ;;
    --interval) INTERVAL=${2:?--interval needs a value}; shift ;;
    *) echo "await-merge.sh: unknown argument '$1'" >&2; exit 3 ;;
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
# from two different lanes. A watcher that cannot outlive its deadline cannot
# become that. Run this backgrounded and it will end on its own, whatever
# happens to the PR.
DEADLINE=$(( $(date +%s) + TIMEOUT ))

report_merged() {
  sha=$1
  echo "await-merge: PR #$PR MERGED as $sha"
  # AGENTS.md: close an issue against a commit on main, not against a merge —
  # "if a closure comment cannot name main, the work is still in flight". Say
  # which of those two this is, rather than leaving the caller to assume.
  git fetch origin --quiet 2>/dev/null || echo "await-merge: (could not fetch; ancestry unchecked)"
  if git rev-parse --verify --quiet "$sha^{commit}" >/dev/null; then
    if git merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
      echo "await-merge: $sha is an ancestor of origin/main — safe to cite"
    else
      echo "await-merge: WARNING $sha is NOT an ancestor of origin/main."
      echo "await-merge: the PR merged into something other than main. Check its base"
      echo "await-merge: before closing anything against it."
    fi
  else
    echo "await-merge: $sha not present locally — fetch before citing it"
  fi
}

poll_once() {
  gh pr view "$PR" --repo "$REPO" --json state,mergedAt,mergeCommit,baseRefName 2>/dev/null \
    | jq -r '[.state, (.mergeCommit.oid // "-"), .baseRefName] | @tsv'
}

while :; do
  ROW=$(poll_once) || { echo "await-merge: gh could not read PR #$PR" >&2; exit 3; }
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

  NOW=$(date +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then
    echo "await-merge: deadline reached after ${TIMEOUT}s; PR #$PR still open." >&2
    echo "await-merge: this is not a failure — re-run when you next have a reason to." >&2
    exit 2
  fi
  REMAIN=$(( DEADLINE - NOW ))
  [ "$INTERVAL" -lt "$REMAIN" ] && SLEEP=$INTERVAL || SLEEP=$REMAIN
  sleep "$SLEEP"
done
