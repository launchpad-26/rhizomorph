#!/bin/bash
# soak.sh <pid|--spawn> <hours> [interval-seconds] — unattended resource soak (#213).
#
# Samples RSS, CPU% and open-fd count of the target process on an interval,
# writing a CSV and a summary. The one rule that matters (#213's own): a
# crashed target is a FAILED soak, said in the exit status and the first line
# of the summary — never a silent truncation that reads as a clean run.
#
#   scripts/dev/soak.sh 12345 8          # watch an already-running server for 8h
#   scripts/dev/soak.sh --spawn 1 30     # spawn `npm start`, sample every 30s for 1h
#
# Output: soak-<start-epoch>.csv / soak-<start-epoch>.summary.txt in $PWD.
set -uo pipefail

[ $# -lt 2 ] && { echo "usage: soak.sh <pid|--spawn> <hours> [interval-seconds]"; exit 2; }
TARGET=$1; HOURS=$2; INTERVAL=${3:-60}

case "$HOURS" in (''|*[!0-9.]*) echo "hours must be numeric, got '$HOURS'"; exit 2;; esac
case "$INTERVAL" in (''|*[!0-9]*) echo "interval must be integer seconds, got '$INTERVAL'"; exit 2;; esac

SPAWNED=""
if [ "$TARGET" = "--spawn" ]; then
  npm start > /tmp/soak-server.log 2>&1 &
  PID=$!
  SPAWNED=yes
  sleep 5
else
  PID=$TARGET
fi
kill -0 "$PID" 2>/dev/null || { echo "SOAK FAILED: no process $PID"; exit 1; }

START=$(date +%s)
END=$(awk -v s="$START" -v h="$HOURS" 'BEGIN { printf "%d", s + h * 3600 }')
CSV="soak-$START.csv"
SUM="soak-$START.summary.txt"
echo "epoch,elapsed_s,rss_kb,cpu_pct,fds" > "$CSV"

echo "soaking pid $PID for ${HOURS}h, sampling every ${INTERVAL}s -> $CSV"

FAILED=""
SAMPLES=0
FIRST_RSS=""
LAST_RSS=""
while [ "$(date +%s)" -lt "$END" ]; do
  if ! kill -0 "$PID" 2>/dev/null; then FAILED=yes; break; fi
  NOW=$(date +%s)
  RSS=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')
  CPU=$(ps -o %cpu= -p "$PID" 2>/dev/null | tr -d ' ')
  FDS=$(ls "/proc/$PID/fd" 2>/dev/null | wc -l)
  [ -z "$RSS" ] && { FAILED=yes; break; }
  echo "$NOW,$((NOW - START)),$RSS,$CPU,$FDS" >> "$CSV"
  SAMPLES=$((SAMPLES + 1))
  [ -z "$FIRST_RSS" ] && FIRST_RSS=$RSS
  LAST_RSS=$RSS
  sleep "$INTERVAL"
done

{
  if [ -n "$FAILED" ]; then
    echo "RESULT: FAILED — target pid $PID died after $SAMPLES samples ($(( ($(date +%s) - START) / 60 )) min). A crashed soak is a failed soak."
  else
    echo "RESULT: COMPLETED — $SAMPLES samples over ${HOURS}h."
  fi
  echo "pid: $PID (spawned: ${SPAWNED:-no})"
  echo "started: $(date -d "@$START" 2>/dev/null || date -r "$START")"
  if [ -n "$FIRST_RSS" ] && [ -n "$LAST_RSS" ]; then
    echo "rss first sample: ${FIRST_RSS} kB"
    echo "rss last sample:  ${LAST_RSS} kB"
    echo "rss growth:       $((LAST_RSS - FIRST_RSS)) kB"
  fi
  echo "csv: $CSV"
} > "$SUM"

cat "$SUM"
[ -n "$SPAWNED" ] && kill "$PID" 2>/dev/null
[ -n "$FAILED" ] && exit 1
exit 0
