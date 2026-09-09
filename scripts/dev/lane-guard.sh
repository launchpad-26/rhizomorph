#!/usr/bin/env bash
# lane-guard.sh <target-branch> — assert this shell is standing in its own lane
# before a build stage creates a branch in it.
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

TARGET=${1:-}
[ -n "$TARGET" ] || { echo "usage: lane-guard.sh <target-branch> [--no-fetch]" >&2; exit 2; }
NO_FETCH=${2:-}

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
DIRTY=$(git status --porcelain)
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
# A fresh lane starts on main and branches off it; a resumed lane is already on
# its own branch. Anything else means this worktree belongs to a different lane
# and you are about to branch off its work — which produces a base nobody
# intended and a diff full of someone else's commits.
HEAD_BRANCH=$(git symbolic-ref --quiet --short HEAD || echo "(detached)")
if [ "$HEAD_BRANCH" = "$TARGET" ]; then
  ok "already on '$TARGET' (resumed lane)"
elif [ "$HEAD_BRANCH" = "main" ]; then
  ok "on main, ready to branch"
else
  fail "HEAD is '$HEAD_BRANCH' — neither main nor '$TARGET'. This worktree looks
                  like it belongs to another lane. Branching from here bases your work on
                  theirs. Get a lane of your own, or check out main first if this really is
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
if [ "$NO_FETCH" != "--no-fetch" ]; then
  if git fetch origin --quiet 2>/dev/null; then
    if git rev-parse --verify --quiet origin/main >/dev/null; then
      BEHIND=$(git rev-list --count main..origin/main 2>/dev/null || echo 0)
      [ "$BEHIND" -gt 0 ] \
        && warn "local main is $BEHIND commit(s) behind origin/main — branch off origin/main, not main" \
        || ok "main is level with origin/main"
    fi
  else
    warn "could not fetch origin (offline?) — base freshness unchecked"
  fi
fi

echo
if [ "$FAILED" -gt 0 ]; then
  printf 'lane-guard: %s — %d check(s) failed. Not your lane; do not build here.\n' "$HANDLE" "$FAILED" >&2
  exit 1
fi
printf 'lane-guard: %s — clear for %s\n' "$HANDLE" "$TARGET"
