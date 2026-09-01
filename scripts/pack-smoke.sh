#!/usr/bin/env bash
# pack-smoke.sh — proves a stranger's `npm install` of the packed artifact
# actually runs, on THIS machine's Node, from the installed files (not the
# repo checkout). Run after `npm ci && npm run build` at the repo root; the
# workflow that calls this owns those steps so this script can focus on one
# thing: pack, install elsewhere, execute.
#
# Every path this touches lives under a mktemp dir outside the repo, so a
# stranger's `npm install` is exercised for real — no symlink back to the
# monorepo, no workspace resolution shortcut.
#
# `-m` (job control) is load-bearing: it gives each backgrounded server its
# own process group (pgid == its own pid), so `stop_jobs` below can kill that
# whole group — npx, the rhizomorph CLI, and anything it spawns — with one
# `kill -TERM -$pgid`, instead of only ever hitting the wrapper (#225: that
# gap is how six servers were leaked live). It also gives the exit paths a
# job table to read, which is what makes them independent of any variable this
# script remembers to set.
set -euo pipefail
set -m

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

[ -f packages/server/dist/cli/index.js ] || {
  echo "packages/server/dist/cli/index.js is missing — run 'npm run build' before this script"
  exit 1
}

WORK="$(mktemp -d)"

# Every background server this script starts, killed by process group.
#
# Read from **bash's own job table** rather than a hand-tracked `SERVER_PID`.
# A variable assigned after `&` has a window: a signal landing between the
# spawn and the assignment leaves nothing to kill — the #225 leak reproduced
# by the fix for it. The job table has no such window and cannot go stale.
# `set -m` (above) makes each job its own process group with pgid == pid, so
# the negative pid reaches npx, the CLI, and anything either of them spawned.
#
# Escalation lives here rather than only on the signal path: TERM, a bounded
# grace period, then KILL. A CLI that ignores TERM must not be able to hang
# this script on an unbounded `wait`.
#
# Echoes `escalated` when the grace period ran out and SIGKILL was needed, so
# a caller can report what happened instead of claiming a clean stop.
stop_jobs() {
  local pgid waited=0 escalated=""
  for pgid in $(jobs -p); do
    kill -TERM -"$pgid" 2>/dev/null || true
  done
  while [ -n "$(jobs -rp)" ] && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  for pgid in $(jobs -rp); do
    escalated=escalated
    kill -KILL -"$pgid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  printf '%s' "$escalated"
}

# The other half of what pack-smoke promises (#225): a server that answered
# correctly and then outlived the script is still a leak.
#
# A function, called from EVERY exit path, because the paths that matter most
# are the failing ones. As a straight-line block at the end of the script it
# only ran once everything else had passed — so a boot that timed out, a check
# that failed, or a CI timeout signalling the script all skipped the leak check
# at exactly the moment a leak was most likely.
#
# Non-zero when something is still alive, after a short grace period: a freshly
# TERMed process tree does not necessarily vanish instantly.
verify_no_leak() {
  echo "== verifying no leaked rhizomorph processes remain =="
  # The traps are armed long before `INSTALL_DIR` exists, so any failure in
  # between arrives here with nothing to search for. Answered explicitly:
  # without the guard, `set -u` kills the `pgrep` substitution, `leaked` comes
  # back empty, and this function prints "clean" — a false pass, which is the
  # one outcome a leak check must never produce.
  if [ -z "${INSTALL_DIR:-}" ]; then
    echo "nothing was installed yet, so nothing can have leaked"
    return 0
  fi
  if ! command -v pgrep >/dev/null 2>&1; then
    # A check that cannot run says so. Printing "clean" here would be this
    # instrument's own cardinal sin: silence reported as a verdict.
    echo "cannot verify: pgrep is unavailable here, so leaked processes were NOT checked for"
    return 0
  fi
  local leaked="" i
  for i in $(seq 1 5); do
    leaked="$(pgrep -f "$INSTALL_DIR" 2>/dev/null || true)"
    [ -z "$leaked" ] && break
    sleep 1
  done
  if [ -n "$leaked" ]; then
    echo "LEAK: process(es) still running under $INSTALL_DIR after cleanup:"
    # shellcheck disable=SC2086 # word splitting is wanted: one pid per -p
    ps -fp $leaked 2>/dev/null || true
    return 1
  fi
  echo "no leaked processes: clean"
  return 0
}

