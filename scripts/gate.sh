#!/bin/bash
# gate.sh <handle> <fence-regex> [load-batches] — a landing gate that BLOCKS.
#
# Every check exits 1 on failure, so the merge is unreachable from a failed
# check. Written after a gate that printed "RED" and merged anyway: a check that
# reports without honouring itself is not a gate.
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
fail()  { echo "GATE FAILED: $1"; echo ">>> HOLDING $H — not merged"; exit 1; }

echo "════════ GATE: $H ════════"
[ -d "$W" ] || fail "worktree missing (resolved: ${W:-none})"
BRANCH=$(git -C "$W" rev-parse --abbrev-ref HEAD 2>/dev/null) || fail "cannot read branch"
echo "  worktree: $W (branch $BRANCH)"

# lockfile churn from per-worktree installs blocks merges on either side
clean
workmux rebase "$H" >/dev/null 2>&1 || echo "  (rebase reported an issue — continuing to checks)"
# In a linked worktree .git is a FILE, so $W/.git/rebase-merge never exists —
# resolve the real git dir first (learned when a mid-rebase lane read as "stranded").
GD=$(git -C "$W" rev-parse --absolute-git-dir 2>/dev/null || echo "$W/.git")
{ [ -d "$GD/rebase-merge" ] || [ -d "$GD/rebase-apply" ]; } && fail "worktree is mid-rebase (conflict) — resolve on the branch first"

viol=$(git -C "$W" diff main...HEAD --name-only | grep -vE "$FENCE" || true)
[ -n "$viol" ] && { echo "  outside fence:"; echo "$viol" | sed 's/^/    /'; fail "fence violated (widen it deliberately, with the diff as justification, or send it back)"; }
echo "  fence OK: $(git -C "$W" diff main...HEAD --name-only | tr '\n' ' ')"

n=$(git -C "$W" log --oneline main..HEAD | wc -l)
[ "$n" = "0" ] && fail "no commits on the branch (a worker may have left work uncommitted — check git status in the worktree)"
dirty=$(git -C "$W" status --porcelain | grep -v package-lock.json | wc -l)
[ "$dirty" != "0" ] && { git -C "$W" status --porcelain | head -5; fail "uncommitted work stranded in the worktree"; }
echo "  commits: $n, worktree clean"

# NUL check guards TEXT files (one stray NUL makes them binary to git —
# undiffable, unmergeable). Deliberate binary assets are exempt; a docs lane
# committing PNGs was falsely held before this exemption existed.
while read -r f; do
  [ -f "$W/$f" ] || continue
  case "$f" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.webp|*.woff|*.woff2|*.ttf|*.pdf|*.zip|*.gz) continue ;;
  esac
  c=$(python3 -c "import sys;print(open(sys.argv[1],'rb').read().count(b'\x00'))" "$W/$f" 2>/dev/null || echo 0)
  [ "$c" != "0" ] && fail "$f contains $c NUL byte(s) — git treats it as binary: undiffable, unmergeable"
done < <(git -C "$W" diff main...HEAD --name-only)
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
    PREV=$(cat "$COUNT_FILE" 2>/dev/null)
    case "$PREV" in ('' | *[!0-9]*) PREV=0 ;; esac
    [ "$TCOUNT" -lt "$PREV" ] && fail "timing pass matches $TCOUNT file(s), fewer than the $PREV last recorded — a timing test silently fell out (if this is deliberate, a human clears $COUNT_FILE)"
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

clean
workmux merge "$H" 2>&1 | grep -E "Merged '|Error|Caused by" | head -2
git rev-parse --verify "refs/heads/$BRANCH" >/dev/null 2>&1 && fail "branch $BRANCH still exists — the merge did not complete"

# The lane manifest (ruling 19, written by dispatch.sh) describes CURRENT
# lanes. Prune the merged lane or observers fence a ghost — three landed
# lanes read OFF-FENCE in a live UI before this existed.
if [ -f "$root/.swarm/lanes.json" ]; then
  H="$H" ROOT="$root" node -e '
    const fs = require("fs");
    const p = process.env.ROOT + "/.swarm/lanes.json";
    try {
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      m.lanes = (m.lanes || []).filter(l => l.handle !== process.env.H);
      fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
    } catch {}
  ' 2>/dev/null && echo "  lane manifest pruned: $H"
fi

# A merged lockfile leaves the ROOT node_modules stale, and the suite cannot
# see it: a lane that adds a dependency lands green, then the app fails to
# boot with "Failed to resolve module specifier". Reconcile here, then prove
# the thing actually builds — a gate that never builds is a gate that ships
# a broken bundle behind a green suite.
npm install --no-audit --no-fund >/tmp/gate-install-$H.log 2>&1 || echo "  ! npm install after merge reported an issue (see /tmp/gate-install-$H.log)"
if npm run build >/tmp/gate-build-$H.log 2>&1; then
  echo "  build OK"
else
  tail -6 /tmp/gate-build-$H.log
  echo "  !! BUILD BROKEN ON MAIN after merging $H — fix forward immediately"
fi
echo "  MERGED, main now at $(git log --oneline -1)"

# Landings are not durable until they leave this disk (operator ruling
# 2026-08-04: "where are we pushing these changes?"). Loud but non-fatal —
# an offline push must not hold a green landing hostage.
git push origin main 2>&1 | tail -1 || echo "  ! push FAILED — main is LOCAL-ONLY until pushed by hand"
