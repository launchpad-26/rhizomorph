## What was found (conductor live verification of #95)

The server's lane-manifest schema (`packages/server/src/api/lanes.ts`)
predates #95 and does not know the `parked` field. Two consequences,
found only in a real browser:

1. `GET /api/lanes` returns `{ available: true, ...result.data }` — zod's
   parse OUTPUT, which strips unknown keys — so `parked: true` never
   crosses the wire. #95's feature is inert on live data (its tests feed
   the web validator directly; both halves green, whole broken — the
   third seam of this exact class in this repo).
2. The schema takes `issue`/`model` as optional strings; entries carrying
   `null` (as a conductor tool briefly wrote) fail validation and take the
   WHOLE manifest down (`available: false`), reading as NO LANE MANIFEST
   everywhere.

## Direction

- Add `parked: z.boolean().optional()` to `laneSchema`.
- Decide and pin null-tolerance honestly: either accept-and-normalise
  `null` issue/model to absent (recommended — a manifest is operator
  input, and one sloppy field should not un-fence the fleet; note the
  asymmetry with the web validator's flat refusal and justify in a
  comment), or keep strict rejection and say so in the served `reason`.
  Either way, a test pins the chosen behavior.
- Regression tests: a manifest entry with `parked: true` is served with
  the flag intact (the exact assertion the bug would fail); the doctor
  check (`packages/server/src/cli/doctor.ts`) still passes if it validates
  the same schema — update it in lockstep if it shares the schema module.

## Fence (may touch ONLY)

- `packages/server/src/api/lanes.ts`, `packages/server/src/api/lanes.test.ts`
- `packages/server/src/cli/doctor.ts`, `packages/server/src/cli/doctor.test.ts` (only if they share the schema)

## Blocked by

Nothing (#76/#95 landed). **Model:** sonnet. **Wave:** follow-up (micro).

## Definition of done

- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches x 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures reported verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED.** Never push, never merge.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
