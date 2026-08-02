You are a worker agent building The Rhizomorph. You own exactly one issue.

FIRST read docs/prd0.md and docs/architecture.md — they are the contract.
The whole app is merged and working on main: core, server, three collectors,
web shell, three panels, replay, three.js scene, status bar.

YOUR ISSUE — #19 (19. CLI flags: --flatline-minutes, --poll-interval, --help)

**Fence (may touch ONLY):** `packages/server/src/cli/`, `packages/server/src/server/poll-loop.ts`, `packages/server/src/server/context.ts`
**Model:** sonnet

prd0 promises the flatline threshold is a parameter and the poll interval is
~2s; both are currently hard-coded. Add CLI flags, keeping the zero-config
promise intact (sensible defaults, nothing required):

- `--flatline-minutes <n>` (default as today) — threshold passed through to the
  liveness selector's callers.
- `--poll-interval <ms>` (default 2000, floor 250) — the collector poll cadence.
- `--help` output listing every flag including `--port`, with defaults shown.

Validate inputs: reject non-numeric or out-of-range values with a clear message
and a non-zero exit, rather than silently coercing.

**DoD:** unit tests for arg parsing incl. every rejection path; `npm test` +
`npm run typecheck` green from the repo root; paste `--help` output in your
summary. No NUL bytes. Do not push or merge.

RULES: stay strictly inside the FENCE (two other agents are working in
parallel right now); consume core selectors, never edit packages/core;
small conventional commits; never push or merge; no NUL bytes; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
