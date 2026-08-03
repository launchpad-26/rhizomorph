You are a worker agent on rhizomorph (prd9: the trace era, rolling).
You own exactly one issue. Read the files your issue names IN FULL
before changing anything; import from @rhizomorph/core; laws
restated stronger, never weakened.

YOUR ISSUE — #139:

## Direction

Follow-up to #137, from live verification: the stale
`NEED ATTENTION 132⇄134` banner SURVIVES the branch.removed fix in the
current session. Diagnosis: the ghosts are grandfathered — their deletion
happened under the pre-#137 collector, which updated its snapshot without
emitting (the event type didn't exist), so the post-#137 collector boots
with a snapshot that already lacks them (no present→absent transition to
report), while the fold rebuilt from the log still holds their old
`branch.updated` facts. #137 is correct for every future removal; recovery
of an OLD log needs the missing removals reconstructed at boot.

Fix — extend the #111 resume-reconciliation pattern to branches:

1. At recovery (the same seam #111 uses for its reconciliation), compare
   the FOLDED state's live branches against the current `for-each-ref`
   reality; for each branch the fold believes in that reality lacks, emit
   a real `branch.removed` event (source `git`, honest fact: "this branch
   is not present now"). Same collector-emits-facts law — the
   reconciliation observes reality, it does not edit history.
2. Idempotent: a second boot emits nothing new (the fold no longer holds
   them).
3. Laws, test-stated: a log carrying pre-#137 ghost branches + a reality
   without them → one `branch.removed` per ghost at boot, banner-quiet
   state, ALL CLEAR reachable; a log/reality in agreement → zero events;
   replay of the ghost log WITHOUT reconciliation (pure replay) still
   shows history as it was — reconciliation is a live-boot act, never a
   replay rewrite.

## Fence (may touch ONLY)

- `packages/server/src/collectors/resume-reconcile.ts`
- `packages/server/src/collectors/resume-reconcile.test.ts`
- `packages/server/src/collectors/git/` (collector + tests)

All boot-reconciliation laws live in the server-side tests — core is not
touched.

## Blocked by

#137 (landed). **Model:** sonnet. **Wave:** morning hygiene.

## Definition of done

- The live session's actual ghost shape (132⇄134) reconstructed as a
  fixture goes quiet at boot; idempotence and replay-purity test-stated.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
