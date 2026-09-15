#!/usr/bin/env bash
# Manage this repo's GitHub issues and its project board from one place.
#
# The board (project 19, "rhizomorph") carries two fields that matter:
#
#   Status   — where the work IS    : Backlog / Ready / In progress / In review / Done
#   Timeline — when it should HAPPEN: Now / Soon / Later   (multi-select)
#
# They answer different questions and both are needed. Status alone collapses
# "do this next" and "correctly parked" into one Backlog column; Timeline alone
# says nothing about what is in flight. `list` prints them side by side.
#
# Usage:
#   scripts/dev/issues.sh list                    # open issues with Status + Timeline
#   scripts/dev/issues.sh when <n>... <now|soon|later>
#   scripts/dev/issues.sh type <n>... <bug|feature|task>
#   scripts/dev/issues.sh priority <n>... <urgent|high|medium|low>
#   scripts/dev/issues.sh status <n>... <backlog|ready|in-progress|in-review|done>
#   scripts/dev/issues.sh batch                   # many issues, many fields, one board read
#   scripts/dev/issues.sh show <n>                # issue body + board fields
#   scripts/dev/issues.sh close <n> "reason"      # close WITH a comment, never silently
#   scripts/dev/issues.sh orphans                 # open issues off the board, or with no milestone
#   scripts/dev/issues.sh ids                     # field/option ids (for debugging)
#
# The value comes LAST on the write subcommands, so the historical two-argument
# form (`when 548 now`) is unchanged and `when 548 549 550 now` is the new one.
#
# `batch` reads "<issue> <when> <status> [priority] [type]" lines on stdin, one
# per issue, `-` for any field to leave alone. Boarding an era is one call:
#
#   scripts/dev/issues.sh batch <<'EOF'
#   548  now   in-review
#   549  now   backlog     high
#   550  later ready       -      task
#   EOF
#
# ponytail: ids are resolved from the API each run rather than hardcoded here.
# One extra call per RUN buys immunity to someone renaming an option in the
# GitHub UI — a stale hardcoded id fails by silently writing the wrong column,
# which is exactly the quiet wrongness this repo's own reviews keep finding.
# That per-run cost is memoised (see `ensure_*` below); what #581 removed was
# the per-WRITE cost, which is a different thing and was never deliberate.
#
# Note Timeline is a MULTI-select, so its value goes through
# `multiSelectOptionIds` (a list), not `singleSelectOptionId`. Sending the
# single-select shape to it fails with `argumentNotAccepted`. `when` sets
# exactly one option, which is the intended use.
# END-USAGE
set -euo pipefail

OWNER="launchpad-26"
REPO="launchpad-26/rhizomorph"
PROJECT=19
PROJECT_ID="PVT_kwDOEnEMsM4Bfk9Q"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH"; }
need gh
need python3

# #508: on at least one contributor machine, roughly half of every `gh` call
# fails on a transient DNS fault that never reaches the network — see
# gh-retry.sh for the measurement and the discriminator. Every `gh`
# invocation below goes through `gh_retry` rather than calling `gh` directly.
GH_RETRY_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-retry.sh"
# shellcheck source=./gh-retry.sh
source "$GH_RETRY_SH"

# ── memoised reads (#581) ───────────────────────────────────────────────────
# Every write used to re-read everything it needed from scratch. `set_select`
# alone cost FOUR API calls — `field_id`, `field_kind` and `option_id` each ran
# the whole `fields` query, and `item_id` ran a full `gh project item-list` of
# every item and every field on the board to resolve one issue's item id.
#
# GitHub's GraphQL budget is node-count based, not request-count based, so that
# board read cost O(board size) *per field written* and got worse on its own as
# the project grew. Measured 2026-08-15: boarding 28 issues x 2 fields burned a
# full 5,000-point hourly budget after ~15 writes — ~330 points per invocation
# — and left 22 of the 28 unboarded.
#
# So each remote read happens at most once per process and is held in a plain
# global. Not a temp file: every `ensure_*` is invoked from the main shell, so
# the assignment survives, and a subshell that only READS the cache — the
# `$(item_id ...)` below, or `batch`'s per-line `( ... )` — still sees it
# populated. Anything that fetches from inside a command substitution would
# silently re-fetch every time, which is the bug this replaces.
BOARD_JSON=""     # gh project item-list --format json
FIELDS_TSV=""     # the project's single/multi-select fields and their options
ORG_TYPES_JSON="" # org-level issue types (Bug/Feature/Task)
ORG_FIELDS_JSON="" # org-level issue fields (Priority)

