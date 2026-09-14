#!/usr/bin/env bash
# gh-retry.test.sh — proves both directions of #508: the transient network
# fault is retried and recovers, and a genuine failure is NOT retried.
#
# Run it:  bash scripts/dev/gh-retry.test.sh
#
# A mock `gh` goes on PATH ahead of the real one and logs its own invocation
# count to a file this test reads back — call-count is the only honest way to
# state "retried" vs "not retried"; asserting on the final exit code alone
# cannot distinguish "failed once" from "failed, retried, failed again."
set -uo pipefail

root=$(git rev-parse --show-toplevel) || exit 2
SCRIPT="$root/scripts/dev/gh-retry.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export PATH="$tmp/bin:$PATH"
mkdir -p "$tmp/bin"

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2], got [$3]"; fi; }
has() { case "$3" in *"$2"*) ok "$1";; *) bad "$1" "expected to contain [$2], got: $3";; esac; }

# GH_LOG counts real `gh` invocations. GH_MODE selects the mock's behavior.
cat >"$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
echo "call" >>"$GH_LOG"
n=$(wc -l <"$GH_LOG")
case "$GH_MODE" in
  fail-then-ok)
    if [ "$n" -eq 1 ]; then
      echo "error connecting to api.github.com" >&2
      echo "check your internet connection or https://githubstatus.com" >&2
      exit 1
    fi
    echo '{"resources":{"core":{"remaining":5000}}}'
    exit 0 ;;
  fail-then-ok-debug)
    if [ "$n" -eq 1 ]; then
      echo 'dial tcp: lookup api.github.com on 10.0.0.1:53: no such host' >&2
      exit 1
    fi
    echo 'ok'
    exit 0 ;;
  fail-twice)
    echo "error connecting to api.github.com" >&2
    exit 1 ;;
  owner-fail-then-ok)
    if [ "$n" -eq 1 ]; then
      echo "unknown owner type" >&2
      exit 1
    fi
    echo '{"items":[]}'
    exit 0 ;;
  owner-fail-twice)
    echo "unknown owner type" >&2
    exit 1 ;;
  auth-fail)
    echo "HTTP 401: Bad credentials (https://api.github.com/rate_limit)" >&2
    exit 1 ;;
  real-rate-limit)
    echo "API rate limit exceeded for user ID 123." >&2
    exit 1 ;;
  not-found)
    echo "GraphQL: Could not resolve to an issue or pull request with the number of 99999. (repository.issue)" >&2
    exit 1 ;;
  empty-stderr-fail)
    exit 7 ;;
  ok-with-stderr-warning)
    echo "some incidental warning" >&2
    echo "payload"
    exit 0 ;;
  multi-trailing-newline)
    printf 'x\n\n\n'
    exit 0 ;;
  has-nul-byte)
    printf 'a\000b\n'
    exit 0 ;;
  out-then-err)
    printf 'OUT1\n'
    echo "ERR1" >&2
    exit 0 ;;
  fail-with-partial-stdout)
    printf 'partial-output\n'
    echo "HTTP 401: Bad credentials" >&2
    exit 1 ;;
esac
MOCK
chmod +x "$tmp/bin/gh"

fresh() { GH_LOG="$tmp/log.$1"; export GH_LOG; : >"$GH_LOG"; calls() { wc -l <"$GH_LOG"; }; }

echo "── gh-retry.sh: the transient fault ──"

# ── the flake: recovers on one immediate retry ──────────────────────────────
fresh flake; export GH_MODE=fail-then-ok
out=$(source "$SCRIPT"; gh_retry api rate_limit 2>"$tmp/err.flake"); rc=$?
is  "connection fault: sourced gh_retry recovers"       0 "$rc"
is  "connection fault: exactly two gh calls (one retry)" 2 "$(calls)"
has "connection fault: recovered payload reaches stdout" '"remaining":5000' "$out"
has "connection fault: the retry is announced on stderr" "retrying once" "$(cat "$tmp/err.flake")"

fresh flake-debug; export GH_MODE=fail-then-ok-debug
out=$(source "$SCRIPT"; gh_retry issue view 1 2>/dev/null); rc=$?
is  "GH_DEBUG-style 'dial tcp ... no such host' is recognized" 0 "$rc"
is  "GH_DEBUG-style fault: exactly two gh calls"            2 "$(calls)"
is  "GH_DEBUG-style fault: recovered output"                "ok" "$out"

