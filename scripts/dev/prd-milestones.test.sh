#!/usr/bin/env bash
# prd-milestones.test.sh — mocks `gh` on PATH, same pattern as
# prd-reconcile.test.sh: this script's whole job is to shell out to `gh` and
# write a file, so a mock request/response pair is enough surface to cover it
# without a real network call.
#
# Run it:  bash scripts/dev/prd-milestones.test.sh
set -uo pipefail

root=$(git rev-parse --show-toplevel) || exit 2
SCRIPT="$root/scripts/dev/prd-milestones.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
has() { case "$3" in *"$2"*) ok "$1";; *) bad "$1" "expected to contain [$2], got: $3";; esac; }

# ── the mock `gh` ────────────────────────────────────────────────────────────
# The script's only call is `gh api repos/:owner/:repo/milestones -X GET -f
# state=all --paginate -q '<jq filter producing title\tstate\tclosed_at rows>'`.
# Mirrors prd-reconcile.test.sh's mock-gh pattern: MOCK_ROWS is already the
# post-`jq` tab-separated output the real `gh api -q` would have produced, so
# the mock does not need a real `jq` on PATH to apply the filter itself.
# MOCK_GH_FAIL=1 makes it fail loudly instead.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
if [ "$1" = "api" ]; then
  if [ "${MOCK_GH_FAIL:-0}" = 1 ]; then
    echo "error connecting to api.github.com" >&2
    exit 1
  fi
  # The one thing worth asserting from argv, rather than trusting the call
  # blindly: the two real defects this script's own comment names — state=all
  # requires -X GET (otherwise `gh api` POSTs and hits "create a milestone"
  # instead of listing), and the endpoint is milestones.
  case "$*" in
    *"milestones"*) case "$*" in *"-X GET"*) : ;; *) echo "prd-milestones.test.sh mock gh: missing -X GET (would POST, not list): $*" >&2; exit 1 ;; esac ;;
    *) echo "prd-milestones.test.sh mock gh: unexpected invocation: $*" >&2; exit 1 ;;
  esac
  case "$*" in
    *"state=all"*) : ;;
    *) echo "prd-milestones.test.sh mock gh: missing state=all: $*" >&2; exit 1 ;;
  esac
  # MOCK_RAW_JSON=1: instead of replaying already-filtered rows, hand the
  # script's OWN `-q` expression to jq against raw milestone JSON. Without this
  # the jq title filter was never exercised at all — deleting
  # `select(.title | test("^prd[0-9]+$"))` from the script left this suite
  # reporting "11 passed, 0 failed", because the mock supplied rows that were
  # already filtered. The filter is the only thing keeping `charter-laws` and
  # any other non-numeric milestone out of the manifest, so it needs a test that
  # can fail when it is removed.
  if [ "${MOCK_RAW_JSON:-0}" = 1 ]; then
    q=""; prev=""
    for a in "$@"; do [ "$prev" = "-q" ] && q="$a"; prev="$a"; done
    [ -n "$q" ] || { echo "mock gh: no -q expression in argv" >&2; exit 1; }
    printf '%s' "${MOCK_JSON:-[]}" | jq -r "$q"
    # Propagate jq's OWN status. `exit 0` discarded it, so a syntactically broken
    # filter surfaced as the generator's data-protection refusal instead — the
    # emptiness guard taking the blame for a jq error, with jq's diagnostic lost.
    exit "${PIPESTATUS[1]}"
  fi
  printf '%s\n' "${MOCK_ROWS:-}"
  exit 0
fi
echo "prd-milestones.test.sh mock gh: unhandled call: $*" >&2
exit 1
MOCK
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"

# The glob-hazard fixture: a non-numeric milestone (`charter-laws`, real title
# in this repo) would never survive the real jq filter (`^prd[0-9]+$`), so it
# has no business reaching this script at all — proving that is `-q`'s job,
# not this script's, and the real filter is exercised for real against the
# actual repo in the raw-JSON filter run below. What THIS fixture must prove is what
# a real filtered response feeds the script: one open and one closed `prdNN`,
# and a closed one whose number is a single digit — proving the strip-prefix
# sort is NUMERIC, not lexical (`prd9` must sort before `prd10`, not after it).
export MOCK_ROWS=$'prd10\topen\t-\nprd9\tclosed\t2026-01-02T03:04:05Z\nprd25\tclosed\t2026-09-07T05:10:31Z'

work="$tmp/work"
mkdir -p "$work/.swarm"
git init -q "$work"

run() { OUT=$(cd "$work" && bash "$SCRIPT" "$@" 2>&1); RC=$?; }

echo "── prd-milestones.sh: writes the manifest ──"
run
manifest="$work/.swarm/prd-milestones.txt"
[ -f "$manifest" ] && ok "manifest file created" || bad "manifest file created" "not found at $manifest"
text=$(cat "$manifest" 2>/dev/null)

is_line() { # is_line <label> <line>
  grep -qxF "$2" <<<"$text" && ok "$1" || bad "$1" "expected line [$2] in:\n$text"
}

is_line "prd9 (single digit) is closed, with its date"      $'9\tclosed\t2026-01-02T03:04:05Z'
is_line "prd10 is open, with a dash for closed_at"          $'10\topen\t-'
is_line "prd25 is closed, with its date"                    $'25\tclosed\t2026-09-07T05:10:31Z'

