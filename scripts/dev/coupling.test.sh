#!/usr/bin/env bash
# coupling.test.sh — `.swarm/coupling.txt` still describes this tree.
#
# Run it:  bash scripts/dev/coupling.test.sh
#
# A coupling file rots in two ways, and both make it worse than nothing:
#
#   * a path that no longer exists — the reader trusts a warning about a file
#     that moved three PRs ago, or worse, trusts the SILENCE about the file it
#     moved to;
#   * an entry with no reason — the reader cannot judge the warning without
#     going and finding out what couples, so they learn to skip the section.
#     That is the failure mode `fence-lint.sh`'s own comments already record
#     for its sibling-file warnings.
#
# Neither is caught by anything else: `fence-lint.sh` reads the file happily
# either way. So this asserts both, and that the three branches of the lint's
# coupling section still work, using the file's own parsing rules — the same
# `${line%%#*}` / `${line#*#}` split fence-lint.sh does, so a divergence there
# shows up here rather than in a dispatch.
set -uo pipefail

root=$(git rev-parse --show-toplevel) || exit 2
cd "$root"
COUPLING=.swarm/coupling.txt
LINT=scripts/fence-lint.sh

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
has() { case "$3" in *"$2"*) ok "$1";; *) bad "$1" "expected [$2] in: $3";; esac; }

echo "── .swarm/coupling.txt ──"

if [ -f "$COUPLING" ]; then ok "the file fence-lint.sh requires exists"
else bad "the file fence-lint.sh requires exists"; echo "$pass passed, $fail failed"; exit 1; fi

# Tracked, not just present. `.swarm/` is ignored wholesale for lane state, so
# an untracked coupling.txt is one machine's file and every other clone gets
# the "create one" abort — which is how this went missing in the first place.
if git ls-files --error-unmatch "$COUPLING" >/dev/null 2>&1; then
  ok "it is tracked, so every clone gets it"
else
  bad "it is tracked, so every clone gets it" "untracked — check .gitignore's .swarm/* + !.swarm/coupling.txt"
fi

