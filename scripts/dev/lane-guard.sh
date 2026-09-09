#!/usr/bin/env bash
# lane-guard.sh <target-branch> [--no-fetch] — assert this shell is standing in
# its own lane before a build stage commits anything in it.
#
# Run it, don't read it: the isolation rule it enforces was previously held in
# the operator's head, which is why it was enforced by typing. Measured over
# 2026-09-07..09, five concurrent lanes: three ended up entangled badly enough
# that the operator halted every session to untangle 109 local branches and a
# primary worktree carrying another session's uncommitted edit, then had to
# re-issue "make sure you are on your own clean worktree" to two lanes by hand.
# Every one of those failures is visible at `git checkout -b` time and free to
# refuse there.
#
# This script only ASSERTS. It never creates, moves or deletes a worktree, and
# it never edits .workmux.yaml — worktree creation is workmux's job and stays
# that way. A failure here is a signal to go and get a clean lane, not a
# situation for this script to repair.
#
# Exit 0 clean (warnings may still have printed), 1 a check failed, 2 misuse.
set -euo pipefail

# bash 3.2 is the only bash on some machines here, so: no associative arrays,
# no `${arr[@]}` under `set -u`. Failures accumulate in a plain counter and are
# printed as they are found, so a run reports every problem rather than the
# first one — you want the whole picture before you go looking for a lane.
FAILED=0
fail() { printf 'lane-guard: FAIL  %s\n' "$1" >&2; FAILED=$((FAILED + 1)); }
warn() { printf 'lane-guard: warn  %s\n' "$1" >&2; }
ok()   { printf 'lane-guard: ok    %s\n' "$1"; }

usage() { echo "usage: lane-guard.sh <target-branch> [--no-fetch]" >&2; exit 2; }

TARGET=${1:-}
[ -n "$TARGET" ] || usage
case "$TARGET" in --*) echo "lane-guard: '$TARGET' looks like a flag, not a branch — the branch goes first" >&2; usage ;; esac
shift

# Exit 2 is documented as misuse, so misuse has to actually reach it. A bare
# `NO_FETCH=${2:-}` accepted `--nofetch` (typo: silently fetched anyway), ignored
# trailing garbage, and read `lane-guard.sh --no-fetch lane3` as a branch called
# `--no-fetch`, cheerfully reporting it free. A guard that mis-parses its own
# arguments and says "ok" is worse than no guard.
NO_FETCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-fetch) NO_FETCH=1 ;;
    *) echo "lane-guard: unknown argument '$1'" >&2; usage ;;
  esac
  shift
done

command -v git >/dev/null || { echo "lane-guard: needs git" >&2; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "lane-guard: not inside a git work tree" >&2; exit 2; }

TOP=$(git rev-parse --show-toplevel)
HANDLE=$(basename "$TOP")

