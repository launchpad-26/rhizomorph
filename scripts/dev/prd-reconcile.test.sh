#!/usr/bin/env bash
# prd-reconcile.test.sh — what #161 shipped 244 lines of shell with no test to
# cover, because that issue's fence forbade adding one. #175 is the fence that
# lifts that: all three defects it fixed (a distant SUPERSEDED marker retiring
# the wrong wave, a `printf | grep -q` pipeline that reports a false VACANT
# under `pipefail`, four verifications that discarded the reason they failed)
# were found by READING this script, not by running it. This is what running
# it looks like.
#
# Run it:  bash scripts/dev/prd-reconcile.test.sh
#
# Standalone rather than a vitest file for the same reason as issues.test.sh:
# the repo's vitest projects are `packages/*`, and this script is not in a
# package. Follows that file's mock-`gh`-on-PATH pattern, but prd-reconcile.sh
# also shells out to `git` — fetch, ls-tree, show, rev-list, symbolic-ref — far
# more surface than is sane to mock. So this harness builds a REAL, throwaway
# git remote+clone pair per run (bare "origin" + a working clone), commits
# each scenario's PRD text to it, and lets the script's own git calls run
# against that local pair. Nothing here touches the actual repository's
# history, network, or its real `docs/prds/`.
set -uo pipefail

root=$(git rev-parse --show-toplevel) || exit 2
SCRIPT="$root/scripts/dev/prd-reconcile.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
is()  { # is <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2], got [$3]"; fi
}
has() { # has <label> <needle> <haystack>
  case "$3" in *"$2"*) ok "$1";; *) bad "$1" "expected to contain [$2], got: $3";; esac
}
not_has() { # not_has <label> <needle> <haystack>
  case "$3" in *"$2"*) bad "$1" "expected NOT to contain [$2]";; *) ok "$1";; esac
}

# ── the mock `gh` ────────────────────────────────────────────────────────────
# The script's only `gh` call is `issue list`. MOCK_ISSUE_ROWS is the tsv this
# script's own `-q` filter would have produced (number\tstate\ttitle per
# line); MOCK_GH_FAIL=1 makes it fail loudly instead, stderr and all, for the
# stderr-capture cases.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  "issue list")
    if [ "${MOCK_GH_FAIL:-0}" = 1 ]; then
      echo "error connecting to api.github.com" >&2
      exit 1
    fi
    printf '%s\n' "${MOCK_ISSUE_ROWS:-}"
    exit 0
    ;;
esac
echo "prd-reconcile.test.sh mock gh: unhandled call: $*" >&2
exit 1
MOCK
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"

# ── the real (throwaway) git remote + clone ─────────────────────────────────
bare="$tmp/origin.git"
work="$tmp/work"
git init -q --bare "$bare"
git init -q -b main "$work"
git -C "$work" remote add origin "$bare"
mkdir -p "$work/docs/prds"
git -C "$work" -c user.email=t@t.test -c user.name=t commit -q --allow-empty -m init
git -C "$work" push -q origin main

# Commits <body> to docs/prds/prd-99-test.md on the throwaway trunk. NN=99
# so this suite can never collide with a real PRD in this repository — the
# script reads only from $work's own docs/prds/, never this repo's.
set_doc() {
  printf '%s\n' "$1" > "$work/docs/prds/prd-99-test.md"
  git -C "$work" add -A
  git -C "$work" -c user.email=t@t.test -c user.name=t commit -q -m case >/dev/null 2>&1 || true
  git -C "$work" push -q origin main
}

# Runs the script from inside the throwaway clone (its `git rev-parse
# --show-toplevel` must resolve to $work, not this repository). Sets OUT/RC.
run() {
  OUT=$(cd "$work" && bash "$SCRIPT" "$@" 2>&1); RC=$?
}

echo "── prd-reconcile.sh: a distant SUPERSEDED marker is a hard error ──"

# CONTROL — a marker directly below its own declaration, nothing else
# declared in between: pops correctly, same shape as this repo's own
# prd-42 wave 5/6/7 markers.
set_doc '**Wave 1 — retired.** placeholder text about wave 1.

> **SUPERSEDED** by Wave 2 below (grooming): wave 1 folded into wave 2.

**Wave 2 — replacement.** placeholder text about wave 2.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w2: replacement issue' run 99
is  "control: adjacent marker pops cleanly, exit 0"      0 "$RC"
has "control: reports reconciled"                        "reconciled" "$OUT"

