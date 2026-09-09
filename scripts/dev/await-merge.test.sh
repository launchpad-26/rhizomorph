#!/usr/bin/env bash
# await-merge.test.sh — await-merge.sh's exit codes still mean what its header says.
#
# Run it:  bash scripts/dev/await-merge.test.sh
#
# The contract IS the feature. This script exists so a stopped lane can branch on
# an exit status instead of waiting to be told, which makes a wrong code worse
# than a crash: 1 means "the PR was closed without merging", and the first draft
# returned 1 for five different argument mistakes. A lane polling a typo would
# have read its own work as rejected. One sibling (`*)` unknown argument) was
# handled and five were not.
#
# `gh` is stubbed, deliberately. Asserting against live PRs would make this test
# depend on the tracker's current state — the class of test that passes today and
# is meaningless next week — and it could not reach the CLOSED path at all
# without closing something. The stub is on PATH ahead of the real binary, so no
# network call happens and nothing is mutated.
set -uo pipefail

SCRIPT=$(cd "$(dirname "$0")" && pwd)/await-merge.sh
[ -f "$SCRIPT" ] || { echo "cannot find await-merge.sh beside this test" >&2; exit 2; }

PASS=0; FAIL=0
ok()  { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/await-merge-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# ── the gh stub ─────────────────────────────────────────────────────────────
# FAKE picks the response. Anything the script does NOT stub (git) runs for real
# against the throwaway repo below, so ancestry logic is exercised, not faked.
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Every call is counted when CALLS is set. Without a call count a --wait test
# cannot tell "the loop ran" from "the loop was deleted": the exit status of a
# watch that polls once and a watch that polls five times is identical.
if [ -n "${CALLS:-}" ]; then
  n=$(cat "$CALLS" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$CALLS"
else
  n=1
fi
case "${FAKE:-}" in
  merged)    echo '{"state":"MERGED","mergedAt":"2026-09-09T00:00:00Z","mergeCommit":{"oid":"'"${FAKE_SHA:-deadbeef}"'"},"baseRefName":"main"}' ;;
  mergedalt) echo '{"state":"MERGED","mergedAt":"2026-09-09T00:00:00Z","mergeCommit":{"oid":"'"${FAKE_SHA:-deadbeef}"'"},"baseRefName":"prd44"}' ;;
  closed)    echo '{"state":"CLOSED","mergedAt":null,"mergeCommit":null,"baseRefName":"main"}' ;;
  # MERGED with the merge commit not yet published. Not contrived: this is what
  # the API returns in the seconds after the merge, which is exactly when --wait
  # asks.
  mergednull) echo '{"state":"MERGED","mergedAt":"2026-09-09T00:00:00Z","mergeCommit":null,"baseRefName":"main"}' ;;
  open)      echo '{"state":"OPEN","mergedAt":null,"mergeCommit":null,"baseRefName":"main"}' ;;
  # 4 is gh's own exit status for an auth failure; the script keys on it to tell
  # "not logged in" (fatal) from "the network blinked" (retryable in --wait).
  unauth)    echo "gh: not authenticated" >&2; exit 4 ;;
  # a transport failure: gh's generic 1, the status a wedged resolver produces
  netdown)   echo "error connecting to api.github.com" >&2; exit 1 ;;
  # fails once, then answers. The blip a thirty-minute watch has to survive.
  blip)      if [ "$n" -eq 1 ]; then echo "error connecting to api.github.com" >&2; exit 1; fi
             echo '{"state":"MERGED","mergedAt":"2026-09-09T00:00:00Z","mergeCommit":{"oid":"'"${FAKE_SHA:-deadbeef}"'"},"baseRefName":"main"}' ;;
  garbage)   echo 'not json at all' ;;
  *)         echo "stub: unknown FAKE='${FAKE:-}'" >&2; exit 9 ;;
esac
STUB
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
command -v gh | grep -q "$TMP/bin" || { echo "stub not on PATH first" >&2; exit 2; }

# a throwaway repo so the real git runs against known history
git init -q -b main "$TMP/repo"
git -C "$TMP/repo" config user.email t@example.invalid
git -C "$TMP/repo" config user.name  "Test"
echo a > "$TMP/repo/f"; git -C "$TMP/repo" add f; git -C "$TMP/repo" commit -qm one
REAL_SHA=$(git -C "$TMP/repo" rev-parse HEAD)
git -C "$TMP/repo" update-ref refs/remotes/origin/main "$REAL_SHA"   # a local origin/main, no remote
echo b >> "$TMP/repo/f"; git -C "$TMP/repo" commit -qam two
OFF_SHA=$(git -C "$TMP/repo" rev-parse HEAD)                          # NOT an ancestor of origin/main

