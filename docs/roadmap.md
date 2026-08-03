# Roadmap

> Rough shape blessed by Lachlan 2026-07-30; re-cut per prd as each lands.
> prds are blessed docs before they are backlogs, backlogs before they are
> fleets.

- **prd1 — the money layer** (`docs/prd1.md`, shipped): native telemetry
  collectors (sessionlog + otel), cost selectors with the role dimension,
  spend ticker, per-lane cost, collapsible panels, bounded scene
  meaning-fixes.
- **prd2 — anyone, anywhere** (`docs/prd2.md`, shipped): trustworthy numbers
  (session-scoped totals, true timestamps, resume-on-restart), identity that
  cannot collide (instance namespacing, explicit-at-source, no magic strings),
  cost that reaches the branch ledger, visible threads, and a first-run that
  works for a stranger.

- **prd3 — the viz design study.** *Superseded by what actually shipped —
  see `docs/prd3.md`: a same-day spike round chose Direction C, Mycelium
  Pulse-Network, over the two other spike builds, and prd3 landed as "the
  beautiful instrument" — the derived fleet object, the glyph alphabet, the
  pulse-as-event laws, the lane manifest/fence contract.* The big one, had
  properly: every visual channel encodes a metric or is removed; relatedness
  layout (file/semantic proximity), cost-in-scene, task-progress
  verticality — designed against real prd1 data and interview findings.
- **prd4 — the catch-up brief + lane chat replay.** *Superseded by what
  actually shipped — see `docs/prd4.md`: prd4 landed as "the layman bar," an
  operator-review pass re-aiming every surface at a first-time viewer — the
  hue/brightness palette, the scene as centerpiece, the conversation drawer,
  parked-as-a-state. The catch-up brief itself was never built under this
  slot; it reappears below as a cohort candidate.* "What did my swarm do
  while I was away" as a first-class digest (the strongest user-stated pain
  from the JV call), plus click-a-lane chat replay reconstructed from session
  logs at major-event granularity.
- **prd5 — task graphs + tool-agnostic capture.** *Superseded by what
  actually shipped — see `docs/prd5.md`: prd5 landed as "the finished
  application" — camera and gestures, the motion budget, the cord-cut, amber
  aging, orientation keyboard registers. Task graphs and the LiteLLM route
  were never built under this slot; task graphs reappears below as a cohort
  candidate.* TodoWrite/beads collector for task-size-and-growth per lane;
  the LiteLLM passthrough route (proven viable with subscription OAuth — see
  the research note) for CLIs without native OTel.
- **prd6 candidate / standing research question — dispatch-policy
  optimization.** *Superseded by what actually shipped — see `docs/prd6.md`:
  prd6 landed as "the living cycle" — absolute seed sizing,
  lifecycle-as-distance, the way home, germinating seeds, MAIN's own drawer.
  Dispatch-policy optimization was never claimed as an issue; it remains a
  standing research question, listed again below.* Descriptive analytics →
  lookup-table defaults → contextual bandit over (model × effort) per issue
  class; rewards on **verified** outcomes only (Goodhart guard — we have
  already watched a metric diverge from the goal under load). The `role`
  dimension and a stable additive schema are what make this dataset
  compound. The optimizer never lives in the Rhizomorph: sensor array in the
  balcony, policy in the conductor.
- **prd7 — procedural form** (`docs/prd7.md`, shipped): ribbons replace
  stroked lines, the root-mass becomes one marching-squares contour, canvas
  2D confirmed over WebGL by measurement rather than assumed.
- **prd8 — from private project to published software** (`docs/prd8.md`,
  shipped): the `rhizomorph` rename, a `files` allowlist verified by
  `npm pack`, the README as a trust document, CHANGELOG/semver policy, a
  tag-gated release workflow.

## prd9 — the trace era (`docs/prd9.md`, IN FLIGHT)

One week to handover, two thrusts in kill-order: **a junior-proof front door
first**, then **a trace layer** ripped-with-evidence from OpenTelemetry and
Langfuse (`research/2026-08-03-trace-era-captures.md`), with the lane-drawer
waterfall as its centerpiece. See
[docs/architecture.md](architecture.md#prd9--the-trace-era-in-flight) for
what has landed so far (the `trace.span` keystone, issue #123) and what wave
A is building in parallel (the receiver, selectors, and CLI/doctor lines,
issues #124–#126).

## Unclaimed candidates (cohort-facing)

Scoped, not built — the deliberate inheritance for the cohort's six-week
project rather than this week's work:

- **The catch-up brief** — left unclaimed on purpose as the cohort's
  flagship first milestone, with the trace layer as its enabler.
- **Task graphs** — a TodoWrite/beads collector for task-size-and-growth per
  lane.
- **LiteLLM/OpenRouter/pi capture** — CLIs without native OTel; prd9 ruling 9
  scopes these as cohort issues rather than building them now.
- **A Langfuse forwarder** — an opt-in outbound relay, filed as a future
  issue and gated on a re-ruling of the Trust section (see
  [docs/telemetry.md](telemetry.md#coexisting-with-langfuse)); "nothing
  leaves the machine" stands until that re-ruling happens.
- **Dispatch-policy optimization** — the prd6-candidate research question
  above, still standing.

**Parallel product thread, ongoing:** user-interview script (collisions
question included; cohort first; JV's LinkedIn amplification offer standing);
open-sourcing prep — including scrubbing guidance for `user.email` in OTel
captures before the repo goes public.

## Decisions appended post-prd2 (operator, 2026-07-31)

- **npm name:** scoped — `@kelliherl/rhizomorph`. Publish is deferred until
  after prd3; clone+run stays the supported path until then. (Unscoped
  `rhizomorph` is taken; a scoped name needs no reservation.) *Superseded
  twice over: prd8 ruling 2 found the unscoped `rhizomorph` name free after
  all and made it the published identity; prd9 ruling 2 then removed
  publishing from this week's plan entirely — no npm publish, the clonable
  repo is the install story, and the scoped-vs-unscoped question is moot
  while nothing is published. The release machinery from prd8 stays dormant,
  not deleted.*
- **prd3 next:** the visualization design study, run as a bounded prd; its
  spend-surface patterns feed the factory GUI alpha.
- **macOS CI:** repo is private → claim softened to match verification (#74)
  instead of paying 10x for a macos-latest leg.
