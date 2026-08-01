## Direction (prd4 ruling 5)

**Parked is a state, not a mute.** An operator can declare a lane parked;
the instrument acknowledges it visibly instead of alarming forever.

- **Manifest contract**: `.swarm/lanes.json` lane entries gain an optional
  `parked: true` (boolean). Operator-declared only — the read-only
  instrument NEVER writes it. `parseLaneManifest`
  (`packages/web/src/fleet/fences.ts`) accepts and carries the field
  (absent = false). Document the field in `docs/architecture.md`'s lane
  manifest contract section.
- **Inference exemption**: `detectFrozen` and the WAITING inference
  (`packages/web/src/fleet/buildFleet.ts:712-760`) gain a parked exemption
  alongside the three structural ones. The honesty guard in the comment at
  :704-710 stands: parked is a visible operator declaration in the
  manifest, not a UI mute — cite it.
- **Rendering**: a parked lane renders a dimmed `PARKED` state in the
  fleet table STATE column (use the post-#92 state-class map; ice-family,
  clearly dimmer than idle) — visible, never hidden, never alarmed. The
  ladder (`buildLadder`) skips parked lanes entirely. Scene: no scene file
  is in your fence — the lane's activity may present as idle/unknown
  there; if you can express parked through the EXISTING fleet object
  fields the scene already reads (e.g. activity), do it from buildFleet;
  otherwise leave a precise scope comment on issue #96 for the docs and a
  follow-up note in your final report.
- **Tests**: manifest parsing with parked; frozen/waiting exemption
  (a lane that WOULD be FROZEN reads parked instead); ladder skip; table
  renders PARKED dimmed; a parked lane with real new activity — decide and
  pin the honest behavior (recommend: activity evidence still shows in
  OUTPUT/AGE columns; parked only suppresses the alarm inference) and say
  so in the test name.

## Fence (may touch ONLY)

- `packages/web/src/fleet/buildFleet.ts`, `packages/web/src/fleet/buildFleet.test.ts`
- `packages/web/src/fleet/fences.ts`, `packages/web/src/fleet/fences.test.ts`
- `packages/web/src/fleet/FleetContext.test.tsx` (only if a fixture needs the field)
- `packages/web/src/panels/fleet/**`
- `docs/architecture.md` (the manifest contract section only)

## Blocked by

#92 (`panels/fleet/index.tsx` is in its fence; PARKED uses the new class
map). **Model:** sonnet. **Wave:** 2.

## Definition of done

- All tests above; root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures reported verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments as you go.**
  Never push, never merge, never switch branches.
- Build for a stranger's machine — no user-specific paths or assumptions.
- If blocked, print `BLOCKED: <need>` and stop.
