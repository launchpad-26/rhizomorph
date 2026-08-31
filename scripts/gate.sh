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
#
# `--is-ancestor` returns 1 for the ordinary "not an ancestor" and 128 for a
# bad object (a corrupt ref, history missing from a shallow clone) — two
# different facts. The old form discarded stderr and routed both through the
# same `|| fail "the rebase did not take"`, telling an operator with a
# corrupt ref that their rebase failed. stderr is captured instead so the 128
# case can say what it actually is.
ANCESTOR_ERR=$(git -C "$W" merge-base --is-ancestor main HEAD 2>&1 >/dev/null)
ANCESTOR_RC=$?
if [ "$ANCESTOR_RC" -eq 1 ]; then
  fail "branch $BRANCH is not on top of main (the rebase did not take) — rebase it, then re-run"
elif [ "$ANCESTOR_RC" -ne 0 ]; then
  echo "$ANCESTOR_ERR"
  fail "git merge-base --is-ancestor exited $ANCESTOR_RC on $BRANCH — not the ordinary 1 for 'not an ancestor'; a ref may be corrupt (see stderr above)"
fi

# The producer (git diff) and the consumer's normal exit (grep) are two
# different facts and are checked separately. `|| true` cannot simply be
# deleted: grep -v exits 1 on the ordinary "everything matched the fence, no
# violations" path, so treating any nonzero as failure would hold every clean
# landing. Only a producer failure, or grep itself erroring (an invalid
# regex — FENCE='[' exits 2, not 1), holds.
#
# -z / read -r -d '', not --name-only line-delimited: git quotes a non-ASCII
# name by default ("caf\303\251.ts"), so a line-based read compares an
# escaped literal against FENCE instead of the bytes on disk, and an in-fence
# file with such a name is reported as a violation (prd-46 #71). This is the
# same defect the NUL-byte guard below already fixed at its own producer —
# reusing that shape here rather than inventing a third. The file listing is
# written to a real file, not a pipe or process substitution, so the
# producer's own exit status is captured directly.
#
# The regex is validated separately from the per-file matching below: it is
# checked ONCE, against empty input, so its rc means only "does this pattern
# compile" and is never conflated with "did this filename match" (which is
# always 0 or 1 once the pattern is known-valid).
#
# Matching is `[[ =~ ]]`, not `grep -qE`: grep matches LINE BY LINE, so a name
# containing a newline was admitted whenever ANY line of it matched FENCE —
# `evil/a<NL>src/foo/b.ts` passed a fence of '^src/foo/'. EXECUTED: the
# line-delimited form this replaces CONVICTED that file, so per-file grep was a
# fail-OPEN reversal of the very guard #71 exists to harden. `[[ =~ ]]` matches
# the whole string (no REG_NEWLINE), so `^` anchors at the name, not at a line.
# Validation above stays on grep -E: both are POSIX ERE, and if they ever did
# disagree the disagreement lands as rc 2 from [[ ]], which reads as no-match
# and CONVICTS — a false hold, never a false pass.
printf '' | grep -E "$FENCE" >/dev/null 2>&1
GREP_RC=$?
[ "$GREP_RC" -gt 1 ] && fail "fence regex '$FENCE' is invalid (grep rc=$GREP_RC) — cannot audit the fence"

FENCE_LIST=$(mktemp "/tmp/gate-fence-list-$H.XXXXXX") || fail "cannot create a scratch file for the fence file listing"
git -C "$W" diff -z main...HEAD --name-only >"$FENCE_LIST"
DIFF_RC=$?
[ "$DIFF_RC" -ne 0 ] && { rm -f "$FENCE_LIST"; fail "git diff main...HEAD failed (rc=$DIFF_RC) — cannot audit the fence"; }

DIFF_FILES=()
viol=()
while IFS= read -r -d '' f; do
  DIFF_FILES+=("$f")
  [[ $f =~ $FENCE ]] || viol+=("$f")
done <"$FENCE_LIST"
rm -f "$FENCE_LIST"

