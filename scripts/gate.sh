#!/bin/bash
# gate.sh <handle> <fence-regex> [load-batches] — a landing gate that BLOCKS.
#
# Every check exits 1 on failure: a failed check BEFORE the merge makes the
# merge unreachable, and a failed check after it (install, build) makes the
# PUSH unreachable and says so. Written after a gate that printed "RED" and
# merged anyway: a check that reports without honouring itself is not a gate.
# The one exception is the final push — see push_or_warn(), which names and
# scopes that exemption instead of leaving it as a comment on the line.
#
# Callers must also gate their side effects:
#     gate.sh 37 '^src/foo/' 3 && gh issue close 37   # NOT on separate lines
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
[ $# -lt 2 ] && { echo "usage: gate.sh <handle> <fence-regex> [load-batches]"; exit 2; }
H=$1; FENCE=$2; LOAD=${3:-0}
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root"

# Resolve the worktree from the tool, never by string construction: workmux may
# suffix a directory name (collision avoidance), and a constructed path then
# silently misses a live lane.
W=$(workmux path "$H" 2>/dev/null | tail -1)
[ -d "${W:-}" ] || W="$(dirname "$root")/$(basename "$root")__worktrees/$H"

clean() { git -C "$root" checkout -- package-lock.json 2>/dev/null || true
          git -C "$W"    checkout -- package-lock.json 2>/dev/null || true; }
# MERGED flips at the merge so fail()'s recovery line stays TRUE on both sides
# of it. Before: nothing landed, the lane still holds the work. After: local
# main carries the merge and the only thing held is the push — so "not merged"
# would send the operator to a lane whose branch and worktree are already gone.
MERGED=0
fail()  { echo "GATE FAILED: $1"
          if [ "$MERGED" = 0 ]; then echo ">>> HOLDING $H — not merged"
          else echo ">>> MERGED to local main, NOT pushed — fix forward on main immediately, then push"; fi
          exit 1; }

echo "════════ GATE: $H ════════"
command -v python3 >/dev/null 2>&1 || fail "python3 not found — the NUL-byte guard cannot run without it"
[ -d "$W" ] || fail "worktree missing (resolved: ${W:-none})"
BRANCH=$(git -C "$W" rev-parse --abbrev-ref HEAD 2>/dev/null) || fail "cannot read branch"
echo "  worktree: $W (branch $BRANCH)"

# lockfile churn from per-worktree installs blocks merges on either side
clean
workmux rebase "$H" >/dev/null 2>&1 || echo "  (rebase reported an issue — the branch's base is asserted below)"
# In a linked worktree .git is a FILE, so a naive "$W/.git" fallback would
# make $GD/rebase-merge structurally unable to exist — verified against a
# real in-progress rebase: the correct resolution DETECTED it, the fallback
# MISSED it. :41 already proved git works in this worktree, so a failure to
# resolve the real git dir here is held rather than papered over with a path
# that cannot do the job.
#
# mktemp, not a predictable "/tmp/gate-gitdir-$H.log" — a fixed path a
# symlink can occupy before this runs, same class as :116's NUL_LIST.
GITDIR_LOG=$(mktemp "/tmp/gate-gitdir-$H.XXXXXX") || fail "cannot create a scratch log for the git-dir probe"
GD=$(git -C "$W" rev-parse --absolute-git-dir 2>"$GITDIR_LOG") || { cat "$GITDIR_LOG"; rm -f "$GITDIR_LOG"; fail "cannot resolve the real git dir for $W — the mid-rebase guard below cannot run without it"; }
rm -f "$GITDIR_LOG"
{ [ -d "$GD/rebase-merge" ] || [ -d "$GD/rebase-apply" ]; } && fail "worktree is mid-rebase (conflict) — resolve on the branch first"
# workmux's exit code is not the check — the STATE is. A rebase that never ran
# (workmux absent, unknown handle) or aborted cleanly leaves the branch on an
# old base, where the three-dot fence audit and the suite below both measure a
# tree that is not the one landing. Verified: this holds a stale branch and
# false-holds nothing — an already-current branch, a fresh zero-commit branch
# and HEAD == main all have main as an ancestor.
git -C "$W" merge-base --is-ancestor main HEAD 2>/dev/null || fail "branch $BRANCH is not on top of main (the rebase did not take) — rebase it, then re-run"

# The producer (git diff) and the consumer's normal exit (grep -vE) are two
# different facts and are checked separately. `|| true` cannot simply be
# deleted: grep -v exits 1 on the ordinary "everything matched the fence, no
# violations" path, so treating any nonzero as failure would hold every clean
# landing. Only a producer failure, or grep itself erroring (an invalid
# regex — FENCE='[' exits 2, not 1), holds.
DIFF_FILES=$(git -C "$W" diff main...HEAD --name-only)
DIFF_RC=$?
[ "$DIFF_RC" -ne 0 ] && fail "git diff main...HEAD failed (rc=$DIFF_RC) — cannot audit the fence"
viol=$(printf '%s' "$DIFF_FILES" | grep -vE "$FENCE")
GREP_RC=$?
[ "$GREP_RC" -gt 1 ] && fail "fence regex '$FENCE' is invalid (grep rc=$GREP_RC) — cannot audit the fence"
[ -n "$viol" ] && { echo "  outside fence:"; echo "$viol" | sed 's/^/    /'; fail "fence violated (widen it deliberately, with the diff as justification, or send it back)"; }
echo "  fence OK: $(printf '%s' "$DIFF_FILES" | tr '\n' ' ')"

# These two compare ARITHMETICALLY, not as text: BSD wc -l right-aligns its
# count in an eight-char field ("       0"), and command substitution strips
# only the trailing newline — compared as text on macOS, the stranded-work
# check fired on every clean tree and the empty-branch check never (#416).
n=$(git -C "$W" log --oneline main..HEAD | wc -l)
[ "$n" -eq 0 ] && fail "no commits on the branch (a worker may have left work uncommitted — check git status in the worktree)"
STATUS_OUT=$(git -C "$W" status --porcelain)
STATUS_RC=$?
[ "$STATUS_RC" -ne 0 ] && fail "git status failed in $W (rc=$STATUS_RC) — cannot verify the worktree is clean"
dirty=$(printf '%s' "$STATUS_OUT" | grep -v package-lock.json | wc -l)
[ "$dirty" -ne 0 ] && { printf '%s\n' "$STATUS_OUT" | head -5; fail "uncommitted work stranded in the worktree"; }
echo "  commits: $n, worktree clean"

# NUL check guards TEXT files (one stray NUL makes them binary to git —
# undiffable, unmergeable). Deliberate binary assets are exempt; a docs lane
# committing PNGs was falsely held before this exemption existed.
#
# -z / read -r -d '' replaces line-delimited reading of the file list: git
# quotes a non-ASCII name by default ("caf\303\251.ts"), which fails [ -f ]
# and silently skips the file — exactly the file this guard exists to catch.
# -z disables quoting and NUL-terminates each entry instead, so a name with
# any byte in it round-trips intact. The listing is written to a real file,
# not a pipe or process substitution, so its own exit status is captured
# directly instead of being lost the way a pipe/proc-sub loses a producer's
# failure.
#
# mktemp, not a predictable "/tmp/gate-nul-list-$H" — EXECUTED: a symlink
# planted at that fixed path before this ran had `>` silently follow it and
# overwrite an unrelated file, while the guard read the wrong file list.
# mktemp both removes the guessable name and creates the file atomically, so
# there is no window between "name chosen" and "file exists" for a symlink
# to occupy. The trap clears it even if fail() exits mid-loop below, so a
# held NUL check does not leak a listing into /tmp.
NUL_LIST=$(mktemp "/tmp/gate-nul-list-$H.XXXXXX") || fail "cannot create a scratch file for the NUL-byte file listing"
trap 'rm -f "$NUL_LIST"' EXIT
git -C "$W" diff -z main...HEAD --name-only >"$NUL_LIST"
NUL_LIST_RC=$?
[ "$NUL_LIST_RC" -ne 0 ] && fail "git diff (file listing) failed (rc=$NUL_LIST_RC) — cannot verify NUL bytes"
while IFS= read -r -d '' f; do
  [ -f "$W/$f" ] || continue
  case "$f" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.webp|*.woff|*.woff2|*.ttf|*.pdf|*.zip|*.gz) continue ;;
  esac
  c=$(python3 -c "import sys;print(open(sys.argv[1],'rb').read().count(b'\x00'))" "$W/$f" 2>/tmp/gate-nul-$H.log) || fail "$f unreadable — cannot verify NUL bytes (see /tmp/gate-nul-$H.log)"
  [ "$c" != "0" ] && fail "$f contains $c NUL byte(s) — git treats it as binary: undiffable, unmergeable"
