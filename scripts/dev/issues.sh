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
#   scripts/dev/issues.sh when <n> <now|soon|later>
#   scripts/dev/issues.sh type <n> <bug|feature|task>
#   scripts/dev/issues.sh priority <n> <urgent|high|medium|low>
#   scripts/dev/issues.sh status <n> <backlog|ready|in-progress|in-review|done>
#   scripts/dev/issues.sh show <n>                # issue body + board fields
#   scripts/dev/issues.sh close <n> "reason"      # close WITH a comment, never silently
#   scripts/dev/issues.sh orphans                 # open issues missing from the board
#   scripts/dev/issues.sh ids                     # field/option ids (for debugging)
#
# ponytail: ids are resolved from the API each run rather than cached here. One
# extra call per invocation buys immunity to someone renaming an option in the
# GitHub UI — a stale hardcoded id fails by silently writing the wrong column,
# which is exactly the quiet wrongness this repo's own reviews keep finding.
#
# Note Timeline is a MULTI-select, so its value goes through
# `multiSelectOptionIds` (a list), not `singleSelectOptionId`. Sending the
# single-select shape to it fails with `argumentNotAccepted`. `when` sets
# exactly one option, which is the intended use.
set -euo pipefail

OWNER="launchpad-26"
REPO="launchpad-26/rhizomorph"
PROJECT=19
PROJECT_ID="PVT_kwDOEnEMsM4Bfk9Q"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH"; }
need gh
need python3

# "<field>\t<field-id>\t<kind>\t<option>\t<option-id>" per option.
# kind is SINGLE or MULTI — the mutation shape differs between them.
fields() {
  gh api graphql -f query="{node(id:\"$PROJECT_ID\"){... on ProjectV2{fields(first:50){nodes{
      __typename
      ... on ProjectV2SingleSelectField{id name options{id name}}
      ... on ProjectV2MultiSelectField{id name multiSelectOptions{id name}}
    }}}}}" \
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

field_id()   { fields | awk -F'\t' -v f="$1" 'tolower($1)==tolower(f){print $2; exit}'; }
field_kind() { fields | awk -F'\t' -v f="$1" 'tolower($1)==tolower(f){print $3; exit}'; }
option_id()  { fields | awk -F'\t' -v f="$1" -v o="$2" 'tolower($1)==tolower(f) && tolower($4)==tolower(o){print $5; exit}'; }

item_id() {
  gh project item-list "$PROJECT" --owner "$OWNER" --limit 200 --format json \
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
  item="$(item_id "$issue")"; [ -n "$item" ] || die "#$issue is not on project $PROJECT (see: $0 orphans)"
  fid="$(field_id "$field")";  [ -n "$fid" ] || die "no field named '$field'"
  kind="$(field_kind "$field")"
  oid="$(option_id "$field" "$opt")"; [ -n "$oid" ] || die "'$field' has no option '$opt'"

  if [ "$kind" = "MULTI" ]; then
    value="{multiSelectOptionIds:[\"$oid\"]}"
  else
    value="{singleSelectOptionId:\"$oid\"}"
  fi

  gh api graphql -f query="mutation{updateProjectV2ItemFieldValue(input:{projectId:\"$PROJECT_ID\",itemId:\"$item\",fieldId:\"$fid\",value:$value}){projectV2Item{id}}}" >/dev/null
  echo "#$issue  $field -> $opt"
}

# `gh project item-list --format json` returns only `status` — it does not
# surface multi-select values at all, so Timeline reads have to go through
# GraphQL. Issue type comes from the same query rather than a second round trip.
cmd_list() {
  gh api graphql -f query="{node(id:\"$PROJECT_ID\"){... on ProjectV2{items(first:100){nodes{
      content{... on Issue{number title state issueType{name}
        issueFieldValues(first:10){nodes{... on IssueFieldSingleSelectValue{name field{... on IssueFieldSingleSelect{name}}}}}}}
      fieldValues(first:20){nodes{
        __typename
        ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}
        ... on ProjectV2ItemFieldMultiSelectValue{options{name} field{... on ProjectV2FieldCommon{name}}}
      }}
  }}}}}" \
    | python3 -c '
import sys, json

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

nodes = json.load(sys.stdin)["data"]["node"]["items"]["nodes"]
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
'
}