# Two handlers, not one function on three signals.
#
# `trap cleanup EXIT INT TERM` with `exit "$ec"` inside fires the handler
# TWICE on a signal — its own `exit` re-enters the EXIT trap — and reports the
# status of whatever command the signal interrupted rather than the signal.
# Measured: **exit 0 after SIGTERM**, on bash 5.2 as well as 3.2. A gate script
# that answers 0 because it was killed is a false green, which is worse than
# the leak this PR is about.
#
# Both handlers disarm every trap first, so neither can re-enter.
finish() {
  local ec=$?
  trap - EXIT INT TERM
  stop_jobs >/dev/null
  verify_no_leak || ec=1
  rm -rf "$WORK"
  exit "$ec"
}

# Clean up, then re-raise, so the shell dies of the signal and reports 128+N
# (143 for TERM) the way anything calling this script expects.
on_signal() {
  local sig="$1"
  trap - EXIT INT TERM
  echo "pack-smoke: caught SIG$sig — stopping servers and checking for leaks before exiting"
  stop_jobs >/dev/null
  verify_no_leak || true
  rm -rf "$WORK"
  kill "-$sig" $$
}

trap finish EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

TARBALLS="$WORK/tarballs"
mkdir -p "$TARBALLS"

ROOT_VERSION="$(node -p "require('./package.json').version")"

echo "== npm pack: root + every workspace =="
pack_log="$WORK/npm-pack.log"
{
  npm pack --pack-destination "$TARBALLS"
  for ws in packages/core packages/server packages/web; do
    npm pack --workspace "$ws" --pack-destination "$TARBALLS"
  done
} >"$pack_log" 2>&1 || {
  echo "npm pack failed:"
  cat "$pack_log"
  exit 1
}

TARBALL_COUNT="$(find "$TARBALLS" -name '*.tgz' | wc -l | tr -d ' ')"
[ "$TARBALL_COUNT" = "4" ] || {
  echo "expected 4 tarballs (root + 3 workspaces), found $TARBALL_COUNT:"
  ls -la "$TARBALLS"
  exit 1
}
echo "packed $TARBALL_COUNT tarballs"

ROOT_TARBALL="$TARBALLS/rhizomorph-$ROOT_VERSION.tgz"
[ -f "$ROOT_TARBALL" ] || {
  echo "expected $ROOT_TARBALL from the root pack — got:"
  ls -la "$TARBALLS"
  exit 1
}

echo "== npm install the root tarball into a clean project =="
INSTALL_DIR="$WORK/install-project"
mkdir -p "$INSTALL_DIR"
(cd "$INSTALL_DIR" && npm init -y >/dev/null && npm install "$ROOT_TARBALL" >/dev/null)

BIN="$INSTALL_DIR/node_modules/.bin/rhizomorph"
[ -x "$BIN" ] || {
  echo "installed project has no executable rhizomorph bin at $BIN"
  exit 1
}

echo "== rhizomorph --version, from the installed artifact, not the repo =="
INSTALLED_VERSION="$("$BIN" --version)"
[ "$INSTALLED_VERSION" = "$ROOT_VERSION" ] || {
  echo "installed --version ($INSTALLED_VERSION) != package.json ($ROOT_VERSION)"
  exit 1
}
echo "rhizomorph --version -> $INSTALLED_VERSION"

echo "== npx rhizomorph --version, resolved locally, no registry fetch =="
NPX_VERSION="$(cd "$INSTALL_DIR" && npx --no-install rhizomorph --version)"
[ "$NPX_VERSION" = "$ROOT_VERSION" ] || {
  echo "npx rhizomorph --version ($NPX_VERSION) != package.json ($ROOT_VERSION)"
  exit 1
}
echo "npx rhizomorph --version -> $NPX_VERSION"

# The roster `doctor` reports is data compiled into the bundle, not source text
# read off disk — and that distinction is only testable against the INSTALLED
# artifact, because the published package ships `dist/` and `bin/` and no
# `src/` at all. Review of #632 found a check that reported `ok` in all 6000+
# tests and `could not read the harness roster` on every real install; the
# suite could not see it, because vitest runs from `src/`, and nothing here ran
# `doctor` at all. This is the gate that closes that class.
echo "== rhizomorph doctor, from the installed artifact: the roster is readable, not merely reported on =="
DOCTOR_REPO="$WORK/doctor-repo"
mkdir -p "$DOCTOR_REPO"
git -C "$DOCTOR_REPO" init -q
DOCTOR_OUT="$WORK/doctor.log"
# Exit status is deliberately not asserted: `doctor` exits non-zero on genuine
# blockers (a port taken, no web build) and this smoke is about what it can
# READ, not about whether this throwaway directory is a healthy install.
(cd "$INSTALL_DIR" && npx --no-install rhizomorph doctor "$DOCTOR_REPO") >"$DOCTOR_OUT" 2>&1 || true
grep -q "harness roster: " "$DOCTOR_OUT" || {
  echo "installed doctor never reported the harness roster at all:"
  cat "$DOCTOR_OUT"
  exit 1
}
if grep -qi "could not read the harness roster" "$DOCTOR_OUT"; then
  echo "installed doctor cannot read the harness roster — it is reading source the package does not ship:"
  cat "$DOCTOR_OUT"
  exit 1
