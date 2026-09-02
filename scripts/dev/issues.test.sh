#!/usr/bin/env bash
# issues.test.sh — what `scripts/dev/issues.sh` costs, and that it still refuses
# to answer from a truncated read.
#
# Run it:  bash scripts/dev/issues.test.sh
#
# It is standalone rather than a vitest file because the repo's vitest projects
# are `packages/*` and this script is not in a package. It touches nothing
# remote: a mock `gh` goes on PATH ahead of the real one, answers every call
# this script makes, and logs its own argv. The assertions are then counts over
# that log — which is the only way to state #581's before/after honestly, since
# the defect was never wrong output, it was how many times the board got read.
#
# The "before" figures are not asserted from memory either: the pre-#581 script
# is recovered from git and run against the same mock, so the comparison in the
# PR body is a measurement, not a claim.
set -uo pipefail

root=$(git rev-parse --show-toplevel) || exit 2
SCRIPT="$root/scripts/dev/issues.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export PATH="$tmp/bin:$PATH"
mkdir -p "$tmp/bin"

pass=0; fail=0
ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
is()   { # is <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2], got [$3]"; fi
}
has()  { # has <label> <needle> <haystack>
  case "$3" in *"$2"*) ok "$1";; *) bad "$1" "expected to contain [$2], got: $3";; esac
}

# ── the mock ────────────────────────────────────────────────────────────────
# MOCK_BOARD_ITEMS / MOCK_OPEN_ISSUES let a test push either read up to the cap
# that issues.sh checks. Everything else is a fixed, valid answer.
cat > "$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
all="$*"
n_items=${MOCK_BOARD_ITEMS:-4}
n_open=${MOCK_OPEN_ISSUES:-4}

case "$1 ${2:-}" in
  "project item-list")
    python3 -c '
import json, sys
n = int(sys.argv[1])
print(json.dumps({"items": [{"id": "PVTI_%d" % i, "content": {"number": i, "title": "issue %d" % i}}
                            for i in range(1, n + 1)], "totalCount": n}))' "$n_items"
    exit 0 ;;
  "issue list")
    # MOCK_NO_MILESTONE is a space-separated set of issue numbers whose
    # `milestone` comes back null; every other issue carries one. Default: all
    # carry one, so a test that does not opt in cannot accidentally depend on a
    # drifted issue existing.
    # MOCK_DROP_MILESTONE omits the key altogether, which is what an older gh
    # or a trimmed --json list does. Distinct from a null value on purpose.
    python3 -c '
import json, sys, os
n = int(sys.argv[1])
none = set(os.environ.get("MOCK_NO_MILESTONE", "").split())
drop = os.environ.get("MOCK_DROP_MILESTONE")
out = []
for i in range(1, n + 1):
    row = {"number": i, "title": "issue %d" % i}
    if not drop:
        row["milestone"] = None if str(i) in none else {"title": "prd99"}
    out.append(row)
print(json.dumps(out))' "$n_open"
    exit 0 ;;
  "issue view")
    echo "I_issue_$3"; exit 0 ;;
  "issue close")
    echo "closed"; exit 0 ;;
esac

case "$all" in
  *mutation*)          echo '{"data":{}}' ;;
  *ProjectV2SingleSelectField*)
    cat <<'JSON'
{"data":{"node":{"fields":{"nodes":[
 {"__typename":"ProjectV2SingleSelectField","id":"F_status","name":"Status",
  "options":[{"id":"o_backlog","name":"Backlog"},{"id":"o_ready","name":"Ready"},
             {"id":"o_prog","name":"In progress"},{"id":"o_rev","name":"In review"},
             {"id":"o_done","name":"Done"}]},
 {"__typename":"ProjectV2MultiSelectField","id":"F_time","name":"Timeline",
  "multiSelectOptions":[{"id":"o_now","name":"Now"},{"id":"o_soon","name":"Soon"},
                        {"id":"o_later","name":"Later"}]}
]}}}}
JSON
    ;;
  *issueTypes*)
    echo '{"data":{"organization":{"issueTypes":{"nodes":[{"id":"IT_bug","name":"Bug"},{"id":"IT_feat","name":"Feature"},{"id":"IT_task","name":"Task"}]}}}}' ;;
  *issueFields*)
    echo '{"data":{"organization":{"issueFields":{"nodes":[{"id":"IF_prio","name":"Priority","options":[{"id":"P_urgent","name":"Urgent"},{"id":"P_high","name":"High"},{"id":"P_med","name":"Medium"},{"id":"P_low","name":"Low"}]}]}}}}' ;;
  *"repository(owner:"*)
    echo "I_issue_repo" ;;
  *issueFieldValues*)
    # cmd_list's paginated board walk. One page, no next page.
    python3 -c '
import json, sys
n = int(sys.argv[1])
nodes = [{"content": {"number": i, "title": "issue %d" % i, "state": "OPEN",
                      "issueType": {"name": "Task"}, "issueFieldValues": {"nodes": []}},
          "fieldValues": {"nodes": []}} for i in range(1, n + 1)]