entries=0; missing=0; unexplained=0
while read -r line; do
  case "$line" in ''|\#*) continue;; esac
  raw=${line%%#*}
  path=$(echo "$raw" | xargs)
  why=${line#*#}
  [ -z "$path" ] && continue
  entries=$((entries + 1))
  [ -e "$path" ] || { missing=$((missing + 1)); printf '        no such path: %s\n' "$path"; }
  # `${line#*#}` returns the WHOLE line when there is no `#` at all, so an
  # unexplained entry is the one whose reason, trimmed, IS its own leading path.
  #
  # EQUALITY, not containment (prd-54 ruling 10). An entry may legitimately name
  # its own path inside a reason — the `docs/adr/` entry tells a lane to run
  # `git ls-tree origin/main docs/adr/` — and the containment reading convicted
  # it, so this check stood at 10 of 11 on a registry where nothing was wrong.
  # A guard that fails a true entry teaches its readers to expect red, which is
  # this file's own header warning about warnings one level down.
  #
  # THE PATH HAS TWO SPELLINGS AND BOTH ARE COMPARED. `$path` has been through
  # `xargs`, which strips quotes, unescapes backslashes and collapses internal
  # whitespace; the reason is trimmed by parameter expansion, which does none of
  # those. So whenever `xargs` rewrites the leading field the two strings CANNOT
  # compare equal, and the first version of this check let nine shapes through
  # that the containment reading it replaced had caught — `'p'` and `"p"` with no
  # `#` at all, `p  # 'p'`, `p  # "p"`, and the whole "reason is the field exactly
  # as typed" family for a quoted, backslash-escaped or multiply-spaced field.
  # `$rawtrim` is therefore the leading field AS TYPED, whitespace-trimmed only,
  # and one layer of matched surrounding quotes is stripped off the reason before
  # comparing. A match against any of those pairings is "no reason given".
  #
  # Unreachable on today's registry — no path in it is quoted or carries odd
  # whitespace — which is exactly why it is written down here rather than left
  # for the entry that first needs a quoted path to discover.
  #
  # THE DELIMITER SET, and the rule is about the SET rather than about whichever
  # member the repair happened to be built around. It is, in full:
  #
  #     `   backtick        — THIS FILE'S OWN citation convention, on 44 lines
  #     '   single quote    — shell quoting, and the apostrophe in ordinary prose
  #     "   double quote    — shell quoting, and quoted prose
  #
  # AT MOST ONE matched layer of ANY member is stripped before comparing, and the
  # loop below `break`s on the first member that matches. Order inside it does not
  # matter: a string starts with exactly one character, so at most one member can
  # match the opening delimiter at all.
  #
  # Backtick is in the set because it is the spelling an author of THIS file would
  # actually produce — the first version of this rule closed `'p'` and `"p"`, which
  # nobody writes here, and left `` `p` `` open. Note that backtick is NOT a shell
  # quote: `xargs` does not strip it, so a backticked LEADING FIELD reaches the
  # comparison intact and is caught by the `$rawtrim` arm rather than by this one.
  # That asymmetry is why the set is named here rather than inferred from `$path`.
  #
  # Two shapes are deliberately NOT caught, and both exclusions apply to EVERY
  # member of the set: two layers of the SAME delimiter (`` ``p`` ``, `''p''`,
  # `""p""`), and a MISMATCHED pair — either order, any two members. A layer of one
  # member nested inside another is the same case: one is stripped, the remainder
  # is not the path, and it reads as a reason. Neither is a spelling of the path
  # anybody types, and stripping delimiters until a match appears is the unbounded
  # version of this rule.
  #
  # The reason does NOT go through `xargs`: reasons carry quotes, parentheses and
  # `$`, which xargs parses rather than passes, and an unbalanced quote in one
  # would make the trim itself fail.
  rawtrim=${raw#"${raw%%[![:space:]]*}"}
  rawtrim=${rawtrim%"${rawtrim##*[![:space:]]}"}
  trimmed=${why#"${why%%[![:space:]]*}"}
  trimmed=${trimmed%"${trimmed##*[![:space:]]}"}
  bare=$trimmed
  for d in '`' "'" '"'; do
    case "$bare" in
      "$d"*"$d") bare=${bare#"$d"}; bare=${bare%"$d"}; break ;;
    esac
  done
  if [ -z "$trimmed" ] \
     || [ "$trimmed" = "$path" ] || [ "$trimmed" = "$rawtrim" ] \
     || [ "$bare" = "$path" ]    || [ "$bare" = "$rawtrim" ]; then
    unexplained=$((unexplained + 1)); printf '        no reason given: %s\n' "$path"
  fi
done < "$COUPLING"

if [ "$entries" -gt 0 ]; then ok "$entries entries parsed"
else bad "entries parsed" "the file has no entries fence-lint.sh can read"; fi
if [ "$missing" -eq 0 ]; then ok "every path still exists in the tree"
else bad "every path still exists in the tree" "$missing stale"; fi
if [ "$unexplained" -eq 0 ]; then ok "every entry says what couples it"
else bad "every entry says what couples it" "$unexplained without a reason"; fi

echo ""
echo "── fence-lint.sh's coupling section ──"

# A mock `gh` gives the lint a fenced issue body, so the three branches are
# exercised against the real file without touching the API or needing an issue
# groomed a particular way.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
printf '## Fence\n\n- `%s`\n' "$MOCK_FENCE"
MOCK
chmod +x "$tmp/bin/gh"
lint() { PATH="$tmp/bin:$PATH" MOCK_FENCE="$1" bash "$LINT" 900 2>&1; }

out=$(lint 'packages/web/src/App.test.tsx')
case "$out" in
  *"create one"*) bad "the 'create one' abort is gone" "$out" ;;
  *) ok "the 'create one' abort is gone" ;;
esac
has "a fence naming a coupling point reports it owned" \
    "ok    packages/web/src/App.test.tsx" "$out"

# Characterisation, and a finding. A DIRECTORY fence reports every coupling
# point under it as `ok`, never `WARN` — fence-lint.sh's `owned` test is a raw
# string prefix (`case "$path" in "$p"*`), and its `reachable` test only fires
# when the fence is the coupling point's directory or contains it. Every fence
# that satisfies `reachable` is therefore also a prefix of the path itself, so
# `owned` wins first and the WARN branch is unreachable.
#
# That matters: WARN is the branch that says "this wave can REACH the file but
# nobody claimed it", which is the judgement call the section exists to prompt.
# Today a directory fence silently absorbs every coupling point beneath it.
# `scripts/fence-lint.sh` is not this change's fence, so it is left alone and
# recorded here instead — when it is fixed, this assertion fails and points at
# this comment.
out=$(lint 'packages/web/src/theme')
has "a directory fence absorbs the points beneath it as owned" \
    "ok    packages/web/src/theme/tokens.test.ts" "$out"
case "$out" in
  *WARN*) bad "WARN is still unreachable (see the comment above — fence-lint.sh changed?)" "$out" ;;
  *) ok "WARN is still unreachable — recorded, not fixed: fence-lint.sh is not this fence" ;;
esac

# A sibling file in the same directory is NOT treated as coupled, which is the
# behaviour fence-lint.sh's own comments say it was given deliberately.
out=$(lint 'packages/web/src/theme/tokens.ts')
has "a sibling fence is only informational" \
    "info  packages/web/src/theme/tokens.test.ts" "$out"

out=$(lint 'packages/server/src/api')
has "a fence elsewhere is only informational" \
    "info  packages/web/src/App.test.tsx" "$out"

echo ""
echo "──"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
