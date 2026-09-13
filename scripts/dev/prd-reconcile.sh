#!/usr/bin/env bash
#
# prd-reconcile.sh — does the PRD's Sequencing section still describe the
# tracker, and does the tracker still match the PRD?
#
# Adopted into this repo by #161 from the author's personal `prd-groom` skill
# install (~/.claude/skills/prd-groom/scripts/prd-reconcile.sh), where it lived
# unreviewable by anyone else. See #161 for the incident that made that a
# problem: #145 cited "prd-reconcile.sh 42 reports no drift" as an acceptance
# criterion that no reviewer and no CI job could check, because the script was
# not in the repository.
#
# CI: NOT wired in (deliberately — see #161's fence, which is this one file
# only; a CI workflow is an explicitly separate follow-up). Wiring this into CI
# would fail the build on reported PRD drift, which is a judgement call about
# amend-vs-tracker-edit that this script deliberately leaves to the operator
# (see "WHAT THIS IS NOT" below) — that call belongs in a follow-up issue that
# decides it on purpose, not as a side effect of landing the script.
#
# READS THE TRUNK, NOT THE WORKING TREE, BY DESIGN (see the note further down
# for why). One direct consequence for callers of this script: a clean run is
# not obtainable before a PR lands, even by the PR's own author, because the
# trunk this script reads does not yet contain the PR's changes. An acceptance
# criterion that cites this script must say "reports no drift AFTER this
# lands" — never "reports no drift" as a pre-merge bar. That was the mistake
# #145 made, and this line exists so it is not made again.
#
# Every other check in this toolchain runs in ONE direction: issue -> is it
# groomed? `fence-lint` reads issues you name as a wave. The board's orphan
# check sees board membership. `issue-write.sh` checks a body's own contract.
# Nothing reads the DOCUMENT against the TRACKER, so the reverse failures are
# invisible:
#
#   - a wave the PRD names that no issue claims        (vacant wave)
#   - a wave number the PRD assigns TWICE, to different issues, because an
#     amendment re-sequenced without marking the old paragraph superseded
#   - an issue whose wave the PRD never names          (filed, never sequenced)
#
# MEASURED, prd-42, 2026-08-26 — all three, in one document:
#
#   PRD names:    Wave 1..8
#   issues claim: w1 w2 w3 w4 w5 w6 w8        <- w7 vacant
#
#   :296  "Wave 6 — the law's escape hatch. #52"     <- #52 later superseded
#   :299  "Wave 7 — the tidy-ups, last. #53"         <- #53 later moved to w6
#
# A later amendment moved #53 to wave 6 and closed #52; the PRD is append-only
# by design, so that supersession is LAWFUL. But both paragraphs still read as
# current, and an agent grepping `Wave 7` finds #53 — which is wave 6.
#
# That ambiguity caused a real error the same day: an agent read the wave-7
# paragraph, saw the tracker say w6, and "corrected" the TRACKER to match the
# stale half of the document. The retro blamed its judgement. The cause was that
# the document held two live answers and nothing could tell them apart.
#
# WHAT THIS IS NOT. It does not rewrite the PRD, and it must not: the corpus is
# append-only precisely so that ruling citations keep resolving. It REPORTS, and
# the operator decides whether the answer is an amendment or a tracker edit.
#
# IT READS THE TRUNK, NOT THE WORKING TREE — and the first version of this
# script did not, which is how that rule earned its line here. Run against a
# checkout eight commits behind origin/main, it reported wave 7 vacant and said
# nothing about wave 6, because the amendment that re-sequenced them was on the
# trunk and not on disk. The trunk copy declares `**Wave 6` TWICE; the stale
# copy declares it once. A reconciler that reads a stale document reconciles
# the tracker against a plan nobody is following any more.
#
# This is `prd-groom`'s own scar in a new place. Its numbering station already
# says the count is taken "on the TRUNK, never the working tree", after a
# checkout one merge behind main answered "next = prd-38" while prd-38 already
# existed. Same cause, opposite end of the lifecycle.
#
# Usage:
#   prd-reconcile.sh <NN>            # e.g. 42
#   prd-reconcile.sh <NN> --quiet    # exit status only
#
# Exit: 0 reconciled · 1 drift found · 2 usage/precondition · 3 INCONCLUSIVE
#       (could not fetch; a clean result on a stale trunk is not a clean result)
set -uo pipefail

die() { echo "prd-reconcile: $1" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || die "gh not found on PATH"

NN="${1:-}"; [ -n "$NN" ] || die "usage: prd-reconcile.sh <NN> [--quiet]"
case "$NN" in *[!0-9]*) die "the PRD number must be digits: got '$NN'" ;; esac
QUIET=0; [ "${2:-}" = "--quiet" ] && QUIET=1
say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }

root=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
# 10# forces base 10. Bash's printf reads a leading-zero argument as OCTAL, so
# `08` and `09` — both legal, and both matching this repo's own zero-padded PRD
# filenames — died with "invalid octal number", left NNP as 00, and the script
# carried on to reconcile **prd-00 instead of prd-08**. Not a crash and not a
# refusal: a confident report about the wrong document.
NNP=$(printf '%02d' "$((10#$NN))")

# The plan of record lives on the trunk. See the note above: reading the working
# tree is how this script's first version missed a re-sequencing entirely.
# A FAILED FETCH IS NOT A CLEAN RUN. `|| true` here silently fell through to
# whatever origin/main happened to be on disk — so offline, unauthenticated, or
# with the remote down, this script would read a stale trunk and report "no
# drift" about a plan that had moved. That is the exact failure reading the
# trunk exists to prevent, reintroduced by the line meant to tolerate being
# offline.
#
# It still RUNS offline, deliberately — a stale answer is useful and the
# findings are still worth seeing. What it will not do is exit 0 and let that
# read as verified. `STALE_FETCH=1` makes the verdict inconclusive at the end
# (the tracker has its own `STALE_TRACKER` flag, set further down, for the same
# reason applied to a different system — see the banner at the bottom for why
# they are tracked, and reported, separately).
#
# Four checks below (fetch, ls-tree, show, issue list) used to discard stderr
# outright — the verdicts stayed honest, but a real failure (say, the network
# being down) and a benign one (no PRD filed yet) printed the same message, so
# the operator was pointed at the wrong hypothesis. `errfile` captures whatever
# the failing command actually said, and each `die`/verdict below prints it.
errfile=$(mktemp) || die "cannot create a temp file"
trap 'rm -f "$errfile"' EXIT