# "<field>\t<field-id>\t<kind>\t<option>\t<option-id>" per option.
# kind is SINGLE or MULTI — the mutation shape differs between them.
#
# Captured, not piped — same reason as fetch_board below: a failing `gh_retry`
# handed python an empty stdin, which raised JSONDecodeError and buried the
# real error (a 401, say) under a 19-line traceback instead of `ensure_fields`'s
# own honest `|| die`. Found in review of #508: this was the one call site
# among fetch_fields/fetch_board/cmd_orphans/cmd_show that still piped straight
# through, despite fetch_board's own comment naming the exact defect one
# function below.
fetch_fields() {
  local raw
  raw="$(gh_retry api graphql -f query="{node(id:\"$PROJECT_ID\"){... on ProjectV2{fields(first:50){nodes{
      __typename
      ... on ProjectV2SingleSelectField{id name options{id name}}
      ... on ProjectV2MultiSelectField{id name multiSelectOptions{id name}}
    }}}}}")" || return 1
  printf '%s' "$raw" \
    | python3 -c '
import sys, json
for n in json.load(sys.stdin)["data"]["node"]["fields"]["nodes"]:
    t = n.get("__typename")
    if t == "ProjectV2SingleSelectField":
        kind, opts = "SINGLE", n["options"]
    elif t == "ProjectV2MultiSelectField":
        kind, opts = "MULTI", n["multiSelectOptions"]
    else:
        continue
    name, fid = n["name"], n["id"]
    for o in opts:
        print("\t".join([name, fid, kind, o["name"], o["id"]]))
'
}

ensure_fields() {
  [ -n "$FIELDS_TSV" ] && return 0
  FIELDS_TSV="$(fetch_fields)" || die "could not read the project's fields"
  [ -n "$FIELDS_TSV" ] || die "the project returned no select fields — refusing to guess"
}

field_id()   { printf '%s\n' "$FIELDS_TSV" | awk -F'\t' -v f="$1" 'tolower($1)==tolower(f){print $2; exit}'; }
field_kind() { printf '%s\n' "$FIELDS_TSV" | awk -F'\t' -v f="$1" 'tolower($1)==tolower(f){print $3; exit}'; }
option_id()  { printf '%s\n' "$FIELDS_TSV" | awk -F'\t' -v f="$1" -v o="$2" 'tolower($1)==tolower(f) && tolower($4)==tolower(o){print $5; exit}'; }

# The board's item cap, in ONE place. Every reader below uses it, and every
# reader checks whether it was hit — a truncated read here is not a smaller
# answer, it is a wrong one: `item_id` returning empty makes `set_select` die
# with "#N is not on project", which is false, and sends the reader to
# `orphans`, which would then agree because it truncated identically. That is
# the same silent-cap defect #420 fixed in `cmd_list`, one function over.
BOARD_LIMIT=1000

# Every item on the board, as JSON. Dies loudly rather than returning a short
# list if the cap is ever reached — and dies BEFORE any caller writes anything,
# because `ensure_board` runs up front.
fetch_board() {
  # Captured, not piped: a failing `gh` handed python an empty stdin, which
  # raised JSONDecodeError and buried gh's own error under a traceback — the
  # real exit status replaced by the parser's. Executed during review with a
  # mock `gh` exiting 7.
  local raw
  raw="$(gh_retry project item-list "$PROJECT" --owner "$OWNER" --limit "$BOARD_LIMIT" --format json)" \
    || die "could not read the board (gh project item-list failed)"
  printf '%s' "$raw" \
    | python3 -c '
import sys, json
limit = int(sys.argv[1])
data = json.load(sys.stdin)
items = data.get("items", [])
if len(items) >= limit:
    sys.stderr.write("error: board returned %d items, at or above the --limit of %d; raise BOARD_LIMIT in %s\n"
                     % (len(items), limit, sys.argv[2]))
    sys.exit(1)
json.dump(data, sys.stdout)
' "$BOARD_LIMIT" "$0"
}