# run <label> <wanted-rc> <FAKE> [args...]
run() {
  label=$1; want=$2; fake=$3; shift 3
  rm -f "$TMP/calls"
  started=$(date +%s)
  out=$(cd "$TMP/repo" && FAKE="$fake" FAKE_SHA="${FAKE_SHA:-deadbeef}" \
        CALLS="$TMP/calls" FLIP_AT="${FLIP_AT:-2}" bash "$SCRIPT" "$@" 2>&1); got=$?
  ELAPSED=$(( $(date +%s) - started ))
  CALLS_MADE=$(cat "$TMP/calls" 2>/dev/null || echo 0)
  LAST_OUT=$out
  if [ "$got" = "$want" ]; then ok "$label (exit $got)"
  else bad "$label — wanted $want, got $got"; printf '%s\n' "$out" | sed 's/^/          /' >&2; fi
}
saw()    { printf '%s' "$LAST_OUT" | grep -q "$1" && ok "  └ says: $1" || { bad "  └ expected output '$1'"; printf '%s\n' "$LAST_OUT" | sed 's/^/          /' >&2; }; }
polled() { [ "$CALLS_MADE" -ge "$1" ] && ok "  └ polled gh $CALLS_MADE time(s), wanted >= $1" || bad "  └ polled gh $CALLS_MADE time(s), wanted >= $1"; }
polled_once(){ [ "$CALLS_MADE" -eq 1 ] && ok "  └ polled gh exactly once — not retried" || bad "  └ polled gh $CALLS_MADE time(s), wanted exactly 1"; }
took_under(){ [ "$ELAPSED" -lt "$1" ] && ok "  └ finished in ${ELAPSED}s, under ${1}s" || bad "  └ took ${ELAPSED}s, wanted under ${1}s"; }
saw_not(){ printf '%s' "$LAST_OUT" | grep -q "$1" && { bad "  └ must NOT say '$1'"; printf '%s\n' "$LAST_OUT" | sed 's/^/          /' >&2; } || ok "  └ correctly silent on: $1"; }

echo "── exit 3: every argument mistake, not just the one that was handled ───"
run "no arguments"                3 open
run "PR is not a number"          3 open notanumber
run "unknown argument"            3 open 377 --bogus
run "--timeout with no value"     3 open 377 --wait --timeout
run "--interval with no value"    3 open 377 --wait --interval
run "--timeout is not a number"   3 open 377 --wait --timeout abc
run "--timeout 5x (partial parse)" 3 open 377 --wait --timeout 5x
run "--interval is negative"      3 open 377 --wait --timeout 3 --interval -5
run "--interval is zero"          3 open 377 --wait --timeout 3 --interval 0

echo "── the 5x case specifically: it must not reach a deadline-less success ─"
# The original printed an arithmetic error, carried on with DEADLINE unset, and
# exited 0 on a merged PR — bounded-by-construction silently void.
FAKE_SHA=$REAL_SHA run "merged PR + --timeout 5x is still a usage error" 3 merged 378 --wait --timeout 5x
saw_not "MERGED"

echo "── exit 0/1/2: the documented states ──────────────────────────────────"
FAKE_SHA=$REAL_SHA run "merged, sha on origin/main" 0 merged 378
saw "MERGED as $REAL_SHA"
saw "is an ancestor of origin/main"

FAKE_SHA=$OFF_SHA run "merged, sha NOT on origin/main" 0 merged 378
saw "NOT an ancestor of origin/main"

FAKE_SHA=$REAL_SHA run "merged into a non-main base is flagged" 0 mergedalt 378
saw "base was 'prd44'"

run "closed without merging"      1 closed 379
run "still open, single-shot"     2 open   377
run "deadline reached in --wait"  2 open   377 --wait --timeout 0
saw "deadline reached"

echo "── a sha git has never seen is 'not present', not 'not an ancestor' ────"
FAKE_SHA=0000000000000000000000000000000000000000 run "unknown sha" 0 merged 378
saw "not present locally"
saw_not "NOT an ancestor"

echo "── MERGED before GitHub has published the merge commit ────────────────"
# The null-sha case used to borrow F9's sentence: "MERGED as -", then
# "- is not present locally — fetch before citing it" — an instruction that can
# never be satisfied, for a sha that does not exist. The merge is still a fact,
# so this stays 0; what must not survive is a fabricated sha or an impossible
# instruction.
run "merged, merge commit not reported yet" 0 mergednull 378
saw "has not reported its merge commit yet"
saw_not "MERGED as -"
saw_not "fetch before citing it"
saw_not "NOT an ancestor"

echo "── dependency and transport failures are 3, never 1 ───────────────────"
run "gh unauthenticated"          3 unauth  378
run "gh returns malformed json"   3 garbage 378

echo "── a transport blip is what --wait exists to outlive ──────────────────"
# One `error connecting to api.github.com` used to exit 3 after a single poll:
# a two-minute watch dead on a blip, reporting "usage or dependency error".
FAKE_SHA=$REAL_SHA run "one gh failure does not end a --wait" 0 blip 378 --wait --timeout 60 --interval 1
saw "MERGED as $REAL_SHA"
saw "retrying until the deadline"
polled 2

run "a transport failure single-shot is still 3" 3 netdown 378
polled_once

# Not retried, and not waited out: no amount of polling fixes a missing login.
run "auth failure is fatal even in --wait" 3 unauth 378 --wait --timeout 60 --interval 1
saw "not authenticated"
polled_once
took_under 10

# The honest half of the retry: exit 2 means "still open", which is a FACT about
# the PR. A run that never once read the PR has no such fact to report.
run "gh never answering is 3, not a false 'still open'" 3 netdown 378 --wait --timeout 1 --interval 1
saw "never answered"
saw_not "still open"
polled 2

echo "── it must never mutate ───────────────────────────────────────────────"
if grep -nE 'gh pr (merge|close|edit|comment|review)|git (push|commit|merge |checkout|reset|branch -)' "$SCRIPT" | grep -v '^[0-9]*:#' | grep -q .; then
  bad "script contains a mutating command outside a comment"
  grep -nE 'gh pr (merge|close|edit|comment|review)|git (push|commit|merge |checkout|reset|branch -)' "$SCRIPT" | grep -v '^[0-9]*:#' >&2
else
  ok "no mutating command outside comments"
fi

echo
printf 'await-merge.test.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
