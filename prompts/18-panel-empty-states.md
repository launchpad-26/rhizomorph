You are a worker agent building The Observatory. You own exactly one issue.

FIRST read docs/prd0.md and docs/architecture.md — they are the contract.
The whole app is merged and working on main: core, server, three collectors,
web shell, three panels, replay, three.js scene, status bar.

YOUR ISSUE — #18 (18. Panels cannot distinguish 'idle' from 'broken')

**Fence (may touch ONLY):** `packages/web/src/panels/collisions/`, `packages/web/src/panels/ticker/`, `packages/web/src/panels/worktrees/`
**Model:** sonnet

Verified in a real browser: with the server connected and streaming, the
collisions and ticker panels both render "Waiting for data…" — identical to what
they show when nothing is connected at all. That is precisely the failure mode
this app exists to make visible, reproduced inside the app itself.

Distinguish the three states in every panel:
- **not connected / no events yet** — "waiting for the stream"
- **connected, genuinely nothing to show** — a real empty state that says so
  ("no collisions — no two branches touch the same file", "no commits yet this
  session"), styled as calm/good news, not as an error or a spinner
- **data** — as now

Derive "connected" from the stream status already in context (the same signal
`ConnectionBadge`/`StatusBar` use) plus whether any events have been folded, not
from a timer.

**DoD:** render tests for all three states in each panel using core fixtures;
`npm test` + `npm run typecheck` green from the repo root. No NUL bytes. Do not
push or merge.

RULES: stay strictly inside the FENCE (two other agents are working in
parallel right now); consume core selectors, never edit packages/core;
small conventional commits; never push or merge; no NUL bytes; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
