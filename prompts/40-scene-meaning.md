You are a worker agent building The Observatory (prd1: the money layer).
You own exactly one issue.

FIRST read, in order: docs/prd0.md, docs/prd1.md, docs/architecture.md,
and research/2026-07-30-telemetry-capture-routes.md (real payload shapes
your work must match).

YOUR ISSUE — #40 (40. Scene meaning-fixes (bounded))

**Fence (may touch ONLY):** `packages/web/src/scene/**`
**Blocked by:** nothing — independent. **Model:** sonnet. **Wave:** 2

Bounded scene meaning-fixes per docs/prd1.md (NOT the redesign — that is
prd2): every visual channel must be labeled, mapped to a real metric, or
removed. The three questions from the JV call must each have an answer in the
UI itself: what do sizes mean, what do positions mean, what does motion mean.

- Add/extend the legend so each channel's meaning is stated on screen.
- Any channel currently driven by randomness or aesthetics alone: either map
  it to a real selector metric that already exists, or remove the variation.
- Keep the constellation's character; this is honesty, not redecoration.

**DoD:** a short table in your summary — channel → meaning → where shown;
render smoke test still green; green root test+typecheck; fence respected. No
NUL bytes; never push/merge; no git in sibling worktrees.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; NEVER switch branches, push, merge, or run git in a
sibling worktree; no NUL bytes; tests must be deterministic (no waitFor
racing async work — stub or await the boundary; a flaky test blocks the
gate); DoD is root 'npm test' + 'npm run typecheck' green, then STOP with
a short summary.