# --- 1. not the primary checkout -------------------------------------------
#
# The distinguishing fact, and the only reliable one: in the primary worktree
# --git-dir and --git-common-dir resolve to the same directory; in a linked
# worktree --git-dir is <common>/worktrees/<name>. Path-shape heuristics on the
# directory name are not equivalent — a lane worktree may be named anything,
# and macOS resolves /tmp through a symlink, so comparing prefixes gets this
# wrong in both directions.
GITDIR=$(cd "$TOP" && cd "$(git rev-parse --git-dir)" && pwd -P)
COMMON=$(cd "$TOP" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
if [ "$GITDIR" = "$COMMON" ]; then
  fail "this is the PRIMARY worktree ($TOP). A lane builds in its own worktree,
                  never here — the primary is shared, and a second session writing to it is
                  how work gets crossed. Get a lane worktree and re-run."
else
  ok "linked worktree: $TOP"
fi

# --- 2. working tree clean --------------------------------------------------
#
# A dirty tree at branch-creation time means one of two things, and you cannot
# tell which from here: leftovers of your own, or another session's live work.
# The second is the expensive one. On 2026-09-08 a dirty markdown file in the
# shared checkout was classified as undiscardable divergent work off a
# line-level diff, backed up, and only later found to be a re-wrap of content
# already on the PR branch — a wrong call made under a full work stoppage.
# Refusing to start on a dirty tree removes the need to make that call at all.
#
# package-lock.json is excluded, matching `scripts/gate.sh:559`, whose own
# comment records why: ".workmux.yaml"'s post_create runs `npm install` in every
# new lane, so lockfile churn is the one dirty file this repo has already ruled
# is not divergent work. Failing a lane for it would make the guard fire on the
# normal case, which is how a check gets routed around.
DIRTY=$(git status --porcelain | grep -v 'package-lock\.json' || true)
if [ -n "$DIRTY" ]; then
  fail "working tree is dirty. Do not assume it is yours — another session may
                  hold this checkout. Stash or commit deliberately, with the paths named:"
  printf '%s\n' "$DIRTY" | sed 's/^/                  /' >&2
else
  ok "working tree clean"
fi

# --- 3. the target branch is not checked out in another worktree ------------
#
# git refuses this at checkout time anyway, but it refuses with "already checked
# out" and a path, several steps after you have decided this is your lane. Said
# here it is a different sentence: someone else is already building this issue.
OTHER=$(git worktree list --porcelain \
  | awk -v want="refs/heads/$TARGET" -v self="$TOP" '
      /^worktree /  { wt = substr($0, 10) }
      /^branch /    { if (substr($0, 8) == want && wt != self) print wt }
    ')
if [ -n "$OTHER" ]; then
  fail "branch '$TARGET' is already checked out at: $OTHER
                  That is another lane building this issue. Do not race it."
else
  ok "branch '$TARGET' is free"
fi

# --- 4. HEAD is main, or already the target --------------------------------
#
# Two shapes pass, and the FIRST is the common one — worth stating, because the
# obvious reading of this script ("run it, then `git checkout -b`") describes the
# rarer path. Check 1 requires a linked worktree, and a linked worktree usually
# cannot check out `main` at all: while the primary holds it, `git checkout main`
# fails with "already used by worktree at …". So in the normal workmux flow the
# worktree ARRIVES on its lane branch, already created, and this check confirms
# it rather than clearing the way for one. `git checkout -b` afterwards is the
# other case — a worktree that happens to sit on main because the primary does
# not.
#
# Anything else means this worktree belongs to a different lane, and branching
# from here bases your work on theirs: a base nobody intended, and a diff full of
# someone else's commits.
HEAD_BRANCH=$(git symbolic-ref --quiet --short HEAD || echo "(detached)")
if [ "$HEAD_BRANCH" = "$TARGET" ]; then
  ok "on '$TARGET' already — the normal workmux shape"
elif [ "$HEAD_BRANCH" = "main" ]; then
  ok "on main, ready to branch"
elif [ "$HEAD_BRANCH" = "(detached)" ]; then
  fail "HEAD is detached. A lane commits to a branch; a detached HEAD loses the
                  commit as soon as anything else is checked out. Check out '$TARGET' first."
else
  fail "HEAD is '$HEAD_BRANCH' — neither main nor '$TARGET'. This worktree looks
                  like it belongs to another lane. Branching from here bases your work on
                  theirs. Get a lane of your own, or check out '$TARGET' if this really is
                  yours."
fi

# --- 5. WARN: is the base current? -----------------------------------------
#
# Non-fatal on purpose: an offline lane must still be able to work, and a stale
# base is a rebase, not a corruption. But it is worth saying, because branching
# off a local main that has drifted behind origin is silent — the branch looks
# healthy and the diff carries reverts of things that already landed. Local main
# was 4 commits behind origin when this script was written, in a clean tree, with
# nothing on screen to suggest it.
# Both refs are verified to EXIST before they are compared, and every branch
# below says something. The first draft did neither, and the result was a check
# that could not go red for the reason it existed for:
#
#   BEHIND=$(git rev-list --count main..origin/main 2>/dev/null || echo 0)
#
# With no local `main` — a clone whose default branch is named otherwise, or the
# `--shared` review clone — rev-list exits 128 (`fatal: ambiguous argument`),
# `|| echo 0` launders that into "0 behind", and the guard printed
# "ok  main is level with origin/main": an assertion about a branch that did not
# exist. Proven by mutation, not argued. And when `origin/main` was the missing
# ref, the whole check vanished with no line at all — a silent skip in a script
# whose header says "run it, don't read it".
#
# The lesson generalises past this line: `|| echo <default>` on a command that
# can fail for reasons other than the one you mean turns an error into data, and
# the data then reads as a pass.
# `--no-fetch` narrows the FETCH, not the check. The comparison below is
# refs/heads/main..origin/main — two refs already on disk — so it is answerable
# offline and answerable against a stale origin/main; all --no-fetch costs is
# the freshness of one side, which is worth saying out loud rather than
# withholding the whole answer over.
#
# The first version wrapped everything in `if [ -z "$NO_FETCH" ]` and so printed
# NOTHING AT ALL under the flag: F3's defect ("a silent skip in a script whose
# header says run it, don't read it") surviving in the sibling door, one branch
# above where F3 was fixed. It had a second cost that is the more embarrassing
# one — every hard-check case in this script's own test file passes --no-fetch,
# so the suite systematically exercised the guard in the mode where check 5 was
# mute, which is how the two defects the review found here stayed invisible.
if [ -n "$NO_FETCH" ]; then
  warn "--no-fetch: origin/main not refreshed — comparing against the ref already on disk"
elif ! git fetch origin --quiet 2>/dev/null; then
  warn "could not fetch origin (offline?) — comparing against the origin/main already on disk"
fi

if ! git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  warn "no origin/main ref — base freshness UNCHECKED (is the default branch named something else?)"
elif ! git rev-parse --verify --quiet refs/heads/main >/dev/null 2>&1; then
  warn "no local 'main' branch — base freshness UNCHECKED. Compare your own base against origin/main by hand."
else
  BEHIND=$(git rev-list --count refs/heads/main..origin/main)
  if [ "$BEHIND" -gt 0 ]; then
    warn "local main is $BEHIND commit(s) behind origin/main — branch off origin/main, not main"
  else
    ok "main is level with origin/main"
  fi
fi

echo
if [ "$FAILED" -gt 0 ]; then
  printf 'lane-guard: %s — %d check(s) failed. Not your lane; do not build here.\n' "$HANDLE" "$FAILED" >&2
  exit 1
fi
printf 'lane-guard: %s — clear for %s\n' "$HANDLE" "$TARGET"
