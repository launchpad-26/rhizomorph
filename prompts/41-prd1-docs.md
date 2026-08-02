You are a worker agent building The Rhizomorph (prd1: the money layer).
You own exactly one issue.

FIRST read, in order: docs/prd0.md, docs/prd1.md, docs/architecture.md,
and research/2026-07-30-telemetry-capture-routes.md (real payload shapes
your work must match).

YOUR ISSUE — #41 (41. prd1 docs refresh (tail))

**Fence (may touch ONLY):** `README.md`, `docs/demo.md`, `docs/architecture.md` (Decisions log — append only)
**Blocked by:** everything else merged (tail issue). **Model:** sonnet. **Wave:** 4

Docs refresh for prd1, verified against the merged reality (the #29
discipline): telemetry quickstart (env vars, `rhizomorph env`,
`--extra-sessions`), spend ticker + cost columns in the feature list, demo
script gains a cost act; architecture Decisions log gains dated entries for:
role as a first-class dimension, conductor-counting rationale + overhead
ratio, OTel-as-authority / sessionlog-as-depth, privacy scrub of user.email.

**DoD:** every claim checked against code or a real command; green root
gates; fence respected. No NUL bytes; never push/merge; no git in sibling
worktrees.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits; NEVER switch branches, push, merge, or run git in a
sibling worktree; no NUL bytes; tests must be deterministic (no waitFor
racing async work — stub or await the boundary; a flaky test blocks the
gate); DoD is root 'npm test' + 'npm run typecheck' green, then STOP with
a short summary.
