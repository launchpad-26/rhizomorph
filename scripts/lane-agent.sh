#!/usr/bin/env bash
# Lane agent wrapper — telemetry env by construction (scar, 2026-08-04).
#
# History: the pane-command prefix in .workmux.yaml never reached the agent —
# workmux launches the agent outside the pane command's shell, so two rounds
# of prefix fixes changed nothing (proven by /proc/<agent>/environ: no OTel
# vars while the manual prefix worked). This wrapper is the fix that cannot
# regress that way: the env is resolved and eval'd IN THE SAME PROCESS that
# execs claude, so the agent inherits it by construction.
#
# Usage (dispatch.sh): workmux add <h> -a "bash scripts/lane-agent.sh <model>"
# workmux appends the prompt after our args; we pass everything through.
set -u
MODEL="${1:-sonnet}"
shift || true

OBS_MAIN=$(dirname "$(git rev-parse --git-common-dir)") \
  && OBS_ENV=$(node "$OBS_MAIN/packages/server/bin/rhizomorph.mjs" env "$(basename "$PWD")" --port 4321) \
  && eval "$OBS_ENV" \
  || echo "!! no rhizomorph env (server down on 127.0.0.1:4321, or main checkout unbuilt) — this lane runs UNINSTRUMENTED" >&2

exec claude --model "$MODEL" --dangerously-skip-permissions "$@"
