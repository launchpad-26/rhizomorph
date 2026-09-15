#!/usr/bin/env bash
# scripts/dev/gh-retry.sh — retry ONE `gh` invocation, once, immediately, but
# only when it failed before ever reaching the network. See #508.
#
# The fault: on at least one contributor machine, a DNS proxy returns
# malformed response packets. glibc clients (curl, git, dig-on-retry) tolerate
# them; Go's resolver reports "no such host", so `gh` fails on roughly half
# its calls while every other tool on the box looks healthy.
#
# Two measurements decide this file's shape, both EXECUTED (issue #508,
# comment 2):
#
#   * the failure ALTERNATES. Thirty rapid calls gave
#     OOFOFOFOFOFOFOFOFOFOFOFOOFOFOF — every failure run has length 1. One
#     immediate retry, no backoff, recovered 16/16 observed failures.
#   * retrying the whole SCRIPT does not work: four board writes retried 8x
#     each with delays succeeded 0/32, while bare single calls in the same
#     minutes succeeded 60%. A compound of n calls succeeds at p^n; retrying
#     the compound never changes p. The retry has to wrap each `gh` call
#     individually, never the operation built out of several of them.
#
# What this must NOT do: retry a genuine failure. Auth, a 404, a real rate
# limit, a bad query — these die on the first attempt, exactly as calling
# `gh` directly would. The discriminator is stderr TEXT, not exit status:
# this fault returns in ~150ms, before any HTTP round trip, with a low-level
# connection failure ("error connecting to api.github.com", or — with
# GH_DEBUG=api — "dial tcp: ... no such host"). A real API error returns an
# HTTP status after a round trip and never produces that text.
#
# "unknown owner type" IS matched, on purpose, after round-2 review measured
# `issues.sh when` still failing 4/6 on exactly this text (`fetch_board`'s
# `gh project item-list --owner`, which nearly every write goes through via
# `ensure_board`). `gh` needs a network call of its own to learn whether an
# owner is a user or an org; when that call is what fails, `gh` reports this
# CONFIG-shaped message instead of a connection error. Verified (EXECUTED,
# this worktree, repeated): a real bad owner and this fault produce
# byte-IDENTICAL plain stderr — "unknown owner type", nothing else — across
# every trial; `GH_DEBUG=api` shows the difference underneath (the fault's
# own `dial tcp: ... no such host` vs. a genuine round trip returning
# "Could not resolve to a User/Organization ..."), timed at ~0.13-0.14s for
# the fault vs. ~0.59-0.74s for a real lookup — but that split is invisible
# to this wrapper without GH_DEBUG, and this design deliberately stays
# TEXT-based rather than timing-based (fragile under load, and inconsistent
# with everything else here). So text alone cannot tell the two apart, ever.
# Retried anyway, once, for the same reason "error connecting" already is
# despite being equally ambiguous IN PRINCIPLE (a truly dead network would
# also produce it): the cost of a wrong retry here is small and BOUNDED —
# one extra `gh` call, then the identical honest message reaches the caller
# exactly as it would have without the retry — while the cost of NOT
# retrying is the thing this issue measured directly: `fetch_board` sits
# under nearly every write, so leaving this one text unmatched left board
# operations "effectively unusable" (the issue's own words) even after every
# other call site was fixed.
#
# Deliberately still NOT matched: a rate-limit message with quota remaining.
# Unlike "unknown owner type", retrying a GENUINE rate limit is not cheap —
# it is guaranteed to fail again and spends real quota doing it, working
# against the caller rather than merely costing one wasted round trip.
# CONTRIBUTING.md documents it as the same underlying fault when it occurs,
# but a wrapper that cannot tell "quota exhausted" from "quota misreported"
# should not spend the caller's quota finding out; that one still needs the
# `curl` check a human runs.
#
# Two ways to use it:
#   1. Standalone, anywhere a `gh` call would go, including from another
#      language's subprocess call:
#        scripts/dev/gh-retry.sh api graphql -f query="..."
#   2. Sourced, for a bash script that wants it as a function rather than a
#      subprocess hop:
#        source "$(dirname "$0")/gh-retry.sh"
#        out="$(gh_retry issue view 508 --json body)" || die "..."
#
# No `set -uo pipefail` at this level — that used to run at SOURCE time,
# which turns `-u` and `pipefail` on in the SOURCING script permanently, not
# just in this file. issues.sh already sets both itself, so nothing broke in
# practice, but a future caller that sources this file without asking for
# either would inherit them anyway, silently, forever — the opposite of what
# "sourced, as a function" promises. gh_retry's own logic doesn't need either
# option to behave correctly. It's set instead inside the standalone-CLI
# guard below, where it affects only this file's own fresh process.

