You are a worker agent on The Observatory (prd1: the money layer).

FIRST read docs/prd1.md, docs/architecture.md and
research/2026-07-30-telemetry-capture-routes.md.

YOUR ISSUE — #47 (47. Cost is one metric with provenance; un-instrumented conductor is a visible gap)

**Fence (may touch ONLY):** `packages/web/src/panels/spend/`, `docs/telemetry.md`, `docs/architecture.md` (Decisions log — append only)
**Model:** sonnet

Two related corrections, one principle.

**1. One metric with provenance, not two grades.** The spend ticker must express
**cost** exactly one way. The core schema already carries provenance on cost
events (`authoritative: true` from an agent's own telemetry; `estimateSource`
for a pricing-table derivation, which exists for future agent CLIs that cannot
emit cost — *not* as a fallback for un-instrumented setups). Show the
provenance; do not introduce a parallel token-based ratio as a co-equal
headline. The role split and the overhead ratio are defined on cost.

**2. Missing conductor telemetry is a GAP, not a substitute number.** When no
`role: conductor` cost events have been seen, the ticker must say so plainly
and point at the fix — e.g. "conductor not instrumented — see docs/telemetry.md"
— instead of rendering a ratio computed from whatever happens to be available.
An incomplete setup should be visible and actionable, never quietly
accommodated. (Today the ticker showed OVERHEAD 0.14× computed from synthetic
probe traffic while the real conductor was entirely uncounted; that number was
worse than absent.)

**3. Record the principle.** Append to the architecture Decisions log, dated:
*design for the correctly-configured case; surface incomplete configuration as
a gap, never as a second-class metric.* Explicitly note the rejected
alternative (a token-based ratio kept alive so historical, un-instrumented
sessions would still produce a number) and why it was rejected: it fits an
accident of this project's own history onto every future user.

**4. Docs.** `docs/telemetry.md` gains a conductor section that does not assume
the conductor's platform: the env block for OTel export (works from Windows,
WSL, or elsewhere — a Windows-side agent can export to a WSL-hosted receiver on
localhost), and the note that instrumentation attaches at **launch**, so a
session already running cannot be retro-instrumented. State that tailing old
logs yields tokens/tools/timeline for history and replay, and is deliberately
*not* the basis of the cost metric.

**DoD:** render tests for the instrumented and not-instrumented states; no
token-derived ratio anywhere in the panel; root `npm test` +
`npm run typecheck` green; docs claims checked against the code. No NUL bytes;
never push/merge; no git in sibling worktrees.

RULES: stay strictly inside the FENCE (another agent works in parallel);
import from @observatory/core, never redefine its types; small conventional
commits; committing on YOUR branch is REQUIRED; never push, merge, or run
git in a sibling worktree; deterministic tests only (no waitFor racing an
async boundary); no NUL bytes; STOP with a summary including any live
evidence the issue asks for.
