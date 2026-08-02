You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md, then docs/telemetry.md. Wave E context: #69
landed — core now ranks by output and the ratio is output-based. Your
job is the display layer. The ruling you are implementing: headline =
OUTPUT tokens; all four tiers always visible (cache tiers muted, never
hidden); NO unlabelled all-tier total anywhere in the product.

YOUR ISSUE — #70 (70. Dashboard: output-led headline, four tiers always visible, one shared formatter)

**Fence (may touch ONLY):** `packages/web/src/lib/format.ts` (new), `packages/web/src/lib/format.test.ts` (new), `packages/web/src/panels/spend/` (directory), `packages/web/src/panels/ledger/` (directory), `packages/web/src/panels/worktrees/` (directory), `packages/web/src/replay/format.ts`, `packages/web/src/replay/format.test.ts`
**Blocked by:** #69. **Model:** sonnet. **Wave: E (token semantics ruling)**

Every token number the dashboard shows is an unlabelled all-tier sum — eight
surfaces render `.total`, zero render buckets — while the four tiers differ
up to 50x in value. Operator rulings: output-led headline; all four tiers
always visible, cache tiers visually de-emphasized but never hidden (cache
reads are the dominant rate-limit consumer even when cheap); **no unlabelled
grand total anywhere in the product**.

- **Spend ticker**: headline becomes OUTPUT tokens with copy saying so
  ("output tokens — work produced"); beneath it the four buckets as
  labelled counts (input / output / cache read / cache write) and the lane
  mini-bars become stacked segments (muted styling for the cache tiers).
  Role-split cards show output-led figures with the split available.
- **Ledger TOKENS column**: shows output-led figure; full four-bucket
  breakdown via the panel's existing `title=` tooltip idiom (the cost cells
  already do this; the tokens cell currently has no title).
- **Worktree table token fallback**: output-led figure, labelled, breakdown
  in the existing cost-cell tooltip.
- **Replay bar**: same output-led figure + "tok out" style label.
- **Consolidate the formatters**: four near-duplicate `formatTokens` and
  three `formatUsd` implementations exist across panels — replace with one
  shared `packages/web/src/lib/format.ts` (including a bucket-breakdown
  string builder for tooltips) and update all call sites in the fence.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests
(no waitFor racing an async boundary); no NUL bytes. Tests must prove: the
headline renders output tokens; all four tiers render with their labels; no
rendered surface shows an unlabelled `.total`; the shared formatter is the
only formatter (old duplicates gone). Never push, merge, or run git in a
sibling worktree — committing on YOUR branch is required.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; build for a
stranger machine — no personal paths or names, no OS or tool
assumptions beyond documented prerequisites, machine-specific behavior
degrades loudly; small conventional commits; committing on YOUR branch
is REQUIRED; never push, merge, or run git in a sibling worktree; no
NUL bytes; STOP when done.