print(json.dumps({"data": {"node": {"items": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                                              "nodes": nodes}}}}))' "$n_items" ;;
  *) echo '{"data":{}}' ;;
esac
MOCK
chmod +x "$tmp/bin/gh"

count() { grep -c -- "$1" "$GH_LOG" 2>/dev/null || true; }
fresh() { GH_LOG="$tmp/log.$1"; export GH_LOG; : > "$GH_LOG"; }

BOARD_READ='project item-list'
FIELD_READ='ProjectV2SingleSelectField'
MUTATION='mutation{updateProjectV2ItemFieldValue'

echo "── issues.sh: cost ──"

# The measurement #581 asks for. Six field writes across three issues.
fresh new
cat > "$tmp/in.batch" <<'EOF'
1 now  in-review
2 now  backlog
3 later ready
EOF
out=$("$SCRIPT" batch < "$tmp/in.batch" 2>&1)
new_board=$(count "$BOARD_READ"); new_fields=$(count "$FIELD_READ"); new_muts=$(count "$MUTATION")
is "batch(3 issues x 2 fields) reads the board once"      1 "$new_board"
is "batch(3 issues x 2 fields) reads the field ids once"  1 "$new_fields"
is "batch(3 issues x 2 fields) still writes all 6 fields" 6 "$new_muts"
has "batch reports what it applied" "6 write(s) applied, 0 failed" "$out"

# The same six writes through the pre-#581 script, for the before/after number.
# Skipped rather than failed if that revision is no longer reachable — this
# test's job is the current cost, and the comparison is a bonus.
if git -C "$root" show cc5e513:scripts/dev/issues.sh > "$tmp/old-issues.sh" 2>/dev/null; then
  fresh old
  for n in 1 2 3; do
    bash "$tmp/old-issues.sh" when "$n" now      >/dev/null 2>&1
    bash "$tmp/old-issues.sh" status "$n" backlog >/dev/null 2>&1
  done
  old_board=$(count "$BOARD_READ"); old_fields=$(count "$FIELD_READ"); old_muts=$(count "$MUTATION")
  is "before: one full board read per field written" 6 "$old_board"
  is "before: three field-id queries per write"     18 "$old_fields"
  is "before: the same 6 mutations"                  6 "$old_muts"
  printf '  note  board reads %s -> %s, field reads %s -> %s, for the same %s writes\n' \
    "$old_board" "$new_board" "$old_fields" "$new_fields" "$new_muts"
else
  printf '  skip  before/after comparison (cc5e513 unreachable)\n'
fi

echo ""
echo "── issues.sh: the guards still fail loudly ──"

# The whole point of the cap check. A board at the limit is not a smaller
# answer, it is a wrong one — and it must abort BEFORE anything is written.
fresh trunc
cat > "$tmp/in.trunc" <<'EOF'
1 now in-review
2 now backlog
EOF
out=$(MOCK_BOARD_ITEMS=1000 "$SCRIPT" batch < "$tmp/in.trunc" 2>&1); rc=$?
is  "truncated board: batch exits non-zero"      1 "$rc"
has "truncated board: says which limit it hit"   "at or above the --limit of 1000" "$out"
is  "truncated board: writes nothing at all"     0 "$(count "$MUTATION")"

fresh trunc1
out=$(MOCK_BOARD_ITEMS=1000 "$SCRIPT" when 1 now 2>&1); rc=$?
is  "truncated board: single write exits non-zero" 1 "$rc"
is  "truncated board: single write writes nothing" 0 "$(count "$MUTATION")"

# orphans reads open issues through a different call with its own cap, so it
# gets its own check — the board surviving the cap does not prove this did.
fresh orph
out=$(MOCK_OPEN_ISSUES=1000 "$SCRIPT" orphans 2>&1); rc=$?
is  "truncated issue list: orphans exits non-zero" 1 "$rc"
has "truncated issue list: names the limit"        "at or above the --limit of 1000" "$out"

# The milestone half of `orphans`, added 2026-09-02. AGENTS.md had claimed this
# command found issues with no milestone since before it could; the claim went
# unchecked because nothing here exercised it. These assertions are the check
# that claim never had.
#
# Each is written so it FAILS if the milestone arm is deleted — that is the
# mutation to run against them. Asserting only the clean case would pass with
# the arm removed, since the off-board line prints either way.
fresh ms_clean
out=$("$SCRIPT" orphans 2>&1)
has "orphans: says so when every issue carries a milestone" "all open issues carry a milestone" "$out"

fresh ms_drift
out=$(MOCK_NO_MILESTONE="2 3" "$SCRIPT" orphans 2>&1)
has "orphans: names an issue with no milestone"    "no milestone:" "$out"
has "orphans: lists the drifted issue by number"   "#2 issue 2" "$out"
has "orphans: lists every drifted issue, not one"  "#3 issue 3" "$out"