# Issue type (Bug / Feature / Task) is an org-level type, not a label — it is
# set through updateIssue, not `gh issue edit`.
cmd_type() { # cmd_type <issue> <Bug|Feature|Task>
  local n="$1" want="$2" iid tid
  iid="$(gh issue view "$n" --repo "$REPO" --json id -q .id)"
  [ -n "$iid" ] || die "#$n not found"
  tid="$(gh api graphql -f query="{organization(login:\"$OWNER\"){issueTypes(first:20){nodes{id name}}}}" \
    | python3 -c '
import sys, json
want = sys.argv[1].lower()
for t in json.load(sys.stdin)["data"]["organization"]["issueTypes"]["nodes"]:
    if t["name"].lower() == want:
        print(t["id"]); break
' "$want")"
  [ -n "$tid" ] || die "no issue type named '$want' (have: Bug, Feature, Task)"
  gh api graphql -f query="mutation{updateIssue(input:{id:\"$iid\",issueTypeId:\"$tid\"}){issue{number issueType{name}}}}" >/dev/null
  echo "#$n  type -> $want"
}

# Priority is a native ORG-level issue field (Urgent/High/Medium/Low), not a
# project field and not a label. The project board column named "Priority" is
# derived from it and is read-only via the project API — writing it there fails
# with "Only custom fields can be updated". It goes through setIssueFieldValue.
cmd_priority() { # cmd_priority <issue> <urgent|high|medium|low>
  local n="$1" want="$2" iid pf po
  iid="$(gh api graphql -f query="{repository(owner:\"$OWNER\",name:\"rhizomorph\"){issue(number:$n){id}}}" --jq .data.repository.issue.id)"
  [ -n "$iid" ] || die "#$n not found"
  read -r pf po <<<"$(gh api graphql -f query="{organization(login:\"$OWNER\"){issueFields(first:20){nodes{... on IssueFieldSingleSelect{id name options{id name}}}}}}" \
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
  gh api graphql -f query="mutation{setIssueFieldValue(input:{issueId:\"$iid\",issueFields:[{fieldId:\"$pf\",singleSelectOptionId:\"$po\"}]}){clientMutationId}}" >/dev/null
  echo "#$n  priority -> $want"
}

cmd_orphans() {
  local on_board
  on_board="$(gh project item-list "$PROJECT" --owner "$OWNER" --limit 200 --format json \
    | python3 -c 'import sys,json; [print(i["content"]["number"]) for i in json.load(sys.stdin).get("items",[]) if i.get("content",{}).get("number")]')"
  gh issue list --repo "$REPO" --state open --limit 200 --json number,title \
    | python3 -c '
import sys, json
on = set(sys.argv[1].split())
missing = [i for i in json.load(sys.stdin) if str(i["number"]) not in on]
if not missing:
    print("all open issues are on the board")
else:
    print("not on the board:")
    for i in missing:
        print("  #%d %s" % (i["number"], i["title"][:70]))
' "$on_board"
}

cmd_show() {
  gh issue view "$1" --repo "$REPO"
  echo "--- board ---"
  cmd_list | awk -v n="#$1" 'NR==1 || $3==n'
}

cmd_close() {
  local n="$1"; shift
  [ $# -gt 0 ] || die "close needs a reason — an issue closed without one is a fact nobody can recover"
  gh issue close "$n" --repo "$REPO" --comment "$*"
}

case "${1:-}" in
  list)    cmd_list ;;
  when)    [ $# -eq 3 ] || die "usage: $0 when <issue> <now|soon|later>"; set_select "$2" Timeline "$3" ;;
  type)    [ $# -eq 3 ] || die "usage: $0 type <issue> <bug|feature|task>"; cmd_type "$2" "$3" ;;
  priority) [ $# -eq 3 ] || die "usage: $0 priority <issue> <urgent|high|medium|low>"; cmd_priority "$2" "$3" ;;
  status)  [ $# -eq 3 ] || die "usage: $0 status <issue> <backlog|ready|in-progress|in-review|done>"
           set_select "$2" Status "$(echo "$3" | tr '-' ' ')" ;;
  show)    [ $# -eq 2 ] || die "usage: $0 show <issue>"; cmd_show "$2" ;;
  close)   shift; [ $# -ge 1 ] || die "usage: $0 close <issue> \"reason\""; cmd_close "$@" ;;
  orphans) cmd_orphans ;;
  ids)     fields ;;
  *)       sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