# ── bounded: one retry, not a loop ──────────────────────────────────────────
fresh loop; export GH_MODE=fail-twice
out=$(source "$SCRIPT"; gh_retry api rate_limit 2>/dev/null); rc=$?
is  "a fault on both attempts still fails (bounded, not a loop)" 1 "$rc"
is  "a fault on both attempts costs exactly two gh calls"        2 "$(calls)"

# ── round-2 review: "unknown owner type" is the SAME fault, misreported ────
# `fetch_board`'s `gh project item-list --owner` needed its own network call
# to resolve the owner's type; when THAT call is what fails, `gh` reports
# this config-shaped message instead of a connection error. Measured
# (EXECUTED, live, this worktree): a genuinely nonexistent owner produces
# byte-identical plain stderr to this fault — "unknown owner type", nothing
# else — so no text-based check can tell them apart. Retried anyway, once,
# bounded: a real bad owner still fails on the second attempt below, and the
# SAME honest message still reaches the caller, just one call later.
fresh owner; export GH_MODE=owner-fail-then-ok
out=$(source "$SCRIPT"; gh_retry project item-list 19 --owner someone 2>"$tmp/err.owner"); rc=$?
is  "'unknown owner type' recovers on one immediate retry" 0 "$rc"
is  "...exactly two gh calls (one retry)"                   2 "$(calls)"
has "...recovered payload reaches stdout"                   '{"items":[]}' "$out"
has "...the retry is still announced"                        "retrying once" "$(cat "$tmp/err.owner")"

fresh owner_loop; export GH_MODE=owner-fail-twice
out=$(source "$SCRIPT"; gh_retry project item-list 19 --owner someone 2>"$tmp/err.owner-loop"); rc=$?
is  "a PERSISTENT 'unknown owner type' (a real bad owner) still fails" 1 "$rc"
is  "...bounded to exactly two gh calls, not a retry loop"              2 "$(calls)"
has "...the same honest message still reaches the caller, undisguised" "unknown owner type" "$(cat "$tmp/err.owner-loop")"

# ── the mutation: a genuine failure must NOT be retried ─────────────────────
echo ""
echo "── gh-retry.sh: genuine failures die on the first attempt ──"

fresh auth; export GH_MODE=auth-fail
out=$(source "$SCRIPT"; gh_retry api rate_limit 2>"$tmp/err.auth"); rc=$?
is  "an auth failure is not retried (one gh call)" 1 "$(calls)"
is  "an auth failure's exit status passes through" 1 "$rc"
has "an auth failure's message passes through"     "Bad credentials" "$(cat "$tmp/err.auth")"

fresh ratelimit; export GH_MODE=real-rate-limit
out=$(source "$SCRIPT"; gh_retry api rate_limit 2>"$tmp/err.rl"); rc=$?
is  "a real rate-limit message is not retried (one gh call)" 1 "$(calls)"
has "a real rate-limit message passes through" "rate limit exceeded" "$(cat "$tmp/err.rl")"

fresh notfound; export GH_MODE=not-found
gh_retry_test_out=$(source "$SCRIPT"; gh_retry issue view 99999 2>"$tmp/err.nf")
is  "a 404 is not retried (one gh call)" 1 "$(calls)"
has "a 404's message passes through" "Could not resolve" "$(cat "$tmp/err.nf")"

fresh emptystderr; export GH_MODE=empty-stderr-fail
gh_retry_test_out=$(source "$SCRIPT"; gh_retry api rate_limit 2>"$tmp/err.empty"); rc=$?
is  "a non-zero exit with empty stderr is not retried (one gh call)" 1 "$(calls)"
is  "its exit status still passes through"                            7 "$rc"

# ── the transparent path: success needs no special handling ────────────────
echo ""
echo "── gh-retry.sh: success passes through untouched ──"

fresh success; export GH_MODE=ok-with-stderr-warning
out=$(source "$SCRIPT"; gh_retry api rate_limit 2>"$tmp/err.ok"); rc=$?
is  "success: exit 0"                         0 "$rc"
is  "success: exactly one gh call"            1 "$(calls)"
is  "success: stdout passes through exactly"  "payload" "$out"
has "success: stderr still surfaces (not swallowed)" "incidental warning" "$(cat "$tmp/err.ok")"

