You are a worker agent building The Observatory (prd1: the money layer).
You own exactly one issue.

FIRST read, in order: docs/prd0.md, docs/prd1.md, docs/architecture.md,
and research/2026-07-30-telemetry-capture-routes.md (real payload shapes
your work must match).

YOUR ISSUE — #34 (34. sessionlog collector (JSONL tailing, lane attribution))

**Fence (may touch ONLY):** `packages/server/src/collectors/sessionlog/**`
**Blocked by:** #33. **Model:** sonnet. **Wave:** 2

sessionlog collector per docs/prd1.md + research note §S2 (real structure
documented there; real logs exist on this machine under
`~/.claude/projects/-home-operator-worktrees-challenge--worktrees-*/`).

- Map the watched repo's worktree paths to Claude project-dir slugs
  (`/` and `_` → `-`; verify against the real dirs and fixture the mapping).
- Incremental tailing: per-file byte offset in the collector snapshot; only
  new lines parsed each poll; rotated/new session files discovered.
- Parse assistant messages → `llm.usage` (tokens by tier, model, requestId,
  durationMs) and tool_use entries → `tool.activity`; `lane` from
  cwd/gitBranch; `role: worker` default, `conductor` when the project dir was
  registered via extra-session config (accept a list of extra dirs in the
  collector's constructor config; CLI wiring is issue #36, not yours).
- Missing/undiscoverable dirs → `collector.disabled` once, never crash.
- Fixtures: copy 2-3 REAL session JSONLs (or representative excerpts) from
  this machine into your fixtures dir; parsers pure and tested against them.

**DoD:** green root test+typecheck; tests run with no real ~/.claude present;
fence respected; summary at end. No NUL bytes; never push/merge; no git in
sibling worktrees.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; NEVER switch branches, push, merge, or run git in a
sibling worktree; no NUL bytes; tests must be deterministic (no waitFor
racing async work — stub or await the boundary; a flaky test blocks the
gate); DoD is root 'npm test' + 'npm run typecheck' green, then STOP with
a short summary.
