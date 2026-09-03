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

# Git Bash on a Windows runner reports MINGW64_NT-*; MSYS2 proper MSYS_NT-*.
# Everything below that says "Windows" is keyed on this, not on any CI
# variable, so a hand run from a Git Bash prompt exercises the same branches.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ON_WINDOWS=1 ;;
  *) ON_WINDOWS="" ;;
esac
echo "pack-smoke: $(uname -s), bash $BASH_VERSION${ON_WINDOWS:+ — Windows: process control goes through WMI, see stop_jobs}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

[ -f packages/server/dist/cli/index.js ] || {
  echo "packages/server/dist/cli/index.js is missing — run 'npm run build' before this script"
  exit 1
}

WORK="$(mktemp -d)"

# The one token every process this script launches carries in its command
# line: the random basename of $WORK (…/tmp.XXXXXXXXXX). On Windows this is
# what the process query matches — never the full path, because MSYS hands
# node the 8.3 short-name and the long-name form of the same directory
# interchangeably (the hosted runner's TEMP is a short-name path, and the
# first Windows run showed both forms in one log), so a full-path match
# would miss one of them.
RUN_TOKEN="$(basename "$WORK")"

# Windows (Git Bash), measured rather than assumed on the first windows-latest
# run of this script (#211). The chain a boot launches there is: bash.exe (the
# subshell) -> bash.exe (the `npx` sh shim) -> native node.exe (npx-cli) ->
# native cmd.exe (npm runs a bin through the shell) -> native node.exe (the
# rhizomorph server). Every one of them carries $RUN_TOKEN in its command
# line — one of them in BOTH the 8.3 and the long form of the same temp dir at
# once, which is why the match is on the token and not on a path.
#
# What the POSIX path does there: `kill -TERM -$pgid` reaches the two MSYS bash
# processes, and the MSYS2 runtime Git for Windows ships takes their native
# child tree down with them — observed: the query below saw itself and nothing
# else of the run within a second of the group TERM. That is a property of the
# runtime, not of POSIX signals; nothing in this script can send a native
# console process a SIGTERM (`taskkill` without /F posts WM_CLOSE, which a
# console process ignores). So the WMI branches exist for two reasons: to
# TERMINATE whatever a runtime without that behaviour leaves behind, and to
# PROVE on every run that nothing survived — Git for Windows ships no `pgrep`,
# so without them verify_no_leak's "cannot verify" branch would return 0 on
# the one runner where a leak is likeliest.
#
# Rejected: `taskkill //T` from the MSYS pid (not the Windows pid); matching
# on $INSTALL_DIR's full path (8.3 vs long form, above); a pidfile or a kill
# route in the product (ADR-0001: the observer grows no surface so a smoke can
# kill it). Chosen: every process of THIS run carries $RUN_TOKEN, because
# every argument path lives under $WORK — so enumerate them through WMI.

# Windows only. One line per process whose command line names this run: its
# Windows PID, or the word `self` for the PowerShell process running the query
# — whose own command line carries the token by construction. That sentinel is
# what makes the query SELF-CHECKING: a working query returns at least `self`,
# so an empty result means the query itself failed (powershell.exe missing,
# quoting mangled by the MSYS argv rewrite, WMI unavailable) and is treated by
# every caller as a failure, never as "nothing running". The first Windows run
# had no sentinel, matched nothing, and reported clean — the one verdict a
# leak check must never reach by accident. stderr is folded into the output
# so a failure's reason is in the log, not discarded.
#
# WQL LIKE: `%` is the wildcard; the token is alphanumeric with one dot, so it
# needs no escaping. MSYS_NO_PATHCONV stops Git Bash rewriting anything
# slash-shaped in the argument as a path.
windows_run_query() {
  MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -NonInteractive -Command \
    "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%$RUN_TOKEN%'\" | ForEach-Object { if (\$_.ProcessId -eq \$PID) { 'self' } else { \$_.ProcessId } }" \
    2>&1 | tr -d '\r' || true
}

