You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md, then the operator ruling this issue encodes (in the issue body). Wave E context: #64 landed; you own the core files now.

YOUR ISSUE — #69 (69. Token semantics in core: output-based overhead ratio, output-led sorting, residual dedup)

**Fence (may touch ONLY):** `packages/core/src/selectors/spend.ts`, `packages/core/src/selectors/spend.test.ts`, `packages/core/src/reduce.ts`, `packages/core/src/reduce.telemetry.test.ts`, `packages/core/src/events/telemetry.ts` (comment only)
**Blocked by:** #64. **Model:** sonnet. **Wave: E (token semantics ruling)**

**Operator ruling (Lachlan, 2026-07-31): a "token" is not a unit.** Across
current Claude models an output token costs ~5x an input token, a cache read
~0.1x, a cache write ~1.25x — a collated sum adds units differing 50x in
value. Rulings: the headline scalar is OUTPUT tokens (work produced); the
overhead ratio is re-based to output; no unlabelled all-tier total anywhere.

- **Overhead ratio → output basis** (`spend.ts:404,417-420`): conductor
  OUTPUT tokens ÷ worker OUTPUT tokens. Update the doc comment to say so and
  why (immune to cache-read inflation from a polling conductor). This is a
  deliberate semantic change to prd1's headline number — say so in the
  comment. Unattributed stays excluded from both sides.
- **Display sorting moves to output**: `bySpend` (`spend.ts:705`) and any
  sort feeding a display surface ranks by `tokens.output`, not `.total`.
  `.total` stays on the type (callers may still read it) but nothing ranks
  or headlines by it.
- **Residual cross-collector double-count**: #59 deduped by `requestId`, but
  OTel usage events with `requestId: null` still double-count against
  sessionlog. Close the gap in the reducer with origin precedence (when a
  session is covered by sessionlog usage, OTel null-requestId usage for the
  same session folds rather than appends — or the equivalent honest rule you
  find in the data; state your choice and why in the summary). Never delete
  real spend: OTel-only sessions must keep counting.
- **Fix the stale comment** `events/telemetry.ts:63-64`: it claims OTel's
  token.usage splits input/output only — `parse-metrics.ts` maps all four
  tiers. Comment-only change in that file.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests.
Tests must prove: ratio uses output only (cache-heavy conductor fixture no
longer inflates it); sort order follows output; a session seen by both
collectors counts once even when OTel carries no requestId; an OTel-only
session still counts. Never push, merge, or run git in a sibling worktree —
committing on YOUR branch is required.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; build for a
stranger machine — no personal paths or names, no OS or tool
assumptions beyond documented prerequisites, machine-specific behavior
degrades loudly; small conventional commits; committing on YOUR branch
is REQUIRED; never push, merge, or run git in a sibling worktree; no
NUL bytes; STOP when done.
