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
# own process group (pgid == its own pid), so the cleanup trap below can
# kill that whole group — npx, the rhizomorph CLI, and anything it spawns —
# with one `kill -TERM -$pid`, instead of only ever hitting the wrapper
# (#225: that gap is how six servers were leaked live).
set -euo pipefail
set -m

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

[ -f packages/server/dist/cli/index.js ] || {
  echo "packages/server/dist/cli/index.js is missing — run 'npm run build' before this script"
  exit 1
}

WORK="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  local ec=$?
  if [ -n "$SERVER_PID" ]; then
    kill -TERM -"$SERVER_PID" 2>/dev/null || true
    sleep 1
    kill -KILL -"$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  exit "$ec"
}
trap cleanup EXIT INT TERM

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
  SERVER_PID="$pid"

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

  local meta_ok=""
  for i in $(seq 1 30); do
    if curl -sf "$url/api/meta" -o "$WORK/meta-$label.json"; then
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

  kill -TERM -"$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  SERVER_PID=""
  echo "server shut down cleanly ($label)"
}

# The default case, then two path-robustness cases the audit named
# explicitly: a space and non-ASCII characters in the watched repo's path,
# exercised through the same installed-artifact, npx-driven boot path as
# every other check here.
boot_and_check "$WORK/watched/plain-repo" "plain"
boot_and_check "$WORK/watched/a repo with spaces" "spaces"
boot_and_check "$WORK/watched/café-世界-repo" "unicode"

# The assertions above are only half of what pack-smoke promises (#225): a
# server that answered correctly and then outlived the script is still a
# leak. Confirm, loudly, that nothing tied to this run's install is still
# alive before reporting success — allow a short grace period since a
# freshly TERMed process tree doesn't necessarily vanish instantly.
echo "== verifying no leaked rhizomorph processes remain =="
LEAKED=""
for i in $(seq 1 5); do
  LEAKED="$(pgrep -f "$INSTALL_DIR" 2>/dev/null || true)"
  [ -z "$LEAKED" ] && break
  sleep 1
done
if [ -n "$LEAKED" ]; then
  echo "LEAK: process(es) still running under $INSTALL_DIR after cleanup:"
  ps -fp $LEAKED 2>/dev/null || true
  exit 1
fi
echo "no leaked processes: clean"

echo "pack-smoke: all checks passed"
