#!/usr/bin/env bash
# metrics.sh [days] — is the working agreement (#399) actually working?
#
# Splits cycle time into the two halves that behave differently:
#
#   open -> first review   the QUEUE. Nobody has looked yet. Measured at 81% of
#                          median cycle time over 2026-08-09..11, and it is a
#                          fixed per-PR toll — ~21h attaches to a PR regardless
#                          of its size (#275: 98 lines, 62h; #396: 1,235 lines,
#                          0.5h). Only fewer PRs moves it.
#   first review -> merge  the WORK. Median 4.8h. Not the problem.
#
# So the two numbers to watch are the queue share and issues-per-PR. If the
# queue share stays ~80% while issues-per-PR stays ~1.0, the bundling half of
# the agreement is not being applied.
set -euo pipefail

DAYS=${1:-7}
LIMIT=${LIMIT:-200}

command -v gh >/dev/null || { echo "metrics.sh: needs gh" >&2; exit 2; }
command -v jq >/dev/null || { echo "metrics.sh: needs jq" >&2; exit 2; }

# Portable epoch-seconds for "$DAYS ago": GNU date and BSD/macOS date disagree
# on every flag that matters, so ask the shell for now and subtract.
CUTOFF=$(( $(date +%s) - DAYS * 86400 ))

ROWS=$(gh pr list --state merged --limit "$LIMIT" \
  --json number,author,createdAt,mergedAt,reviews,body --jq '
  .[]
  | select(.mergedAt != null)
  | [ .number,
      .author.login,
      (.createdAt   | fromdateiso8601),
      (.mergedAt    | fromdateiso8601),
      ( (.reviews | map(.submittedAt) | sort | first) as $r
        | if $r == null then -1 else ($r | fromdateiso8601) end ),
      ( [ (.body // "") | scan("(?i)(?:closes|fixes|resolves) +#[0-9]+") ] | length )
    ]
  | @tsv')

[ -n "$ROWS" ] || { echo "no merged PRs found"; exit 0; }

printf '%s\n' "$ROWS" | awk -F'\t' -v cutoff="$CUTOFF" -v days="$DAYS" '
function median(a, n,   i, j, tmp) {
  if (n == 0) return -1
  # insertion sort: n is small (tens of PRs) and this keeps the script
  # dependency-free.
  for (i = 2; i <= n; i++) { tmp = a[i]; for (j = i - 1; j >= 1 && a[j] > tmp; j--) a[j+1] = a[j]; a[j+1] = tmp }
  return (n % 2) ? a[(n+1)/2] : (a[n/2] + a[n/2+1]) / 2
}
function h(s) { return s / 3600 }
$4 >= cutoff {
  total++
  issues += $6
  if ($6 == 0) noissue++
  if ($6 >= 2) bundled++
  if ($5 < 0) { unreviewed++; next }
  reviewed++
  q[reviewed] = $3 < 0 ? 0 : ($5 - $3)
  w[reviewed] = $4 - $5
  if (($5 - $3) > 86400) slow++
}
END {
  if (total == 0) { print "no merged PRs in the last " days " day(s)"; exit }
  mq = median(q, reviewed); mw = median(w, reviewed)
  printf "\n  merged PRs (last %d day%s): %d\n", days, (days == 1 ? "" : "s"), total
  printf "  reviewed: %d    merged with no review at all: %d\n\n", reviewed, unreviewed
  if (reviewed > 0) {
    printf "  %-28s %6.1f h   <- the queue\n", "median open -> 1st review", h(mq)
    printf "  %-28s %6.1f h   <- the work\n", "median 1st review -> merge", h(mw)
    if (mq + mw > 0) printf "  %-28s %5.0f %%\n", "QUEUE SHARE", mq / (mq + mw) * 100
    printf "  %-28s %6d      (of %d reviewed)\n\n", "waited > 24h for a look", slow, reviewed
  }
  printf "  %-28s %6.2f\n", "issues closed per PR", (total ? issues / total : 0)
  printf "  %-28s %6d\n", "PRs bundling 2+ issues", bundled
  printf "  %-28s %6d\n", "PRs closing no issue", noissue
  if (issues > 0) printf "  %-28s %6.2f      <- gate events per issue\n", "PRs per issue closed", total / issues
  printf "\n  baseline 2026-08-09..11: queue 81%%, 20.9h -> 4.8h, 0.84 issues/PR\n\n"
}'