# ── output fidelity: bytes out must equal bytes in ──────────────────────────
# Review of #508: `printf '%s' "$out"` replays what `$(...)` already
# stripped — ALL trailing newlines gone, embedded NULs silently dropped
# (bash variables cannot hold them), and a fixed "stderr always first"
# replay order that inverts a direct `gh` call's own ordering when a caller
# merges both streams. None of that is visible to a test that captures
# gh_retry's OWN output through `$(...)` too, since a command substitution
# strips the exact same trailing newlines being checked for — these checks
# redirect gh_retry's real output to a FILE and inspect its raw bytes
# instead, the only way any of this is actually observable.
echo ""
echo "── gh-retry.sh: output fidelity — bytes out must equal bytes in ──"

fresh newlines; export GH_MODE=multi-trailing-newline
"$SCRIPT" api rate_limit >"$tmp/raw.newlines" 2>/dev/null
is  "ALL trailing newlines survive, not just one" 4 "$(wc -c <"$tmp/raw.newlines")"

fresh nul; export GH_MODE=has-nul-byte
"$SCRIPT" api rate_limit >"$tmp/raw.nul" 2>/dev/null
is  "an embedded NUL byte survives, not dropped" 4 "$(wc -c <"$tmp/raw.nul")"

fresh order; export GH_MODE=out-then-err
out=$("$SCRIPT" api rate_limit 2>&1)
case "$out" in
  *OUT1*ERR1*) ok "stdout is replayed before stderr when a caller merges both" ;;
  *)           bad "stdout is replayed before stderr when a caller merges both" "got: $out" ;;
esac

fresh partial; export GH_MODE=fail-with-partial-stdout
out=$(source "$SCRIPT"; gh_retry api rate_limit 2>/dev/null); rc=$?
is  "a genuine failure still exits non-zero"                1 "$rc"
has "...and any partial stdout it wrote is still replayed" "partial-output" "$out"

# The ordering check above (`out-then-err`) exercises the SUCCESS replay pair
# at the top of gh_retry. The failure path has its own, separate pair at the
# bottom of the function, and it was unpinned: swapping just those two lines
# left all 51 checks green. Found in review of #508 by mutation.
fresh partial-order; export GH_MODE=fail-with-partial-stdout
out=$("$SCRIPT" api rate_limit 2>&1)
case "$out" in
  *partial-output*"Bad credentials"*) ok "...and stdout precedes stderr on the FAILURE replay too, not just the success one" ;;
  *)                                  bad "...and stdout precedes stderr on the FAILURE replay too, not just the success one" "got: $out" ;;
esac

unset GH_MODE

# ── no dangling RETURN trap across calls ────────────────────────────────────
# Regression: an earlier draft set `trap ... RETURN` inside gh_retry to clean
# up its temp file. `trap ... RETURN` is not scoped to the call that sets
# it — it fires on the NEXT function return anywhere in that shell, whatever
# function that turns out to be. That has two different outcomes depending
# on what returns next, and BOTH are tested below because review of #508
# found the wrong one described here first (see the precise wording note):
#
#   * gh_retry calls ITSELF again next: harmless. Each call re-arms the trap
#     against its OWN fresh, in-scope temp-file variable before it returns,
#     so it "self-heals" every time — two bare gh_retry calls in a row never
#     reproduce anything, however many times you repeat it.
#   * a DIFFERENT function returns next: not harmless. gh_retry's own return
#     re-armed the trap against ITS temp-file variable, which does not exist
#     in the OTHER function's scope — that function's own return then hits
#     "<file>: unbound variable" under `set -u`, thrown from a line that
#     never mentions the name.
#
# So the reproduction needs a CALLER — gh_retry called bare from within some
# other function, which then itself returns — not merely "gh_retry called
# bare" on its own. An earlier version of this comment said "reproduced with
# two nested calls", which reads as the first (harmless) shape and does NOT
# reproduce it; the case below is the second. Confirmed repeatedly on bash
# 5.3.9: 3/3 clean runs for two bare gh_retry calls, 3/3 reproductions for a
# caller function.
echo ""
echo "── gh-retry.sh: no dangling RETURN trap across calls ──"

fresh notrap_selfheals; export GH_MODE=ok-with-stderr-warning
source "$SCRIPT"
gh_retry api rate_limit >/dev/null 2>&1; rc1=$?
gh_retry api rate_limit >/dev/null 2>&1; rc2=$?
is "two bare gh_retry calls in a row self-heal (control — this must NOT fail)" "0 0" "$rc1 $rc2"

