# 78c — Fix the load-hold (lane 78, branch `78-fleet-table`)

Your branch regated after #87 landed and HELD at 3/12 under busy-box 4×
load, every failure the SAME in-fence test:

- `renders every lane, in the fleet object's own order` — 5.0–6.2s
  (vitest's 5s default timeout).

Context you need:

- #87 landed suite-wide fixture memoisation: `fleet20Spec()` etc. return
  frozen singletons; `fixtureHistory(spec, now, seed)` memoises by (spec
  identity, seed, now). Read `packages/web/src/fleet/fixtures.ts` — your
  worktree already has it (the gate rebased you onto main).
- Your test predates #87, so it likely misses the memo (its own spec
  construction or its own `NOW`) or pays a heavy 20-lane table render per
  test. #77 fixed the identical hold by hoisting the build to
  describe/module scope; adopt the same pattern, and share the singleton
  spec + memoised history where possible.

FORBIDDEN: raising `testTimeout`, `.skip`, retries, weakening assertions.

Measure before finishing — 3 batches × 4 concurrent full-suite runs from
your worktree root; report the result in the commit message. A failure in
a file OUTSIDE your fence: report verbatim, do not touch the file.

RULES (unchanged): fence `packages/web/src/panels/fleet/**` +
`packages/web/src/panels/worktrees/**`; work only in this worktree;
committing REQUIRED; never push/merge; root suite + typecheck green;
stranger-machine rule; `BLOCKED: <need>` if stuck.
