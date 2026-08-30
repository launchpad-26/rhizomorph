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
# read as verified. STALE=1 makes the verdict inconclusive at the end.
STALE=0
if ! git -C "$root" fetch -q origin 2>/dev/null; then
  STALE=1
fi
trunk=$(git -C "$root" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
[ -n "$trunk" ] || trunk=origin/main
git -C "$root" rev-parse -q --verify "$trunk" >/dev/null 2>&1 \
  || die "cannot resolve trunk ref '$trunk' — fetch, or check the remote"

docpath=$(git -C "$root" ls-tree -r --name-only "$trunk" \
            -- docs/prds 2>/dev/null | grep -E "prd-$NNP-[^/]*\.md$" | head -1)
[ -n "$docpath" ] || die "no PRD for prd-$NNP on $trunk under docs/prds/ (or done/)"

doc=$(mktemp) || die "cannot create a temp file"
trap 'rm -f "$doc"' EXIT
git -C "$root" show "$trunk:$docpath" > "$doc" 2>/dev/null \
  || die "cannot read $docpath from $trunk"

say "── prd-$NNP — $docpath @ $trunk ──"

# Say so when the copy on disk is not the copy being judged. Not an error: a
# working tree mid-amendment is normal. But a reader comparing this output
# against the file in their editor needs to know they are different documents.
if [ -f "$root/$docpath" ] && ! cmp -s "$doc" "$root/$docpath"; then
  behind=$(git -C "$root" rev-list --count HEAD.."$trunk" 2>/dev/null || echo '?')
  say "  note: your working copy of this PRD differs from $trunk"
  say "        (HEAD is $behind commit(s) behind it). Judged against $trunk."
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
# The pop is POSITIONAL, not proximity-based, and this comment used to say
# "within the six lines following the declaration" — a proximity rule the awk
# below does not implement and never did. It keeps a stack: a `**Wave N`
# line pushes, a column-0 marker pops whichever declaration is on TOP, however
# far above it that declaration sits and whatever prose lies between. A marker
# beside superseded prose therefore retires an unrelated, still-current wave
# and says nothing.
#
# One precedence detail, because the sentence above is not the whole rule and a
# half-rule is what this comment was corrected FOR: the declaration arm is
# matched FIRST and ends in `next`, so a marker line that ITSELF contains
# `**Wave N` never reaches the marker arm at all — it PUSHES instead of popping.
# EXECUTED: `> **SUPERSEDED** by **Wave 2 - replacement**` under `**Wave 1`
# leaves both waves pending (`1 1` and `2 2`); the same marker without the
# quoted wave correctly pops (no output). That is precisely why prd-42's
# convention forbids `**Wave <digit>` inside quoted text, and the two documents
# now agree on the mechanism rather than only on the conclusion. That is a real failure this corpus hit (wave 4 vanished
# from the count), and prd-42's amendment in this same bundle documents the
# positional rule correctly — so the two now agree. Making a distant marker a
# hard error is a behaviour change, deliberately not made here: this file is a
# verbatim adoption, and the amendment's prose is the guard today.
doc_waves=$(awk '
  /\*\*Wave [0-9]+/ {
    line = NR
    match($0, /\*\*Wave [0-9]+/)
    w = substr($0, RSTART+7, RLENGTH-7)
    pending[++n] = w " " line
    next
  }
  /^> \*\*SUPERSEDED/ {
    if (n > 0) { delete pending[n]; n-- }
    next
  }
  { }
  END { for (i = 1; i <= n; i++) if (pending[i] != "") print pending[i] }
' "$doc")
[ -n "$doc_waves" ] || die "no '**Wave N' declarations in $doc — is this PRD groomed?"

# Waves the TRACKER claims, from titles. Open AND closed: a closed issue still
# accounts for its wave, and ignoring it would report every shipped wave vacant.
issue_rows=$(gh issue list --milestone "prd$NN" --state all --limit 200 \
               --json number,title,state \
               -q '.[] | "\(.number)\t\(.state)\t\(.title)"' 2>/dev/null) \
  || die "could not read milestone 'prd$NN' — does it exist?"

drift=0

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
for w in $(printf '%s\n' "$doc_waves" | awk '{print $1}' | sort -nu); do
  [ "$w" = 0 ] && continue
  if ! printf '%s\n' "$issue_rows" | grep -qE "	.*[[:space:]]w$w:"; then
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
  elif ! printf '%s\n' "$doc_waves" | awk '{print $1}' | grep -qx "$w"; then
    say "  UNDECLARED WAVE  #$num ($state) claims w$w, which $docpath never declares"
    say "                   The tracker is ahead of the plan of record. Amend the PRD, or"
    say "                   move the issue — the DOCUMENT is the plan, so it rules."
    drift=1
  fi
done <<< "$issue_rows"

# A clean verdict on data we could not refresh is the one answer this script must
# never give: "no drift" is a claim about the CURRENT plan, and a stale trunk is
# not it. So staleness outranks a clean reconciliation, and says why.
if [ "$STALE" = 1 ]; then
  say
  say "── INCONCLUSIVE: could not fetch origin, so the trunk read above may be stale. ──"
  say "   Findings (if any) still stand — they were derived from a real document."
  say "   What cannot be trusted is the ABSENCE of findings. Re-run with the remote"
  say "   reachable before treating this as 'no drift'."
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
