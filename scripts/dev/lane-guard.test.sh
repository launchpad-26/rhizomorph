#!/usr/bin/env bash
# lane-guard.test.sh — lane-guard.sh's checks can still go red for the reasons
# they claim.
#
# Run it:  bash scripts/dev/lane-guard.test.sh
#
# Why a test and not a careful reading: this script's own review found check 5
# asserting "main is level with origin/main" in a clone where local `main` did
# not exist. The command behind it exited 128 and a `|| echo 0` laundered that
# into a pass. Nothing about the code LOOKED wrong — the defect was only visible
# by constructing the repo shape and running it, which is what this file does.
#
# Every case below builds a throwaway repo under a temp dir, so nothing here
# touches the repo you are standing in. The teardown runs on exit, including on
# failure — a test that leaves worktrees behind gets deleted rather than fixed.
set -uo pipefail

GUARD=$(cd "$(dirname "$0")" && pwd)/lane-guard.sh
[ -f "$GUARD" ] || { echo "cannot find lane-guard.sh beside this test" >&2; exit 2; }

PASS=0; FAIL=0
ok()   { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  FAIL  %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

# expect <wanted-rc> <label> -- <command...>
expect() {
  want=$1; label=$2; shift 3
  out=$("$@" 2>&1); got=$?
  if [ "$got" = "$want" ]; then ok "$label (exit $got)"
  else bad "$label — wanted exit $want, got $got"; printf '%s\n' "$out" | sed 's/^/          /' >&2; fi
}

# says <yes|no> <pattern> <label> -- <command...>
says() {
  want=$1; pat=$2; label=$3; shift 4
  out=$("$@" 2>&1)
  if printf '%s' "$out" | grep -q "$pat"; then found=yes; else found=no; fi
  if [ "$found" = "$want" ]; then ok "$label"
  else bad "$label — wanted '$pat' $want, got $found"; printf '%s\n' "$out" | sed 's/^/          /' >&2; fi
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/lane-guard-test.XXXXXX")
cleanup() {
  # worktrees first: a repo with live worktrees does not rm cleanly on all
  # platforms, and a stray worktree registered against a deleted path is exactly
  # the "malformed live pane"-shaped mess this repo already knows about.
  for wt in "$TMP"/*/.git; do :; done
  find "$TMP" -maxdepth 2 -name '.git' -type d 2>/dev/null | while read -r g; do
    r=$(dirname "$g"); git -C "$r" worktree prune 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

q() { git "$@" >/dev/null 2>&1; }

# ── a bare origin, a primary clone on main, one commit ──────────────────────
q init --bare -b main "$TMP/origin.git"
q init -b main "$TMP/primary"
git -C "$TMP/primary" config user.email t@example.invalid
git -C "$TMP/primary" config user.name  "Test"
echo one > "$TMP/primary/a"
q -C "$TMP/primary" add a
q -C "$TMP/primary" commit -m one
q -C "$TMP/primary" remote add origin "$TMP/origin.git"
q -C "$TMP/primary" push -u origin main

echo "── misuse (exit 2) ─────────────────────────────────────────────────────"
expect 2 "no arguments"                    -- bash "$GUARD"
expect 2 "flag given where branch belongs" -- bash "$GUARD" --no-fetch lane1
expect 2 "unknown flag"                    -- bash "$GUARD" lane1 --nofetch
expect 2 "trailing garbage"                -- bash "$GUARD" lane1 --no-fetch EXTRA

echo "── check 1: the primary worktree is refused ────────────────────────────"
expect 1 "primary checkout fails"          -- bash -c "cd '$TMP/primary' && bash '$GUARD' lane1 --no-fetch"
says yes "PRIMARY worktree" "primary failure names itself" -- \
  bash -c "cd '$TMP/primary' && bash '$GUARD' lane1 --no-fetch"

echo "── a linked lane worktree ──────────────────────────────────────────────"
q -C "$TMP/primary" worktree add -b lane1 "$TMP/wt-lane1" main
expect 0 "clean linked worktree on its own branch" -- \
  bash -c "cd '$TMP/wt-lane1' && bash '$GUARD' lane1 --no-fetch"

echo "── check 2: dirty tree, and the package-lock carve-out ─────────────────"
echo dirty > "$TMP/wt-lane1/scratch"
expect 1 "dirty tree fails"                -- bash -c "cd '$TMP/wt-lane1' && bash '$GUARD' lane1 --no-fetch"
rm -f "$TMP/wt-lane1/scratch"
echo '{}' > "$TMP/wt-lane1/package-lock.json"
expect 0 "lockfile churn alone still passes (matches gate.sh:559)" -- \
  bash -c "cd '$TMP/wt-lane1' && bash '$GUARD' lane1 --no-fetch"
rm -f "$TMP/wt-lane1/package-lock.json"

echo "── check 3: a branch checked out elsewhere ─────────────────────────────"
q -C "$TMP/primary" worktree add -b lane2 "$TMP/wt-lane2" main
expect 1 "target held by another worktree fails" -- \
  bash -c "cd '$TMP/wt-lane1' && bash '$GUARD' lane2 --no-fetch"
says yes "already checked out at" "and names the worktree holding it" -- \
  bash -c "cd '$TMP/wt-lane1' && bash '$GUARD' lane2 --no-fetch"

echo "── check 4: HEAD belongs to another lane, or is detached ───────────────"
expect 1 "HEAD on a third branch fails" -- \
  bash -c "cd '$TMP/wt-lane1' && bash '$GUARD' something-else --no-fetch"
q -C "$TMP/primary" worktree add --detach "$TMP/wt-det" main
expect 1 "detached HEAD fails" -- bash -c "cd '$TMP/wt-det' && bash '$GUARD' lane3 --no-fetch"
says yes "detached" "and says so in those words" -- \
  bash -c "cd '$TMP/wt-det' && bash '$GUARD' lane3 --no-fetch"

echo "── check 5: the regression that shipped ────────────────────────────────"
# THE case. A clone whose local default branch is not called `main`, so
# `git rev-list --count main..origin/main` exits 128. The original swallowed
# that with `|| echo 0` and asserted the base was level. Both halves are
# asserted: it must not CLAIM level, and it must say the check did not run.
q clone "$TMP/origin.git" "$TMP/c2"
git -C "$TMP/c2" config user.email t@example.invalid
git -C "$TMP/c2" config user.name  "Test"
q -C "$TMP/c2" branch -m main trunk
q -C "$TMP/c2" worktree add -b lane9 "$TMP/c2-lane9" trunk
says no  "level with origin/main" "no local main: does NOT claim the base is level" -- \
  bash -c "cd '$TMP/c2-lane9' && bash '$GUARD' lane9"
says yes "UNCHECKED"               "no local main: says the check did not run" -- \
  bash -c "cd '$TMP/c2-lane9' && bash '$GUARD' lane9"

# The sibling: origin/main absent rather than main. It must not vanish silently.
q clone "$TMP/origin.git" "$TMP/c3"
q -C "$TMP/c3" remote rename origin upstream
q -C "$TMP/c3" worktree add -b lane8 "$TMP/c3-lane8"
says yes "unchecked\|UNCHECKED\|offline" "no origin/main: still prints a line" -- \
  bash -c "cd '$TMP/c3-lane8' && bash '$GUARD' lane8"

# And the warning itself still fires when the base really is behind.
q -C "$TMP/primary" checkout main
echo two >> "$TMP/primary/a"
q -C "$TMP/primary" commit -am two
q -C "$TMP/primary" push origin main
q clone "$TMP/origin.git" "$TMP/c4"
q -C "$TMP/c4" reset --hard HEAD~1
q -C "$TMP/c4" worktree add -b lane7 "$TMP/c4-lane7"
says yes "behind origin/main" "a genuinely stale base still warns" -- \
  bash -c "cd '$TMP/c4-lane7' && bash '$GUARD' lane7"

# Review finding 7: --no-fetch used to skip the whole of check 5 and print
# nothing at all. The comparison is refs/heads/main..origin/main — both already
# on disk — so the flag can only cost the freshness of one side, never the
# answer. Same worktree, same genuinely-behind base, run both ways: the warning
# has to survive the flag, and the flag has to say what it skipped.
says yes "behind origin/main" "a stale base still warns under --no-fetch" -- \
  bash -c "cd '$TMP/c4-lane7' && bash '$GUARD' lane7 --no-fetch"
says yes "not refreshed" "--no-fetch names the half it did skip" -- \
  bash -c "cd '$TMP/c4-lane7' && bash '$GUARD' lane7 --no-fetch"

echo
printf 'lane-guard.test.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
