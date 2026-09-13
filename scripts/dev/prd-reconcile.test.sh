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
# The script's two `gh` calls are `issue list` (the wave checks) and `issue view <N>`
# (the STALE STATUS check, one call per declared number). MOCK_ISSUE_ROWS is the tsv
# `issue list`'s own `-q` filter would have produced (number\tstate\ttitle per line);
# MOCK_GH_FAIL=1 makes it fail loudly instead, stderr and all, for the stderr-capture
# cases. `MOCK_ISSUE_VIEW_<N>` is the state\tclosedAt tsv `issue view <N>`'s own `-q`
# filter would have produced for issue N; an N with no such variable set fails loudly
# (unhandled call) rather than silently returning nothing — a test that never sets one
# is asserting `issue view` is never called for that number at all, which is the point
# of the "marker outside the head" and "PR, not an issue" cases below.
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
  "issue view")
    var="MOCK_ISSUE_VIEW_$3"
    val="${!var:-}"
    if [ -z "$val" ]; then
      echo "prd-reconcile.test.sh mock gh: issue view $3 called with no $var set" >&2
      exit 1
    fi
    printf '%s\n' "$val"
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

# Same, forced to the POSIX/C locale — finding 3 (round 4): a bracket expression like
# `[-–—]` matches one BYTE, and an en-dash is three, so the range exclusion silently
# vanishes outside a UTF-8 locale. cron, sudo and a bare container commonly run C.
run_locale_c() {
  OUT=$(cd "$work" && LC_ALL=C bash "$SCRIPT" "$@" 2>&1); RC=$?
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
#
# Round 5: asserting only the substring "INCONCLUSIVE" is what let a wrong-cause
# banner ship in round 4 — that substring is present on EVERY inconclusive verdict
# regardless of which one fired. Assert the CAUSE-SPECIFIC sentence, and the negative
# control that makes it a real assertion: this banner must NOT carry the tracker's own
# wording, or the two causes are still indistinguishable one level up.
git -C "$work" remote set-url origin /nonexistent/path/origin.git
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "fetch failure: still INCONCLUSIVE, exit 3"       3 "$RC"
has "fetch failure: still reports INCONCLUSIVE"       "INCONCLUSIVE" "$OUT"
has "fetch failure: now carries git's stderr"         "does not appear to be a git repository" "$OUT"
has "fetch failure: names its actual cause"           "could not fetch origin" "$OUT"
has "fetch failure: tells the operator to check the git remote" "git remote" "$OUT"
not_has "fetch failure: does NOT blame the tracker"   "the tracker could not be read" "$OUT"
not_has "fetch failure: does NOT tell the operator to check gh" "tracker (gh) is answering" "$OUT"
git -C "$work" remote set-url origin "$bare"

echo ""
echo "── prd-reconcile.sh: round 6 — claims live ONLY in a declared **Open:** field ──"

# THE RULING CHANGE, PROVEN AGAINST THE OLD ANCHORS. Rounds 1-5 treated ANY bold-labelled
# first paragraph as the checked field, and prd-20's real shape (a bare #216 inside
# **Outcome:** prose) was the worked "bite" for five straight rounds. The operator's
# round-6 ruling: **Status:**/**Outcome:** are PROSE fields, never claims, whatever they
# contain — a claim lives ONLY inside a dedicated **Open:** field. So prd-20's real shape
# is DELETED as a positive test and REPLACED with its own negative: it must now be
# SILENT, and the coverage line must say NOT CHECKED, not "checked — 0 claims" (that
# would assert a verification that did not happen). Same for prd-49's real shape (a
# ref-link ending in a period, inside **Status:**). Both fixtures are kept, deliberately,
# as the two real-corpus proofs that the ruling actually changed behaviour, not just
# prose.
set_doc '> **Outcome:** ruling 7 is satisfied by the tree; the other is #216 — the wizard
> invoking the route prd-42 hardened. One issue is the whole of what is left.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "prd-20 shape (Outcome:, no Open:): now silent, exit 0 (was: fired, rounds 1-5)" 0 "$RC"
not_has "prd-20 shape: no STALE STATUS — Outcome: is prose, never a claim" "STALE STATUS" "$OUT"
has "prd-20 shape: NOT CHECKED, not \"checked — 0 claims\""    "head field: NOT CHECKED" "$OUT"

set_doc '> **Status:** holds one issue, moved out of prd47 at its closeout: [#190][i190].

**Wave 1 — control.** placeholder.

[i190]: https://example.invalid/190'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "prd-49 shape (Status:, no Open:): now silent, exit 0"    0 "$RC"
not_has "prd-49 shape: no STALE STATUS — Status: is prose, never a claim" "STALE STATUS" "$OUT"
has "prd-49 shape: NOT CHECKED, not \"checked — 0 claims\""    "head field: NOT CHECKED" "$OUT"

# THE OPERATOR'S OWN WORKED EXAMPLE, VERBATIM — prd-39's real shape, and the case that
# named the whole defect: the head says the milestone "**closed** with issues #1, #2 and
# #27" IN THE SAME SENTENCE that reports them, and the pre-round-6 reading fired on #1
# anyway and told the operator to amend an append-only corpus over it. There is no
# **Open:** field here at all — the numbers sit in **Outcome:** prose — so this must be
# silent regardless of what the sentence says.
set_doc '> **Outcome:** milestone `prd39` **closed** with issues #1, #2 and #27, all
> shipped.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "prd-39 shape (closed IN the sentence that cites them): silent, exit 0" 0 "$RC"
not_has "prd-39 shape: no STALE STATUS for numbers cited inside Outcome: prose" "STALE STATUS" "$OUT"

# THE BITE, MOVED — a fixture that HAS a declared field. Bare, unbracketed, no range, no
# ref-link, no PR prefix. Must fire, and now for the ruling-compliant reason: it is
# inside **Open:**, not merely inside SOME bold label.
set_doc '> **Outcome:** ruling 7 is satisfied by the tree.
> **Open:** #216 — the wizard invoking the route prd-42 hardened.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_216=$'CLOSED\t2026-09-08T04:30:10Z' \
  run 99
is  "the bite (Open:): reports drift, exit 1"                 1 "$RC"
has "the bite (Open:): reports STALE STATUS"                  "STALE STATUS" "$OUT"
has "the bite (Open:): names the number"                       "#216" "$OUT"
has "the bite (Open:): names the date the tracker closed it"   "2026-09-08" "$OUT"

# THE CONTROL, MOVED — a ref-link ending in a period, inside **Open:** this time. #190 is
# genuinely open, so this stays silent, and for the RIGHT reason: recognised, queried,
# verified true (MOCK_ISSUE_VIEW_190 is set; a wrongly-unrecognised claim would never
# call it and would also stay silent, which is exactly the bug round 1 shipped).
set_doc '> **Status:** holds one issue, moved out of prd47 at its closeout.
> **Open:** [#190][i190].

**Wave 1 — control.** placeholder.

[i190]: https://example.invalid/190'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_190=$'OPEN\t' \
  run 99
is  "the control (Open:): silent, exit 0"                     0 "$RC"
not_has "the control (Open:): no STALE STATUS — #190 is genuinely open" "STALE STATUS" "$OUT"
has "the control (Open:): reports reconciled"                 "reconciled" "$OUT"
has "the control (Open:): the field IS recognised as checked" "head field: checked" "$OUT"

# A REF-LINK BITE, ENDING IN A PERIOD.
set_doc '> **Open:** the one remaining issue is [#217][i217].

**Wave 1 — control.** placeholder.

[i217]: https://example.invalid/217'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_217=$'CLOSED\t2026-09-10T00:00:00Z' \
  run 99
is  "ref-link bite (period): reports drift, exit 1"          1 "$RC"
has "ref-link bite (period): a period-terminated ref-link IS a claim" "STALE STATUS" "$OUT"
has "ref-link bite (period): names the number"               "#217" "$OUT"

# A REF-LINK BITE, ENDING IN A SEMICOLON.
set_doc '> **Open:** the one remaining issue is [#219][i219]; nothing else is open.

**Wave 1 — control.** placeholder.

[i219]: https://example.invalid/219'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_219=$'CLOSED\t2026-09-11T00:00:00Z' \
  run 99
is  "ref-link bite (semicolon): reports drift, exit 1"       1 "$RC"
has "ref-link bite (semicolon): a semicolon-terminated ref-link IS a claim" "STALE STATUS" "$OUT"
has "ref-link bite (semicolon): names the number"            "#219" "$OUT"

# A REF-LINK BITE, ENDING THE FIELD.
set_doc '> **Open:** the one remaining issue is [#220][i220]

**Wave 1 — control.** placeholder.

[i220]: https://example.invalid/220'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_220=$'CLOSED\t2026-09-12T00:00:00Z' \
  run 99
is  "ref-link bite (end-of-field): reports drift, exit 1"    1 "$RC"
has "ref-link bite (end-of-field): an unterminated trailing ref-link IS a claim" "STALE STATUS" "$OUT"
has "ref-link bite (end-of-field): names the number"         "#220" "$OUT"

# A REF-LINK BITE, ENDING IN !, ?, :, or ).
set_doc '> **Open:** the one remaining issue is [#221][i221]!

**Wave 1 — control.** placeholder.

[i221]: https://example.invalid/221'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_221=$'CLOSED\t2026-09-13T00:00:00Z' \
  run 99
is  "ref-link bite (bang): reports drift, exit 1"             1 "$RC"
has "ref-link bite (bang): a bang-terminated ref-link IS a claim" "STALE STATUS" "$OUT"

set_doc '> **Open:** is the one remaining issue [#222][i222]?

**Wave 1 — control.** placeholder.

[i222]: https://example.invalid/222'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_222=$'CLOSED\t2026-09-13T00:00:00Z' \
  run 99
is  "ref-link bite (question): reports drift, exit 1"         1 "$RC"
has "ref-link bite (question): a question-terminated ref-link IS a claim" "STALE STATUS" "$OUT"

set_doc '> **Open:** the one remaining issue is [#223][i223]: confirmed.

**Wave 1 — control.** placeholder.

[i223]: https://example.invalid/223'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_223=$'CLOSED\t2026-09-13T00:00:00Z' \
  run 99
is  "ref-link bite (colon): reports drift, exit 1"            1 "$RC"
has "ref-link bite (colon): a colon-terminated ref-link IS a claim" "STALE STATUS" "$OUT"

set_doc '> **Open:** see the fix (already covered by [#224][i224])

**Wave 1 — control.** placeholder.

[i224]: https://example.invalid/224'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_224=$'CLOSED\t2026-09-13T00:00:00Z' \
  run 99
is  "ref-link bite (close-paren): reports drift, exit 1"      1 "$RC"
has "ref-link bite (close-paren): a paren-terminated ref-link IS a claim" "STALE STATUS" "$OUT"

# A CITATION REF-LINK, ", which" — prd-54's real shape, moved inside **Open:**.
set_doc '> **Open:** written out of the review of [#353][i353], which registered one
> coupling point.

**Wave 1 — control.** placeholder.

[i353]: https://example.invalid/353'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "citation ref-link (which): silent, exit 0"              0 "$RC"
not_has "citation ref-link (which): a \", which\" continuation is not a claim" "STALE STATUS" "$OUT"

# A CITATION REF-LINK, ", that" — a different, equally ordinary relative pronoun; the
# closed-set ending test has no opinion on the connective at all.
set_doc '> **Open:** written out of the review of [#353][i353], that registered one
> coupling point.

**Wave 1 — control.** placeholder.

[i353]: https://example.invalid/353'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "citation ref-link (that): silent, exit 0"                0 "$RC"
not_has "citation ref-link (that): a differently-worded continuation is still not a claim" "STALE STATUS" "$OUT"

# A CITATION REF-LINK, CONTINUING WITH NO PUNCTUATION AT ALL BEFORE THE NEXT WORD.
set_doc '> **Open:** drafted from the review of [#353][i353] and its findings on the
> registry.

**Wave 1 — control.** placeholder.

[i353]: https://example.invalid/353'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "citation ref-link (continues, no comma): silent, exit 0" 0 "$RC"
not_has "citation ref-link (continues, no comma): still not a claim" "STALE STATUS" "$OUT"

# THE NAMED, ACCEPTED GAP — a citation sentence that happens to end in a period, moved
# inside **Open:**. Still reads as a CLAIM: position alone cannot tell "a claim that
# ends" from "a citation that happens to end the same way". Recorded, not fixed.
set_doc '> **Open:** drafted 2026-09-08 from the review of [#353][i353].

**Wave 1 — control.** placeholder.

[i353]: https://example.invalid/353'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_353=$'CLOSED\t2026-09-08T21:14:00Z' \
  run 99
is  "named gap (citation ending in a period): fires, exit 1" 1 "$RC"
has "named gap: a citation that happens to end in a period reads as a claim (recorded, not fixed)" "STALE STATUS" "$OUT"

# NO MARKER AT ALL — no bold label anywhere in the head. NOT CHECKED.
set_doc '> Just prose here, no bold label, mentions #500 in passing — not a declared field.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "no marker: silent, exit 0"                              0 "$RC"
not_has "no marker: an unlabeled head is not swept"          "STALE STATUS" "$OUT"
has "no marker: NOT CHECKED"                                  "head field: NOT CHECKED" "$OUT"

# A BOLD LABEL, BUT NOT **Open:** — round 6's own distinction from "no marker at all":
# **Status:**/**Outcome:** ARE present, but neither is the declared field, so this must
# ALSO read as NOT CHECKED, never "checked — 0 claims" (ruling point 3).
set_doc '> **Status:** blessed, no open issues named here. Nothing about #216 either.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "labelled but not Open: silent, exit 0"                   0 "$RC"
not_has "labelled but not Open:: no STALE STATUS"             "STALE STATUS" "$OUT"
has "labelled but not Open:: NOT CHECKED, not \"checked\""     "head field: NOT CHECKED" "$OUT"

# MARKER OUTSIDE THE HEAD — no blockquote before the first `##` heading, and a
# **Open:**-labelled block appears later in the BODY. Must not count.
set_doc '**Wave 1 — control.** placeholder.

## Some section

> **Open:** #501 — a marker that is not in the head, and must not count.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "marker outside head: silent, exit 0"                    0 "$RC"
not_has "marker outside head: a body marker is not swept"    "STALE STATUS" "$OUT"

# A NUMBER NAMING A PR, NOT AN ISSUE — prd-37-the-shared-world.md's real shape:
# "(PR #462)" (round 6: corrected attribution — this text is in prd-37, NOT prd-34;
# prd-34's own head declares only the bare #21). Moved inside **Open:**.
set_doc '> **Open:** implementation shipped; release acceptance pending (PR #777) —
> no other numbers here.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "PR reference: silent, exit 0"                           0 "$RC"
not_has "PR reference: a PR-prefixed number is not a claim"  "STALE STATUS" "$OUT"

# PR HAS NO LEFT WORD BOUNDARY (round 6, both seats) — "ACPR #811" and "expr #216" used
# to qualify as PR-REFERENCE merely because their tail spells "PR"/"pr". Both must now
# be read as bare CLAIMS.
set_doc '> **Open:** landed via ACPR #811 in one sweep, and the expr #814 covers the rest.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_811=$'CLOSED\t2026-09-14T00:00:00Z' \
  MOCK_ISSUE_VIEW_814=$'CLOSED\t2026-09-14T00:00:00Z' \
  run 99
is  "PR word boundary: both numbers ARE claims, exit 1"       1 "$RC"
has "PR word boundary: ACPR #811 is a claim, not PR-excluded" "#811" "$OUT"
has "PR word boundary: expr #814 is a claim, not PR-excluded" "#814" "$OUT"

# A DEAD RANGE, TIGHT — prd-53's real shape: "#433–#441 ... died in the deletion", no
# spaces around the dash. Neither endpoint is queried.
set_doc '> **Open:** resurrects an old paper — issues #433–#441 died in the 2026-08-19
> deletion.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "dead range: silent, exit 0"                             0 "$RC"
not_has "dead range: a dash-joined range is not a claim"     "STALE STATUS" "$OUT"

# A CHAINED RANGE, THREE-WIDE (round 6) — `#812-#813-#814` used to leave the tail
# (#814) unclassified by the range rule, falling through to a bare CLAIM. All three
# numbers must now be excluded.
set_doc '> **Open:** the retired range #812-#813-#814 is fully closed and covers nothing
> live.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "chained range: silent, exit 0"                          0 "$RC"
not_has "chained range: no member of a 3-way chain is a claim" "STALE STATUS" "$OUT"

# A SPACED EM-DASH BETWEEN TWO INDEPENDENT CLAIMS (round 6) — "#216 — #235 covers the
# rest" is ordinary parenthetical punctuation (spaced on both sides), not a range (a
# real range is written tight, no spaces at all — see "dead range" above). Both numbers
# must now be read as INDEPENDENT bare claims, not dropped as a false range.
set_doc '> **Open:** #216 — #235 covers the rest of what remains open.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_216=$'CLOSED\t2026-09-08T04:30:10Z' \
  MOCK_ISSUE_VIEW_235=$'OPEN\t' \
  run 99
is  "spaced em-dash: drift, exit 1 (both read as claims, not a range)" 1 "$RC"
has "spaced em-dash: the first independent claim fires"       "#216" "$OUT"
spaced_claims=$(grep -c 'STALE STATUS \|STALE STATUS?' <<< "$OUT")

# A PR REFERENCE FOLLOWED BY A COMMA (round 6) — "PR #431, and #216 is still open."
# used to leak PR-REFERENCE onto #216 via the old comma-inclusive filler set. #216 is a
# genuinely separate, unrelated claim and must now fire on its own.
set_doc '> **Open:** landed in PR #431, and #216 is still open.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_216=$'CLOSED\t2026-09-08T04:30:10Z' \
  run 99
is  "PR then comma then unrelated claim: fires, exit 1"       1 "$RC"
has "PR then comma then unrelated claim: #216 is its own claim" "#216" "$OUT"

# "PRs #778 and #779" — the corpus's real plural shape, moved inside **Open:**. Neither
# number is queried.
set_doc '> **Open:** landed via PRs #778 and #779 in one sweep, no other numbers here.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "PRs plural: silent, exit 0"                              0 "$RC"
not_has "PRs plural: neither number is a claim"                "STALE STATUS" "$OUT"

# TWO DECLARED NUMBERS, ONE STALE — ruling 1's own worked example.
set_doc '> **Open:** #216, #235 — two outstanding issues.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_216=$'CLOSED\t2026-09-08T04:30:10Z' \
  MOCK_ISSUE_VIEW_235=$'OPEN\t' \
  run 99
is  "two numbers: drift, exit 1"                             1 "$RC"
has "two numbers: reports the closed one"                     "#216" "$OUT"
stale_lines=$(grep -c 'STALE STATUS ' <<< "$OUT")
is  "two numbers: exactly one STALE STATUS line, not two"     1 "$stale_lines"

# A SECOND BLOCKQUOTE, SEPARATED BY A BLANK QUOTED LINE — #428's in-flight shape. This
# time the **Open:** marker itself sits in the SECOND block, past the blank `>` line —
# the sharper version of this test under round 6's rule: an Open: field found ONLY past
# the boundary must still not count.
set_doc '> **Status:** blessed, no open issues named here.
>
> **Open:** #999 — should not count, this is a second block.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "second blockquote: silent, exit 0"                       0 "$RC"
not_has "second blockquote: an Open: field in the SECOND block is not read" "STALE STATUS" "$OUT"
has "second blockquote: NOT CHECKED (the first block has no Open:)" "head field: NOT CHECKED" "$OUT"

# A BLANK LINE BEFORE THE DOCUMENT'S OWN H1 TITLE (round 6) — used to push the title
# past NR==1, and the old "NR > 1" test then read the TITLE ITSELF as "a heading with no
# blockquote before it," ending the scan silently. The field must still be found.
printf '\n# prd-99 title\n\n> **Open:** the other is #605 — the whole of what is left.\n\n**Wave 1 — control.** placeholder.\n' > "$work/docs/prds/prd-99-test.md"
git -C "$work" add -A
git -C "$work" -c user.email=t@t.test -c user.name=t commit -q -m case >/dev/null 2>&1 || true
git -C "$work" push -q origin main
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_605=$'CLOSED\t2026-09-14T00:00:00Z' \
  run 99
is  "blank line before H1: the field is still found, exit 1"  1 "$RC"
has "blank line before H1: the Open: claim still fires"        "STALE STATUS" "$OUT"
has "blank line before H1: names the number"                   "#605" "$OUT"

# AN INLINE LINK WHOSE URL CONTAINS BALANCED PARENTHESES (round 6) — valid CommonMark. A
# naive "stop at the first `)`" consumer truncates early and misreads the URL's own
# inner closing paren as the field's ending punctuation. A real balanced-paren scan
# must consume the WHOLE URL, so the true continuation after it is what gets tested.
set_doc '> **Open:** the fix landed in [#229](https://example.invalid/wiki_(disambiguation)),
> see notes for context.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "balanced-paren inline link, continues: silent, exit 0"   0 "$RC"
not_has "balanced-paren inline link: not truncated into a false claim" "STALE STATUS" "$OUT"

# Same URL shape, this time truly ending the sentence — must fire.
set_doc '> **Open:** the fix landed in [#231](https://example.invalid/wiki_(disambiguation)).

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_231=$'CLOSED\t2026-09-14T00:00:00Z' \
  run 99
is  "balanced-paren inline link, ends: fires, exit 1"          1 "$RC"
has "balanced-paren inline link, ends: names the number"       "#231" "$OUT"

# `gh issue view` FAILS FOR A DECLARED NUMBER.
set_doc '> **Open:** the other is #602 — the whole of what is left.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "unresolvable number: now INCONCLUSIVE, exit 3 (was exit 0)" 3 "$RC"
has "unresolvable number: reports it could not be read"       "STALE STATUS?" "$OUT"
has "unresolvable number: carries gh's own stderr"             "no MOCK_ISSUE_VIEW_602 set" "$OUT"
has "unresolvable number: the run says INCONCLUSIVE, not clean" "INCONCLUSIVE" "$OUT"
has "unresolvable number: names its actual cause"             "the tracker could not be read" "$OUT"
has "unresolvable number: tells the operator to check gh"     "tracker (gh) is answering" "$OUT"
not_has "unresolvable number: does NOT blame the git remote"  "could not fetch origin" "$OUT"
not_has "unresolvable number: does NOT tell the operator to check the git remote" "git remote reachable" "$OUT"

# BOTH CAUSES IN ONE RUN — origin unreachable AND a declared claim unreadable.
set_doc '> **Open:** the other is #604 — the whole of what is left.

**Wave 1 — control.** placeholder.'
git -C "$work" remote set-url origin /nonexistent/path/origin.git
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "both causes: still INCONCLUSIVE, exit 3"                 3 "$RC"
has "both causes: names the fetch cause"                      "could not fetch origin" "$OUT"
has "both causes: names the tracker cause"                    "could not read the tracker" "$OUT"
has "both causes: carries git's stderr"                       "does not appear to be a git repository" "$OUT"
has "both causes: carries gh's stderr"                        "no MOCK_ISSUE_VIEW_604 set" "$OUT"
git -C "$work" remote set-url origin "$bare"

# THE REGRESSION ROUND 2 EXISTS TO CATCH — a declared field, and NO `**Wave N`
# declaration anywhere in the document.
set_doc '> **Open:** the other is #603 — the whole of what is left.

No wave declarations anywhere in this document.'
MOCK_ISSUE_VIEW_603=$'CLOSED\t2026-09-11T00:00:00Z' run 99
is  "no Wave N declared: still dies (unrelated to this check), exit 2" 2 "$RC"
has "no Wave N declared: STALE STATUS still ran"              "STALE STATUS" "$OUT"
has "no Wave N declared: names the number"                    "#603" "$OUT"
has "no Wave N declared: the wave-groomed die still fires"    "is this PRD groomed" "$OUT"
stale_line=$(grep -n 'STALE STATUS ' <<< "$OUT" | head -1 | cut -d: -f1)
die_line=$(grep -n 'is this PRD groomed' <<< "$OUT" | head -1 | cut -d: -f1)
if [ -n "$stale_line" ] && [ -n "$die_line" ] && [ "$stale_line" -lt "$die_line" ]; then
  ok "no Wave N declared: STALE STATUS ran BEFORE the wave-groomed die, not after"
else
  bad "no Wave N declared: STALE STATUS ran BEFORE the wave-groomed die, not after" \
      "stale_line=$stale_line die_line=$die_line"
fi

# LOCALE — the range exclusion under LC_ALL=C.
set_doc '> **Open:** resurrects an old paper — issues #433–#441 died in the 2026-08-19
> deletion.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run_locale_c 99
is  "locale C: dead range still excluded, exit 0"             0 "$RC"
not_has "locale C: no STALE STATUS under the C locale"        "STALE STATUS" "$OUT"

# A BARE-CITED MERGED PULL REQUEST — prd-51's real shape.
set_doc '> **Open:** the shared-record research lands via #254 in this tree.

**Wave 1 — control.** placeholder.'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_254=$'CLOSED\t2026-09-03T00:00:00Z\thttps://github.com/x/y/pull/254' \
  run 99
is  "merged-PR cited bare: not drift, exit 0"                 0 "$RC"
has "merged-PR cited bare: reports NOT AN ISSUE"               "NOT AN ISSUE" "$OUT"
not_has "merged-PR cited bare: never STALE STATUS for a PR"    "STALE STATUS" "$OUT"

# A comma-joined ref-link LIST.
set_doc '> **Open:** [#225][a], [#226][b].

**Wave 1 — control.** placeholder.

[a]: https://example.invalid/225
[b]: https://example.invalid/226'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_225=$'CLOSED\t2026-09-01T00:00:00Z' \
  MOCK_ISSUE_VIEW_226=$'CLOSED\t2026-09-02T00:00:00Z' \
  run 99
is  "ref-link list: both members drift, exit 1"               1 "$RC"
has "ref-link list: the first member fires too"                "#225" "$OUT"
has "ref-link list: the second member fires"                   "#226" "$OUT"
list_stale=$(grep -c 'STALE STATUS ' <<< "$OUT")
is  "ref-link list: two STALE STATUS lines, not one"           2 "$list_stale"

# A three-member list whose chain ends in a citation continuation.
set_doc '> **Open:** [#225][a], [#226][b], which is odd.

**Wave 1 — control.** placeholder.

[a]: https://example.invalid/225
[b]: https://example.invalid/226'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' run 99
is  "ref-link list into a citation: silent, exit 0"           0 "$RC"
not_has "ref-link list into a citation: neither member is a claim" "STALE STATUS" "$OUT"

# A reference label containing a space.
set_doc '> **Open:** the remaining issue is [#701][the review].

**Wave 1 — control.** placeholder.

[the review]: https://example.invalid/701'
MOCK_ISSUE_ROWS=$'1\tOPEN\tprd99 w1: control issue' \
  MOCK_ISSUE_VIEW_701=$'CLOSED\t2026-09-13T00:00:00Z' \
  run 99
is  "spaced label: reports drift, exit 1"                     1 "$RC"
has "spaced label: a label containing a space IS still a ref-link" "STALE STATUS" "$OUT"

echo ""
echo "── prd-reconcile.sh: THE CORPUS LAW — the real docs/prds/ heads, live tree (round 6, condition of merge) ──"

# Runs prd-reconcile.sh's OWN extraction and classifier awk programs — sourced directly
# from $SCRIPT at test time via extract_between(), never hand-duplicated here — against
# every REAL PRD file in this repository's live working tree. Because the programs are
# extracted from the script by matching its own literal marker lines rather than typed
# out a second time, this law cannot silently drift from the code it guards the way a
# hand-copied duplicate could.
#
# THE INVARIANT: any PRD whose head does NOT independently grep-match `**Open:**` must
# yield ZERO claims from the classifier. Written this way — conditioned on an
# INDEPENDENT presence check, never a hardcoded corpus-wide zero — so the day a
# programme legitimately adopts `**Open:**` this law does not go red for the right
# change; it goes red only if the classifier finds a claim in a PRD that still has no
# declared field, which is precisely the round-6 regression (a reversion to sweeping
# **Status:**/**Outcome:** prose) it exists to catch. No round before this one tested
# against a real PRD file, and that absence is how a twelve-false-positive reading
# survived five rounds.
extract_between() {  # extract_between <start-literal> <end-literal> <file>
  awk -v start="$1" -v end="$2" '
    index($0, start) == 1 { grab = 1; next }
    grab && index($0, end) > 0 { grab = 0; next }
    grab { print }
  ' "$3"
}
# End markers are each awk block's own closing bash syntax — `"$doc")` for the
# extractor, `')` for the classifier — matched as a SUBSTRING so neither needs the
# whole line reproduced. EXECUTED, the mistake this replaced: an end marker chosen as
# the START of the NEXT statement (e.g. "declared_nums=") stops grabbing too late and
# includes the awk blocks own closing bash line as if it were awk source, which failed
# to parse at all — silently producing an EMPTY classification for every real file and
# a corpus law that could not have found a regression if one existed.
extract_between "head_field=\$(awk '" '"$doc")' "$SCRIPT" > "$tmp/prod-extract.awk"
extract_between "  classified=\$(printf '%s' \"\$head_field\" | awk '" "')" "$SCRIPT" > "$tmp/prod-classify.awk"
[ -s "$tmp/prod-extract.awk" ]  && ok  "corpus law: extracted the field-extraction awk from the real script" \
                                  || bad "corpus law: extracted the field-extraction awk from the real script" "empty — the script's marker lines may have moved"
[ -s "$tmp/prod-classify.awk" ] && ok  "corpus law: extracted the classifier awk from the real script" \
                                  || bad "corpus law: extracted the classifier awk from the real script" "empty — the script's marker lines may have moved"

corpus_total=0
corpus_regressions=0
while IFS= read -r f; do
  corpus_total=$((corpus_total + 1))
  has_open=0
  grep -q '\*\*Open:\*\*' "$f" && has_open=1
  field=$(awk -f "$tmp/prod-extract.awk" "$f")
  if [ "$has_open" = 0 ] && [ -n "$field" ]; then
    corpus_regressions=$((corpus_regressions + 1))
    echo "  REGRESSION: $f — no **Open:** by independent grep, but the extractor found a field"
    continue
  fi
  if [ -n "$field" ]; then
    n=$(printf '%s' "$field" | awk -f "$tmp/prod-classify.awk" | awk -F'\t' '$1=="CLAIM"{c++} END{print c+0}')
    if [ "$has_open" = 0 ] && [ "$n" -gt 0 ]; then
      corpus_regressions=$((corpus_regressions + 1))
      echo "  REGRESSION: $f — no **Open:** by independent grep, but the classifier found $n claim(s)"
    fi
  fi
done < <(find "$root/docs/prds" -type f -name 'prd-*.md')

if [ "$corpus_total" -gt 0 ]; then ok "corpus law: swept $corpus_total real PRD file(s) under docs/prds/"
else bad "corpus law: swept $corpus_total real PRD file(s) under docs/prds/" "expected more than zero"
fi
is "corpus law: no PRD without an independently-grepped **Open:** field yields a claim" 0 "$corpus_regressions"

echo ""
echo "──"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
