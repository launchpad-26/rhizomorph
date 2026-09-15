#!/usr/bin/env bash
# fence-lint.test.sh — the wave lint reads a claim, not a mention (#549).
#
# Run it:  bash scripts/dev/fence-lint.test.sh
#
# `fence-lint.sh` scrapes a fence declaration out of an issue body. Measured on
# the live corpus (#549, grooming #460/#461/#443): it silently misread two
# shapes rather than failing on them —
#
#   * a fence written as a bare fenced code block extracted NOTHING from the
#     block itself, so the real claim was invisible and a genuine overlap
#     between two issues reported `overlaps: none`;
#   * any backticked token on any line containing the word "fence" — anywhere
#     in the body, not just the fence section — was read as a claim, so a
#     count literal quoted in prose (`71`) or the script's own name in a
#     Definition of done line became a phantom fence path.
#
# A check that reports clean while reading the wrong thing is worse than one
# that fails loudly, which is exactly the class this repo has hit before (the
# heading-form-parsed-as-EMPTY defect this script's own header already
# records). The assertions below are the negative ones named in #549's "what
# mutation would this test survive": a code-block fence must not silently
# yield prose tokens, and a bare count literal must not be counted as a path.
#
# The mock `gh` gives the lint a fenced issue body, the same technique
# `coupling.test.sh` uses for the lint's OTHER section — real fence text
# without touching the API or needing an issue groomed a particular way.
#
# LINT is overridable so a mutation proof can point this same suite at the
# pre-fix script (`git show HEAD:scripts/fence-lint.sh`) without touching the
# working tree — see AGENTS.md's pre-commit discipline for why the proof runs
# in-place rather than by reverting and restoring a file by hand.
set -uo pipefail

root=$(git rev-parse --show-toplevel) || exit 2
cd "$root"
: "${LINT:=scripts/fence-lint.sh}"

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
has() { case "$3" in *"$2"*) ok "$1";; *) bad "$1" "expected [$2] in: $3";; esac; }
lacks() { case "$3" in *"$2"*) bad "$1" "did not expect [$2] in: $3";; *) ok "$1";; esac; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
printf '%s' "$MOCK_FENCE"
MOCK
chmod +x "$tmp/bin/gh"
lint() { PATH="$tmp/bin:$PATH" MOCK_FENCE="$1" bash "$LINT" 900 2>&1; }

echo "── fence-lint.sh: a fence declaration, not a mention ──"

# The existing behaviour that IS correct: a bulleted, backticked fence is read
# and passes clean.
out=$(lint $'## Fence (may touch ONLY)\n\n- `packages/server/src/doc-citation-law.test.ts`\n')
has "the bulleted form is still read" \
    "1 fence path(s)" "$out"
has "a correctly-read bulleted fence passes" "fence lint PASSED" "$out"

# --- defect 1: a fence written as a bare fenced code block --------------------
#
# #460's actual pre-fix shape: a "## Fence" heading whose body is a code
# block, plus a count literal quoted in backticks three times elsewhere in the
# same issue (the way #460's Why section pinned `71`).
CODEBLOCK_FENCE=$'## Why\n\nThe pinned count `71` is re-derived, not retyped, at `71` other sites. See `71`.\n\n## Fence (may touch ONLY)\n\n```\npackages/server/src/doc-citation-law.test.ts\n```\n\n## Definition of done\n\n- Green.\n'
out=$(lint "$CODEBLOCK_FENCE")
has "a code-block fence is READ (the path inside it is extracted)" \
    "1 fence path(s)" "$out"
lacks "the code-block fence does not also yield the bare count literal" \
    "  #900: 2 fence path(s)" "$out"
has "a correctly-read code-block fence passes" "fence lint PASSED" "$out"

# A code block that genuinely cannot be read as paths must fail LOUDLY, not
# silently pass on zero (the defect this issue is filed against) and not
# silently fall back to scraping the prose around it.
out=$(lint $'## Fence (may touch ONLY)\n\n```\nthis reads as prose, not a path list\n```\n')
has "an unreadable code-block fence fails loudly, by name" \
    "code block whose lines don't read as paths" "$out"
has "an unreadable code-block fence hard-fails the lint" \
    "fence lint FAILED" "$out"

# --- defect 2: over-claim from any line mentioning "fence" ---------------------
#
# #443's actual shape: the fence itself is one bare path, but a Definition of
# done line elsewhere in the same issue names this very script — whose own
# filename contains the trigger word "fence". The old extractor read that line
# as a second claim on its own source.
SELF_POISON=$'## Fence (may touch ONLY)\n\n- `.swarm/coupling.txt`\n\n## Definition of done\n\n- `scripts/fence-lint.sh` still passes.\n'
out=$(lint "$SELF_POISON")
has "a Definition-of-done line naming this script is not a fence claim" \
    "1 fence path(s)" "$out"