# Narrowed from an earlier draft that also matched `dial tcp[^"]*(i/o
# timeout|connection reset)` alongside `no such host` — speculative
# variants, never actually measured for this fault (the issue's own evidence
# is specifically a DNS resolution failure, which by definition happens
# BEFORE any TCP connection exists to time out or reset). Found in review of
# #508: a timeout or reset CAN land on the RESPONSE path, after a request
# was already delivered and processed server-side — the safety argument this
# whole file rests on ("failed before ever reaching the network") does not
# hold for either. Every mutation in issues.sh is idempotent except
# `cmd_close`'s `gh issue close --comment`, which posts a comment and then
# closes; a response-path failure retried there re-sends the whole mutation
# and can post the closing comment TWICE — not hypothetical, a retried `gh pr
# review` elsewhere left two identical reviews on PR #440 this same way.
# Matching only the two forms this fault is actually evidenced to produce
# removes the risk instead of documenting around it.
#
# This is a SUBSTRING search over the whole of stderr, not a precise
# identification of this one fault: a 404 whose message happens to contain
# "unknown owner type", or a permanently broken resolver producing its own
# "no such host" for an unrelated reason, both get retried too — bounded to
# one extra call and nothing is masked, but neither is actually this fault.
GH_RETRY_FAULT_PATTERN='dial tcp[^"]*no such host|error connecting to|unknown owner type'