ensure_board() {
  [ -n "$BOARD_JSON" ] && return 0
  # Assigned in two steps, not `local x="$(...)"`: that form always returns the
  # exit status of `local`, so a truncated board would sail past the `||` and
  # every write would then be attempted against an empty board. The cap check
  # only fails loudly if its failure can actually be seen.
  BOARD_JSON="$(fetch_board)" || die "could not read the board"
  [ -n "$BOARD_JSON" ] || die "could not read the board (empty response)"
}

# Requires `ensure_board` to have run in the CALLER — this is invoked from a
# command substitution, so an `ensure_board` here would fetch into a subshell,
# throw the result away, and re-fetch on the next call.
item_id() {
  printf '%s' "$BOARD_JSON" \
    | python3 -c '
import sys, json
want = sys.argv[1]
for i in json.load(sys.stdin).get("items", []):
    if str(i.get("content", {}).get("number")) == want:
        print(i["id"]); break
' "$1"
}

set_select() { # set_select <issue> <Field> <Option>
  local issue="$1" field="$2" opt="$3"
  local item fid kind oid value
  ensure_board; ensure_fields
  item="$(item_id "$issue")"; [ -n "$item" ] || die "#$issue is not on project $PROJECT (see: $0 orphans)"
  fid="$(field_id "$field")";  [ -n "$fid" ] || die "no field named '$field'"
  kind="$(field_kind "$field")"
  oid="$(option_id "$field" "$opt")"; [ -n "$oid" ] || die "'$field' has no option '$opt'"

  if [ "$kind" = "MULTI" ]; then
    value="{multiSelectOptionIds:[\"$oid\"]}"
  else
    value="{singleSelectOptionId:\"$oid\"}"
  fi

  gh_retry api graphql -f query="mutation{updateProjectV2ItemFieldValue(input:{projectId:\"$PROJECT_ID\",itemId:\"$item\",fieldId:\"$fid\",value:$value}){projectV2Item{id}}}" >/dev/null \
    || die "could not set #$issue $field -> $opt (gh api graphql mutation failed — see the error above)"
  echo "#$issue  $field -> $opt"
}

