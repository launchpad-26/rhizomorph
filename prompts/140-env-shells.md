You are a worker agent on rhizomorph (prd9: the trace era, rolling).
You own exactly one issue. Read the files your issue names IN FULL
before changing anything; import from @rhizomorph/core; laws
restated stronger, never weakened.

YOUR ISSUE — #140:

## Direction

Operator-ruled: the conductor must be wireable BEFORE handover, on any
shell. Today `rhizomorph env` emits bash `export` lines only — a
Windows/PowerShell conductor (the operator's own daily case, and half a
cohort's) has no supported path, and a hand-pasted static block goes stale
because the `instance` id is per-server-session. Fix it product-side:

1. **`rhizomorph env <lane> --shell sh|powershell|cmd`** (default `sh`,
   unchanged output byte-for-byte for the default — `.workmux.yaml` and
   every existing doc depend on it):
   - `powershell`: `$env:NAME = "value"` lines.
   - `cmd`: `set NAME=value` lines.
   - Same variables, same live-fetched instance id, all shells. `--help`
     documents it.
2. **Doctor speaks the reader's shell**: the conductor-instrumentation
   remedy names the `--shell powershell` form when it matters; keep the
   existing no-bare-binary copy rule (#126).
3. **`docs/telemetry.md` — "Wiring the conductor" hardened**: the
   PowerShell path documented with a copy-paste launch wrapper (fetch env
   from the RUNNING server via `--shell powershell`, then start `claude`),
   the degrade-loudly case (no server listening → say so, launch
   uninstrumented anyway), and the existing instrumentation-attaches-at-
   launch caveat cross-referenced.

## Fence (may touch ONLY)

- `packages/server/src/cli/telemetry-env.ts`
- `packages/server/src/cli/telemetry-env.test.ts`
- `packages/server/src/cli/args.ts`
- `packages/server/src/cli/args.test.ts`
- `packages/server/src/cli/doctor.ts`
- `packages/server/src/cli/doctor.test.ts`
- `packages/server/src/cli/index.test.ts` (minimal reconciliation only)
- `docs/telemetry.md`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** rolling.

## Definition of done

- `--shell sh` output byte-identical to today (test-stated); powershell
  and cmd forms tested for every variable incl. the quoted
  `OTEL_RESOURCE_ATTRIBUTES`.
- Doctor remedy tested in both shell voices.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