# MALFORMED — the wave-4-vanishes shape: waves 1-4 declared and never
# marked, waves 5/6/7 each declared and marked immediately after (legal on
# their own), then a marker beside unrelated prose. Under the pre-#175
# stack-pop-whatever-is-on-top rule this silently retired wave 4 — the exact
# failure prd-42's own wave-10 amendment records. It must now be a hard
# error instead of a silent, wrong pop.
set_doc '**Wave 1 — first.** placeholder.

**Wave 2 — second.** placeholder.

**Wave 3 — third.** placeholder.

**Wave 4 — fourth.** placeholder text that stays pending, never marked directly.

**Wave 5 — fifth.** placeholder.

> **SUPERSEDED** by Wave 6 below (grooming): wave 5 folded into wave 6.

**Wave 6 — sixth.** placeholder.

> **SUPERSEDED** by Wave 7 below (grooming): wave 6 folded into wave 7.

**Wave 7 — seventh.** placeholder.

> **SUPERSEDED** by the wave-8 amendment (grooming): wave 7 folded into wave 8.

Waves 5, 6 and 7 are each a single issue, and that observation is itself now stale.

> **SUPERSEDED** by the wave-8 amendment (grooming): this residual paragraph is superseded too, and this marker is the bug — it pops wave 4, not the paragraph it sits beside.

**Wave 8 — eighth.** placeholder.'
MOCK_ISSUE_ROWS='' run 99
is  "distant marker: hard error, exit 2"                 2 "$RC"
has "distant marker: names the wave it wrongly targeted"  "is 4 (declared" "$OUT"
has "distant marker: names the wave that closed the range" "wave 5" "$OUT"
has "distant marker: says out-of-range"                   "out-of-range" "$OUT"

echo ""
echo "── prd-reconcile.sh: a marker cannot quote **Wave N in its own text ──"

# CONTROL — a marker that references the next wave in plain prose (no bold
# markup) pops correctly, same as this repo's real markers.
set_doc '**Wave 1 — control.** placeholder.

> **SUPERSEDED** by Wave 2 - replacement: no bold markup in the reference.

**Wave 2 — replacement.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w2: replacement issue' run 99
is  "control: plain-prose reference pops cleanly, exit 0" 0 "$RC"
has "control: reports reconciled"                         "reconciled" "$OUT"

# MALFORMED — the marker's own quoted text reproduces the two-asterisks-
# Wave-digit shape prd-42's convention forbids. The declaration pattern is
# unanchored, so pre-#175 this matched the PUSH arm first (it ends in
# `next`), so the marker never popped anything at all — it pushed a SECOND
# declaration instead.
set_doc '**Wave 1 — control.** placeholder.

> **SUPERSEDED** by **Wave 2 - replacement**: mistakenly quotes the heading.

**Wave 2 — replacement.** placeholder.'
MOCK_ISSUE_ROWS='' run 99
is  "quoted-wave marker: hard error, exit 2"    2 "$RC"
has "quoted-wave marker: names the shape"       "quoted-wave" "$OUT"

echo ""
echo "── prd-reconcile.sh: survives a large tracker read ──"

# :267/:287's `printf "$issue_rows" | grep -qE ...` used to race: `grep -q`
# exits at the FIRST match, so a large enough remaining payload got its
# writer killed by SIGPIPE, and `pipefail` promoted that into a false
# VACANT for a wave that WAS claimed. 200 rows x a ~250-char title is the
# size the issue measured against this script's own `--limit 200`; the row
# that matches is first, so if the old pipeline's early-exit race were still
# there, the other 199 padding rows are exactly what it would race against.
set_doc '**Wave 1 — control.** placeholder.'
# 400, not 240 — but read the NEXT assertion before trusting this one.
#
# At 240 the payload is 51,892 B against a 65,536 B pipe buffer, so whether the
# old `printf | grep -q` writer got SIGPIPE before `grep -q` exited was a
# scheduling race: byte-exact revert, 19 of 25 runs caught it and 6 reported a
# clean 19/19. 400 puts it at 83,892 B and lifts that to 18 of 20 — better, and
# STILL NOT DETERMINISTIC (EXECUTED, wave-11 verify; a reconcile pass measured
# 20/20 on its machine and it did not reproduce on another).
#
# Size cannot close this. Raising further hits a real ceiling: the rows reach
# the script through MOCK_ISSUE_ROWS in argv, and past ~130 KB MAX_ARG_STRLEN
# makes the FIXED script fail too, so the fixture would go red for a reason
# that has nothing to do with the defect. This end-to-end row proves the
# behaviour WHEN the race fires, and that is ALL it proves — there is no text
# assertion beside it. Four attempts at one were made and all four were wrong;
# see the note further down for what they were and why the idea was abandoned.
filler=$(printf 'x%.0s' $(seq 1 400))
rows=""
for i in $(seq 1 200); do
  rows+="$i"$'\t'"OPEN"$'\t'"prd99 w1: $filler"$'\n'
