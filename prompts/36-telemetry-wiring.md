You are a worker agent building The Observatory (prd1: the money layer).
You own exactly one issue.

FIRST read, in order: docs/prd0.md, docs/prd1.md, docs/architecture.md,
and research/2026-07-30-telemetry-capture-routes.md (real payload shapes
your work must match).

YOUR ISSUE — #36 (36. CLI + dispatch wiring: --extra-sessions, observatory env, live lane-attr verify)

**Fence (may touch ONLY):** `packages/server/src/cli/**`, `packages/server/src/server/context.ts`, `.workmux.yaml`, `docs/telemetry.md` (new)
**Blocked by:** #34, #35 merged. **Model:** sonnet. **Wave:** 3

Wire telemetry into real operation.

- CLI: `--extra-sessions <dir>` (repeatable) feeding the sessionlog
  collector's extra-dirs config (for conductors on foreign filesystems, e.g.
  `/mnt/c/Users/<u>/.claude/projects/<slug>`); flag validated like the
  others (#30/#32 conventions: clean usage errors, no stack traces).
- `observatory env <lane>` subcommand printing the exact env block a lane (or
  conductor) needs: CLAUDE_CODE_ENABLE_TELEMETRY=1, OTLP endpoint pointed at
  this server's receiver, `OTEL_RESOURCE_ATTRIBUTES=lane=<lane>,role=<role>`.
- Add those env vars to this repo's `.workmux.yaml` so future lanes emit
  telemetry to the local Observatory automatically.
- `docs/telemetry.md`: enabling for workers (workmux), for a conductor
  (cross-machine note), subscription-dollars honesty note (from the prd).
- **LIVE VERIFY (the research note's one unrun claim):** run one real
  `claude -p` with `OTEL_RESOURCE_ATTRIBUTES=lane=test-lane` exporting to the
  running receiver; paste evidence that the stored event carries
  lane=test-lane.

**DoD:** green root test+typecheck; live-verify evidence in your summary;
fence respected. No NUL bytes; never push/merge; no git in sibling worktrees.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; NEVER switch branches, push, merge, or run git in a
sibling worktree; no NUL bytes; tests must be deterministic (no waitFor
racing async work — stub or await the boundary; a flaky test blocks the
gate); DoD is root 'npm test' + 'npm run typecheck' green, then STOP with
a short summary.