# `gh project item-list --format json` returns only `status` — it does not
# surface multi-select values at all, so Timeline reads have to go through
# GraphQL. Issue type comes from the same query rather than a second round trip.
# The board is read through ONE paginated code path (#420). The previous
# version asked for `items(first:100)` with no pagination AND filtered to OPEN
# downstream in python — so every CLOSED item consumed the page budget before
# any open issue was filtered in. On a board with more closed items than the
# page size, that silently rendered 51 of 74 open issues and still exited 0.
#
# Worse than a plain truncation: project items come back in board order, so the
# rows that fell off the end were the NEWEST — exactly the freshly-filed,
# un-triaged work the triage view exists to surface. A Now/High issue filed the
# same day was invisible.
#
# Two defences, because pagination alone would fail silently again if the query
# shape ever changed: the walk pages until `hasNextPage` is false, and the
# output reconciles what it rendered against the repo's own open-issue list,
# saying so when they differ rather than printing a table that looks complete.
cmd_list() {
  PROJECT_ID="$PROJECT_ID" REPO="$REPO" BOARD_LIMIT="$BOARD_LIMIT" GH_RETRY_SH="$GH_RETRY_SH" python3 -c '
import json, os, subprocess, sys

PROJECT_ID = os.environ["PROJECT_ID"]
REPO = os.environ["REPO"]
# #508: each `gh` call goes through gh-retry.sh rather than `gh` directly —
# see that file for why (a transient DNS fault that a per-invocation retry
# recovers and retrying the whole operation does not).
GH = os.environ["GH_RETRY_SH"]

QUERY = """
query($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      content { ... on Issue { number title state issueType { name }
        issueFieldValues(first: 10) { nodes {
          ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { name } } } } } } }
      fieldValues(first: 20) { nodes {
        __typename
        ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldMultiSelectValue { options { name } field { ... on ProjectV2FieldCommon { name } } }
      } }
    }
  } } }
}
"""

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    # Forwarded whenever non-empty, not only on a non-zero returncode: a
    # retried-then-recovered call exits 0 but still wrote gh-retry.sh its own
    # "retrying once" notice to that stderr. Gating on returncode alone
    # (found in review of #508, via a mock retried 2 calls -> 4 with zero
    # bytes of stderr) makes this the one call site the retry is completely
    # silent at -- cmd_list is the most-used read, and criterion 1 requires
    # saying which failure was retried, not only one that was not recovered.
    #
    # NOTE: no apostrophes in this comment on purpose. This whole block is
    # embedded inside a bash SINGLE-quoted string one function up -- a literal
    # apostrophe here closes that string early and breaks the script.
    if p.stderr:
        sys.stderr.write(p.stderr)
    if p.returncode != 0:
        sys.exit(p.returncode)
    return json.loads(p.stdout)

def page(after):
    cmd = [GH, "api", "graphql", "-f", "query=" + QUERY, "-f", "id=" + PROJECT_ID]
    if after:
        cmd += ["-f", "after=" + after]
    return run(cmd)["data"]["node"]["items"]

nodes, after = [], None
while True:
    items = page(after)
    nodes.extend(items["nodes"])
    info = items["pageInfo"]
    if not info["hasNextPage"]:
        break
    after = info["endCursor"]

def field_values(item):
    out = {}
    for v in item.get("fieldValues", {}).get("nodes", []):
        f = (v.get("field") or {}).get("name")
        if not f:
            continue
        if v.get("__typename") == "ProjectV2ItemFieldMultiSelectValue":
            out[f] = ",".join(o["name"] for o in (v.get("options") or []))
        else:
            out[f] = v.get("name") or ""
    return out

rows = []
for n in nodes:
    c = n.get("content") or {}
    if not c.get("number") or c.get("state") != "OPEN":
        continue
    fv = field_values(n)
    prio = ""
    for v in (c.get("issueFieldValues") or {}).get("nodes", []):
        if (v.get("field") or {}).get("name") == "Priority":
            prio = v.get("name") or ""
    rows.append((fv.get("Timeline", ""), fv.get("Status", ""),
                 (c.get("issueType") or {}).get("name", ""), prio, c["number"], c["title"]))

when_order = {"Now": 0, "Soon": 1, "Later": 2}
prio_order = {"Urgent": 0, "High": 1, "Medium": 2, "Low": 3}
rows.sort(key=lambda r: (when_order.get(r[0], 4), prio_order.get(r[3], 4), -r[4]))
print("%-6s %-7s %-8s %-12s %-6s %s" % ("WHEN", "PRIO", "TYPE", "STATUS", "ISSUE", "TITLE"))
for when, status, typ, prio, num, title in rows:
    print("%-6s %-7s %-8s %-12s %-6s %s" % (when or "-", prio or "-", typ or "-", status or "-", "#%d" % num, title[:48]))

# The reconciliation. `orphans` reads the board through a different API and a
# different limit, so the two commands could previously contradict each other
# in the same breath — one reporting every open issue on the board while the
# other silently omitted 23 of them. This makes that impossible to miss.
shown = {r[4] for r in rows}
# Capped the same way the board read is, and for the same reason: a silently
# truncated count here would make the reconciliation itself the thing that
# lies. Executed during review against a mock with 501 open issues: the old
# `--limit 500` printed "500 shown, 500 open" with no warning while `orphans`
# reported #501 missing — the exact two-commands-disagree symptom this fix
# exists to end, reappearing inside the fix.
ISSUE_LIMIT = int(os.environ["BOARD_LIMIT"])
open_issues = run([GH, "issue", "list", "--repo", REPO, "--state", "open",
                   "--limit", str(ISSUE_LIMIT), "--json", "number"])
if len(open_issues) >= ISSUE_LIMIT:
    sys.stderr.write("error: gh issue list returned %d issues, at or above the --limit of %d; "
                     "raise BOARD_LIMIT in scripts/dev/issues.sh\n" % (len(open_issues), ISSUE_LIMIT))
    sys.exit(1)
missing = sorted({i["number"] for i in open_issues} - shown)
print()
print("%d shown, %d open in %s" % (len(shown), len(open_issues), REPO))
if missing:
    print("WARNING: %d open issue(s) not shown above." % len(missing))
    print("  Either they are not on the board (check: issues.sh orphans), or this")
    print("  listing truncated. Both have happened; the counts above say which.")
    print("  " + " ".join("#%d" % n for n in missing))
'
}

