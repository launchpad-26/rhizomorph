You are a worker agent building The Rhizomorph (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #82 (82. Collisions: attention-integrated, evidence-bearing (ruling 14))

## Direction

A real collision is a ladder item; the panel is the evidence, not the
alarm.

- The fleet object already raises the rung on non-zero collisions (g5,
  keystone). Your side: the collisions chip/entry names the pair
  (`collision: <branch-a> × <branch-b> — <file>` style evidence, g4), and
  clicking it expands/scrolls the collision matrix panel to that pair.
- Panel demoted to calm chrome: dense mono matrix, no status hues except
  a genuine collision's cell carrying the ladder's needs-you treatment
  from tokens.
- Empty state is the ambient evidence line (`collisions: 0 — checked N
  branches / M files`) — same numbers the strip's ALL CLEAR cites (both
  read the fleet object, so they cannot disagree).
- Keep the existing matrix/rows logic where it is sound (prd2 fixed its
  labels); this is integration + register, not a rebuild.

## Fence (may touch ONLY)

- `packages/web/src/panels/collisions/**`

## Blocked by

#75. **Model:** sonnet. **Wave:** 2.

## Definition of done

- Tests: evidence empty state with real checked-counts; a colliding
  fixture yields the named-pair entry; click expands to the pair; no
  status hue leaks outside a genuine collision.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits (committing is REQUIRED — review happens from your
branch); NEVER switch branches, push, merge, or run git in a sibling
worktree; no NUL bytes; tests must be deterministic (no waitFor racing
async work — stub or await the boundary; a flaky test blocks the gate);
build for a stranger's machine (no personal paths, 127.0.0.1 not [::1],
degrade loudly never silently); if you cannot proceed print "BLOCKED:
<need>" and stop; DoD is root 'npm test' + 'npm run typecheck' green,
then STOP with a short summary.
