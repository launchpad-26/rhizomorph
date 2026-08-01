## What was found (conductor verification after the prd4 spike retirement)

Two symptoms, one root — state from worktrees that DISAPPEAR (removed,
not merged) persists in the fold indefinitely:

1. `spike-a-constellation`'s worktree was removed ~40 min ago, yet the
   attention strip still shows a needs-you chip "workmux reports waiting
   4h53m" — the last workmux agent status stands forever because the
   agent record vanished instead of transitioning, and the
   workmux-reported waiting pathology apparently doesn't honour
   `lane.present === false` the way the FROZEN/WAITING *inferences* do
   (buildFleet.ts:712-760 exempt `!present`; the agent-status path does
   not).
2. The collisions panel counts ~15 contended files including paths from
   prd3 worktrees that no longer exist — dirty-set records for removed
   worktrees are never cleared, so ghosts contend with the living.

## Direction

Honest lifecycle for disappearance: when a worktree is observed removed
(`worktree.removed`), lane-scoped mutable state derived from it (dirty
set, agent status pathologies, contention participation) must stop
asserting present-tense facts. Decide the cleanest seam:

- fold-side (`packages/core/src/reduce.ts`): clear the lane's dirty set
  on `worktree.removed` (mirrors what merge-landings already look like),
  and/or
- view-side (`packages/web/src/fleet/buildFleet.ts`): every pathology and
  the collision fold honour `present === false` (evidence may still say
  "last reported waiting, worktree now gone" in the lane's own row —
  history stays visible, alarms do not).

Whichever seam you choose, the OTHER side gets a regression test proving
the symptom can't return. History stays queryable (this is an
event-sourced instrument — we suppress false present-tense alarms, we do
not erase the past).

## Fence (may touch ONLY)

- `packages/core/src/reduce.ts`, `packages/core/src/reduce.test.ts` (or the core test file that owns the fold)
- `packages/web/src/fleet/buildFleet.ts`, `packages/web/src/fleet/buildFleet.test.ts`
- `packages/web/src/panels/collisions/index.tsx`, `index.test.tsx` (only if the collision fold lives there)

## Blocked by

#95 (owns buildFleet until it lands). **Model:** sonnet. **Wave:** follow-up.

## Definition of done

- Regression tests: a lane with a stale agent status whose worktree is
  removed raises NO attention chip; a removed worktree's dirty files stop
  counting as contended; the lane's row still shows honest history.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches x 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures reported verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never push,
  never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