[ "${#viol[@]}" -gt 0 ] && { echo "  outside fence:"; printf '    %s\n' "${viol[@]}"; fail "fence violated (widen it deliberately, with the diff as justification, or send it back)"; }
# ${DIFF_FILES[*]-}, not ${DIFF_FILES[*]}: an empty array under `set -u` (:13)
# is an unbound variable on bash < 4.4, and /bin/bash on macOS is 3.2. EXECUTED
# there: a branch whose diff against main is empty aborted with a bare
# "DIFF_FILES[*]: unbound variable", rc 1, WITHOUT passing through fail() — so
# no "GATE FAILED" and no ">>> HOLDING" line, on the one code path the script
# has a dedicated diagnosis for eighteen lines further down ("no commits on the
# branch (a worker may have left work uncommitted)", :142). The old
# line-delimited form printed "fence OK: " and reached it; this restores that.
echo "  fence OK: ${DIFF_FILES[*]-}"

# These two compare ARITHMETICALLY, not as text: BSD wc -l right-aligns its
# count in an eight-char field ("       0"), and command substitution strips
# only the trailing newline — compared as text on macOS, the stranded-work
# check fired on every clean tree and the empty-branch check never (#416).
#
# The producer's own exit status is read before the verdict below trusts $n
# (prd-46 #70): pipefail (set at :13) makes this pipeline's status the git
# log failure, not wc -l's own success, when main..HEAD cannot even be
# computed — e.g. with .git/HEAD removed, `git log` reports "fatal: not a
# git repository", pipeline rc 128, n=0, and the OLD code (no RC check) held
# with "no commits on the branch (a worker may have left work uncommitted)"
# — a fault it did not earn. This was #70's headline evidence: the law
# reading green over exactly this line.
n=$(git -C "$W" log --oneline main..HEAD | wc -l)
N_RC=$?
[ "$N_RC" -ne 0 ] && fail "git log/wc -l failed (rc=$N_RC) — cannot count commits on the branch"
[ "$n" -eq 0 ] && fail "no commits on the branch (a worker may have left work uncommitted — check git status in the worktree)"
STATUS_OUT=$(git -C "$W" status --porcelain)
STATUS_RC=$?
[ "$STATUS_RC" -ne 0 ] && fail "git status failed in $W (rc=$STATUS_RC) — cannot verify the worktree is clean"
# SIBLING of the same shape (a $(...) pipeline whose own exit status feeds
# no check), FIXED here rather than declared — the :96 fix above is its
# twin (prd-46 #70 ruling 3). The guard is `-gt 1`, not `-ne 0`, and the
# asymmetry is the whole point:
#
#   -ne 0  would misfire on EVERY clean landing. EXECUTED: grep -v's "no
#          match" exit (1) is the ORDINARY outcome both on a clean tree and
#          when nothing besides package-lock.json changed — the same
#          masking bug the fence fix at :74-80 exists to avoid.
#   -gt 1  cannot fire on a legitimate landing: grep returns only 0 or 1
#          when it RUNS, and wc -l returns 0. It fires when a stage does
#          not run or dies — EXECUTED: rc 127 with grep absent from PATH
#          (this script rewrites PATH itself at :14), and rc >=128 when a
#          stage is signalled.
#
# An earlier revision of this comment declared the line instead, arguing
# `-gt 1` "would never fire at all, since the pattern is a fixed literal
# and cannot itself be invalid". Pattern validity is not the only route to
# a >1 status, so that reason was false and the tolerance it justified was
# a claim this file had not earned — the exact defect prd-46 exists to
# abolish, sitting inside its own tolerance table. Recorded rather than
# quietly deleted: the wrong reason is why the fix looked unnecessary.
#
# $STATUS_OUT, the other fallible input, is already RC-checked two lines up.
dirty=$(printf '%s' "$STATUS_OUT" | grep -v package-lock.json | wc -l)
DIRTY_RC=$?
[ "$DIRTY_RC" -gt 1 ] && fail "the dirty-count pipeline failed (rc=$DIRTY_RC) — cannot verify the worktree is clean"
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
  # A RISE is not the mirror image of a DROP. A dropped timing test is a
  # silent loss of coverage, so it stays a hard fail() below (#42's line,
  # untouched). A risen count is routine — landing a genuine new timing test
  # raises it correctly — and #48 measured what hard-failing every rise would
  # buy: a check annoying enough to get suppressed or have its ratchet file
  # deleted within a week, which is worse than the gap it closes. So a rise
  # is never a fail(): it is a REPORT, printed next to the write below so it
  # is never silently absorbed into the new floor unseen. RISE_TOLERANCE is
  # declared data (prd-45 ruling 3: tolerances are data, not a condition
  # folded into a regex) — a human changes the VALUE by editing this one
  # line. gate-honesty-law.test.ts's rise fixtures parse this value out of
  # this file and derive their own expected delta from it, so raising it
  # moves their expected numbers instead of reddening them with a diff that
  # names neither the tolerance nor the change.
  RISE_TOLERANCE=0
  RISE_NOTE=""
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
    # All-digit still isn't safe: bash arithmetic below (:$((TCOUNT - PREV)))
    # reads a leading zero as an OCTAL prefix, not decimal — '08' is not even
    # valid octal (errors out, and the rise it hid is never reported, floor
    # written anyway), and '010' is valid octal 8, so a genuine hold (PREV=10)
    # would misreport as a rise from 8. #42 hardened the ONE arithmetic
    # consumer of $PREV (the `-lt` comparison, unaffected — [ ] does decimal);
    # this is the SECOND one (#48), and gets the same "do not silently trust
    # it" treatment rather than a normalising rewrite. Deliberately kept
    # ABOVE the drop check below rather than moved after it: `[ -lt ]` does
    # read a leading zero as decimal, so reordering would "work", but it
    # would make this guard's safety depend on landing below a check it can
    # just as easily sit above — the guard holds regardless of order, and
    # keeping it here needs no such dependency.
    case "$PREV" in
      (0[0-9]*) fail "$COUNT_FILE contains '$PREV', a non-canonical leading-zero number — bash arithmetic (not the '-lt' comparison below, which reads it correctly as decimal) would treat it as octal. This guard fires BEFORE the drop check below can, so a hand-written value here can be hiding a real drop: before touching $COUNT_FILE, compare $TCOUNT (the current timing-set count, above) against the DECIMAL number '$PREV' was meant to hold — if $TCOUNT is lower, that is a genuine drop, and clearing this file (rather than correcting it) would silently absorb the drop into a fresh floor instead of reporting it. A human corrects the VALUE (writes the intended decimal number to $COUNT_FILE); clearing it is only safe once that comparison is done." ;;
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
    # CMP_RC is 1 here — both 0 and >1 fail() above — so TCOUNT >= PREV always.
    [ "$((TCOUNT - PREV))" -gt "$RISE_TOLERANCE" ] && RISE_NOTE=" ROSE from $PREV to $TCOUNT — confirm the new file(s) belong in the timing set rather than an accidental marker match (#48); this becomes the new floor below"
  else
    RISE_NOTE=" no prior floor found — this landing ESTABLISHES it at $TCOUNT (first run, or a human cleared $COUNT_FILE; the file is .gitignore'd and per-machine, #48)"
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
    # RISE_NOTE claims a consequence of this write ("becomes the new floor" /
    # "ESTABLISHES it") — a claim this line is not entitled to make unless the
    # write actually landed. mkdir -p failing, or printf hitting a read-only
    # $COUNT_FILE, used to fall through silently: the fragment still exited 0
    # and RISE_NOTE still printed, a verdict about a floor that never moved.
    mkdir -p "$root/.swarm" && printf '%s\n' "$TCOUNT" >"$COUNT_FILE" \
      || fail "cannot write the timing-count floor at $COUNT_FILE — the ratchet did not advance; a human fixes its permissions"
    [ -n "$RISE_NOTE" ] && echo "  timing-count ratchet:$RISE_NOTE"
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
  #
  # That closed the swallowed-catch half but not the shape half: a
  # lanes.json that is a JSON ARRAY, an object with no `.lanes` key, or a
  # `.lanes` holding non-object entries, all parse and (without a shape
  # guard) write back fine — node exits 0 either way — even though "the
  # file parsed and was rewritten" is not "this handle was removed". A
  # shape this code does not understand now throws too, same route as
  # malformed JSON. A manifest that legitimately has no entry for this
  # handle is a different, honest outcome (NOOP) and is not an error — it
  # is reported as neither a prune nor a failure.
  #
  # The write itself only runs when something actually changed (verify
  # review, MUST-FIX 1): writing lanes.json back unconditionally on every
  # run — even a NOOP — made a VALID manifest with no entry for this
  # handle FAIL on a read-only lanes.json (EACCES), which is exactly the
  # case this issue's own criterion protects: "a manifest that legitimately
  # has no entry for this handle still succeeds quietly; that is not an
  # error." A NOOP now never touches the file at all.
  #
  # The result crosses the shell/node boundary through a file, read back
  # with `grep -qxF` — EXACT whole-line match, not `grep -qF`'s substring
  # match (verify review, MUST-FIX 2: a corrupted result like "NOT_PRUNED"
  # contains "PRUNED" as a substring and the old `-F` form printed the
  # false "pruned" line for it) — rather than captured via
  # VAR=$(node -e '<multi-line>'): a multi-line $(...) is invisible to
  # ruling 1's own structural predicate (it only matches a producer whose
  # closing paren is on the SAME line), so capturing this multi-line
  # script that way would add a checked producer the law itself cannot see
  # is checked — exactly the blind spot prd46 w5 (#179) names. Anything
  # other than an exact "PRUNED" or "NOOP" line — truncated output, a
  # missing file, garbage — holds rather than guessing either way.
  MANIFEST_LOG=$(mktemp "/tmp/gate-manifest-$H.XXXXXX") || fail "cannot create a scratch log for the lane-manifest prune"
  MANIFEST_OUT_LOG=$(mktemp "/tmp/gate-manifest-out-$H.XXXXXX") || { rm -f "$MANIFEST_LOG"; fail "cannot create a scratch file for the lane-manifest prune's result"; }
  H="$H" ROOT="$root" node -e '
    const fs = require("fs");
    const p = process.env.ROOT + "/.swarm/lanes.json";
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    if (m === null || typeof m !== "object" || Array.isArray(m) || !Array.isArray(m.lanes)) {
      throw new Error("lanes.json is not shaped as {lanes: [...]}");
    }
    if (!m.lanes.every(l => l !== null && typeof l === "object" && !Array.isArray(l))) {
      throw new Error("lanes.json .lanes contains a non-object entry");
    }
    const before = m.lanes.length;
    const after = m.lanes.filter(l => l.handle !== process.env.H);
    if (after.length === before) {
      process.stdout.write("NOOP");
    } else {
      m.lanes = after;
      fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
      process.stdout.write("PRUNED");
    }
  ' >"$MANIFEST_OUT_LOG" 2>"$MANIFEST_LOG"
  MANIFEST_RC=$?
  if [ "$MANIFEST_RC" -eq 0 ]; then
    if grep -qxF PRUNED "$MANIFEST_OUT_LOG"; then
      echo "  lane manifest pruned: $H"
    elif grep -qxF NOOP "$MANIFEST_OUT_LOG"; then
      :
    else
      rm -f "$MANIFEST_LOG" "$MANIFEST_OUT_LOG"
      fail "lane manifest prune produced an unrecognized result — refusing to guess whether $H was pruned"
    fi
    rm -f "$MANIFEST_LOG" "$MANIFEST_OUT_LOG"
  else
    # The thrown message (what a human needs) sits a few lines INTO node's
    # stack trace, not in the last 6 lines of it (verify review: a shape
    # guard's message never reached this point — PROVEN INERT by deleting
    # the whole guard and finding every shape test still passed on the
    # `tail -6` fallback's generic fail() line alone). Node always prints
    # the error's own class + message on a line starting `Error:`,
    # `TypeError:`, or `SyntaxError:` before the "at ..." frames; that line
    # is grepped for first, and `tail -6` stays as the fallback for
    # anything that error class list does not cover.
    grep -m1 -E '^(Error|SyntaxError|TypeError):' "$MANIFEST_LOG" || tail -6 "$MANIFEST_LOG"
    rm -f "$MANIFEST_LOG" "$MANIFEST_OUT_LOG"
    fail "lane manifest prune failed — .swarm/lanes.json is malformed, unwritable, or not shaped as {lanes: [...]}"
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