gh_retry() {
  local err_file out_file status notice
  err_file="$(mktemp)" || { echo "gh_retry: mktemp failed" >&2; return 1; }
  out_file="$(mktemp)" || { echo "gh_retry: mktemp failed" >&2; rm -f "$err_file"; return 1; }
  # No `trap ... RETURN` here on purpose — it was tried and removed. Set from
  # inside this function, it is not scoped to this call: called as a plain
  # command (no subshell around the call, e.g. `gh_retry ... >/dev/null`
  # rather than `x="$(gh_retry ...)"`), the trap outlives this function's own
  # return and fires on the CALLER's next function return instead, by which
  # point `err_file` is out of scope — "err_file: unbound variable" under
  # `set -u`, thrown from a line that never mentions it. Reproduced directly,
  # repeatedly, on bash 5.3.9: `caller_fn` calls `gh_retry` bare and then
  # itself returns — gh_retry's OWN return re-arms the trap harmlessly (it
  # calls itself again with a fresh, in-scope variable each time), but a
  # DIFFERENT function's return afterward hits the stale reference. Two bare
  # `gh_retry` calls in a row do NOT reproduce it, because each call re-arms
  # the trap against its own fresh variable before the other one's turn comes
  # — the leak needs some OTHER function to be the one returning next.
  # gh-retry.test.sh's "no dangling RETURN trap" section tests both shapes:
  # the one that leaks and the one that self-heals. Cleaning up explicitly at
  # every return point below has no such lifetime surprise either way.

  # stdout goes to a FILE, never a shell variable, and is replayed with `cat`,
  # never `printf '%s' "$var"`. Review of #508 measured what the variable
  # form corrupts: `$(...)` strips ALL trailing newlines (not just one) and
  # silently drops embedded NULs (bash C-strings can't hold them), and
  # `printf '%s'` has no way to put either back — a bug this file's own test
  # suite could not see, because `is "success: stdout passes through
  # exactly" ... "$(gh_retry ...)"` captures the ASSERTION through `$(...)`
  # too, which strips the exact same trailing newlines being checked for.
  # Piping a multi-line `gh` output through this wrapper used to lose its
  # last line silently. A temp file has neither problem, and does not hold a
  # large board listing in a shell variable either.
  #
  # The failing `gh` call MUST still sit as the CONDITION of an `if`, not as
  # a bare statement followed by reading `$?` — two separate, both-real bugs,
  # and this is the only shape that survives both:
  #
  #   1. A bare `gh "$@" >"$out_file" 2>"$err_file"` is a plain top-level
  #      statement. When the CALLER has `set -e` active (issues.sh does) and
  #      calls gh_retry as a plain command rather than through
  #      `x="$(gh_retry ...)"` — exactly how issues.sh calls it for every
  #      mutation (`gh_retry ... >/dev/null`) — that inherited `-e` is still
  #      live inside gh_retry's own body, and a failing plain statement
  #      aborts the WHOLE CALLING PROCESS right there: no retry, no error
  #      text (stderr went to the temp file, not the terminal), not even
  #      this function's own diagnostic — silent rc=1. Reproduced directly:
  #      `gh_retry api rate_limit >/dev/null` under `set -euo pipefail`, a
  #      mock `gh` failing once then succeeding — the process exits 1 after
  #      exactly ONE `gh` call, no output at all. Wrapping the call as an
  #      `if` CONDITION sidesteps it: POSIX exempts `-e` for the compound
  #      list an `if`/`elif` tests, in every calling shape (bare,
  #      substituted, or piped), not just the substituted one.
  #   2. `if gh ...; then ... fi` with NO `else`, followed by reading `$?`
  #      after `fi`, is the other direction: when the condition is false and
  #      no `else` branch runs, POSIX defines the `if` compound's own exit
  #      status as 0 regardless of the condition's failure — so `$?` after
  #      `fi` is always 0 and every failure reads as success. Giving both
  #      branches of the SAME `if` an explicit `status=` avoids this one too.
  if gh "$@" >"$out_file" 2>"$err_file"; then
    status=0
  else
    status=$?
  fi
  if [ "$status" -eq 0 ]; then
    # stdout before stderr: a caller merging both (`gh_retry ... 2>&1`) sees
    # the primary output before any diagnostic. Measured backwards in an
    # earlier draft (stderr replayed first, unconditionally) and flagged in
    # review as an inversion relative to a direct, unwrapped `gh` call.
    cat "$out_file"
    cat "$err_file" >&2
    rm -f "$out_file" "$err_file"
    return 0
  fi

  if grep -qE "$GH_RETRY_FAULT_PATTERN" "$err_file"; then
    # Truncated: `"gh $*"` on an untruncated notice dumps an entire GraphQL
    # mutation — hundreds of characters — to stderr on every retry. The
    # notice only needs to say THAT a retry happened, not replay the call.
    notice="gh $*"
    if [ "${#notice}" -gt 80 ]; then notice="${notice:0:77}..."; fi
    echo "gh-retry: transient network fault on '$notice' — retrying once, immediately" >&2
    : >"$err_file"
    : >"$out_file"
    if gh "$@" >"$out_file" 2>"$err_file"; then
      status=0
    else
      status=$?
    fi
    if [ "$status" -eq 0 ]; then
      cat "$out_file"
      cat "$err_file" >&2
      rm -f "$out_file" "$err_file"
      return 0
    fi
  fi

  cat "$out_file"
  cat "$err_file" >&2
  rm -f "$out_file" "$err_file"
  return "$status"
}

# Only act as a CLI when executed directly, not when sourced. `set -uo
# pipefail` lives here, not at file scope — see the note above.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -uo pipefail
  gh_retry "$@"
  exit $?
fi