fresh notrap; export GH_MODE=ok-with-stderr-warning
caller_fn() {
  gh_retry api rate_limit >/dev/null 2>&1
  echo "caller_fn returned"
}
out=$(caller_fn 2>&1); rc=$?
is  "a DIFFERENT function returning after a bare gh_retry call does not leak" 0 "$rc"
has "...the caller's own return still completes normally"                    "caller_fn returned" "$out"
unset -f caller_fn gh_retry

# ── retries correctly even when the CALLER has `set -e` ─────────────────────
# Round-1 review finding: `scripts/dev/issues.sh` has `set -euo pipefail`, and
# `issues.sh priority 508 high` (three gh_retry calls: two read via `x="$(...)"`,
# one mutation called bare, `gh_retry ... >/dev/null`) failed 4 of 6 live runs
# with NO diagnostic at all — not even this file's own "retrying once" line.
# Root cause: a failing `gh` call inside gh_retry, called BARE (no command
# substitution around the gh_retry call itself) in a shell where `-e` is
# already on, aborted the whole calling PROCESS on the first `gh` failure,
# before the retry logic — or any of gh_retry's own diagnostics — ever ran.
# Every earlier test in this file calls gh_retry through `$(...)`, which by
# default runs gh_retry's body in a subshell with `-e` OFF regardless of the
# caller (no `shopt -s inherit_errexit`) — so none of them could have caught
# this. These spawn a REAL fresh bash process with `-e` on, calling gh_retry
# both ways, to match issues.sh's actual shapes.
echo ""
echo "── gh-retry.sh: retries correctly even when the caller has set -e ──"

fresh sete_bare; export GH_MODE=fail-then-ok
out=$(
  PATH="$PATH" GH_LOG="$GH_LOG" GH_MODE="$GH_MODE" bash -c "
    set -euo pipefail
    source '$SCRIPT'
    gh_retry api rate_limit >/tmp/gh-retry-sete-bare.out
    echo bare-call-survived
  " 2>&1
); rc=$?
is  "a BARE gh_retry call under set -e still retries and recovers" 0 "$rc"
is  "...exactly two gh calls (one retry)"                          2 "$(calls)"
has "...the retry is still announced"                              "retrying once" "$out"
has "...the caller's script continues past the call"               "bare-call-survived" "$out"
is  "...recovered payload reached its redirect target" '{"resources":{"core":{"remaining":5000}}}' "$(cat /tmp/gh-retry-sete-bare.out 2>/dev/null)"
rm -f /tmp/gh-retry-sete-bare.out

fresh sete_sub; export GH_MODE=fail-then-ok
out=$(
  PATH="$PATH" GH_LOG="$GH_LOG" GH_MODE="$GH_MODE" bash -c "
    set -euo pipefail
    source '$SCRIPT'
    x=\"\$(gh_retry api rate_limit)\"
    echo \"sub-call-survived: \$x\"
  " 2>&1
); rc=$?
is  "a SUBSTITUTED gh_retry call under set -e retries and recovers" 0 "$rc"
is  "...exactly two gh calls (one retry)"                           2 "$(calls)"
has "...the caller's script continues past the call"                "sub-call-survived" "$out"

fresh sete_bare_double; export GH_MODE=fail-twice
out=$(
  PATH="$PATH" GH_LOG="$GH_LOG" GH_MODE="$GH_MODE" bash -c "
    set -euo pipefail
    source '$SCRIPT'
    gh_retry api rate_limit >/dev/null || { echo \"DIED rc=\$?\"; exit 9; }
    echo unreachable
  " 2>&1
); rc=$?
is  "a genuine double failure, bare call under set -e, still exits non-zero" 9 "$rc"
is  "...bounded to exactly two gh calls, not a retry loop"                    2 "$(calls)"
has "...a diagnostic actually reaches the caller (not silent)"                "error connecting to api.github.com" "$out"
has "...the caller's own || branch still runs (die-equivalent reachable)"     "DIED rc=" "$out"

unset GH_MODE

# ── standalone CLI mode, not just sourced ───────────────────────────────────
echo ""
echo "── gh-retry.sh: works standalone, not only sourced ──"

fresh cli; export GH_MODE=fail-then-ok
out=$("$SCRIPT" api rate_limit 2>/dev/null); rc=$?
is  "standalone CLI mode recovers the same way" 0 "$rc"
is  "standalone CLI mode: exactly two gh calls" 2 "$(calls)"

unset GH_MODE

echo ""
echo "──"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
