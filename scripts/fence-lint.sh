#!/bin/bash
# fence-lint.sh <issue-number>... — check a wave's fences before dispatch.
#
# Three checks, learned from three real failures:
#   1. VAGUE   a fence that lets the worker decide its own boundary
#              ("touch the minimum shared surface", "otherwise create", "if needed")
#              -> the worker edits a shared file nobody fenced, and the landing
#                 gate rejects work that was actually correct.  HARD FAIL.
#   2. OVERLAP two issues claiming the same path -> rebase conflict at landing.  HARD FAIL.
#   3. GAP     a known coupling point (.swarm/coupling.txt) no fence owns, in a
#              subtree this wave is working in -> orphaned file, red root gate
#              for every stacked branch.  WARN (judgement: can any issue reach it?).
#
# All three depend on extraction reading a CLAIM, not a mention (#549). The
# input class, pinned so the next defect in this family adds a row instead of
# an alternation:
#   DECLARATION FORM   bulleted `- \`path\`` under "## Fence"        -> read
#                       prose aside inside the section                -> read
#                       bare fenced code block under the heading      -> read
#                       code block that doesn't parse as any path     -> hard fail, named
#                       inline "Fence: `a`" with NO heading at all    -> not read (0 real users in this repo's corpus)
#                       no heading OPENING with [Ff]ence              -> hard fail ("declares NO fence")
#                       a heading merely MENTIONING a fence               -> not a declaration, not read
#   TOKEN SHAPE        contains "/" or "." ANYWHERE, leading included --
#                       a/b.ts, AGENTS.md, docs/adr/, and dotfiles like
#                       .gitignore or .windows-known-failures (13 live claims
#                       across 12 issues)                             -> counted
#                       no "/" or "." once the trailing slash or /** is
#                       stripped (scripts/, packages/**, Makefile, 71,
#                       A_CONSTANT, --flag, a bare sha)               -> dropped.
#                       So a DOTFILE fences fine; a single-segment directory or
#                       an extensionless file does not.
#   LINE CONTEXT       inside the heading-delimited section           -> eligible
#                       a line matching the prohibition VOCABULARY    -> dropped
#                       any OTHER negation spelling inside it        -> NOT dropped, still a claim
#                       anywhere else in the body                     -> NOT eligible (no body-wide scan)
#   TRIGGER WORD       this script's own name, bulleted IN the section -> read (a real self-claim)
#                       this script's own name OUTSIDE the section     -> not read (#443)
set -uo pipefail
[ $# -eq 0 ] && { echo "usage: fence-lint.sh <issue-number>..."; exit 2; }
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root"
fail=0
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
: > "$tmp/fences"

echo "── fence lint: issues $* ──"
for n in "$@"; do
  body=""
  for _try in 1 2 3 4 5; do
    body=$(gh issue view "$n" --json body -q .body 2>/dev/null) && break
    body=""; sleep 8
  done
  [ -z "$body" ] && { echo "  !! issue $n unreadable (after retries)"; fail=1; continue; }
  # A fence is a bulleted (or prose-backticked) section under a "## Fence"
  # heading. The heading form parsed as EMPTY until 2026-07-31, so the lint
  # passed while checking nothing.
  #
  # There used to be a second source here: `grep -i fence` over the WHOLE
  # body, to catch a fence declared inline without a heading ("Fence: `a`,
  # `b`"). Measured over every issue this repo has (#549): across the full
  # corpus that second source never once supplied a real path a heading
  # section didn't already have — every contribution it ever made was a
  # backticked token on some unrelated line that happened to contain the word
  # "fence" (a Definition of done line naming this script, a Why paragraph
  # discussing someone else's fence, a bare identifier next to "off-fence").
  # That is the over-claim defect, not a feature: since this script's own
  # name contains the trigger word, any issue whose prose says
  # "`scripts/fence-lint.sh` still passes" claimed the linter's own source
  # (#443). Body-wide scanning is gone; only the heading-delimited section is
  # read.
  # The heading must DECLARE a fence, not merely mention one. `.*[Ff]ence`
  # matched any heading containing the word anywhere, so `## Why the fence is
  # in `log/`, and why that matters` opened a claim section and `### 1.
  # stripFencedCodeBlocks is inert` matched inside a SYMBOL NAME — four live
  # instances in this repo's corpus, plus the `## Off-fence notes` shape. That
  # is #443's over-claim defect again, narrowed from body-wide to heading-wide
  # rather than closed. The word must now open the heading text and end there
  # (a non-letter or end of line), which keeps every declaration form this repo
  # actually uses -- `## Fence`, `## Fence (may touch ONLY)`, `### Fence (...)`,
  # `## Fence widened at grooming, ...` -- and admits none of the mentions.
  # The boundary names the characters that CONTINUE the token, and rejects only
  # those. That set is closed — letters, digits, `_`, and `-` — because those are
  # what make `Fence-notes`, `Fence_notes`, `Fence2` and `Fences` a DIFFERENT
  # WORD rather than the word plus a qualifier. Everything else ends the word and
  # opens a declaration.
  #
  # It took four rounds to land on that, and the three failures are worth keeping
  # because they are the same mistake at different sizes. `[^A-Za-z]` let
  # `## Fence_notes` through; `[^A-Za-z0-9_]` still let `## Fence-notes` through;
  # and the round that tried to fix it by WHITELISTING separators
  # (`[[:space:]:]`) broke a live issue — `## Fence, provisional — placement is a
  # grooming decision` (#564) stopped being read at all, taking two real overlaps
  # against #558 with it.
  #
  # That inversion is the lesson. The separators a human might write are an OPEN
  # set — comma, semicolon, full stop, dash, a bracket, an em dash — so
  # enumerating them fails on the first one nobody thought of, and fails SILENTLY
  # by reading fewer paths. The continuers are a closed set that cannot grow --
  # OVER ASCII, which is the honest bound and the one this class actually tests.
  # A non-ASCII continuation still opens a declaration: a non-breaking hyphen
  # (U+2011), an en dash, a combining accent, an Arabic-Indic digit or a Cyrillic
  # letter after the word are all read as separators because the class is
  # bytewise. No live issue writes one, and the same permissiveness is what lets
  # `## Fence` followed by an em dash work, so this is a stated bound rather than
  # a defect to chase into a fifth round. Blacklist the closed side.
  #
  # A class rather than `\b`, which means backspace in some awks.
  section=$(echo "$body" | awk '/^#+ +[Ff]ence([^A-Za-z0-9_-]|$)/{f=1; next} /^#+ /{f=0} f')
  # PROHIBITION lines are not claims. A fence section that says "do NOT touch
  # `x/`" was read as CLAIMING x/ and reported a phantom overlap with the lane
  # that really owns it — three times (#166, #183-era, #192) before this
  # filter existed. Drop any line whose sense is exclusion before extracting
  # paths; the grooming rule is still "prohibitions belong under Blocked by",
  # but the linter no longer punishes prose that reads naturally.
  # The prohibition VOCABULARY, and it is deliberately a closed list rather than
  # an attempt at "any negation". A line here is dropped whole, so a pattern that
  # over-reaches costs real claims: #109's fence says "Touches at least `a` and/or
  # `b`. Not `restore.ts` — ..." on ONE line, so a bare `not \`X\`` rule would
  # discard two genuine claims to drop one prohibition. Measured over all 319
  # bodies before the three `deliberately`/`in this fence`/`does not touch`
  # spellings were added: they newly drop 6 lines across #104, #130, #132, #214,
  # #343 and #376, and every backticked token on those lines is itself a
  # prohibited path. Zero collateral. (#376's line carries no backticked token at
  # all, which is why a token-delta measurement first reported this as 5 — the
  # sentence was wrong when written, not stale.)
  #
  # What this does NOT cover is any other negation spelling, and that is a stated
  # limit rather than an oversight — AGENTS.md's rule is still that prohibitions
  # belong under `Blocked by`. The header table above says the same thing, and
  # `fence-lint.test.sh` pins this list so the two cannot drift apart silently.
  #
  # THE COST, stated for the spellings accepted and not only for the one
  # rejected. A matching line is dropped WHOLE, so a genuine claim sharing a
  # line with one of these three vanishes with no warning — turning a LOUD
  # phantom claim into a SILENT missing one, which is the worse direction for a
  # tool whose job is catching overlaps. Measured over the corpus: the three
  # spellings drop 6 lines (#104, #130, #132, #214, #343, #376) and every backticked
  # token on all six is itself a prohibited path, so nothing real is lost
  # today. It is not safe by construction, only safe by measurement — a fence
  # that writes "it does not touch `a`; it also changes `b`" WILL lose `b`.
  # `fence-lint.test.sh` pins that behaviour so it is visible rather than
  # discovered, and one path out if it ever bites is to hard-fail a mixed line
  # instead of dropping it.
  drop_re='do not touch|do NOT touch|must not enter|not enter|out of scope|owned by|owns|belongs to|leave .* to|EXPLICITLY OUT|do not reach|deliberately \*{0,2}not\*{0,2}|\*{0,2}not\*{0,2} in th(is|e) fence|does \*{0,2}not\*{0,2} touch'
  fence_text=$(printf '%s\n' "$section" | grep -viE "$drop_re" || true)
  [ -z "$(echo "$fence_text" | tr -d '[:space:]')" ] && { echo "  !! #$n declares NO fence"; fail=1; continue; }

  # 1. vague fences — the worker must never choose its own boundary
  vague=$(echo "$fence_text" | grep -oiE 'minimum shared surface|declare exactly what you touched|otherwise create|if needed|as needed|IF a stub|touch the minimum|use your judgement|where necessary' || true)
  if [ -n "$vague" ]; then
    echo "  !! #$n has a VAGUE fence — it delegates the boundary to the worker:"
    echo "$vague" | sed 's/^/       "/;s/$/"/'
    echo "       Name every path explicitly, including shared registries/test doubles."
    fail=1
  fi

  # A candidate token is counted as a path only if it is PATH-SHAPED: it must
  # carry a "/" or a "." somewhere in it. A bare count literal ("71") or a
  # bare identifier ("ALLOWLISTED_BROKEN_CITATIONS") has neither, and a fence
  # section quoting one in prose is not claiming it as a file (#460, #461).
  # This is a filter, applied identically to both extraction sources below.
  path_shaped() {
    grep -E '^[A-Za-z0-9_.@/-]+$' | grep -vE '^(may|touch|ONLY|and|plus)$' | grep -E '[./]'
  }

  # Source 1: backticked tokens anywhere in the section (bulleted list items,
  # and prose asides like "the fence widened to include `x.ts`").
  backtick_paths=$(printf '%s\n' "$fence_text" | grep -oE '`[^`]+`' | tr -d '`' \
    | sed 's/\*\*//g' | sed 's:/\*\*$::' | sed 's:/$::' | path_shaped || true)

  # Source 2: a fence declared as a bare fenced code block ("```\npath\n```")
  # instead of backticked bullets. #460 and #461 both wrote theirs this way;
  # the old extractor never looked inside a code block at all, so the real
  # claim was invisible and `overlaps: none` reported clean while both issues
  # claimed the same file. Read the lines strictly between the ``` markers as
  # literal path candidates (not backtick-wrapped) and put them through the
  # same path-shape filter.
  had_code_block=0
  case "$fence_text" in *'```'*) had_code_block=1 ;; esac
  code_paths=$(printf '%s\n' "$fence_text" | awk '
    /^```/ { c++; next }
    c % 2 == 1 { print }
  ' | sed 's/^[[:space:]]*-[[:space:]]*//; s/^[[:space:]]*//; s/[[:space:]]*$//; s:/$::' \
    | path_shaped || true)

  printf '%s\n%s\n' "$backtick_paths" "$code_paths" | grep -v '^$' | sort -u \
    | while read -r p; do [ -n "$p" ] && echo "$n|$p"; done >> "$tmp/fences"
  count=$(grep -c "^$n|" "$tmp/fences" 2>/dev/null || true)
  echo "  #$n: ${count:-0} fence path(s)"
  if [ "${count:-0}" = "0" ]; then
    if [ "$had_code_block" = "1" ]; then
      echo "  !! #$n: its fence is a code block whose lines don't read as paths — lint cannot read it"
    else
      echo "  !! #$n: no paths extracted from its fence — lint cannot vouch for it"
    fi
    fail=1
  fi
done

echo ""
echo "── overlaps ──"
found=0
while IFS='|' read -r a pa; do
  while IFS='|' read -r b pb; do
    [ "$a" = "$b" ] && continue
    [ "$a" \> "$b" ] && continue
    case "$pa" in "$pb"*) rel=1;; *) case "$pb" in "$pa"*) rel=1;; *) rel=0;; esac;; esac
    [ "$rel" = "1" ] && { echo "  OVERLAP  #$a ($pa)  vs  #$b ($pb)"; found=1; fail=1; }
  done < "$tmp/fences"
done < "$tmp/fences"
[ "$found" = "0" ] && echo "  none"

echo ""
echo "── coupling points ──"
if [ -f .swarm/coupling.txt ]; then
  while read -r line; do
    case "$line" in ''|\#*) continue;; esac
    path=$(echo "${line%%#*}" | xargs); why=${line#*#}
    [ -z "$path" ] && continue
    owned=0; reachable=0
    coupling_dir=$(dirname "$path")
    while IFS='|' read -r _ p; do
      case "$path" in "$p"*) owned=1;; esac
      # Reachable = a fence CONTAINS the coupling point's directory (a directory
      # fence that could add a file here), not merely a sibling in it. Sibling
      # files are independent; treating them as coupled produced warnings on
      # every wave and trained the reader to ignore the section.
      [ "$p" = "$coupling_dir" ] && reachable=1
      case "$coupling_dir" in "$p"/*) reachable=1;; esac
    done < "$tmp/fences"
    if [ "$owned" = "1" ]; then printf '  ok    %s\n' "$path"
    elif [ "$reachable" = "1" ]; then
      printf '  WARN  %s — unowned but this wave works in its subtree —%s\n' "$path" "$why"
      printf '        Give it an owner, or confirm no issue here can change it.\n'
    else printf '  info  %s (out of this wave'"'"'s subtrees)\n' "$path"
    fi
  done < .swarm/coupling.txt
else
  echo "  no .swarm/coupling.txt — create one:  'path  # why it couples'"
  echo "  e.g. packages/web/src/App.test.tsx  # mocks EVERY lazy panel; adding one forces an edit here"
  fail=1
fi

echo "──"
[ "$fail" = "0" ] && { echo "fence lint PASSED"; exit 0; } || { echo "fence lint FAILED — regroom before dispatch"; exit 1; }
