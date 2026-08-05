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
  # A fence is either inline ("Fence: `a`, `b`") or a bulleted section under
  # a "## Fence" heading — take both. The heading form parsed as EMPTY until
  # 2026-07-31, so the lint passed while checking nothing.
  section=$(echo "$body" | awk '/^#+ .*[Ff]ence/{f=1; next} /^#+ /{f=0} f')
  inline=$(echo "$body" | grep -i 'fence' || true)
  # PROHIBITION lines are not claims. A fence section that says "do NOT touch
  # `x/`" was read as CLAIMING x/ and reported a phantom overlap with the lane
  # that really owns it — three times (#166, #183-era, #192) before this
  # filter existed. Drop any line whose sense is exclusion before extracting
  # paths; the grooming rule is still "prohibitions belong under Blocked by",
  # but the linter no longer punishes prose that reads naturally.
  drop_re='do not touch|do NOT touch|must not enter|not enter|out of scope|owned by|owns|belongs to|leave .* to|EXPLICITLY OUT|do not reach'
  fence_text=$(printf '%s\n%s' "$section" "$inline" | grep -viE "$drop_re" || true)
  [ -z "$(echo "$fence_text" | tr -d '[:space:]')" ] && { echo "  !! #$n declares NO fence"; fail=1; continue; }

  # 1. vague fences — the worker must never choose its own boundary
  vague=$(echo "$fence_text" | grep -oiE 'minimum shared surface|declare exactly what you touched|otherwise create|if needed|as needed|IF a stub|touch the minimum|use your judgement|where necessary' || true)
  if [ -n "$vague" ]; then
    echo "  !! #$n has a VAGUE fence — it delegates the boundary to the worker:"
    echo "$vague" | sed 's/^/       "/;s/$/"/'
    echo "       Name every path explicitly, including shared registries/test doubles."
    fail=1
  fi

  echo "$fence_text" | grep -oE '`[^`]+`' | tr -d '`' \
    | sed 's/\*\*//g' | sed 's:/\*\*$::' | sed 's:/$::' \
    | grep -E '^[A-Za-z0-9_.@/-]+$' | grep -vE '^(may|touch|ONLY|and|plus)$' \
    | while read -r p; do [ -n "$p" ] && echo "$n|$p"; done >> "$tmp/fences"
  count=$(grep -c "^$n|" "$tmp/fences" 2>/dev/null || true)
  echo "  #$n: ${count:-0} fence path(s)"
  [ "${count:-0}" = "0" ] && { echo "  !! #$n: no paths extracted from its fence — lint cannot vouch for it"; fail=1; }
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
