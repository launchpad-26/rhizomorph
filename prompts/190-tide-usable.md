You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

URGENT — the operator calls the dock unusable. #186 landed the marks and cards but they paint behind the bar, so its central win is unreachable. Read docs/research/2026-08-05-replay-ux-spike.md section 4 AND #186's landed diff first. A real-browser hit test is mandatory: jsdom cannot hit-test, and that is exactly why this shipped broken.

YOUR ISSUE — #190:

## Direction

**prd15 wave 2a — the honesty layer, server side.** Read `docs/prd15.md`
ruling 5 (the enrichment ladder) and ruling 4 (the adapter contract), then
`docs/research/2026-08-05-agnostic-adapters-spike.md`'s adapter-contract
section, then #188's landed `sessionlog/` organ (it is the reference
adapter — its capabilities are the first real manifest).

Today the product degrades honestly but **cannot say WHY or HOW MUCH**: gap
voices hardcode remedies ("run `rhizomorph env <lane>`"), and nothing tells
an operator which rung of the ladder their setup is on. Make the ladder
legible.

1. **`AdapterCapabilities` on the collector contract.** Each collector
   declares which signals it provides — `identity`, `liveness`, `activity`,
   `attention`, `telemetry`, `cost` — as `provided | partial | absent`, plus
   a one-line reason for anything not `provided` and the remedy that would
   upgrade it (e.g. attention: `partial` — "inferred from transcript shape;
   a hook beacon would declare it"). Additive to the interface; a collector
   that declares nothing gets an honest all-`unknown` default rather than a
   flattering one.
2. **Aggregate to a RUNG per lane.** L0 zero-cooperation (git + transcript
   organ) · L1 env/OTLP · L2 beacon · L3 PTY wrapper · L4 tmux/workmux.
   The rung is *derived* from live capabilities, never configured — a lane
   whose tmux collector is disabled drops a rung automatically and says so.
3. **`/api/meta` carries the manifest and the rungs** (additive, like #180's
   boot facts — and NOTE `server/build-app.test.ts` asserts meta's exact
   shape; it is a known coupling point in `.swarm/coupling.txt` and IS in
   your fence for that reason).
4. **`doctor` speaks the ladder**: per lane, the rung, what is missing, and
   the exact next step to climb one. Doctor's existing honesty style (#126)
   governs the voice — never scold, always name the remedy.
5. **Do NOT touch the web surfaces** — wave 2b (#190) rewires gap voices and
   the provenance strip to read this manifest. Ship the data, not the pixels.

Laws, test-stated: a collector's declared capabilities match what it can
actually emit (assert against each collector's own event surface — a
collector claiming `attention: provided` must have a path that emits it); a
disabled collector's signals read `absent` with a reason, never silently
`provided`; the rung derivation is pure and total (every capability
combination maps to exactly one rung, `_never`-exhaustive).

## Fence (may touch ONLY)

- `packages/core/src/collector.ts`, `packages/core/src/collector.test.ts`
- `packages/server/src/collectors/` (all files — declarations only; no
  behaviour changes to any collector's polling)
- `packages/server/src/cli/doctor.ts`, `packages/server/src/cli/doctor.test.ts`
- `packages/server/src/api/meta.ts`, `packages/server/src/api/meta.test.ts`
- `packages/server/src/server/build-app.test.ts` (the meta exact-shape
  coupling point, pre-widened on the record)

## Blocked by

#188 landed on main (its organ is the reference adapter). **Model:** sonnet.
**Wave:** prd15 wave 2a.

## Definition of done

- Every collector declares capabilities; rungs derive purely; meta carries
  both; doctor names the rung and the next climb per lane; laws test-stated.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