# The two findings are different facts and must not collapse into one verdict:
# an issue can be off the board AND milestone-less, and a merged count would
# hide which rule it broke. Board-clean while milestone-dirty is the case that
# proves the lines are independent — the old command printed only the first and
# a reader would have taken it for the whole answer.
fresh ms_split
out=$(MOCK_NO_MILESTONE="1" "$SCRIPT" orphans 2>&1)
has "orphans: board-clean and milestone-dirty are both reported" "all open issues are on the board" "$out"
has "orphans: ...and the milestone finding is not swallowed by it" "no milestone:" "$out"

# A gh that does not return the field must not be read as "no issue has one".
# The mock drops `milestone` entirely here, which is what an older gh or a
# trimmed --json list does; "not read" is not the same fact as "read, and null".
fresh ms_absent
out=$(MOCK_DROP_MILESTONE=1 "$SCRIPT" orphans 2>&1)
has "orphans: an unread milestone field claims nothing" "milestone not read" "$out"

# Zero open issues is the fourth state, and the branch ordering hides it: with
# the list empty `field_read` is False, so deleting the empty-list line does not
# fall through to silence — it falls through to "milestone not read", a claim
# about gh that nothing observed. Deleting that line was a SILENT mutation, 41/41
# green, until this assertion existed. Same species as the dead guard `cmd_orphans`
# describes deleting: the arm that keeps a verdict honest was itself unheld.
fresh ms_none
out=$(MOCK_OPEN_ISSUES=0 "$SCRIPT" orphans 2>&1)
has "orphans: an empty issue list claims nothing about the field" "no open issues" "$out"

# cmd_list's reconciliation: the board walk and the open-issue list are
# different APIs, and when they disagree the table must say so rather than
# looking complete.
fresh recon
out=$(MOCK_BOARD_ITEMS=2 MOCK_OPEN_ISSUES=5 "$SCRIPT" list 2>&1)
has "list reconciles board against open issues" "2 shown, 5 open" "$out"
has "list warns about what it did not show"     "WARNING: 3 open issue(s) not shown" "$out"

echo ""
echo "── issues.sh: argument handling ──"

fresh compat
"$SCRIPT" when 1 now >/dev/null 2>&1
is "the historical two-argument form still works" 1 "$(count "$MUTATION")"

fresh multi
"$SCRIPT" when 1 2 3 now >/dev/null 2>&1
is "when takes many issues, one board read" 1 "$(count "$BOARD_READ")"
is "when takes many issues, three writes"   3 "$(count "$MUTATION")"

# A transposed value would otherwise set Timeline to "548" on issue "now" —
# the quiet wrong write this script exists to prevent.
fresh transposed
out=$("$SCRIPT" when now 1 2>&1); rc=$?
is  "transposed 'when now 1' is refused"        1 "$rc"
is  "transposed 'when now 1' writes nothing"    0 "$(count "$MUTATION")"
has "transposed 'when now 1' says why"          "the value goes last" "$out"

fresh nonnum
out=$("$SCRIPT" status 1 abc ready 2>&1); rc=$?
is  "a non-numeric issue argument is refused"   1 "$rc"
is  "a non-numeric issue argument writes nothing" 0 "$(count "$MUTATION")"

echo ""
echo "── issues.sh: batch ──"

# One bad line must not abandon the other 27. This is the #581 failure mode in
# miniature: a run that stops halfway leaves the operator reconstructing which
# issues made it.
fresh partial
cat > "$tmp/in.partial" <<'EOF'
1 now in-review
nope now backlog
3 - ready
EOF
out=$("$SCRIPT" batch < "$tmp/in.partial" 2>&1); rc=$?
is  "a bad line does not stop the batch"     1 "$rc"
is  "the good lines were still applied"      3 "$(count "$MUTATION")"
has "the bad line is named at the end"       "line 2: 'nope' is not an issue number" "$out"
has "the count is reported"                  "3 write(s) applied, 1 failed" "$out"

fresh skips
cat > "$tmp/in.skips" <<'EOF'
# a comment, and a blank line follow

3 - in-review
EOF
"$SCRIPT" batch < "$tmp/in.skips" >/dev/null 2>&1
is "comments and blanks are skipped, '-' leaves a field alone" 1 "$(count "$MUTATION")"

fresh five
cat > "$tmp/in.five" <<'EOF'
1 now in-review high task
2 soon ready    low  bug
EOF
out=$("$SCRIPT" batch < "$tmp/in.five" 2>&1)
is  "batch sets priority through setIssueFieldValue" 2 "$(count 'setIssueFieldValue(input:')"
is  "batch sets type through updateIssue"            2 "$(count 'updateIssue(input:')"
is  "batch reads the org priority field once"        1 "$(count 'issueFields(first:20)')"
is  "batch reads the org issue types once"           1 "$(count 'issueTypes(first:20)')"
is  "batch still reads the board once"               1 "$(count "$BOARD_READ")"
has "all four fields on two issues applied"          "8 write(s) applied, 0 failed" "$out"

fresh toomany
cat > "$tmp/in.toomany" <<'EOF'
1 now in-review high task extra
EOF
out=$("$SCRIPT" batch < "$tmp/in.toomany" 2>&1); rc=$?
is  "an over-long line is refused"    1 "$rc"
is  "an over-long line writes nothing" 0 "$(count "$MUTATION")"

echo ""
echo "──"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