# True when a query result proves the query ran (see windows_run_query).
windows_query_ok() {
  printf '%s\n' "$1" | grep -qx 'self'
}

# The PIDs in a query result, one per line — everything but the sentinel.
windows_pids_in() {
  printf '%s\n' "$1" | grep -E '^[0-9]+$' || true
}

# The same query, rendered for a LEAK report: pid, parent, image, command line.
windows_run_report() {
  MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -NonInteractive -Command \
    "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%$RUN_TOKEN%'\" | Where-Object { \$_.ProcessId -ne \$PID } | Format-Table ProcessId, ParentProcessId, Name, CommandLine -AutoSize -Wrap | Out-String -Width 400" \
    2>/dev/null | tr -d '\r' || true
}

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
# Leaves its verdict in STOP_VERDICT, so a caller can report what happened
# instead of claiming a clean stop: `escalated` when the grace period ran out
# and SIGKILL was needed; `terminated` when native Windows processes had to be
# terminated through WMI; `unverified` when the WMI query itself failed;
# comma-joined when several apply; empty when TERM alone did it.
#
# A variable, NOT stdout read through `$(stop_jobs)`: a command substitution
# runs in a subshell, and the servers are children of the PARENT shell, so the
# subshell's `jobs -rp` never sees them change state (no SIGCHLD reaches it)
# and its `wait` has no children to wait on. Read that way, the grace loop
# always ran its full 10s and every boot reported "killed" — on every platform,
# including the runs where TERM had stopped the server in under a second.
# Found on the first Windows run of this script (#211) and true of the macOS
# and Linux legs before it.
stop_jobs() {
  local pgid waited=0 escalated="" terminated=""
  STOP_VERDICT=""
  for pgid in $(jobs -p); do
    kill -TERM -"$pgid" 2>/dev/null || true
  done
  if [ -n "$ON_WINDOWS" ]; then
    # Whatever the group TERM above left alive — on the hosted runner's Git
    # Bash that is nothing (the MSYS2 runtime takes the native child tree
    # down with the bash it kills; see the Windows note above
    # windows_run_query), but a runtime without that behaviour would leave
    # cmd.exe and the server node.exe orphaned. Stop-Process is
    # TerminateProcess — Windows offers a console process nothing gentler
    # from outside — so a stop that needed it is reported as `terminated`,
    # never as clean. One PowerShell call for the whole list, not one per pid
    # (joined with tr/sed: Git for Windows does not promise `paste`).
    local query pids
    query="$(windows_run_query)"
    if ! windows_query_ok "$query"; then
      terminated=unverified
      echo "stop_jobs: the WMI query FAILED (it did not even see itself); nothing native was terminated. Raw output:" >&2
      printf '%s\n' "$query" >&2
    else
      pids="$(windows_pids_in "$query" | tr '\n' ',' | sed 's/,$//')"
      if [ -n "$pids" ]; then
        terminated=terminated
        echo "stop_jobs: WMI matched pid(s) $pids naming $RUN_TOKEN — terminating:" >&2
        windows_run_report >&2
        MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -NonInteractive -Command \
          "Stop-Process -Id $pids -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
      else
        echo "stop_jobs: WMI matched no process naming $RUN_TOKEN (the query saw itself, so this is a real empty)" >&2
      fi
    fi
  fi
  while [ -n "$(jobs -rp)" ] && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if [ -n "$ON_WINDOWS" ] && [ -n "$(jobs -rp)" ]; then
    # Which MSYS process outlived both the group TERM and the WMI terminate:
    # `ps -ef` here is MSYS's own table (PID PPID PGID WINPID … COMMAND).
    echo "stop_jobs: MSYS job(s) still running after ${waited}s, sending KILL:" >&2
    jobs -l >&2 || true
    ps -ef >&2 || true
  fi
  for pgid in $(jobs -rp); do
    escalated=escalated
    kill -KILL -"$pgid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  STOP_VERDICT="${terminated}${terminated:+${escalated:+,}}${escalated}"
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
  if [ -n "$ON_WINDOWS" ]; then
    # Not pgrep: Git for Windows does not ship it, and the "cannot verify"
    # branch below would return 0 — a leak check that did not check, on the
    # runner where the leak is likeliest. The same WMI query stop_jobs used;
    # clean means it returns nothing.
    local query leaked="" i
    for i in $(seq 1 5); do
      query="$(windows_run_query)"
      if ! windows_query_ok "$query"; then
        # Not "clean" and not the pgrep branch's 0: on this runner the check
        # is the whole point of the leg, so a check that cannot run is red.
        echo "cannot verify: the WMI process query failed (it did not even see itself), so leaked processes were NOT checked for. Raw output:"
        printf '%s\n' "$query"
        return 1
      fi
      leaked="$(windows_pids_in "$query")"
      [ -z "$leaked" ] && break
      sleep 1
    done
    if [ -n "$leaked" ]; then
      echo "LEAK: process(es) of this run still alive after cleanup (command lines naming $RUN_TOKEN):"
      windows_run_report
      return 1
    fi
    echo "no leaked processes: clean (WMI: nothing names $RUN_TOKEN)"
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
  stop_jobs
  verify_no_leak || ec=1
  rm -rf "$WORK" || echo "pack-smoke: could not remove $WORK — a handle may still be held; the runner discards its temp dir with the job"
  exit "$ec"
}