# Two independent reasons the verdict can go INCONCLUSIVE, tracked separately rather
# than as one flag: a failed trunk FETCH and a failed TRACKER read are different facts
# (round 5) — a stale git remote is not the same problem as `gh` not answering, they
# want different remedies, and either can happen without the other. `STALE=1` used to be
# one flag for both, so the banner at the bottom could only ever describe the first
# cause it was written for; see that banner for the incident this caused.
STALE_FETCH=0
STALE_TRACKER=0
FETCH_ERR=""
TRACKER_ERR=""
if ! git -C "$root" fetch -q origin 2>"$errfile"; then
  STALE_FETCH=1
  FETCH_ERR=$(cat "$errfile" 2>/dev/null)
fi
trunk=$(git -C "$root" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
[ -n "$trunk" ] || trunk=origin/main
git -C "$root" rev-parse -q --verify "$trunk" >/dev/null 2>&1 \
  || die "cannot resolve trunk ref '$trunk' — fetch, or check the remote"

docpath=$(git -C "$root" ls-tree -r --name-only "$trunk" \
            -- docs/prds 2>"$errfile" | grep -E "prd-$NNP-[^/]*\.md$" | head -1)
if [ -z "$docpath" ]; then
  lstree_err=$(cat "$errfile" 2>/dev/null)
  [ -n "$lstree_err" ] \
    && die "no PRD for prd-$NNP on $trunk under docs/prds/ (or done/) — git said: $lstree_err"
  die "no PRD for prd-$NNP on $trunk under docs/prds/ (or done/)"
fi

doc=$(mktemp) || die "cannot create a temp file"
trap 'rm -f "$doc" "$errfile"' EXIT
if ! git -C "$root" show "$trunk:$docpath" > "$doc" 2>"$errfile"; then
  show_err=$(cat "$errfile" 2>/dev/null)
  [ -n "$show_err" ] && die "cannot read $docpath from $trunk — git said: $show_err"
  die "cannot read $docpath from $trunk"
fi

say "── prd-$NNP — $docpath @ $trunk ──"

# Say so when the copy on disk is not the copy being judged. Not an error: a
# working tree mid-amendment is normal. But a reader comparing this output
# against the file in their editor needs to know they are different documents.
if [ -f "$root/$docpath" ] && ! cmp -s "$doc" "$root/$docpath"; then
  behind=$(git -C "$root" rev-list --count HEAD.."$trunk" 2>/dev/null || echo '?')
  say "  note: your working copy of this PRD differs from $trunk"
  say "        (HEAD is $behind commit(s) behind it). Judged against $trunk."
fi

drift=0

# 4. STALE STATUS — the PRD's own head names an issue as open, and the tracker disagrees.
#
# #448, prd43 w11. prd-30's header (docs/prds/prd-30-the-open-hand.md, before PR #431)
# named an issue as outstanding after that issue's own wave had merged and deleted the
# thing it was open about — a green suite throughout, because nothing read the header
# against the tracker at all. This is that check, and it is deliberately narrow.
#
# PLACEMENT, AND WHY IT IS HERE AND NOT BELOW. This check depends on nothing but $doc
# and the tracker — not $doc_waves, not $issue_rows. It used to sit after both were
# computed, downstream of the `[ -n "$doc_waves" ] || die "...is this PRD groomed?"`
# exit below. EXECUTED against the live corpus (#448 verify, round 1): that placement
# made the check UNREACHABLE on any PRD with no `**Wave N` paragraphs. It now runs
# first, so a PRD that fails the wave-groomed check still gets its header checked
# before that failure is reported.
#
# RULING 1, REVISED (round 6, operator ruling, superseding rounds 1-5's reading). A
# status claim lives ONLY inside a DEDICATED DECLARED FIELD — a bold label whose name
# marks outstanding work. The canonical, and currently only recognised, spelling is
# `**Open:**`:
#
#   > **Outcome:** all four waves shipped ...
#   > **Open:** #216, #235          <- only these are claims
#
# `**Status:**` and `**Outcome:**` are PROSE fields. Their contents are NEVER claims,
# whatever they contain — not "checked and found true," not "checked and found stale":
# not read at all. Rounds 1-5 treated ANY bold-labelled first paragraph as the checked
# field ("the label's name is not enforced, only that one is there at all"), which is a
# SWEEP OF THE STATUS PARAGRAPH, not the declared-field reading ruling 1 always
# described in its own worked example above. MEASURED (operator, round 6): swept all 53
# live PRDs against the live tracker under that reading — 17 STALE STATUS firings,
# roughly 12 false to 5 true. prd-39's head says the milestone "**closed** with issues
# #1, #2 and #27" IN THE SAME SENTENCE, and the old reading reported #1 as a stale open
# claim and told the operator to amend an append-only corpus over it. prd-20's own
# `#216` — the worked bite for five straight rounds — was never evidence the design
# worked; it was the drift itself, since `#216` lives in `**Outcome:**` prose, not any
# declared field. Approving that as the anchor is what let the sweep stand for five
# rounds; recorded here so the mechanism, not just the fix, survives.
#
# CONSEQUENCE, ACCEPTED AND DELIBERATE: no PRD in this corpus declares `**Open:**` today,
# so this check currently catches NOTHING on the real corpus — INCLUDING prd-20's `#216`,
# which is a genuine stale claim sitting in `**Outcome:**` prose, outside what this check
# reads. A law that is honestly inert beats one that is confidently wrong twelve times.
# prd-20 is the named worked example of this gap, not a silent one: it stays uncovered
# until prd-20 itself adopts a declared field, which is prd-20's call, not this check's.
#
# DO NOT BACKFILL. Opt-in means opt-in. This ruling does not reach into prd-20, prd-49,
# or any other live PRD to add `**Open:**` to it, and neither may a future edit of this
# script's tests or comments imply that it should. A programme adopts the field when it
# next touches its own document.
#
# THE INPUT CLASS THIS CHECK CLASSIFIES, one verdict per row — and this table is the
# classifier below, row for row: every row names the branch that implements it. A row
# not implemented by a branch you can point at is documentation, not a verdict.
#
#   head shape                                              | verdict
#   -----------------------------------------------------------+------------------------
#   no blockquote before the first `##` heading                | NOT CHECKED — no field
#   first head blockquote has no `**Open:**` line anywhere in it | NOT CHECKED — no field
#     (a `**Status:**`/`**Outcome:**` line, or any OTHER bold    |   (even though a bold
#     label, does not count — round 6)                          |   label is present)
#   a SECOND blockquote below the first, past a blank `>` line  | never read (own field only)
#   a bold-labeled block after the first `##` heading (body)    | never read (head only)
#   a blank line, or several, before the document's own H1      | the H1 is still skipped;
#     title (round 6, finding — NR>1 alone used to end the       |   only a SECOND heading,
#     scan on the title itself)                                 |   before any blockquote,
#                                                                 |   now ends it
#   `**Open:**` found: text from that line to the next bold-    | THE DECLARED FIELD — fed
#     labelled line (or the block's own end) is the field text   |   to CLASSIFY() below
#   --- everything below is ONE OCCURRENCE of `#N` INSIDE THE DECLARED FIELD, classified
#       on its own by CLASSIFY() — no occurrence's verdict depends on another's, except
#       the two carry-overs named where they apply ---
#   `#A` immediately dash-joined to `#B` (`-`, `–`, or `—`),      | RANGE — neither is a
#     with NO space on either side of the dash (round 6: a        |   claim. A chained
#     spaced dash is prose punctuation, not a range — see          |   `#A-#B-#C...` marks
#     FINDING (c) below); one or more `-#N` repetitions chain      |   every member RANGE,
#     from the first number                                       |   not just the pair
#   "PR" or "PRs" immediately to the left, WITH A WORD BOUNDARY    | PR-REFERENCE — not a
#     before it (round 6, finding (a): "ACPR #811" and "expr       |   claim
#     #216" no longer qualify — "PR"/"pr" must not itself sit      |
#     inside a longer word)                                        |
#   `and `/`& ` filler (comma alone no longer qualifies — round    | PR-REFERENCE
#     6, finding (d)) back to a PR-REFERENCE occurrence, nothing    |   (carry-over) —
#     else between                                                  |   "PRs #778 and #779"
#   `[` immediately to the left, `]` immediately to the right —  | ref-link SHAPE: consume an
#     a reference-style `[#N][label]` or an inline `[#N](url)`   |   optional trailing
#     (label = anything but `]`; a `(url)` is consumed by         |   `[label]` or `(url)`
#     BALANCED-PAREN counting, round 6 finding (e), so a URL       |   (balanced, not just to
#     containing its own `()` pair does not truncate early)        |   the first `)`), then
#                                                                 |   classify what follows:
#     · followed by optional space then `.` `;` `!` `?` `:` `)`  |   CLAIM
#       or the end of the field                                  |
#     · followed by `, `/`and `/`& ` then ANOTHER ref-link        |   same verdict as that
#       (a list: "[#225][a], [#226][b].")                        |   NEXT occurrence
#                                                                 |   (carry-over, resolved
#                                                                 |   right-to-left after the
#                                                                 |   walk — see BACKFILL)
#     · followed by anything else (a comma into prose, a bare     |   CITATION — not a claim
#       word, more text with no list and no ending punctuation)   |
#   none of the above                                           | CLAIM — the bare default
#   --- resolving a CLAIM against the tracker ---
#   `gh issue view` fails (network, auth, DNS)                  | UNRESOLVED —
#                                                                 |   STALE_TRACKER=1, not
#                                                                 |   asserted stale
#   resolves, `.url` contains `/pull/`                          | NOT AN ISSUE — a PR cited
#                                                                 |   bare; not evaluated
#   resolves, `.url` contains `/issues/`, `.state` is OPEN       | true — silent
#   resolves, `.url` contains `/issues/`, `.state` is not OPEN   | STALE STATUS, drift=1
#
# COVERAGE SIGNAL (round 4, finding 4; wording revised round 6). A PRD whose head was
# never read used to be silent in exactly the same way as one that was read and found
# true. Every run now states which, in one line — and round 6 narrows what "checked"
# may mean: `head field: NOT CHECKED` covers BOTH "no bold label at all" and "a bold
# label, but no `**Open:**`" (a PRD is never reported "checked — 0 claims" merely for
# carrying `**Status:**`/`**Outcome:**` prose; that would assert a verification that did
# not happen), or `head field: checked — N claim(s)` once `**Open:**` is actually found,
# with the resolved breakdown (open / stale / not-an-issue / unresolved) alongside it.
#
# WHY THIS IS AN ADDITIVE CLASSIFIER, NOT ANOTHER SUBTRACTIVE PASS (round 4, unchanged in
# shape by round 6 — the ruling change is WHAT TEXT reaches the classifier, not HOW the
# classifier reads it). CLASSIFY() walks the declared field ONCE, and for every
# occurrence of `#[0-9]+` it finds, looks at the immediate LEFT and RIGHT context — never
# a global pattern applied to the whole string — and assigns it EXACTLY ONE verdict:
# RANGE, PR-REFERENCE, CITATION, or CLAIM. No verdict depends on a DIFFERENT pass having
# already run over the whole string, so there is no pass-ordering left to get wrong. The
# two carry-overs (a PR-list's later members; a ref-link-list's earlier members; a
# chained range's later members) are the only place one occurrence's verdict depends on
# another's, and each is resolved by walking the already-classified occurrences once
# more — never by re-scanning the raw text.
#
# THE SMALLER FINDINGS (round 6, both seats, EXECUTED) — all inside the scope of "what
# CLASSIFY() does to text that HAS reached it via a declared field," so they still apply
# now that the field itself is narrower:
#
# (a) PR HAD NO LEFT WORD BOUNDARY. "ACPR #811" and "expr #216" both qualified as
#     PR-REFERENCE, because the old test only checked that the left context ENDED in
#     "PR"/"PRs", not that "PR" wasn't itself the tail of a longer word. Fixed by
#     requiring the character immediately before "P" to be either the start of the
#     field or a non-word character.
#
# (b) A CHAINED RANGE LEFT ITS TAIL AS A CLAIM. `#812-#813-#814` marked `#812` and
#     `#813` RANGE (the pair the old regex matched) and left `#814` unclassified by
#     the range rule entirely, falling through to a bare CLAIM. Fixed by matching one
#     OR MORE `-#N` repetitions in a single pass and marking every number the match
#     consumes RANGE, not just the first pair.
#
# (c) A PROSE EM-DASH BETWEEN TWO INDEPENDENT CLAIMS READ AS A RANGE. "#216 — #235
#     covers the rest" — an ordinary parenthetical em-dash, SPACED on both sides, per
#     this corpus's own typographic convention (a real range is written tight: prd-53's
#     `#433–#441` has no spaces at all) — matched the old range test and dropped both
#     numbers. Fixed by requiring the dash to be immediately adjacent on both sides,
#     with no space; a spaced dash no longer matches RANGE at all, so `#216` and `#235`
#     each fall through to their own independent classification.
#
# (d) A PR REFERENCE FOLLOWED BY A COMMA LEAKED PR-REFERENCE ONTO THE NEXT TOKEN. "landed
#     in PR #431, and #216 is still open." used to read `#216` as PR-REFERENCE too,
#     because the carry-over's filler set accepted a bare `,` and `, and`. Genuinely
#     open, unrelated claims routinely follow a PR mention with exactly this
#     punctuation, so a bare comma is not a safe list-continuation signal the way "and"/
#     "&" are — the corpus's own real plural, "PRs #778 and #779", never uses one at
#     all. Fixed by dropping `,` and `, and` from the filler set, keeping only `and`/`&`/
#     directly-adjacent. Known, accepted gap: a bare-comma list of three or more PR
#     numbers ("PRs #1, #2 and #3") is not supported — the middle member would read as
#     an independent bare CLAIM rather than PR-REFERENCE. No real PRD writes this shape;
#     extend the filler set with a real example in hand rather than reintroducing a
#     comma that this finding just proved unsafe.
#
# (e) AN INLINE LINK WITH BALANCED PARENTHESES IN ITS URL BECAME A FALSE CLAIM. CommonMark
#     permits balanced `()` inside an inline link's URL. The old consumer matched
#     `\([^)]*\)`, which stops at the FIRST `)` — so a URL like `(.../wiki_(disambiguation))`
#     was only "consumed" through the INNER closing paren, leaving the true outer `)`
#     as unconsumed trailing text, which the ending test then read as "ends in `)`" —
#     a claim, regardless of what the field actually said next. Fixed with a real
#     balanced-paren scan (`balanced_paren_len()`) that counts depth and stops only at
#     the MATCHING outer close, the same guarantee CommonMark itself makes.
#
# CORPUS-CITED EXAMPLES, CORRECTED (round 6): `(PR #462)` — cited in earlier rounds as
# prd-34's example of the PR exclusion — is real text, but it is in
# `docs/prds/parked/prd-37-the-shared-world.md`'s head, not prd-34's; prd-34's own head
# declares only the bare `#21` ("prd-43 issue #21 owns the repository/install identity
# correction"), which is its actual, correctly-attributed CLAIM-shaped example under the
# pre-round-6 reading (now moot for prd-34 itself, since neither PRD has adopted
# `**Open:**`). Neither document is edited by this fix or by this fence — reattributing a
# citation in this comment is not a claim about what prd-34 or prd-37 should say.
#
# Known, accepted gap, named rather than chased (round 3, unchanged since): this is a
# POSITIONAL test, and position cannot distinguish "a sentence that states an open claim
# and happens to end" from "a sentence that IS a citation and happens to end the same
# way" — "Drafted 2026-09-08 from the review of [#353][i353]." reads as a CLAIM, because
# it ends in a period like a real claim does. Recorded rather than chased with a further
# exclusion, per the standing instruction to stop enumerating shapes one at a time.
#
# Separately known, accepted gap: an occurrence's digits are read as `#[0-9]+` with no
# further boundary check, so an all-digit token that is not an issue number at all (a hex
# colour like `#000000`, say) would be classified CLAIM if it ever appeared in a declared
# field. `doc-citation-law.test.ts` hit exactly this shape once (`#674c63` matched as a
# citation). Not guarded here because no PRD head in this corpus contains one.
#
# RULING 2 — docs/prds/ stays in doc-citation-law.test.ts's EXCLUDED_DIRS, untouched. This
# check never reads that list: it has its own declared field, read straight off the PRD
# text, and talks to the tracker directly rather than through the citation law at all.
#
# RULING 3 — reporting only, never build-failing. Both suite mechanisms were tried and
# killed elsewhere in this corpus: a `gh`-backed suite check reddens on a tree nobody
# touched the moment somebody else closes an issue (doc-citation-law.test.ts's own
# "WHY NOT `gh`, MEASURED" block, above `recordedMaximum`), and a git-log-derived closure
# signal is unsound — #190 is OPEN with a landed commit on `main` whose subject names it,
# and `Closes #N` appears zero times across the last 20 merge commits. So this stays a
# `prd-reconcile.sh` check, exactly like the wave checks above it, reported for the
# operator to read rather than wired into anything that gates a merge. (Finding 2's
# `STALE_TRACKER=1` is not an exception to this: exit 3 INCONCLUSIVE is not a drift
# verdict, and nothing about it fails a build — it says "unread," which is the honest
# opposite of "clean.")
#
# THE CORPUS LAW (round 6, condition of merge). `prd-reconcile.test.sh` runs this same
# extraction and classifier over every REAL file under `docs/prds/**/*.md` in the live
# tree and asserts: any PRD whose head does NOT independently grep-match `**Open:**`
# yields zero claims. Written that way — conditioned on an INDEPENDENT presence check,
# not a hardcoded corpus-wide zero — so the day a programme legitimately adopts
# `**Open:**` this law does not go red for the right change; it would only go red if the
# classifier started finding claims in a PRD that still has no declared field, which is
# exactly the round-6 regression (a reversion to sweeping `**Status:**`/`**Outcome:**`
# prose) it exists to catch. No round before this one tested against a real PRD file, and
# that absence is how a twelve-false-positive reading survived five rounds.
head_field=$(awk '
  BEGIN { state = 0; title_seen = 0; found_open = 0 }
  {
    if (state == 2) next
    if (state == 0) {
      if ($0 ~ /^>/) { state = 1 }
      else if ($0 ~ /^#/) {
        # Skip exactly the document H1 TITLE, wherever it falls — a leading blank
        # line (or several) before it used to matter, because the old test was
        # "NR > 1", not "have we already skipped the title" (round 6, finding). A
        # blank line before the H1 pushed it past NR==1 and the scan ended on the
        # title itself, reporting no field at all. Scoped to a SINGLE `#` (`^# `)
        # so a real `## heading` — a genuine "no head block here" case — still ends
        # the scan even on a document with no H1 at all, rather than being mistaken
        # for the title (a regression this exact narrowing caught: a fixture with no
        # H1 and a `## Some section` before any blockquote silently kept scanning
        # past it when the test was merely "the first heading of any level").
        if (!title_seen && $0 ~ /^# /) { title_seen = 1; next }
        state = 2; next
      }
      else next
    }
    if (state == 1) {
      if ($0 !~ /^>/) { state = 2; next }
      line = $0
      sub(/^> ?/, "", line)
      if (line ~ /^[ \t]*$/) { state = 2; next }   # a blank quoted line ends this block
      if (found_open) {
        # Already inside the declared field: a DIFFERENT bold-labelled line starts a
        # new field and ends this field text; anything else is more of the Open value.
        if (line ~ /^\*\*[^*]*:\*\*/) { state = 2; next }
        buf = buf line " "
        next
      }
      # THE DECLARED FIELD, ROUND 6: only this exact marker opts a PRD in. Ruling 1
      # own worked example writes it as a line of its own within the head block, not
      # necessarily the block first line -- **Status:**/**Outcome:** may (and today
      # always do) come first. Case-sensitive, no internal-colon widening: the
      # canonical spelling is exactly **Open:**, and nothing about "the label name
      # marks outstanding work" extends to reading **Status:** or **Outcome:** the
      # same way, however their text is shaped.
      if (line ~ /^\*\*Open:\*\*/) { found_open = 1; buf = line " "; next }
      next   # prose before the marker (or a whole field that is never Open:): skip
    }
  }
  END { if (found_open) printf "%s", buf }
' "$doc")

if [ -z "$head_field" ]; then
  say "  head field: NOT CHECKED — no **Open:** field in the head blockquote"
else
  # THE ADDITIVE CLASSIFIER. One pass over the field; every `#[0-9]+` occurrence gets
  # exactly one verdict from its own immediate context, in this priority order per
  # occurrence — RANGE, then PR-REFERENCE (direct or carried over from a PR-list), then
  # ref-link shape (CLAIM or CITATION, with the list carry-over resolved below), then the
  # bare default, CLAIM. See the doc comment above head_field for what each verdict means
  # and which finding it answers.
  classified=$(printf '%s' "$head_field" | awk '
    # (a) round 6: a word boundary before "PR"/"PRs" — the start of the field, or a
    # non-word character — so "ACPR #811" and "expr #216" no longer qualify merely
    # because their tail spells "PR"/"pr".
    function is_pr_left(s) { return s ~ /(^|[^A-Za-z0-9_])[Pp][Rr][Ss]?[[:space:]]*$/ }
    # (d) round 6: a bare "," and ", and" are dropped from the filler set. A PR mention
    # followed by an ordinary comma routinely introduces an unrelated clause ("PR #431,
    # and #216 is still open."), and the corpus own real plural — "PRs #778 and #779" —
    # never uses a comma at all, only "and". Known, accepted gap: a bare-comma list of
    # three or more PR numbers is not supported; see the doc comment above head_field.
    function is_conjunction_only(s,    t) {
      t = s
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", t)
      return (t == "" || t == "and" || t == "&")
    }
    function ends_claim(s,    t) {
      t = s
      sub(/^[[:space:]]+/, "", t)
      return (t == "" || t ~ /^[.;!?:)]/)
    }
    function is_list_continuation(s,    t) {
      t = s
      sub(/^[[:space:]]+/, "", t)
      return (t ~ /^(,|and|&)[[:space:]]*\[#[0-9]/)
    }
    # (e) round 6: a real balanced-parenthesis scan for an inline links URL, replacing
    # a `\([^)]*\)` match that stopped at the FIRST `)` — which truncated early on a
    # CommonMark-legal URL containing its own `()` pair (".../wiki_(disambiguation)"),
    # leaving the true outer `)` as unconsumed text that the ending test then misread
    # as "ends in `)`" regardless of what the field actually said next.
    function balanced_paren_len(s,    depth, i, c, slen) {
      if (substr(s, 1, 1) != "(") return 0
      depth = 0
      slen = length(s)
      for (i = 1; i <= slen; i++) {
        c = substr(s, i, 1)
        if (c == "(") depth++
        else if (c == ")") { depth--; if (depth == 0) return i }
      }
      return 0   # never closes: not a well-formed balanced group
    }
    {
      text = $0
      n = length(text)
      pos = 1
      last_end = 0
      last_class = ""
      count = 0
      while (pos <= n) {
        rest = substr(text, pos)
        if (!match(rest, /#[0-9]+/)) break
        start = pos + RSTART - 1
        len = RLENGTH
        count++
        num[count] = substr(text, start + 1, len - 1)
        endpos = start + len - 1
        left = substr(text, 1, start - 1)
        right = substr(text, endpos + 1)
        pending[count] = 0
        class = ""

        # RANGE: (c) round 6 — the dash must be immediately adjacent on BOTH sides,
        # no space at all. This corpus own convention writes a real range tight
        # ("#433–#441") and a parenthetical em-dash spaced ("#216 — #235 covers the
        # rest"); the old test allowed optional space around the dash, so a spaced
        # em-dash between two INDEPENDENT claims silently dropped both. (b) round 6 —
        # one OR MORE "-#N" repetitions are consumed in a single match, so a chained
        # `#812-#813-#814` marks every member RANGE, not just the first pair (the old
        # test matched only one pair and left the tail to fall through as a bare
        # CLAIM). Every number the match consumes is enumerated and marked RANGE below.
        if (match(right, /^((-|–|—)#[0-9]+)+/)) {
          matchlen = RLENGTH
          chain = substr(right, 1, matchlen)
          class = "RANGE"
          new_end = endpos + matchlen
          pos = new_end + 1
          last_end = new_end
          last_class = class
          class_of[count] = class
          cpos = 1; clen = length(chain)
          while (cpos <= clen) {
            crest = substr(chain, cpos)
            if (!match(crest, /#[0-9]+/)) break
            cstart = cpos + RSTART - 1
            cln = RLENGTH
            count++
            num[count] = substr(chain, cstart + 1, cln - 1)
            class_of[count] = "RANGE"
            pending[count] = 0
            cpos = cstart + cln
          }
          continue
        }

        between = substr(text, last_end + 1, start - 1 - last_end)

        # PR-REFERENCE: "PR"/"PRs" immediately left with a word boundary, OR the
        # previous occurrence was itself PR-REFERENCE and only "and"/"&" filler lies
        # between — the plural-list context kind finding 1 asks for, not a second regex.
        if (is_pr_left(left) || (last_class == "PR" && is_conjunction_only(between))) {
          class = "PR"
          pos = endpos + 1
          last_end = endpos
          last_class = class
          class_of[count] = class
          continue
        }

        # REF-LINK SHAPE: an open bracket immediately left of the hash. Consume the
        # closing bracket and then EITHER a reference-style label bracket (anything
        # up to the next closing bracket, admitting a space — finding 6) OR a
        # BALANCED-PAREN inline URL (finding (e) above) — whichever is there, at most
        # one — then classify what follows THAT.
        if (left ~ /\[$/) {
          after = substr(text, endpos + 1)
          if (substr(after, 1, 1) == "]") {
            remainder = substr(after, 2)
            consumed = 1
            if (match(remainder, /^\[[^]]*\]/)) {
              consumed += RLENGTH
              remainder = substr(remainder, RLENGTH + 1)
            } else {
              plen = balanced_paren_len(remainder)
              if (plen > 0) {
                consumed += plen
                remainder = substr(remainder, plen + 1)
              }
            }
            new_end = endpos + consumed
            if (ends_claim(remainder)) {
              class = "CLAIM"
            } else if (is_list_continuation(remainder)) {
              # Deferred: this ref-link introduces a comma/and-joined chain of more
              # ref-links, and its own verdict is whatever the chain ends in — set
              # in the backfill pass below (finding 5, the ref-link-list case).
              class = "CITATION"
              pending[count] = 1
            } else {
              class = "CITATION"
            }
            pos = new_end + 1
            last_end = new_end
            last_class = class
            class_of[count] = class
            continue
          }
          # An open bracket before the hash with no matching closing bracket right
          # after the digits is not a ref-link this corpus writes. Falls through
          # to the bare default below.
        }

        # Bare token, no exclusion applies.
        class = "CLAIM"
        pos = endpos + 1
        last_end = endpos
        last_class = class
        class_of[count] = class
      }

      # BACKFILL: a pending ref-link inherits the verdict of the NEXT occurrence,
      # walked right-to-left so an arbitrarily long list resolves in one pass.
      for (i = count; i >= 1; i--) if (pending[i] && i < count) class_of[i] = class_of[i + 1]
      for (i = 1; i <= count; i++) printf "%s\t%s\n", class_of[i], num[i]
    }
  ')

  declared_nums=$(printf '%s\n' "$classified" | awk -F'\t' '$1 == "CLAIM" { print $2 }' | sort -nu)
  claim_count=0; open_count=0; stale_count=0; notissue_count=0; unresolved_count=0

  for n in $declared_nums; do
    claim_count=$((claim_count + 1))
    if ! issue_row=$(gh issue view "$n" --json state,closedAt,url \
                        -q '"\(.state)\t\(.closedAt // "")\t\(.url // "")"' 2>"$errfile"); then
      gh_err=$(cat "$errfile" 2>/dev/null)
      say "  STALE STATUS?    prd-$NNP head declares #$n; its tracker state could not be read"
      [ -n "$gh_err" ] && say "                    gh said: $gh_err"
      # An unread claim is not a clean claim (finding 2) — INCONCLUSIVE for the SAME
      # reason a failed trunk fetch is, but not the SAME cause (round 5): this is the
      # tracker, not the git remote, so it gets its own flag and its own error, and the
      # banner at the bottom names them separately rather than always describing fetch.
      STALE_TRACKER=1
      [ -n "$TRACKER_ERR" ] || TRACKER_ERR="$gh_err"
      unresolved_count=$((unresolved_count + 1))
      continue
    fi
    issue_state=$(printf '%s' "$issue_row" | cut -f1)
    issue_closed=$(printf '%s' "$issue_row" | cut -f2)
    issue_url=$(printf '%s' "$issue_row" | cut -f3)
    case "$issue_url" in
      */pull/*)
        # A bare-cited MERGED (or otherwise closed) PULL REQUEST is not an issue
        # claim at all — finding 1. State alone cannot tell a closed PR from a
        # closed issue; the url can, in every state.
        say "  NOT AN ISSUE     prd-$NNP head names #$n; the tracker resolves it to a pull"
        say "                    request, not an issue — not evaluated as a status claim."
        notissue_count=$((notissue_count + 1))
        continue
        ;;
    esac
    if [ "$issue_state" != OPEN ]; then
      closedday="${issue_closed%%T*}"
      [ -n "$closedday" ] || closedday="an unrecorded date"
      say "  STALE STATUS     prd-$NNP head declares #$n open; the tracker closed it $closedday"
      say "                    The header is stale. Amend it as the PRD is next touched — mark"
      say "                    the stale claim in place, never delete it; the corpus is"
      say "                    append-only."
      drift=1
      stale_count=$((stale_count + 1))
    else
      open_count=$((open_count + 1))
    fi
  done

  say "  head field: checked — $claim_count claim(s) declared ($open_count open, $stale_count stale, $notissue_count not-an-issue, $unresolved_count unresolved)"
fi

# Waves the DOCUMENT names, with the line each was declared on. A wave heading
# in this corpus is bold: `**Wave N — ...**`. Deliberately not matching prose
# mentions ("after wave 5"), which are references rather than declarations.
#
# A declaration MARKED SUPERSEDED does not count. Without this the report can
# never be cleared: the corpus is append-only, so the correct fix for a
# re-sequenced wave is a dated marker in place, not a deletion — and a check
# that stays red after the correct fix is a check people learn to ignore. A
# marker is a blockquote line beginning `> **SUPERSEDED` at column 0.
#
# The pop used to be POSITIONAL, not proximity-based: a stack where a
# `**Wave N` line pushes and a column-0 marker pops whichever declaration is
# on TOP, however far above it that declaration sits and whatever prose lies
# between. #175 made that a hard error instead of a silent pop, for two
# shapes prd-42's own convention (see its wave-10 amendment) names by hand:
#
# - **The marker's own quoted text reproduces a `**Wave N` declaration.**
#   The declaration pattern below is unanchored, so a line like
#   `> **SUPERSEDED** by **Wave 2 - replacement**` matches IT FIRST — and
#   that arm ends in `next`, so the marker arm is never reached at all. It
#   PUSHES a second declaration instead of popping the first. EXECUTED:
#   that exact line under `**Wave 1` used to leave both waves pending
#   (`1 1` and `2 2`); checking the marker pattern before the declaration
#   pattern, below, is what lets the marker arm see it.
# - **A marker sits below a declaration OTHER than the one still open.**
#   Concretely: some number of waves are declared and never marked (still
#   current), then a run of LATER waves are each declared and marked
#   immediately, and then a marker appears beside unrelated prose. That
#   marker pops whatever is on top of the stack — one of the never-marked
#   waves from earlier, not anything textually beside it. EXECUTED against
#   this corpus once already: it silently deleted wave 4 from the count.
#   The fix tracks, for the entry a marker is about to pop, the line of the
#   NEXT `**Wave N` declaration after it (fixed the moment that next wave is
#   pushed, regardless of stack order). A pop is legal only while the
#   marker's line is still before that boundary — i.e. no other wave has
#   been declared, and passed, since the one it is popping. A real,
#   correctly-placed marker (this corpus's own wave 5/6/7 markers, 3–6 lines
#   below their declarations) always satisfies this, because nothing else is
#   declared in between; the wave-4 shape violates it, because waves 5, 6
#   and 7 all got declared — and their boundary lines passed — first.
#
# A marker with NOTHING pending to pop (n==0) is left as a silent no-op, as
# before — that shape is not what either measurement above describes, and is
# not changed here.
doc_waves=$(awk '
  /^> \*\*SUPERSEDED/ {
    if ($0 ~ /\*\*Wave [0-9]+/) {
      printf "MALFORMED\tquoted-wave marker at line %d: a SUPERSEDED marker'"'"'s own text reproduces \"**Wave N\" — prd-42'"'"'s convention forbids quoting a wave declaration'"'"'s heading verbatim; name the wave by number and prose instead\n", NR
      err = 1
      exit 9
    }
    top = 0
    for (i = pushed; i >= 1; i--) { if (!popped[i]) { top = i; break } }
    if (top > 0 && top < pushed && NR >= decl_line[top + 1]) {
      printf "MALFORMED\tout-of-range marker at line %d: the nearest still-pending wave is %s (declared at line %d), but wave %s was already declared at line %d before this marker — a marker must sit below its own wave and before any later **Wave N heading\n", NR, wave[top], decl_line[top], wave[top + 1], decl_line[top + 1]
      err = 1
      exit 9
    }
    if (top > 0) { popped[top] = 1 }
    next
  }
  /\*\*Wave [0-9]+/ {
    match($0, /\*\*Wave [0-9]+/)
    pushed++
    wave[pushed] = substr($0, RSTART + 7, RLENGTH - 7)
    decl_line[pushed] = NR
    next
  }
  { }
  END {
    if (err) exit 9
    for (i = 1; i <= pushed; i++) if (!popped[i]) print wave[i] " " decl_line[i]
  }
' "$doc")
awk_rc=$?
[ "$awk_rc" -eq 9 ] && die "$doc_waves"
[ -n "$doc_waves" ] || die "no '**Wave N' declarations in $doc — is this PRD groomed?"

# Waves the TRACKER claims, from titles. Open AND closed: a closed issue still
# accounts for its wave, and ignoring it would report every shipped wave vacant.
if ! issue_rows=$(gh issue list --milestone "prd$NN" --state all --limit 200 \
               --json number,title,state \
               -q '.[] | "\(.number)\t\(.state)\t\(.title)"' 2>"$errfile"); then
  gh_err=$(cat "$errfile" 2>/dev/null)
  [ -n "$gh_err" ] && die "could not read milestone 'prd$NN' — does it exist? gh said: $gh_err"
  die "could not read milestone 'prd$NN' — does it exist?"
fi

# 1. A wave number declared more than once. This is the one that misleads a
#    reader rather than merely leaving a hole, so it is reported first.
dupes=$(printf '%s\n' "$doc_waves" | awk '{print $1}' | sort -n | uniq -d)
if [ -n "$dupes" ]; then
  for w in $dupes; do
    lines=$(printf '%s\n' "$doc_waves" | awk -v w="$w" '$1==w {printf " :%s", $2}')
    say "  DOUBLE-DECLARED  wave $w is declared at$lines"
    say "                   A later amendment supersedes an earlier one, which is lawful"
    say "                   here — but both paragraphs read as current. Mark the superseded"
    say "                   one in place; do not delete it (citations must keep resolving)."
    drift=1
  done
fi

# 2. A declared wave that no issue claims.
#
# Wave 0 is EXEMPT, and not as a convenience: this corpus reserves wave 0 for
# operator acts and says they get NO issue assigned to an agent ("booked, not
# skipped"). A vacant wave 0 is the rule being followed, so reporting it is a
# false positive — and one that fired on the first run of this check against
# prd-46, which books its wave 0 exactly as prd-45 does.
# THE VACANT AND UNDECLARED-WAVE CHECKS below — cited by name, not by line.
# This comment said ":267 and :287", which matched neither the pre-fix file
# (218, 238) nor this one (285, 305): a citation that outran what it
# established, in the commit whose subject is that nothing printed should.
# Line numbers in a file that keeps growing cannot stay earned. They used
# to feed
# `grep -q` through a `printf | ...` pipe. `grep -q` exits at the FIRST
# match, so a wave that IS present on a large enough tracker (or a distant
# enough doc_waves list) got its writer killed by SIGPIPE before it finished
# writing — and `pipefail` promoted that 141 into the pipeline's exit status,
# reporting a false VACANT / UNDECLARED WAVE for a wave that was right there.
# MEASURED, and it is a RACE rather than a threshold: at 200 rows (this
# script's own `--limit`) with 250-char titles the payload is ~52 KB against a
# 65,536 B pipe buffer, and four independent measurements of the same mutant
# came back 12/25, 16/20, 19/25 and 20/25 — schedule-sensitive, not 5/5. It
# saturates only well ABOVE the buffer size. A here-string tripped it 0/5 at
# every size tried — because
# a here-string is fed by the shell itself, not a forked writer process that
# can receive SIGPIPE. Both checks below are now a single `awk`, fed via
# here-string, with no pipe and so no writer to kill.
for w in $(printf '%s\n' "$doc_waves" | awk '{print $1}' | sort -nu); do
  [ "$w" = 0 ] && continue
  if ! awk -v w="$w" '$0 ~ ("\t.*[[:space:]]w" w ":") { found = 1 } END { exit !found }' <<< "$issue_rows"; then
    ln=$(printf '%s\n' "$doc_waves" | awk -v w="$w" '$1==w {print $2; exit}')
    say "  VACANT           wave $w is declared at :$ln, and no issue in prd$NN claims 'w$w:'"
    say "                   Either it was re-sequenced and the old paragraph still reads as"
    say "                   current, or its issues were never filed. Both are silent today."
    drift=1
  fi
done

# 3. An issue whose wave the document never declares — including no wave at all,
#    which is the shape that put three unsequenced issues into prd-42.
while IFS=$'\t' read -r num state title; do
  [ -n "${num:-}" ] || continue
  w=$(printf '%s' "$title" | sed -nE 's/.*[[:space:]]w([0-9]+):.*/\1/p')
  if [ -z "$w" ]; then
    say "  NO WAVE          #$num ($state) — '$title'"
    say "                   In a PRD milestone with no wave: fence-lint never sees it, and"
    say "                   the board's orphan check cannot tell. Sequence it or say in its"
    say "                   body that it is not dispatchable work."
    drift=1
  elif ! awk -v w="$w" '$1 == w { found = 1 } END { exit !found }' <<< "$doc_waves"; then
    say "  UNDECLARED WAVE  #$num ($state) claims w$w, which $docpath never declares"
    say "                   The tracker is ahead of the plan of record. Amend the PRD, or"
    say "                   move the issue — the DOCUMENT is the plan, so it rules."
    drift=1
  fi
done <<< "$issue_rows"

# A clean verdict on data we could not refresh is the one answer this script must
# never give: "no drift" is a claim about the CURRENT plan, and a stale trunk — or an
# unread tracker — is not it. So staleness outranks a clean reconciliation, and says why.
#
# THE BANNER NAMES ITS CAUSE, NOT JUST ITS EXISTENCE (round 5). `STALE_FETCH` and
# `STALE_TRACKER` are different facts about different systems (the git remote; the
# GitHub API), and round 4 made the second one reachable while this banner still only
# ever described the first — EXECUTED against round 4's own "unresolvable number"
# fixture: origin fetched fine, the trunk read was sound, and the banner nonetheless
# said "could not fetch origin" and told the operator to make the git remote reachable,
# when `gh` was the thing that had failed and `FETCH_ERR` was empty (so not even the
# "git said:" cue printed to hint at the mismatch). That is this PRD's own defect class,
# in the code that implements it: a factual sentence that had gone false. Three states
# now, because both causes can be true in the same run, and each gets its own accurate
# first line, remedy, and stderr.
if [ "$STALE_FETCH" = 1 ] || [ "$STALE_TRACKER" = 1 ]; then
  say
  if [ "$STALE_FETCH" = 1 ] && [ "$STALE_TRACKER" = 1 ]; then
    say "── INCONCLUSIVE: could not fetch origin, AND could not read the tracker for one or"
    say "   more declared claims — both the trunk read and the findings below may be"
    say "   incomplete. ──"
    say "   Findings (if any) still stand — they were derived from a real document."
    say "   What cannot be trusted is the ABSENCE of findings. Re-run with the git remote"
    say "   reachable AND the tracker (gh) answering before treating this as 'no drift'."
    [ -n "$FETCH_ERR" ] && say "   git said: $FETCH_ERR"
    [ -n "$TRACKER_ERR" ] && say "   gh said: $TRACKER_ERR"
  elif [ "$STALE_FETCH" = 1 ]; then
    say "── INCONCLUSIVE: could not fetch origin, so the trunk read above may be stale. ──"
    say "   Findings (if any) still stand — they were derived from a real document."
    say "   What cannot be trusted is the ABSENCE of findings. Re-run with the git remote"
    say "   reachable before treating this as 'no drift'."
    [ -n "$FETCH_ERR" ] && say "   git said: $FETCH_ERR"
  else
    say "── INCONCLUSIVE: the tracker could not be read for one or more declared claims,"
    say "   so their true state is unknown. ──"
    say "   Findings (if any) still stand — they were derived from a real document."
    say "   What cannot be trusted is the ABSENCE of findings. Re-run when the"
    say "   tracker (gh) is answering before treating this as 'no drift'."
    [ -n "$TRACKER_ERR" ] && say "   gh said: $TRACKER_ERR"
  fi
  [ "$drift" = 0 ] && exit 3
  exit "$drift"
fi

if [ "$drift" = 0 ]; then
  say "── reconciled: every declared wave has issues, every issue's wave is declared, no wave declared twice ──"
else
  say
  say "── drift found. The PRD is the plan of record; prefer amending it over editing a title. ──"
fi
exit "$drift"