# The numeric-sort assertion the fixture above is FOR: prd9 must print before
# prd10 despite "10" < "9" lexically. A lexical sort on the un-stripped
# `prd9`/`prd10` titles happens to agree (the shared "prd" prefix ties, then
# "1" < "9" byte-wise) — so this only distinguishes the two orderings once the
# `prd` prefix is stripped first, which is what the script actually does.
nine_line=$(grep -n '^9	' <<<"$text" | cut -d: -f1)
ten_line=$(grep -n '^10	' <<<"$text" | cut -d: -f1)
if [ -n "$nine_line" ] && [ -n "$ten_line" ] && [ "$nine_line" -lt "$ten_line" ]; then
  ok "sorted numerically: prd9 before prd10"
else
  bad "sorted numerically: prd9 before prd10" "9 at line $nine_line, 10 at line $ten_line"
fi

has "carries a generated-at header" "generated-at:" "$text"
has "generated-at looks like an ISO-8601 UTC timestamp" \
  "$(grep -oE '# generated-at: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z' <<<"$text")" \
  "$text"

echo ""
echo "── prd-milestones.sh: a gh failure is not written over the existing manifest ──"
echo "sentinel: an existing manifest from a prior good run" > "$manifest"
MOCK_GH_FAIL=1 run
is_gone_untouched() {
  [ "$(cat "$manifest")" = "sentinel: an existing manifest from a prior good run" ] \
    && ok "manifest left untouched on gh failure" \
    || bad "manifest left untouched on gh failure" "manifest was overwritten: $(cat "$manifest")"
}
is_gone_untouched
[ "$RC" -ne 0 ] && ok "gh failure: non-zero exit" || bad "gh failure: non-zero exit" "got 0"
has "gh failure: carries gh's own stderr" "error connecting to api.github.com" "$OUT"

echo ""
echo "── prd-milestones.sh: a SUCCESSFUL gh call that matched nothing must not destroy the manifest ──"
echo "sentinel: an existing manifest from a prior good run" > "$manifest"
MOCK_ROWS="" run
[ "$(cat "$manifest")" = "sentinel: an existing manifest from a prior good run" ] \
  && ok "empty-but-successful gh: manifest left untouched" \
  || bad "empty-but-successful gh: manifest left untouched" "manifest was overwritten: $(cat "$manifest")"
[ "$RC" -ne 0 ] && ok "empty-but-successful gh: non-zero exit" || bad "empty-but-successful gh: non-zero exit" "got 0 — the script claimed success having written nothing"
has "empty-but-successful gh: says what to do" "refusing to overwrite" "$OUT"

echo ""
echo "── prd-milestones.sh: the jq title filter actually excludes non-prdNN milestones ──"
MOCK_JSON='[{"title":"prd25","state":"closed","closed_at":"2026-08-01T00:00:00Z"},{"title":"charter-laws","state":"open","closed_at":null},{"title":"prd14","state":"open","closed_at":null},{"title":"PRD99","state":"open","closed_at":null},{"title":"prd9x","state":"open","closed_at":null},{"title":"xprd9","state":"open","closed_at":null},{"title":"prd57\n","state":"open","closed_at":null}]'
export MOCK_JSON
MOCK_RAW_JSON=1 run
[ "$RC" -eq 0 ] && ok "raw-JSON run succeeds" || bad "raw-JSON run succeeds" "exit $RC: $OUT"
body_only=$(grep -v '^#' "$manifest")
case "$body_only" in *charter-laws*) bad "jq filter excludes charter-laws" "charter-laws reached the manifest" ;; *) ok "jq filter excludes charter-laws" ;; esac
case "$body_only" in *PRD99*) bad "jq filter excludes PRD99 (wrong case)" "PRD99 reached the manifest" ;; *) ok "jq filter excludes PRD99 (wrong case)" ;; esac
# Grep the POST-sed spelling. `prd9x` is the pre-sed TITLE; the script strips the
# `prd` prefix at write time, so a leaked row lands as `9x` and an assertion looking
# for `prd9x` can never fire. Measured: loosening the filter's trailing anchor left
# this suite 20/20 green while writing a bogus `9x` row.
# no_key <label> <key> — asserts no ROW begins with that key. The earlier form
# globbed the whole body, so an ordinary fixture edit (a closed_at ending :57Z)
# accused the anchor of a defect it does not have and pointed the next reader at
# the one line of the script that is correct. The claim is about a row, so the
# assertion is about a row — same reasoning as is_line above.
no_key() {
  if grep -qE "^$2([^0-9]|$)" <<<"$body_only"; then
    bad "$1" "a row keyed $2 reached the manifest:\n$body_only"
  else
    ok "$1"
  fi
}
no_key "jq filter excludes prd9x (trailing junk)" "9x"
no_key "jq filter excludes xprd9 (leading junk)" "xprd9"
no_key "jq filter excludes a trailing-newline title (anchor must be \\z, not \$)" "57"
has "jq filter keeps prd25 as key 25" "25	closed" "$body_only"
has "jq filter keeps prd14 as key 14" "14	open" "$body_only"
unset MOCK_JSON

echo ""
echo "── prd-milestones.sh: refuses arguments (it regenerates the whole manifest, not one PRD) ──"
run 25
[ "$RC" -eq 2 ] && ok "rejects an argument, exit 2" || bad "rejects an argument, exit 2" "got $RC"

echo ""
echo "──"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