# Issue type (Bug / Feature / Task) is an org-level type, not a label — it is
# set through updateIssue, not `gh issue edit`.
ensure_org_types() {
  [ -n "$ORG_TYPES_JSON" ] && return 0
  ORG_TYPES_JSON="$(gh_retry api graphql -f query="{organization(login:\"$OWNER\"){issueTypes(first:20){nodes{id name}}}}")" \
    || die "could not read the org's issue types"
}

cmd_type() { # cmd_type <issue> <Bug|Feature|Task>
  local n="$1" want="$2" iid tid
  ensure_org_types
  iid="$(gh_retry issue view "$n" --repo "$REPO" --json id -q .id)" \
    || die "could not read #$n (gh issue view failed — see the error above)"
  [ -n "$iid" ] || die "#$n not found"
  tid="$(printf '%s' "$ORG_TYPES_JSON" \
    | python3 -c '
import sys, json
want = sys.argv[1].lower()
for t in json.load(sys.stdin)["data"]["organization"]["issueTypes"]["nodes"]:
    if t["name"].lower() == want:
        print(t["id"]); break
' "$want")"
  [ -n "$tid" ] || die "no issue type named '$want' (have: Bug, Feature, Task)"
  gh_retry api graphql -f query="mutation{updateIssue(input:{id:\"$iid\",issueTypeId:\"$tid\"}){issue{number issueType{name}}}}" >/dev/null \
    || die "could not set #$n type -> $want (gh api graphql mutation failed — see the error above)"
  echo "#$n  type -> $want"
}

# Priority is a native ORG-level issue field (Urgent/High/Medium/Low), not a
# project field and not a label. The project board column named "Priority" is
# derived from it and is read-only via the project API — writing it there fails
# with "Only custom fields can be updated". It goes through setIssueFieldValue.
ensure_org_fields() {
  [ -n "$ORG_FIELDS_JSON" ] && return 0
  ORG_FIELDS_JSON="$(gh_retry api graphql -f query="{organization(login:\"$OWNER\"){issueFields(first:20){nodes{... on IssueFieldSingleSelect{id name options{id name}}}}}}")" \
    || die "could not read the org's issue fields"
}

cmd_priority() { # cmd_priority <issue> <urgent|high|medium|low>
  local n="$1" want="$2" iid pf po
  ensure_org_fields
  iid="$(gh_retry api graphql -f query="{repository(owner:\"$OWNER\",name:\"rhizomorph\"){issue(number:$n){id}}}" --jq .data.repository.issue.id)" \
    || die "could not read #$n (gh api graphql failed — see the error above)"
  [ -n "$iid" ] || die "#$n not found"
  read -r pf po <<<"$(printf '%s' "$ORG_FIELDS_JSON" \
    | python3 -c '
import sys, json
want = sys.argv[1].lower()
for f in json.load(sys.stdin)["data"]["organization"]["issueFields"]["nodes"]:
    if f.get("name") == "Priority":
        for o in f["options"]:
            if o["name"].lower() == want:
                print(f["id"], o["id"])
' "$want")"
  [ -n "${po:-}" ] || die "no priority named '$want' (have: Urgent, High, Medium, Low)"
  gh_retry api graphql -f query="mutation{setIssueFieldValue(input:{issueId:\"$iid\",issueFields:[{fieldId:\"$pf\",singleSelectOptionId:\"$po\"}]}){clientMutationId}}" >/dev/null \
    || die "could not set #$n priority -> $want (gh api graphql mutation failed — see the error above)"
  echo "#$n  priority -> $want"
}

cmd_orphans() {
  local on_board
  # `ensure_board`, not the old `items="$(board_items)"`: a `die` inside a
  # command substitution only kills the subshell, so the cap check has to run
  # where its exit can actually stop the script.
  ensure_board
  on_board="$(printf '%s' "$BOARD_JSON" \
    | python3 -c 'import sys,json; [print(i["content"]["number"]) for i in json.load(sys.stdin).get("items",[]) if i.get("content",{}).get("number")]')"
  # Captured, not piped, same reason as fetch_board: a failing gh would hand
  # python an empty stdin and bury the real exit status under a JSONDecodeError
  # traceback. And checked against the cap, same reason as cmd_list's
  # reconciliation: open issues do not all live on the board — that is this
  # command's whole premise — so the board read surviving the cap does not
  # prove this read did.
  # `milestone` rides along on the SAME read rather than a second call. AGENTS.md
  # has always said "every issue must carry a milestone" and named THIS command
  # as what finds the ones that do not — which it did not do until 2026-09-02:
  # it compared against board membership only, so the rule read as enforced
  # while the command answered a different question and reported success. Four
  # issues had drifted milestone-less by the time anyone counted. The field is
  # free here (one `gh issue list`, already being made) and #581's whole subject
  # is how many times this script reads a remote, so adding a call would have
  # been the wrong fix even for a right check.
  local open_raw
  open_raw="$(gh_retry issue list --repo "$REPO" --state open --limit "$BOARD_LIMIT" --json number,title,milestone)" \
    || die "could not read open issues (gh issue list failed)"
  printf '%s' "$open_raw" \
    | python3 -c '
import sys, json
on = set(sys.argv[1].split())
limit = int(sys.argv[2])
issues = json.load(sys.stdin)
if len(issues) >= limit:
    sys.stderr.write("error: gh issue list returned %d issues, at or above the --limit of %d; raise BOARD_LIMIT in %s\n"
                     % (len(issues), limit, sys.argv[3]))
    sys.exit(1)

def label(i):
    return "  #%d %s" % (i["number"], i["title"][:70])

off_board = [i for i in issues if str(i["number"]) not in on]

# "Was the field read at all?" is decided ONCE, here, and every later line
# defers to it. An older gh, or a caller that trims the --json list, returns
# rows with no `milestone` key — and "not read" is a different fact from
# "read, and null". Collapsing them would report every open issue as drifted
# the day gh changes, which is a check reporting a verdict it did not earn.
#
# Decided over ALL rows, not `issues[0]`: gh emits a uniform shape so one row
# would do, but an empty list has no row 0 and must not silently answer "clean"
# for a question nobody could ask. An earlier draft here ALSO put a
# `"milestone" in i` guard on the comprehension below; it was dead code — this
# branch already returns before the list is consulted — and deleting it left
# every test green, which is how it was caught. One place decides, and it is
# this one.
field_read = bool(issues) and all("milestone" in i for i in issues)
no_milestone = [i for i in issues if i.get("milestone") is None]

# Two findings, two lines, never one merged verdict: an issue can be both, and
# a single "N orphans" count would hide which rule it broke. Each clean line
# names the thing it checked, so neither can be read as covering the other.
if not off_board:
    print("all open issues are on the board")
else:
    print("not on the board:")
    for i in off_board:
        print(label(i))

if not issues:
    print("no open issues — nothing to check for a milestone")
elif not field_read:
    print("milestone not read — this gh did not return the field, so nothing is claimed about it")
elif not no_milestone:
    print("all open issues carry a milestone")
else:
    print("no milestone:")
    for i in no_milestone:
        print(label(i))
' "$on_board" "$BOARD_LIMIT" "$0"
}

cmd_show() {
  # `gh issue view` with no --json runs gh's default query, which still asks
  # for repository.issue.projectCards (Projects classic) — an API the server
  # now refuses outright instead of returning empty. An explicit field list
  # builds the query from only what is requested, same as line ~270's
  # `--json id` a few functions up, so it never mentions Projects classic.
  local raw
  raw="$(gh_retry issue view "$1" --repo "$REPO" \
    --json number,title,state,url,labels,body,comments)" \
    || die "could not read issue #$1 (gh issue view failed)"
  printf '%s' "$raw" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("#%d  %s" % (d["number"], d["title"]))
print("state: %s" % d["state"])
labels = ", ".join(l["name"] for l in d.get("labels", []))
if labels:
    print("labels: %s" % labels)
print("url: %s" % d["url"])
print()
print(d.get("body") or "(no description)")
comments = d.get("comments") or []
if comments:
    print()
    print("--- comments (%d) ---" % len(comments))
    for c in comments:
        author = (c.get("author") or {}).get("login") or "?"
        print()
        print("@%s:" % author)
        print(c.get("body") or "")
'
  echo "--- board ---"
  # Match on the ISSUE token itself, not a fixed column: Status values include
  # "In progress" and "In review", which contain a space and shift every field
  # after STATUS by one when awk splits on whitespace. The old `$3==n` checked
  # the TYPE column and could never match; this checks for "#<n>" as a whole
  # whitespace-delimited token wherever the row happens to put it.
  cmd_list | awk -v n="#$1" 'NR==1 || $0 ~ ("[[:space:]]" n "[[:space:]]")'
}

cmd_close() {
  local n="$1"; shift
  [ $# -gt 0 ] || die "close needs a reason — an issue closed without one is a fact nobody can recover"
  gh_retry issue close "$n" --repo "$REPO" --comment "$*" \
    || die "could not close #$n (gh issue close failed — see the error above)"
}

# ── multi-issue writes ──────────────────────────────────────────────────────
# `when 548 549 550 now` — the value LAST, so `when 548 now` is unchanged.
#
# Which argument is which is checked, never assumed: every issue argument must
# be a bare number and the value must not be. Without that, a transposed
# `when now 548` would try to set Timeline to "548" on issue "now" — and the
# whole point of this script is that a wrong write to the board is quiet.
TARGETS=(); VALUE=""
split_targets() { # split_targets <subcommand> <usage-suffix> <arg>...
  local cmd="$1" suffix="$2"; shift 2
  [ $# -ge 2 ] || die "usage: $0 $cmd <issue>... $suffix"
  VALUE="${*: -1}"
  TARGETS=("${@:1:$#-1}")
  case "$VALUE" in
    *[!0-9]*) ;;
    *) die "usage: $0 $cmd <issue>... $suffix — the value goes last, not first" ;;
  esac
  local n
  for n in "${TARGETS[@]}"; do
    case "$n" in
      *[!0-9]*|'') die "'$n' is not an issue number (usage: $0 $cmd <issue>... $suffix)" ;;
    esac
  done
}

# ── batch ───────────────────────────────────────────────────────────────────
# "<issue> <when> <status> [priority] [type]" per line, `-` to skip a field.
# The whole reason this exists: it resolves the board and the field ids ONCE
# and then writes, instead of paying a full board read per field per issue.
#
# Two deliberate shapes:
#   * the reads happen BEFORE the first write, so a truncated board aborts with
#     nothing written rather than half-writing and then dying;
#   * one bad line does not abandon the rest. Each write runs in a subshell so
#     its `die` cannot kill the run, and the failures are re-listed at the end
#     with a non-zero exit. A batch that stops at line 3 of 28 leaves the
#     operator with the same problem #581 is about.
cmd_batch() {
  ensure_board
  ensure_fields
  local line="" n="" when="" status="" prio="" typ="" extra=""
  local lineno=0 ok=0 bad=0
  local spec field value
  local -a failures=()
  local -a writes=()
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    line="${line%%#*}"
    read -r n when status prio typ extra <<<"$line" || true
    if [ -z "${n:-}" ]; then continue; fi
    case "$n" in
      *[!0-9]*)
        failures+=("line $lineno: '$n' is not an issue number"); bad=$((bad + 1)); continue ;;
    esac
    if [ -n "${extra:-}" ]; then
      failures+=("line $lineno: too many fields — <issue> <when> <status> [priority] [type]")
      bad=$((bad + 1)); continue
    fi
    writes=()
    if [ "${when:--}"   != "-" ]; then writes+=("Timeline|$when"); fi
    if [ "${status:--}" != "-" ]; then writes+=("Status|${status//-/ }"); fi
    if [ "${prio:--}"   != "-" ]; then writes+=("priority|$prio"); fi
    if [ "${typ:--}"    != "-" ]; then writes+=("type|$typ"); fi
    if [ ${#writes[@]} -eq 0 ]; then
      failures+=("line $lineno: #$n names no fields to set")
      bad=$((bad + 1)); continue
    fi
    for spec in "${writes[@]}"; do
      field="${spec%%|*}"; value="${spec#*|}"
      # `if ( ... )`: the subshell keeps a `die` from killing the run, and the
      # `if` keeps errexit from doing the same. stdin is closed for the write
      # because the loop is reading it — a `gh` that decided to consume stdin
      # would otherwise eat the rest of the batch.
      #
      # The `ensure_*` runs in the PARENT, before the subshell: warmed inside
      # it, the cache would die with the subshell and every line would pay the
      # lookup again — the exact per-write cost #581 is about, reintroduced one
      # level down.
      case "$field" in
        priority) ensure_org_fields
                  if ( cmd_priority "$n" "$value" ) </dev/null; then ok=$((ok + 1))
                  else failures+=("line $lineno: #$n priority -> $value failed"); bad=$((bad + 1)); fi ;;
        type)     ensure_org_types
                  if ( cmd_type "$n" "$value" ) </dev/null; then ok=$((ok + 1))
                  else failures+=("line $lineno: #$n type -> $value failed"); bad=$((bad + 1)); fi ;;
        *)        if ( set_select "$n" "$field" "$value" ) </dev/null; then ok=$((ok + 1))
                  else failures+=("line $lineno: #$n $field -> $value failed"); bad=$((bad + 1)); fi ;;
      esac
    done
  done
  echo "── batch: $ok write(s) applied, $bad failed ──"
  if [ "$bad" -gt 0 ]; then
    printf '  %s\n' "${failures[@]}" >&2
    exit 1
  fi
}

