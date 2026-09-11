#!/usr/bin/env bash
# boot-smoke.sh — starts the built server, proves it serves the shell and
# answers /api/meta, and shuts it down cleanly. Extracted from the `Boot
# smoke` step of `.github/workflows/ci.yml`, which carried it inline; the
# checks and their timeouts are unchanged.
#
# Run after `npm run build` at the repo root. The caller owns that step, and
# it is load-bearing rather than tidiness: `packages/server/bin/rhizomorph.mjs`
# FALLS BACK to running TS source when `dist/` is absent, so this script boots
# something either way and a green result on an unbuilt tree says nothing
# about the built artifact. ci.yml gated this on Build's own outcome for that
# reason; `ci-local.sh` does the same.
#
# One deliberate difference from the workflow: the server log goes to a
# mktemp dir, not `server.log` in the repo root. A CI workspace is disposable
# and a developer's checkout is not — the workflow's version drops an
# untracked file next to your work.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/rhizo-boot-smoke.XXXXXX")
LOG="$LOGDIR/server.log"
echo "boot-smoke: log at $LOG"

npm start -- --port 0 > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

URL=""
for _ in $(seq 1 30); do
  if grep -q "rhizomorph running at" "$LOG"; then
    URL=$(grep -o 'http://[^ ]*' "$LOG" | head -n1)
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited before printing a listening URL:"
    cat "$LOG"
    exit 1
  fi
  sleep 1
done

if [ -z "$URL" ]; then
  echo "server did not print a listening URL within 30s:"
  cat "$LOG"
  exit 1
fi
echo "server listening at $URL"

# /api/meta is a gated-read (prd-29 ruling 7, #59) — a bare curl now 401s.
# Scrape the capability token off the served shell first, the same way
# `rhizomorph rotate`/`rhizomorph env` do (`cli/rotate.ts`'s
# `readCapabilityTokenFromHtml`: same attribute, same meta name), then carry
# it as the header the gate requires (`api/security.ts`'s
# `CAPABILITY_TOKEN_HEADER`).
TOKEN=""
for _ in $(seq 1 30); do
  SHELL_HTML=$(curl -sf "$URL/" || true)
  TOKEN=$(printf '%s' "$SHELL_HTML" | grep -o '<meta[^>]*name="rhizomorph-capability"[^>]*>' | grep -o 'content="[^"]*"' | sed -E 's/^content="(.*)"$/\1/')
  if [ -n "$TOKEN" ]; then
    break
  fi
  sleep 1
done

if [ -z "$TOKEN" ]; then
  echo "the page served at $URL/ never carried a rhizomorph-capability token within 30s:"
  cat "$LOG"
  exit 1
fi
echo "scraped the capability token off the served shell"

META_OK=""
for _ in $(seq 1 30); do
  if curl -sf -H "x-rhizomorph-capability: $TOKEN" "$URL/api/meta" -o "$LOGDIR/meta.json"; then
    META_OK=1
    break
  fi
  sleep 1
done

if [ -z "$META_OK" ]; then
  echo "/api/meta never answered within 30s (with the capability token attached):"
  cat "$LOG"
  exit 1
fi
echo "/api/meta responded 200"

ROOT_CONTENT_TYPE=$(curl -sI "$URL/" | grep -i '^content-type:' | tr -d '\r\n')
echo "/ responded with: $ROOT_CONTENT_TYPE"
case "$ROOT_CONTENT_TYPE" in
  *text/html*) ;;
  *)
    echo "expected / to return HTML, got: $ROOT_CONTENT_TYPE"
    cat "$LOG"
    exit 1
    ;;
esac

kill -TERM "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
trap - EXIT
rm -rf "$LOGDIR"
echo "server shut down cleanly"