fi
echo "doctor -> $(grep -o 'harness roster: .*' "$DOCTOR_OUT" | head -n1)"

# Boots the installed CLI (via npx, exactly prd8's `npx rhizomorph
# <path-to-repo>` install story) against $1, waits for it to report a
# listening URL, hits /api/meta and /, then kills it immediately — a
# bounded probe, not a long-running server left for someone to notice. $2
# names the run for its log file and error messages.
boot_and_check() {
  local watch_path="$1"
  local label="$2"
  local log="$WORK/server-$label.log"

  echo "== boot check ($label): $watch_path =="
  mkdir -p "$watch_path"
  git -C "$watch_path" init -q

  (cd "$INSTALL_DIR" && exec npx --no-install rhizomorph "$watch_path" --port 0) \
    </dev/null >"$log" 2>&1 &
  local pid=$!

  local url=""
  local i
  for i in $(seq 1 30); do
    if grep -q "rhizomorph running at" "$log" 2>/dev/null; then
      url="$(grep -o 'http://[^ ]*' "$log" | head -n1)"
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "server exited before printing a listening URL ($label):"
      cat "$log"
      exit 1
    fi
    sleep 1
  done

  [ -n "$url" ] || {
    echo "server did not print a listening URL within 30s ($label):"
    cat "$log"
    exit 1
  }
  echo "server listening at $url"

  # /api/meta is a gated-read (prd-29 ruling 7, #59) — a bare curl now 401s.
  # Scrape the capability token off the served shell first, the same way
  # `rhizomorph rotate`/`rhizomorph env` do (`cli/rotate.ts`'s
  # `readCapabilityTokenFromHtml`: same attribute, same meta name), then
  # carry it as the header the gate requires (`api/security.ts`'s
  # `CAPABILITY_TOKEN_HEADER`).
  local token=""
  for i in $(seq 1 30); do
    local shell_html
    shell_html="$(curl -sf "$url/" || true)"
    token="$(printf '%s' "$shell_html" | grep -o '<meta[^>]*name="rhizomorph-capability"[^>]*>' | grep -o 'content="[^"]*"' | sed -E 's/^content="(.*)"$/\1/')"
    [ -n "$token" ] && break
    sleep 1
  done

  [ -n "$token" ] || {
    echo "the page served at $url/ never carried a rhizomorph-capability token within 30s ($label):"
    cat "$log"
    exit 1
  }
  echo "scraped the capability token off the served shell ($label)"

  local meta_ok=""
  for i in $(seq 1 30); do
    if curl -sf -H "x-rhizomorph-capability: $token" "$url/api/meta" -o "$WORK/meta-$label.json"; then
      meta_ok=1
      break
    fi
    sleep 1
  done

  [ -n "$meta_ok" ] || {
    echo "/api/meta never answered within 30s ($label):"
    cat "$log"
    exit 1
  }
  echo "/api/meta responded"

  local content_type
  content_type="$(curl -sI "$url/" | grep -i '^content-type:' | tr -d '\r\n')"
  case "$content_type" in
    *text/html*) ;;
    *)
      echo "expected / to return HTML ($label), got: $content_type"
      cat "$log"
      exit 1
      ;;
  esac

  # The same bounded stop the exit paths use, so this one cannot hang on an
  # unbounded `wait` for a CLI that ignores TERM — and so "cleanly" is only
  # said when it was actually clean.
  if [ -n "$(stop_jobs)" ]; then
    echo "server did not stop on SIGTERM and was killed ($label)"
  else
    echo "server shut down cleanly ($label)"
  fi
}

# The default case, then two path-robustness cases the audit named
# explicitly: a space and non-ASCII characters in the watched repo's path,
# exercised through the same installed-artifact, npx-driven boot path as
# every other check here.
boot_and_check "$WORK/watched/plain-repo" "plain"
boot_and_check "$WORK/watched/a repo with spaces" "spaces"
boot_and_check "$WORK/watched/café-世界-repo" "unicode"

# The leak check is NOT run here. `finish` runs it on the way out of every
# exit path, including the failing ones — see `verify_no_leak`. Running it here
# too would report twice on success and still miss every failure.
echo "pack-smoke: all checks passed"
