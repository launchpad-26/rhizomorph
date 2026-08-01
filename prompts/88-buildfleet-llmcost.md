## What was found (lane 80's landing report, 2026-08-01)

`buildFleet.ts`'s token-origin filter collaterally drops every `llm.cost`
event. Consequence: `conductorInstrumented` (and any fleet-level figure
that should see conductor cost events) is derived from a fleet object that
never saw them. The burn strip currently ships a WORKAROUND: it re-derives
`conductorInstrumented` by calling `useStream()` directly and folding a
real session, bypassing the fleet object (see `panels/burn/index.tsx` after
#80 lands).

## Direction

Fix at the source: `buildFleet` folds `llm.cost` events correctly (the
token-origin filter keeps its intent without eating cost events), with a
regression test proving a conductor `llm.cost` event is visible in the
fleet object. Then remove the burn strip's workaround — its overhead-gap
derivation reads the fleet object again, and its tests stop needing a
`useStream` mock for this purpose.

## Fence (may touch ONLY)

- `packages/web/src/fleet/buildFleet.ts`
- `packages/web/src/fleet/buildFleet.test.ts`
- `packages/web/src/panels/burn/index.tsx`, `packages/web/src/panels/burn/index.test.tsx` (workaround removal only)

## Blocked by

#87 (owns `buildFleet.test.ts` until it lands), #80 (owns `panels/burn/**`
until it lands). **Model:** sonnet. **Wave:** follow-up.

## Definition of done

- Regression test: a session containing a conductor `llm.cost` event
  produces a fleet object that reflects it (the exact assertion the bug
  would fail).
- Burn strip reads the fleet object; the `useStream` re-derivation and its
  test mock are gone; burn's four numbers unchanged.
- Root `npm test` + `npm run typecheck` green.
