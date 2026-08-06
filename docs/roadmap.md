# Roadmap

> Rough shape blessed by Lachlan 2026-07-30; re-cut per prd as each lands.
> prds are blessed docs before they are backlogs, backlogs before they are
> fleets.

- **prd1 — the money layer** (`docs/prds/prd1.md`, shipped): native telemetry
  collectors (sessionlog + otel), cost selectors with the role dimension,
  spend ticker, per-lane cost, collapsible panels, bounded scene
  meaning-fixes.
- **prd2 — anyone, anywhere** (`docs/prds/prd2.md`, shipped): trustworthy numbers
  (session-scoped totals, true timestamps, resume-on-restart), identity that
  cannot collide (instance namespacing, explicit-at-source, no magic strings),
  cost that reaches the branch ledger, visible threads, and a first-run that
  works for a stranger.

- **prd3 — the viz design study.** *Superseded by what actually shipped —
  see `docs/prds/prd3.md`: a same-day spike round chose Direction C, Mycelium
  Pulse-Network, over the two other spike builds, and prd3 landed as "the
  beautiful instrument" — the derived fleet object, the glyph alphabet, the
  pulse-as-event laws, the lane manifest/fence contract.* The big one, had
  properly: every visual channel encodes a metric or is removed; relatedness
  layout (file/semantic proximity), cost-in-scene, task-progress
  verticality — designed against real prd1 data and interview findings.
- **prd4 — the catch-up brief + lane chat replay.** *Superseded by what
  actually shipped — see `docs/prds/prd4.md`: prd4 landed as "the layman bar," an
  operator-review pass re-aiming every surface at a first-time viewer — the
  hue/brightness palette, the scene as centerpiece, the conversation drawer,
  parked-as-a-state. The catch-up brief itself was never built under this
  slot; it reappears below as a cohort candidate.* "What did my swarm do
  while I was away" as a first-class digest (the strongest user-stated pain
  from the JV call), plus click-a-lane chat replay reconstructed from session
  logs at major-event granularity.
- **prd5 — task graphs + tool-agnostic capture.** *Superseded by what
  actually shipped — see `docs/prds/prd5.md`: prd5 landed as "the finished
  application" — camera and gestures, the motion budget, the cord-cut, amber
  aging, orientation keyboard registers. Task graphs and the LiteLLM route
  were never built under this slot; task graphs reappears below as a cohort
  candidate.* TodoWrite/beads collector for task-size-and-growth per lane;
  the LiteLLM passthrough route (proven viable with subscription OAuth — see
  the research note) for CLIs without native OTel.
- **prd6 candidate / standing research question — dispatch-policy
  optimization.** *Superseded by what actually shipped — see `docs/prds/prd6.md`:
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
- **prd7 — procedural form** (`docs/prds/prd7.md`, shipped): ribbons replace
  stroked lines, the root-mass becomes one marching-squares contour, canvas
  2D confirmed over WebGL by measurement rather than assumed.
- **prd8 — from private project to published software** (`docs/prds/prd8.md`,
  shipped): the `rhizomorph` rename, a `files` allowlist verified by
  `npm pack`, the README as a trust document, CHANGELOG/semver policy, a
  tag-gated release workflow.

