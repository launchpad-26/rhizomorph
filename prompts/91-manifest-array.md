## What was found (conductor browser smoke, 2026-08-01)

With a populated `.swarm/lanes.json` on disk and `GET /api/lanes` serving
it (`{"available":true,"version":1,"lanes":[…]}` — an ARRAY of lane
entries, exactly the schema docs/architecture.md documents and
dispatch.sh writes), the live UI still shows `NO LANE MANIFEST —
off-fence unavailable` and every fleet-table FENCE cell reads `none`.

Root cause: `parseLaneManifest` (`packages/web/src/fleet/fences.ts`)
accepts the `{ lanes: … }` envelope only when `lanes` is an OBJECT keyed
by handle, and explicitly rejects arrays
(`Array.isArray(raw) → return null`). The consumer guarded against a
shape decision on #76 — but not the shape #76 actually shipped. Two green
halves, one broken whole; found only in a real browser (same class as the
prd0 SSE named-events bug).

## Direction

The array IS the contract of record (architecture.md + ruling 19's
dispatch writer). Fix the consumer: `parseLaneManifest` accepts the array
envelope (fold entries by `handle`; duplicate handles → reject, per the
same flat-refusal philosophy already in the function). Keep the existing
accepted shapes working. The regression test must pin the REAL payload:
copy the exact envelope `GET /api/lanes` serves (available/version/lanes
array with handle/branch/fence/issue/model/dispatchedAt fields) into the
test, not a hand-rolled approximation — the hand-rolled approximation is
how this bug survived two green suites.

FORBIDDEN: touching the server (its shape is correct); timeout raises;
weakening the flat "no manifest" failure mode.

## Fence (may touch ONLY)

- `packages/web/src/fleet/fences.ts`
- `packages/web/src/fleet/fences.test.ts`

## Blocked by

Nothing (both files unowned since #75/#87/#88 landed). **Model:** sonnet.
**Wave:** integration fix.

## Definition of done

- Regression test with the live payload shape (array envelope) parsing
  into a manifest whose fences match; array-with-duplicate-handles
  rejected; existing shapes still accepted.
- Root `npm test` + `npm run typecheck` green; 3x4 concurrent load runs
  12/12 green from the worktree root.
- **Committing your work is REQUIRED.** Never push, never merge. Work
  only in this worktree. `BLOCKED: <need>` if stuck.

(Conductor-side browser re-verification of the FENCE column happens at
the gate — not this lane's job.)