done <"$NUL_LIST"
trap - EXIT
rm -f "$NUL_LIST"
echo "  no NUL bytes (text files; binary assets exempt)"

( cd "$W" && npm test >/tmp/gate-$H.log 2>&1 ) || { tail -8 /tmp/gate-$H.log; fail "test suite red"; }
( cd "$W" && npm run typecheck >/dev/null 2>&1 ) || fail "typecheck red"
echo "  quiet gate GREEN: $(grep -aoE 'Tests.*passed' /tmp/gate-$H.log | tail -1)"

# Load gate: a suite green 8/8 quietly has failed 67% at 4x concurrency.
# Mandatory for anything touching tests.
#
# Each concurrent run's worker pool is BOUNDED (--maxWorkers=5): unbounded,
# 4 runs x cores-many vitest workers measured the scheduler, not the suite —
# a gate that passed 12/12 on six consecutive landings then failed 6/12 on a
# clean branch purely because a sibling agent was also running tests. 4x
# concurrency is the standard; self-inflicted thrash on top of it is not.
# TIMING TESTS ARE EXCLUDED FROM THE LOAD BATCHES, AND RUN ALONE AFTER.
# Four holds (#124, #130, #144, #151) were all wall-clock MEASUREMENT tests
# (the scene's 60fps frame test; the camera clamp) failing under 4x CPU
# contention: they measure the scheduler, not the code. Excluding them from
# the concurrency probe is not weakening the gate — the load gate exists to
# find RACES, and a race in those files would still surface in the serial
# pass. The serial pass is also the only condition under which a timing
# assertion means anything at all.
# TIMING SET, DERIVED (#209) — not a hand-maintained literal list. A file
# opts in by a `// @gate-timing` marker comment (grepped, wherever it lives)
# or by a `*.bench.test.ts` filename (reduce.bench.test.ts's own convention,
# #174) — so a moved or renamed timing file carries its membership with it
# instead of falling out of a literal path silently. This replaces the
# literal list #157/#193 built and #209 caught going stale: split or rename
# one of these files and the OLD mechanism would drop it from this pass with
# nothing going red — it would just run under load, the exact condition the
# serial pass exists to avoid. So absence is now checked below and fails loud.
if [ "$LOAD" != "0" ]; then
  TIMING_FILES=()
  while IFS= read -r f; do
    [ -n "$f" ] && TIMING_FILES+=("$f")
  done < <(cd "$W" && { grep -rlF '// @gate-timing' --include='*.test.ts' --include='*.test.tsx' packages 2>/dev/null
                        find packages -name '*.bench.test.ts' 2>/dev/null; } | sort -u)

  TCOUNT=${#TIMING_FILES[@]}
  [ "$TCOUNT" = "0" ] && fail "timing pass matches ZERO files — a renamed/moved timing test fell out of the gate (the #209 trap: it would still run, silently, under 4x load); restore its '// @gate-timing' marker or '.bench.test.ts' name"

  COUNT_FILE="$root/.swarm/timing-count"
  if [ -f "$COUNT_FILE" ]; then
    TIMINGCOUNT_LOG=$(mktemp "/tmp/gate-timingcount-$H.XXXXXX") || fail "cannot create a scratch log for reading $COUNT_FILE"
    PREV=$(cat "$COUNT_FILE" 2>"$TIMINGCOUNT_LOG")
    CAT_RC=$?
    [ "$CAT_RC" -ne 0 ] && { cat "$TIMINGCOUNT_LOG"; rm -f "$TIMINGCOUNT_LOG"; fail "cannot read $COUNT_FILE (rc=$CAT_RC) — cannot verify the timing-count ratchet"; }
    rm -f "$TIMINGCOUNT_LOG"
    # A corrupt count used to coerce silently to 0, which makes "$TCOUNT -lt
    # $PREV" unfireable (TCOUNT can't be negative) — the ratchet goes dead
    # instead of holding. A human clearing the file on purpose still produces
    # a MISSING file, which the outer `if` already treats as "no ratchet yet".
    case "$PREV" in
      ('' | *[!0-9]*) fail "$COUNT_FILE contains '$PREV', not a whole number — a corrupt ratchet must not be silently trusted as 0; a human clears or fixes it" ;;
    esac
    # An all-digit but oversized value (e.g. 20 digits) passes the case guard
    # above and then breaks the comparison itself: bash's `[ -lt ]` errors
    # "integer expected" at exit >1, and `&&` never reaches fail() on a
    # nonzero exit of ANY kind — a check that could not run, printing
    # nothing. The comparison's own exit code is read explicitly so an error
    # (2) is distinguished from false (1) and true (0).
    [ "$TCOUNT" -lt "$PREV" ]
    CMP_RC=$?
    [ "$CMP_RC" -gt 1 ] && fail "cannot compare timing counts — $COUNT_FILE contains '$PREV', which is too large to compare against TCOUNT=$TCOUNT; a human clears or fixes it"
    [ "$CMP_RC" -eq 0 ] && fail "timing pass matches $TCOUNT file(s), fewer than the $PREV last recorded — a timing test silently fell out (if this is deliberate, a human clears $COUNT_FILE)"
  fi
  echo "  timing set (${TCOUNT}): ${TIMING_FILES[*]}"

  # vitest resolves --exclude globs and positional filters against each
  # project's OWN root (e.g. packages/web), not the monorepo root — a bare
  # "packages/web/src/scene/perf.test.ts" pattern matches nothing, silently.
  # Stripping down to what follows .../src/ (verified against the running
  # suite below) is what the literal list this replaces already relied on.
  TIMING_SHORT=()
  for f in "${TIMING_FILES[@]}"; do TIMING_SHORT+=("${f#*/src/}"); done

  EXCL=(); for f in "${TIMING_SHORT[@]}"; do EXCL+=(--exclude "**/$f"); done
  lf=0
  for b in $(seq 1 "$LOAD"); do
    for c in 1 2 3 4; do ( cd "$W" && npm test -- --maxWorkers=5 "${EXCL[@]}" >/tmp/g-$H-$b-$c.log 2>&1; echo $? >/tmp/g-$H-$b-$c.rc ) & done
    wait
    for c in 1 2 3 4; do [ "$(cat /tmp/g-$H-$b-$c.rc)" != "0" ] && { lf=$((lf+1)); grep -aE '×' /tmp/g-$H-$b-$c.log | head -1 | sed 's/^/    /'; }; done
  done
  echo "  under 4x load (timing tests excluded): $lf failures / $((LOAD*4))"
  [ "$lf" != "0" ] && fail "flaky under load — remove the race (never widen a timeout)"

  # The timing tests, alone, once — the honest measurement condition.
  # Positional args are FILTERS (substring match), not globs — verified
  # 2026-08-04: exclusion run 2047 tests + serial pass 47 = 2094 = the whole
  # suite, so the split is exact and nothing goes unmeasured.
  if ( cd "$W" && npx vitest run --maxWorkers=1 "${TIMING_SHORT[@]}" >/tmp/g-$H-timing.log 2>&1 ); then
    echo "  timing tests (serial, alone): green"
    mkdir -p "$root/.swarm" && printf '%s\n' "$TCOUNT" >"$COUNT_FILE"
  else
    grep -aE '×' /tmp/g-$H-timing.log | head -3 | sed 's/^/    /'
    fail "timing tests red when run ALONE — this one is real (budget regression, not contention)"
  fi
fi

# Captured before the merge touches the branch ref at all — the fact this
# gate must prove is that THIS commit is now in main, not that some ref of a
# given name is gone.
LANE_SHA=$(git -C "$W" rev-parse HEAD) || fail "cannot resolve $BRANCH's tip commit before merging"
clean
workmux merge "$H" 2>&1 | grep -E "Merged '|Error|Caused by" | head -2
# Branch-ref absence is workmux merge's SIDE EFFECT, not the landing's
# meaning, and it is vacuous in a detached worktree: BRANCH=HEAD there, and
# refs/heads/HEAD never exists whether or not the merge happened — verified,
# the postcondition passed while merge-base showed the commit was NOT in
# main. Proving containment of the actual commit is the fact that matters —
# checked against the `main` REF, not $root's checked-out HEAD: this repo's
# own dispatch preflight exists because the root checkout is routinely
# parked on a feature or audit branch, and HEAD there is not main.
git merge-base --is-ancestor "$LANE_SHA" main || fail "commit $LANE_SHA (branch $BRANCH) is not contained in main — the merge did not complete"
MERGED=1   # every fail() past this point reports the post-merge truth

# The lane manifest (ruling 19, written by dispatch.sh) describes CURRENT
# lanes. Prune the merged lane or observers fence a ghost — three landed
# lanes read OFF-FENCE in a live UI before this existed.
if [ -f "$root/.swarm/lanes.json" ]; then
  # No try/catch here on purpose: a swallowed catch{} is what made a
  # malformed AND an unwritable lanes.json print the same "pruned" line at
  # exit 0 — byte-identical to success in both failure cases. Letting
  # JSON.parse / writeFileSync throw makes node's own exit code the fact
  # that decides which line prints, routed through the same fail() as
  # everything else past the merge.
  MANIFEST_LOG=$(mktemp "/tmp/gate-manifest-$H.XXXXXX") || fail "cannot create a scratch log for the lane-manifest prune"
  if H="$H" ROOT="$root" node -e '
    const fs = require("fs");
    const p = process.env.ROOT + "/.swarm/lanes.json";
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.lanes = (m.lanes || []).filter(l => l.handle !== process.env.H);
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  ' 2>"$MANIFEST_LOG"; then
    echo "  lane manifest pruned: $H"
    rm -f "$MANIFEST_LOG"
  else
    tail -6 "$MANIFEST_LOG"
    rm -f "$MANIFEST_LOG"
    fail "lane manifest prune failed — .swarm/lanes.json is malformed or unwritable"
  fi
fi

# A merged lockfile leaves the ROOT node_modules stale, and the suite cannot
# see it: a lane that adds a dependency lands green, then the app fails to
# boot with "Failed to resolve module specifier". Reconcile here, then prove
# the thing actually builds — a gate that never builds is a gate that ships
# a broken bundle behind a green suite.
npm install --no-audit --no-fund >/tmp/gate-install-$H.log 2>&1 || fail "npm install after merge broke — see /tmp/gate-install-$H.log"
if npm run build >/tmp/gate-build-$H.log 2>&1; then
  echo "  build OK"
else
  tail -6 /tmp/gate-build-$H.log
  fail "BUILD BROKEN ON MAIN after merging $H"
fi
echo "  MERGED, main now at $(git log --oneline -1)"

# push_or_warn() is THE ONE NON-FATAL CHECK IN THIS SCRIPT. Every other check
# above exits through fail(); this single line is exempted, by name, so a
# reader can see it is one line's exemption and not the script's posture.
# Landings are not durable until they leave this disk (operator ruling
# 2026-08-04: "where are we pushing these changes?"), but an offline operator
# must still be able to land — loud but non-fatal, so a failed push does not
# hold a green landing hostage.
push_or_warn() {
  git push origin main 2>&1 | tail -1 || echo "  ! push FAILED — main is LOCAL-ONLY until pushed by hand"
}
push_or_warn