- **prd9 — the trace era** (`docs/prds/prd9.md`, shipped): the one-week handover
  push — a junior-proof front door, then a trace layer ripped-with-evidence
  from OpenTelemetry and Langfuse (`research/2026-08-03-trace-era-captures.md`).
  Landed in full: the `trace.span` keystone (#123), wave A's receiver,
  selectors and CLI/doctor lines (#124–#126), and wave B's lane-drawer TRACE
  waterfall (#132) plus the vendored, SHA-pinned Langfuse pricing table
  (#129). See [docs/architecture.md](architecture.md#prd9--the-trace-era)
  for the walkthrough.
- **prd10 — the gorgeous round** (`docs/prds/prd10.md`, shipped): a scene-beauty
  pass on prd7's procedural form — thread underglow, a tissue-density ramp
  toward the root-mass, further contour refinement — confined to
  `packages/web/src/scene/`, changing no law prd3–prd9 established about
  what a colour, shape, or motion class means.
- **prd11 — the causal record** (`docs/prds/prd11.md`, shipped): provenance at
  file granularity (`tool.activity`'s optional `filePath`/`toolUseId`) and
  the portable session record — a manifest, the event log's own lines
  verbatim, and a hash chain closing in the manifest's digest, specified in
  full in [docs/record-format.md](record-format.md). Built toward a future
  "forest" (a multiplayer instrument with persistent cross-coworker
  knowledge) as a merge later, not a rewrite, but the forest itself is not
  built here.
- **prd12 — the laboratory** (`docs/prds/prd12.md`, shipped): the read-only
  constitution amended to two hands — the observer, absolutely untouched,
  and the laboratory, an explicitly-invoked second actor confined to
  `refs/rhizomorph/` and artefacts outside the watched repo. Engine only;
  nothing in `packages/web/` reaches it yet — prd14 is the UI.
- **prd13 — the TIDE** (`docs/prds/prd13.md`, shipped, cut down from its first
  shape): the scrubber grows a body inside the replay bar, never a panel —
  a chapter-mark lane, a time axis, and the transport. Ruling 13 (operator
  amendment, 2026-08-06) cut the per-lane density band entirely after three
  rounds of affordances still read as noise to the one person using it —
  prd3 ruling 25's "every failing mark gets an affordance or is CUT"
  protocol in its clearest live example.
- **prd14 — the experiment console** (`docs/prds/prd14.md`, BLESSED 2026-08-06,
  wave plan not yet landed): a UI onto prd12's laboratory engine —
  checkpoint a lane, fork arms, compare honestly. Ruling 2 was amended
  same-session: arms configure freely (own model, own brief, no forced
  knob), and the *comparison surface*, not the launcher, carries the rigor —
  naming plainly when arms differ in more than one dimension rather than
  refusing to run them. **Open, not ruled:** whether the checkpoint timeline
  scrubs the whole instrument or only the lab's own view; a hard spend cap;
  and **#205 (the fold-order divergence) remains UNRULED — the lab must not
  assume a resolution.**
- **prd15 — the anywhere instrument** (`docs/prds/prd15.md`, BLESSED 2026-08-05,
  partially landed): true, full-featured system agnosticism — any OS, any
  terminal, any agent CLI, any provider, eventually from a plain
  `npm install`. Landed: ruling 1, the transcript-tail state machine as the
  universal liveness/attention organ (#188), and ruling 5, the enrichment
  ladder named not ranked (#190). **Ruled but not yet landed** (waves 3–7):
  ruling 2 (hook beacons upgrading inferred attention to declared), ruling 3
  (provider/model/cost parity for codex/pi adapters — overlaps and narrows
  the old LiteLLM/OpenRouter cohort candidate below to "build the adapters,"
  the contract is already ruled), ruling 6 (multi-orchestrator honesty), and
  ruling 7 (a named Windows-native verification pass). Publish-to-npm is
  this prd's last wave, gated on #177's still-open history-vs-fresh-tree
  decision.
- **prd16 — the session is a thing you can hold** (`docs/prds/prd16.md`,
  shipped): a session is a bounded, operator-bounded episode; the observer
  gains a third hand, the recorder (rotation, writing only inside
  `~/.local/share/rhizomorph/<repo-slug>/`); a closed session's transcripts
  are captured into its own artefact directory rather than resolved live
  from `~/.claude/projects` at replay time; `/recordings` is the library
  surface (rename, open in replay, export the portable record). Closes
  #182's reserved ruling.
- **prd17 — the complete record** (`docs/prds/prd17.md`, BLESSED 2026-08-06,
  partially landed): the instrument's own judgements and the operator's
  decisions join the log. **Landed** (ruling 3, four of five laws): lenient
  parse (an unrecognized event line is counted and voiced, never dropped —
  see [docs/record-format.md](record-format.md#verifying-a-record)), the
  golden era corpus (one real recording per era, folded byte-identically in
  CI), the identity `upcast()` chokepoint, and durability (fsync on close
  and rotation, close-then-open ordering). **Open ruling: #205** — the
  fold-order divergence between live folding (arrival order) and replay
  folding (ts-sorted) is pinned by a fixture but not resolved in either
  direction; no document or code in this tree states or implies a
  guarantee, and none should be inferred. See
  [docs/architecture.md](architecture.md#the-fold-order-divergence--open-tracked-on-205)
  for the three axes the fixture proves diverge. **Ruled but not yet
  landed:** ruling 1's new event families beyond `session.closed` (summons
  raised/cleared, gate/dispatch/fence, operator ack/verdict/note), ruling 2's
  beacon ingestion mechanism, and ruling 4's timeline dividend (chapter
  marks for gate holds, summonses, and operator verdicts) — the richer UI
  built on top of all of it is a separate prd (prd18), not yet a doc in this
  tree.

## Unclaimed candidates (cohort-facing)

Scoped, not built — the deliberate inheritance for the cohort's six-week
project rather than this week's work:

- **The catch-up brief** — left unclaimed on purpose as the cohort's
  flagship first milestone, with the trace layer as its enabler.
- **Task graphs** — a TodoWrite/beads collector for task-size-and-growth per
  lane.
- **LiteLLM/OpenRouter/pi capture** — CLIs without native OTel; prd9 ruling 9
  scoped these as cohort issues rather than building them now. Narrower
  since prd15: ruling 3 (`docs/prds/prd15.md`) already rules the adapter contract
  and names pi-on-OpenRouter/Gemini explicitly, ruled but not yet landed —
  what remains cohort-inheritable is building the adapters against it, not
  designing the contract.
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
  publishing from that week's plan entirely — no npm publish, the clonable
  repo is the install story, and the scoped-vs-unscoped question is moot
  while nothing is published. prd15 (see above) reopens the door prd9
  ruling 2 had closed, but keeps publish gated on #177's still-open
  history-vs-fresh-tree decision — moot still holds today. The release
  machinery from prd8 stays dormant, not deleted.*
- **prd3 next:** the visualization design study, run as a bounded prd; its
  spend-surface patterns feed the factory GUI alpha.
- **macOS CI:** repo is private → claim softened to match verification (#74)
  instead of paying 10x for a macos-latest leg.
