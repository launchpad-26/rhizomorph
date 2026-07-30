# Roadmap

> Rough shape blessed by Lachlan 2026-07-30; re-cut per prd as each lands.
> prds are blessed docs before they are backlogs, backlogs before they are
> fleets.

- **prd1 — the money layer** (`docs/prd1.md`, in flight): native telemetry
  collectors (sessionlog + otel), cost selectors with the role dimension,
  spend ticker, per-lane cost, collapsible panels, bounded scene
  meaning-fixes.
- **prd2 — the viz design study.** The big one, had properly: every visual
  channel encodes a metric or is removed; relatedness layout (file/semantic
  proximity), cost-in-scene, task-progress verticality — designed against
  real prd1 data and interview findings.
- **prd3 — the catch-up brief + lane chat replay.** "What did my swarm do
  while I was away" as a first-class digest (the strongest user-stated pain
  from the JV call), plus click-a-lane chat replay reconstructed from session
  logs at major-event granularity.
- **prd4 — task graphs + tool-agnostic capture.** TodoWrite/beads collector
  for task-size-and-growth per lane; the LiteLLM passthrough route (proven
  viable with subscription OAuth — see the research note) for CLIs without
  native OTel.
- **prd5 candidate / standing research question — dispatch-policy
  optimization.** Descriptive analytics → lookup-table defaults → contextual
  bandit over (model × effort) per issue class; rewards on **verified**
  outcomes only (Goodhart guard — we have already watched a metric diverge
  from the goal under load). The `role` dimension and a stable additive
  schema are what make this dataset compound. The optimizer never lives in
  the Observatory: sensor array in the balcony, policy in the conductor.

**Parallel product thread, ongoing:** user-interview script (collisions
question included; cohort first; JV's LinkedIn amplification offer standing);
open-sourcing prep — including scrubbing guidance for `user.email` in OTel
captures before the repo goes public.