case "${1:-}" in
  list)    cmd_list ;;
  when)    shift; split_targets when "<now|soon|later>" "$@"
           for n in "${TARGETS[@]}"; do set_select "$n" Timeline "$VALUE"; done ;;
  type)    shift; split_targets type "<bug|feature|task>" "$@"
           for n in "${TARGETS[@]}"; do cmd_type "$n" "$VALUE"; done ;;
  priority) shift; split_targets priority "<urgent|high|medium|low>" "$@"
           for n in "${TARGETS[@]}"; do cmd_priority "$n" "$VALUE"; done ;;
  status)  shift; split_targets status "<backlog|ready|in-progress|in-review|done>" "$@"
           for n in "${TARGETS[@]}"; do set_select "$n" Status "$(echo "$VALUE" | tr '-' ' ')"; done ;;
  batch)   [ $# -eq 1 ] || die "usage: $0 batch   # reads '<issue> <when> <status> [priority] [type]' lines on stdin"
           cmd_batch ;;
  show)    [ $# -eq 2 ] || die "usage: $0 show <issue>"; cmd_show "$2" ;;
  close)   shift; [ $# -ge 1 ] || die "usage: $0 close <issue> \"reason\""; cmd_close "$@" ;;
  orphans) cmd_orphans ;;
  ids)     ensure_fields; printf '%s\n' "$FIELDS_TSV" ;;
  *)       sed -n '2,/^# END-USAGE$/p' "$0" | grep -v '^# END-USAGE$' | sed 's/^# \{0,1\}//' ;;
esac