done
MOCK_ISSUE_ROWS="$rows" run 99
is    "padded 200-row tracker: exit 0, no false VACANT" 0 "$RC"
has   "padded 200-row tracker: reports reconciled"      "reconciled" "$OUT"
not_has "padded 200-row tracker: does not report wave 1 vacant" "VACANT" "$OUT"

# CODE lines only. The script's own comments DISCUSS this shape — they have to,
# it is what the fix is about — and a comment is not a pipeline. Grepping the
# whole file passes today only because those comments happen to split the
# tokens (`grep -q` through a `printf | ...` pipe); an author writing the shape
# naturally in prose would redden this law with a message pointing at a comment.
# Scope by what the line IS, not by what it happens to contain.
# NO SOURCE-TEXT LAW HERE, AND THAT IS THE FINDING RATHER THAN AN OMISSION.
#
# Four attempts, each defeated by a reviewer and not by its author:
#   1. grep for `| grep -q` over the whole file — scoped by CONTENT, so a
#      comment discussing the shape would have reddened it.
#   2. joined pipe-continued lines, matched any quiet flag — evaded by
#      `command grep -q`, `egrep -q` and a backslash-continued pipe.
#   3. same, widened — ALSO falsely convicted `| grep -c -- '-q'`, a quoted
#      string containing the shape, and a heredoc payload. Wrong both ways.
#   4. the positive form: count lines matching `awk … <<< "$issue_rows"`.
#      Satisfied for the WRONG REASON — replacing both real checks with
#      `printf | awk` pipelines and adding two comments carrying the literal
#      kept the count at 2 and the suite green. It also false-reddened on a
#      behaviour-preserving line wrap, and it counted file-wide while claiming
#      to pin two sites.
#
# The pattern is not bad luck. Proving a property of arbitrary SHELL SOURCE with
# a line-oriented text match needs a shell parser: every narrowing opens an
# evasion, every widening convicts real code, and every anchor that is not a
# real parse can be satisfied by a decoy. Four rounds is enough evidence.
#
# So behaviour is the only guard here, and the padded fixture ABOVE is it. What
# that costs is stated rather than hidden: it is SCHEDULE-SENSITIVE. Measured
# against a byte-exact revert of the VACANT pipeline —
#
#   fixture at 240 wide (51,892 B):  19/25 caught,  6/25 fully green
#   fixture at 400 wide (83,892 B):  18/20 and 19/20 on two separate runs,
#                                    i.e. 37/40 caught, 3/40 fully green
#
# Two runs are quoted rather than one because a single figure for a race reads
# as a threshold, which is the exact prose defect this commit corrects further
# up in prd-reconcile.sh.
#
# — so it is a strong detector, not a certain one, and the widening to 400 is
# kept because it is strictly better. The issue's own criterion asks for "a
# padded-output regression test", which this is; determinism was this reviewer's
# addition and it could not be had honestly.

echo ""
echo "── prd-reconcile.sh: the four suppressed verifications now say why ──"

# gh issue list failing used to say only "does it exist?" — true, but not
# what actually happened. It must now carry gh's own stderr.
set_doc '**Wave 1 — control.** placeholder.'
run_with_gh_fail() { OUT=$(cd "$work" && MOCK_GH_FAIL=1 bash "$SCRIPT" 99 2>&1); RC=$?; }
run_with_gh_fail
is  "gh failure: still exits 2"                 2 "$RC"
has "gh failure: still gives the old verdict"   "does it exist?" "$OUT"
has "gh failure: now also carries gh's stderr"  "error connecting to api.github.com" "$OUT"

# A fetch failure is not fatal (the script still runs offline, deliberately)
# but the INCONCLUSIVE verdict used to say nothing about WHY the fetch
# failed. Point origin at a path that is not a git repository at all.
git -C "$work" remote set-url origin /nonexistent/path/origin.git
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "fetch failure: still INCONCLUSIVE, exit 3"       3 "$RC"
has "fetch failure: still reports INCONCLUSIVE"       "INCONCLUSIVE" "$OUT"
has "fetch failure: now carries git's stderr"         "does not appear to be a git repository" "$OUT"
git -C "$work" remote set-url origin "$bare"

echo ""
echo "──"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
