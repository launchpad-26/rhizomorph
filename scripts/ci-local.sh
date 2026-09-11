#!/usr/bin/env bash
# ci-local.sh — the CI leg, on this machine. Runs what
# `.github/workflows/ci.yml` ran per leg, in the same order, with the same
# gating, against the tree you are standing in.
#
#   usage: scripts/ci-local.sh [--no-install] [--no-pack-smoke]
#
#     --no-install     reuse node_modules instead of `npm ci`. Faster, and
#                      LESS honest: `npm ci` is what catches a lockfile that
#                      has drifted from package.json. Use it while iterating,
#                      not for a verdict.
#     --no-pack-smoke  skip the tarball-install leg (the slow one).
#
# WHAT THIS IS NOT. It is one OS and one Node version — whichever you happen
# to be running. The workflow this replaces ran ubuntu + macOS at two Node
# legs, plus a native Windows suite, and the cross-platform coverage is the
# part no local script recovers:
#
#   * `case-collision-law.test.ts` exists because a macOS leg caught 16
#     failures that Linux's case-sensitive filesystem cannot see;
#   * `windows-suite.yml` and pack-smoke's Windows rows are prd-25's whole
#     deliverable, and nothing here witnesses them.
#
# So a green run of this script is evidence about YOUR platform, and silence
# about the other two. Say that when you report it.
#
# GATING mirrors the workflow deliberately, and the workflow's own comments
# say why: `Typecheck` and `Lint` ran under `if: !cancelled()`, so a red suite
# still left their evidence behind; the packaging guard and the boot smoke ran
# under `steps.build.outcome == 'success'`, because the guard passes vacuously
# over an empty dist/ and the boot smoke's bin falls back to TS source when
# dist/ is absent — both would report green having verified nothing.
set -uo pipefail

root=$(git rev-parse --show-toplevel) || { echo "ci-local: not in a git repo"; exit 2; }
cd "$root"

DO_INSTALL=1
DO_PACK_SMOKE=1
for arg in "$@"; do
  case "$arg" in
    --no-install)    DO_INSTALL=0 ;;
    --no-pack-smoke) DO_PACK_SMOKE=0 ;;
    -h|--help)       sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "ci-local: unknown argument '$arg'"; exit 2 ;;
  esac
done

RESULTS=""
FAILED=0
BUILD_OK=0

# Newline-separated "STATUS<TAB>NAME" rather than an array: this repo's macs
# run bash 3.2, where expanding an empty array under `set -u` aborts.
record() { RESULTS="${RESULTS}$1	$2
"; }

step() {
  name="$1"; shift
  echo
  echo "───────────────────────────────────────────────────────────"
  echo "  $name"
  echo "───────────────────────────────────────────────────────────"
  if "$@"; then
    echo "  ✓ $name"
    record "PASS" "$name"
    return 0
  fi
  echo "  ✗ $name"
  record "FAIL" "$name"
  FAILED=1
  return 1
}

skip() {
  echo
  echo "  — skipped: $1 ($2)"
  record "SKIP" "$1"
}

echo "ci-local: $(uname -s), node $(node --version), $(git rev-parse --short HEAD)"

if [ "$DO_INSTALL" -eq 1 ]; then
  step "Install (npm ci — clean, lockfile-honest)" npm ci || true
else
  skip "Install (npm ci)" "--no-install"
fi

if step "Build" npm run build; then BUILD_OK=1; fi

step "Test" npm test || true
step "Typecheck" npm run typecheck || true
step "Lint" npm run lint || true

if [ "$BUILD_OK" -eq 1 ]; then
  step "Packaging guard" node scripts/packaging-guard.mjs || true
  step "Boot smoke" bash scripts/boot-smoke.sh || true
  if [ "$DO_PACK_SMOKE" -eq 1 ]; then
    step "Pack smoke" bash scripts/pack-smoke.sh || true
  else
    skip "Pack smoke" "--no-pack-smoke"
  fi
else
  skip "Packaging guard" "Build red — it passes vacuously over an empty dist/"
  skip "Boot smoke"      "Build red — the bin falls back to TS source"
  skip "Pack smoke"      "Build red — nothing to pack"
fi

echo
echo "═══════════════════════════════════════════════════════════"
printf '%s' "$RESULTS" | while IFS='	' read -r status name; do
  [ -z "$status" ] && continue
  printf '  %-5s %s\n' "$status" "$name"
done
echo "═══════════════════════════════════════════════════════════"
echo "  platform witnessed: $(uname -s) / node $(node --version)"
echo "  NOT witnessed: the other two platforms and the min-node leg"

if [ "$FAILED" -ne 0 ]; then
  echo "  ci-local: RED"
  exit 1
fi
echo "  ci-local: green"
