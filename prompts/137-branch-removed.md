You are a worker agent on rhizomorph (prd9: the trace era). You own
exactly one issue — a dogfooding fix with the diagnosis embedded.
Read the files your issue names before changing anything; import
from @rhizomorph/core; laws restated stronger, never weakened.

YOUR ISSUE — #137:

## Direction

Dogfooding-born: the attention strip has shown a FALSE
`1 NEED ATTENTION — 132-trace-surfaces ⇄ 134-…` collision for hours after
BOTH lanes merged and their branches were deleted — and it survived a
server restart and a fresh fold, so it is a data gap, not UI staleness.
Diagnosis: the git event census (`events/git.ts`) has
`worktree.discovered/removed`, `branch.updated`, `commit.landed`,
`worktree.dirty` — **there is no `branch.removed`**. A branch that
disappears from `for-each-ref` simply stops updating; `state.branches`
retains it forever; the collision matrix keeps comparing ghosts; the
ladder floor law (non-zero collisions ⇒ no ALL CLEAR) then summons the
operator for work that landed hours ago.

Fix — the additive event the schema is missing:

1. **`branch.removed`** in `packages/core/src/events/git.ts` (payload:
   `branch`, mirroring `worktree.removed`'s conventions), registered in
   the union + `EVENT_SOURCE_BY_TYPE` (source `git`), added to
   `fixtures.ts` `oneOfEach()`.
2. **Collector emit** — the git collector already snapshots
   `for-each-ref` between polls to emit `branch.updated`; a name present
   in the previous snapshot and absent now emits `branch.removed`
   (raw-facts-only law: the collector reports the disappearance, nothing
   else).
3. **Fold** — `reduce.ts` removes the branch from `state.branches`
   (mirror the `worktree.removed` handling; `commits` history stays —
   the work happened, only the live branch is gone).
4. **Laws, test-stated**: a collision pair goes quiet when one side's
   branch is removed (the live false-positive shape, reconstructed as a
   fixture); ALL CLEAR is reachable again after removal (the ladder-floor
   inverse); replay of an OLD log (no `branch.removed` events) behaves
   exactly as today — the forward-compat guard stays intact.
5. The events census tests extended, never weakened.

## Fence (may touch ONLY)

- `packages/core/src/events/git.ts`
- `packages/core/src/events/index.ts`
- `packages/core/src/events/events.test.ts`
- `packages/core/src/fixtures.ts`
- `packages/core/src/fixtures.test.ts`
- `packages/core/src/state.ts`
- `packages/core/src/reduce.ts`
- `packages/core/src/reduce.test.ts`
- `packages/core/src/selectors/collisions.ts`
- `packages/core/src/selectors/collisions.test.ts`
- `packages/server/src/collectors/git/` (collector + tests)

## Blocked by

Nothing. **Model:** sonnet. **Wave:** dogfood (parallel with the
lane-page conductor fix — fences disjoint).

## Definition of done

- The recorded false-positive shape goes quiet on branch removal; ALL
  CLEAR reachable; old logs replay unchanged — all test-stated.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; if you
cannot proceed print "BLOCKED: <need>" and stop; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