# Clean up, then re-raise, so the shell dies of the signal and reports 128+N
# (143 for TERM) the way anything calling this script expects.
on_signal() {
  local sig="$1"
  trap - EXIT INT TERM
  echo "pack-smoke: caught SIG$sig — stopping servers and checking for leaks before exiting"
  stop_jobs
  verify_no_leak || true
  rm -rf "$WORK" || echo "pack-smoke: could not remove $WORK — a handle may still be held; the runner discards its temp dir with the job"
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
# On Windows npm writes a sh shim (what Git Bash runs) beside a .cmd (what
# cmd.exe and npx run); MSYS's `-x` is an emulation over a filesystem with
# no exec bit, so the honest check there is that both shims exist.
if [ -n "$ON_WINDOWS" ]; then
  { [ -f "$BIN" ] && [ -f "$BIN.cmd" ]; } || {
    echo "installed project lacks the rhizomorph sh shim and/or .cmd shim at $BIN"
    exit 1
  }
else
  [ -x "$BIN" ] || {
    echo "installed project has no executable rhizomorph bin at $BIN"
    exit 1
  }
fi

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

  # On Windows, show what the process query can see while the server is
  # provably alive (we just read /api/meta from it), so a later "matched no
  # process" can be read against this rather than guessed at.
  if [ -n "$ON_WINDOWS" ]; then
    echo "process tree naming $RUN_TOKEN before the stop ($label):"
    windows_run_report
  fi

  # The same bounded stop the exit paths use, so this one cannot hang on an
  # unbounded `wait` for a CLI that ignores TERM — and so "cleanly" is only
  # said when it was actually clean. Called directly, never as `$(stop_jobs)`:
  # see the note on stop_jobs for why a subshell cannot observe these jobs.
  stop_jobs
  case "$STOP_VERDICT" in
    "")
      if [ -n "$ON_WINDOWS" ]; then
        echo "server stopped on the group TERM ($label) — the MSYS2 runtime took the native tree down with it, and WMI confirms nothing of this run survived"
      else
        echo "server shut down cleanly ($label)"
      fi
      ;;
    terminated) echo "server terminated ($label) — Windows has no SIGTERM to send a console process from outside, so 'cleanly' cannot be claimed here" ;;
    terminated,escalated) echo "server terminated ($label) — Windows has no SIGTERM to send a console process from outside — and the MSYS job wrapper outlived it and needed KILL (see stop_jobs above)" ;;
    *unverified*) echo "server stop UNVERIFIED ($label) — the WMI query failed, see stop_jobs above; the leak check will fail on the same query" ;;
    *) echo "server did not stop on SIGTERM and was killed ($label)" ;;
  esac
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