# A bare count literal or bare identifier — no separator, no extension — is
# never counted as a path, even when it sits inside the fence section itself
# (#461's shape: a single ticked identifier as the whole declaration).
out=$(lint $'## Fence (may touch ONLY)\n\n- `ALLOWLISTED_BROKEN_CITATIONS`\n')
has "a bare identifier alone extracts to zero paths" \
    "0 fence path(s)" "$out"
has "zero paths from a bare identifier hard-fails, not a phantom pass" \
    "no paths extracted from its fence" "$out"

out=$(lint $'## Fence (may touch ONLY)\n\n- `71`\n')
has "a bare number alone extracts to zero paths" \
    "0 fence path(s)" "$out"

# The real #460/#461 case: two issues, each fencing the SAME file, one as a
# bulleted path and one as a code block. Both must be read, and the overlap
# the old extractor reported clean must now be caught.
tmp2=$(mktemp -d); mkdir -p "$tmp2/bin"
cat > "$tmp2/bin/gh" <<'MOCK'
#!/usr/bin/env bash
# args: issue view <n> --json body -q .body
n="$3"
if [ "$n" = "460" ]; then
  printf '## Fence (may touch ONLY)\n\n```\npackages/server/src/doc-citation-law.test.ts\n```\n'
else
  printf '## Fence (may touch ONLY)\n\n- `packages/server/src/doc-citation-law.test.ts`\n'
fi
MOCK
chmod +x "$tmp2/bin/gh"
out=$(PATH="$tmp2/bin:$PATH" bash "$LINT" 460 461 2>&1)
rm -rf "$tmp2"
has "the #460/#461 overlap the old extractor missed is now caught" \
    "OVERLAP  #460" "$out"
has "the wave still hard-fails on that overlap" "fence lint FAILED" "$out"

# --- the existing behaviour that IS correct stays --------------------------

# Prohibition lines are still dropped, not read as claims.
out=$(lint $'## Fence (may touch ONLY)\n\n- `packages/mine.ts`\n\nDo not touch `packages/theirs.ts` — owned by a sibling lane.\n')
has "the owned path is claimed" "1 fence path(s)" "$out"
lacks "a prohibition line is still not read as a claim" \
    "packages/theirs.ts" "$(printf '%s\n' "$out" | grep -v 'Do not touch')"

# A genuinely vague fence still hard-fails.
out=$(lint $'## Fence (may touch ONLY)\n\n- `packages/foo.ts`, touch the minimum shared surface, and otherwise create new files if needed.\n')
has "a vague fence is still flagged" "VAGUE fence" "$out"
has "a vague fence still hard-fails" "fence lint FAILED" "$out"

echo ""
# --- review repair: a heading that MENTIONS a fence is not a declaration ------
# Found by an independent review seat as `## Off-fence notes`. The corpus then
# showed four LIVE instances of the same shape -- including one that matched
# inside a SYMBOL NAME (`### 1. stripFencedCodeBlocks is inert`) and one whose
# heading names a real path (`## Why the fence is in `log/`...`). The matcher was
# `^#+ .*[Ff]ence`, so any heading carrying the word restarted extraction: that is
# the over-claim defect of #443 again, narrowed from body-wide to heading-wide
# rather than closed. These assert the CLASS, not the one spelling that found it.
out=$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n## Off-fence notes\n\n- `scripts/fence-lint.sh` must stay unchanged.\n')
has   "a mention-only heading does not open a claim section" "1 fence path(s)" "$out"
lacks "the path named under a mention heading is not claimed" "scripts/fence-lint.sh" "$out"

out=$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n## Why the fence is in that directory\n\nBecause `zz-unique-dir/thing.ts` is where it lives.\n')
has   "a Why-heading naming a path does not claim it" "1 fence path(s)" "$out"
lacks "the Why-heading path is not claimed" "zz-unique-dir" "$out"

out=$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n### 1. stripFencedCodeBlocks is inert\n\nProof lives in `scripts/zz-symbol-probe.ts` today.\n')
has   "the word matched inside a symbol name is not a declaration" "1 fence path(s)" "$out"
lacks "the symbol-name heading path is not claimed" "zz-symbol-probe" "$out"

# Controls — the declaration forms this repo actually uses must all still be
# read. These are what fail if the matcher is narrowed too far, which is the
# other direction of the same repair.
has "the parenthesised declaration form is still read" "1 fence path(s)" \
    "$(lint $'## Fence (may touch ONLY)\n\n- `packages/core/src/a.ts`\n')"
has "a widening-heading declaration is still read" "1 fence path(s)" \
    "$(lint $'## Fence widened at grooming, 2026-09-01 — recorded before the change\n\n- `packages/core/src/a.ts`\n')"
has "a bare hash-Fence heading is still read" "1 fence path(s)" \
    "$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n')"

# The trailing boundary group, which round 1 left entirely untested: dropping it
# and keeping `^#+ +[Ff]ence` alone passed 26/0, because every mention-heading
# above fails on the ANCHOR. This is the shape only the group catches — the word
# opens the heading but the heading is still not a declaration.
out=$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n## Fences held by the rest of the wave\n\nDo not assume anything about `packages/server/src/zz-w2-owned.ts` — it is w2\'s.\n')
has   "a plural mention heading does not open a claim section" "1 fence path(s)" "$out"
lacks "the plural-heading path is not claimed" "zz-w2-owned" "$out"

# Identifier characters are not a word boundary either. `[^A-Za-z]` alone still
# opened on these two (found by a review seat), because `_` and a digit are not
# letters.
has   "an underscored mention heading does not open a section" "1 fence path(s)" \
    "$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n## Fence_notes\n\nSee `packages/server/src/zz-underscore.ts`.\n')"
has   "a digit-suffixed mention heading does not open a section" "1 fence path(s)" \
    "$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n## Fence2\n\nSee `packages/server/src/zz-digit.ts`.\n')"
has   "a hyphenated mention heading does not open a section" "1 fence path(s)" \
    "$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n## Fence-notes for the operator\n\nSee `packages/server/src/zz-hyphen.ts`.\n')"

# The boundary is a whitelist, so the assertion that matters most is the one in
# the OTHER direction: a real declaration whose qualifier is separated by a
# colon, and one by nothing at all, must still open. These fail if a future
# narrowing goes one character too far.
has   "a colon-qualified declaration still opens" "1 fence path(s)" \
    "$(lint $'## Fence: the files this may touch\n\n- `packages/core/src/a.ts`\n')"

# The direction NO assertion covered until now, and the one that broke a live
# issue. Over-narrowing the boundary fails SILENTLY — the declaration stops being
# read and the lint reports `overlaps: none` over real overlaps. #564's heading
# is `## Fence, provisional — placement is a grooming decision`; a whitelist of
# separators rejected it and lost two genuine overlaps against #558.
#
# A separator is anything that ENDS the word. That set is open, so it is not
# enumerated here: each of these is a spelling a human might reasonably write,
# and every one must open.
for _sep_case in \
  '## Fence, provisional — placement is a grooming decision' \
  '## Fence; the files' \
  '## Fence. The files' \
  '## Fence — widened at grooming' \
  '## Fence (may touch ONLY)'
do
  has "a separator-qualified declaration opens: ${_sep_case}" "1 fence path(s)" \
      "$(lint "${_sep_case}"$'\n\n- `packages/core/src/a.ts`\n')"
done

# And the closed set that must NOT open: a character that CONTINUES the token
# makes it a different word, not a qualified declaration.
for _cont_case in '## Fence-notes' '## Fence_notes' '## Fence2' '## Fences'
do
  out=$(lint "${_cont_case}"$'\n\n- `packages/server/src/zz-cont.ts`\n')
  case "$out" in
    *"declares NO fence"*) ok "a token-continuing heading is not a declaration: ${_cont_case}" ;;
    *) bad "a token-continuing heading is not a declaration: ${_cont_case}" "got: $out" ;;
  esac
done

# --- the prohibition vocabulary, pinned -------------------------------------
# These three spellings appear in live fences (#104, #130/#214, #343) and each
# named a path the issue says it must NOT open. Before they were added, #104
# claimed `packages/server/src/api/lab.ts` — live-fenced by two other issues —
# straight out of its own fence section.
out=$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n**Deliberately not `packages/server/src/zz-forbidden.ts`** — it is live-fenced elsewhere.\n')
has   "a deliberately-not line is dropped"    "1 fence path(s)" "$out"
lacks "the deliberately-not path is not claimed" "zz-forbidden" "$out"

out=$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n`packages/server/src/zz-excluded.ts` is **not** in the fence.\n')
has   "a not-in-the-fence line is dropped"    "1 fence path(s)" "$out"

out=$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\nIt does **not** touch `packages/server/src/zz-untouched.ts`.\n')
has   "a does-not-touch line is dropped"      "1 fence path(s)" "$out"

# The bound on that vocabulary, asserted so the header table cannot drift from
# it: an UNLISTED negation spelling is NOT dropped. #109 is why the list is
# closed — its fence names two real claims and one prohibition on ONE line, so a
# general `not `X`` rule would cost two genuine paths to drop one.
has "an unlisted negation spelling is still read as a claim" "3 fence path(s)" \
    "$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\nTouches `packages/core/src/b.ts`. Not `zz-other.ts` for now.\n')"

# The COST of dropping a matching line whole, pinned rather than left to be
# discovered. A genuine claim sharing a line with an accepted prohibition
# spelling is lost SILENTLY — a missing claim, not a phantom one, which is the
# worse direction for an overlap checker. No live fence does this (measured over
# the corpus), so this asserts the behaviour as it IS, and will fail loudly if
# someone changes the strategy without revisiting the note in fence-lint.sh.
has "a claim sharing a line with a prohibition is LOST (known cost)" "1 fence path(s)" \
    "$(lint $'## Fence\n\n- `packages/core/src/a.ts`\n\n- `packages/core/src/zz-b.ts` — a pure read; it does not touch `packages/core/src/zz-c.ts`.\n')"

echo "──"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
