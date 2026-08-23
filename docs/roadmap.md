# Roadmap

> Rough shape blessed by Lachlan 2026-07-30; re-cut per prd as each lands.
> prds are blessed docs before they are backlogs, backlogs before they are
> fleets.

- **prd1 — the money layer** (`docs/prds/done/prd-01-money-layer.md`, shipped): native telemetry
  collectors (sessionlog + otel), cost selectors with the role dimension,
  spend ticker, per-lane cost, collapsible panels, bounded scene
  meaning-fixes.
- **prd2 — anyone, anywhere** (`docs/prds/done/prd-02-anyone-anywhere.md`, shipped): trustworthy numbers
  (session-scoped totals, true timestamps, resume-on-restart), identity that
  cannot collide (instance namespacing, explicit-at-source, no magic strings),
  cost that reaches the branch ledger, visible threads, and a first-run that
  works for a stranger.

- **prd3 — the viz design study.** *Superseded by what actually shipped —
  see `docs/prds/done/prd-03-viz-design-study.md`: a same-day spike round chose Direction C, Mycelium
  Pulse-Network, over the two other spike builds, and prd3 landed as "the
  beautiful instrument" — the derived fleet object, the glyph alphabet, the
  pulse-as-event laws, the lane manifest/fence contract.* The big one, had
  properly: every visual channel encodes a metric or is removed; relatedness
  layout (file/semantic proximity), cost-in-scene, task-progress
  verticality — designed against real prd1 data and interview findings.
- **prd4 — the catch-up brief + lane chat replay.** *Superseded by what
  actually shipped — see `docs/prds/done/prd-04-human-facing.md`: prd4 landed as "the layman bar," an
  operator-review pass re-aiming every surface at a first-time viewer — the
  hue/brightness palette, the scene as centerpiece, the conversation drawer,
  parked-as-a-state. The catch-up brief itself was never built under this
  slot; it reappears below as a cohort candidate.* "What did my swarm do
  while I was away" as a first-class digest (the strongest user-stated pain
  from the JV call), plus click-a-lane chat replay reconstructed from session
  logs at major-event granularity.
- **prd5 — task graphs + tool-agnostic capture.** *Superseded by what
  actually shipped — see `docs/prds/done/prd-05-beautiful-application.md`: prd5 landed as "the finished
  application" — camera and gestures, the motion budget, the cord-cut, amber
  aging, orientation keyboard registers. Task graphs and the LiteLLM route
  were never built under this slot; task graphs reappears below as a cohort
  candidate.* TodoWrite/beads collector for task-size-and-growth per lane;
  the LiteLLM passthrough route (proven viable with subscription OAuth — see
  the research note) for CLIs without native OTel.
- **prd6 candidate / standing research question — dispatch-policy
  optimization.** *Superseded by what actually shipped — see `docs/prds/done/prd-06-living-cycle.md`:
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
- **prd7 — procedural form** (`docs/prds/done/prd-07-procedural-form.md`, shipped): ribbons replace
  stroked lines, the root-mass becomes one marching-squares contour, canvas
  2D confirmed over WebGL by measurement rather than assumed.
- **prd8 — from private project to published software** (`docs/prds/done/prd-08-published-software.md`,
  shipped): the `rhizomorph` rename, a `files` allowlist verified by
  `npm pack`, the README as a trust document, CHANGELOG/semver policy, a
  tag-gated release workflow.

- **prd9 — the trace era** (`docs/prds/done/prd-09-trace-era.md`, shipped): the one-week handover
  push — a junior-proof front door, then a trace layer ripped-with-evidence
  from OpenTelemetry and Langfuse (`research/2026-08-03-trace-era-captures.md` [never committed]).
  Landed in full: the `trace.span` keystone (#123), wave A's receiver,
  selectors and CLI/doctor lines (#124–#126), and wave B's lane-drawer TRACE
  waterfall (#132) plus the vendored, SHA-pinned Langfuse pricing table
  (#129). See [docs/architecture.md](architecture.md#prd9--the-trace-era)
  for the walkthrough.
- **prd10 — the gorgeous round** (`docs/prds/done/prd-10-gorgeous-round.md`, shipped): a scene-beauty
  pass on prd7's procedural form — thread underglow, a tissue-density ramp
  toward the root-mass, further contour refinement — confined to
  `packages/web/src/scene/`, changing no law prd3–prd9 established about
  what a colour, shape, or motion class means.
- **prd11 — the causal record** (`docs/prds/done/prd-11-causal-record.md`, shipped): provenance at
  file granularity (`tool.activity`'s optional `filePath`/`toolUseId`) and
  the portable session record — a manifest, the event log's own events
  re-serialized one line each, and a hash chain closing in the manifest's
  digest, specified in full in
  [docs/record-format.md](record-format.md). Built toward a future
  "forest" (a multiplayer instrument with persistent cross-coworker
  knowledge) as a merge later, not a rewrite, but the forest itself is not
  built here.
- **prd12 — the laboratory** (`docs/prds/done/prd-12-laboratory.md`, shipped): the read-only
  constitution amended to two hands — the observer, absolutely untouched,
  and the laboratory, an explicitly-invoked second actor confined to
  `refs/rhizomorph/` and artefacts outside the watched repo. The engine is what
  shipped *here*; its UI is prd14's and is live — `packages/web/src/lab/` is 32
  tracked files, reached from `App.tsx:129`.
- **prd13 — the TIDE** (`docs/prds/done/prd-13-tide.md`, shipped, cut down from its first
  shape): the scrubber grows a body inside the replay bar, never a panel —
  a chapter-mark lane, a time axis, and the transport. Ruling 13 (operator
  amendment, 2026-08-06) cut the per-lane density band entirely after three
  rounds of affordances still read as noise to the one person using it —
  prd3 ruling 25's "every failing mark gets an affordance or is CUT"
  protocol in its clearest live example.
- **prd14 — the experiment console** (`docs/prds/prd-14-experiment-console.md`, BLESSED
  2026-08-06, partially shipped): checkpoint, fork, branching, free arm configuration,
  spend estimates and honest comparison are live. Comparison artefacts serialize and parse,
  but are not saved into or reopened from prd16's recording library. The open timeline,
  spend-cap and fold-order rulings remain open; no backlog issue currently owns the artefact
  integration.
- **prd15 — the anywhere instrument** (`docs/prds/prd-15-anywhere-instrument.md`, BLESSED
  2026-08-05, partially shipped): the universal transcript organ and named enrichment ladder
  ship. The original remainder has split into narrower successors: prd25 owns Windows, prd26
  dialect capture, prd27 declared beacons, and prd34 delivery. Multi-orchestrator honesty and
  terminal/PTY parity remain here and have no live backlog owner.
- **prd16 — the session is a thing you can hold** (`docs/prds/done/prd-16-session-you-can-hold.md`,
  shipped): a session is a bounded, operator-bounded episode; the observer
  gains a third hand, the recorder (rotation, writing only inside
  `~/.local/share/rhizomorph/<repo-slug>/`); a closed session's transcripts
  are captured into its own artefact directory rather than resolved live
  from `~/.claude/projects` at replay time; `/recordings` is the library
  surface (rename, open in replay, export the portable record). Closes
  #182's reserved ruling.
- **prd17 — the complete record** (`docs/prds/prd-17-complete-record.md`, BLESSED 2026-08-06,
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
- **prd19 — the connection** (`docs/prds/done/prd-19-the-connection.md`, shipped): the
  `/connect` handshake, folded connection facts, exact remedies and doctor route ship; zero
  folded events is not accepted as proof that a source is live.
- **prd20 — the concierge** (`docs/prds/prd-20-the-concierge.md`, proposed, partially shipped):
  explicit launch/relaunch, clone, discovery and the guarded retarget engine ship. The wizard
  still cannot choose a discovered repository and invoke the retarget. prd42 hardens the
  already-built path boundary but does not own this missing operator flow.
- **prd21 — the scrub bar** (`docs/prds/done/prd-21-scrub-bar.md`, shipped): replay that moves
  smoothly, says where it is, and opens to the full record at a point. Profiling
  overturned the obvious diagnosis — #160's incremental fold is sub-millisecond
  at every size, and the cost is `buildFleet`, which is O(telemetry records) and
  over the frame budget even on a four-lane session. **Ruling 1 landed in full**
  (#267's incremental spend cursor in core, then #269's seek coalescing, #270's
  1000-notch step, #271's 10 fps tick); the two defects verify passes found
  afterwards closed 2026-08-13 (#364 the frame-bounded exemption, #395 the
  resume-after-pause pin). **Ruling 2 — the loupe, reading raw events past the
  mark lane's cap — shipped 2026-08-13** (#273, trigger ruled on the issue:
  zooming past the cap opens it), alongside the readability half (#272: an
  always-on axis and a readout at the thumb, both ruled).
  Numbered 21 at the operator's direction: prd18 stays reserved for prd17's
  richer-UI thread.
- **prd22 — survives a real machine** (`docs/prds/done/prd-22-survives-a-real-machine.md`,
  shipped): collector ticks are bounded, failures recover and speak, removals and parse skips
  are honest, paths remain byte-honest, recording failure cannot seal the recorder forever,
  and a source-derived mutation-tested law makes the resilience wrapper unavoidable.
- **prd23 — the trust boundary** (`docs/prds/done/prd-23-the-trust-boundary.md`, shipped): the
  capability token reaches the browser without entering logs, every command
  route is structurally classified and guarded, real browser-to-server mutation
  contracts hold, and loopback host checks protect reads as well as writes.
- **prd24 — the seam that lies** (`docs/prds/prd-24-the-seam-that-lies.md`, BLESSED
  2026-08-06, partially shipped): contract tests, source-derived laws and mutation proofs now
  protect many critical seams. The original audit plan is stale: CI ordering, boot smoke and
  coverage work now overlap prd25 and prd43, while ADR-0026 supersedes its blanket Playwright
  rejection. The surviving audit scope needs a fresh cut before issues are filed.
- **prd25 — the third platform** (`docs/prds/prd-25-the-third-platform.md`, proposed,
  revalidated): Windows remains unsupported in CI and the pack-smoke path still has no
  `windows-latest` leg. This is relevant and bounded, but must be blessed before issue creation.
- **prd26 — the second dialect** (`docs/prds/done/prd-26-the-second-dialect.md`, shipped):
  the capture-gated conformance seam, Codex evidence, shared roster, and a real Pi observation
  dialect ship. Pi emits five provided signals and one honestly partial signal and verifies
  transcript flow; launching it belongs to prd20, not this PRD.
- **prd27 — the declared voice** (`docs/prds/prd-27-the-declared-voice.md`, BLESSED
  2026-08-07, partially shipped): two of four declared-voice successes ship. Hook beacon
  ingestion and capability-version mismatch voice remain, with no current backlog owner.
- **prd29 — the identity seam** (`docs/prds/prd-29-the-identity-seam.md`, proposed, partially
  shipped): the gated-read seam and its first seven browser reads ship. The remaining policy
  question is unresolved and blocks prd43 issue #23; it needs an operator ruling, not an
  implementation issue.
- **prd30 — the open hand** (`docs/prds/prd-30-the-open-hand.md`, BLESSED 2026-08-08,
  partially shipped): the shared card, condition selector and teach layer ship, but the code's
  own law still names `MarkHoverCard`, the loupe read-out and the semantic `title=` adoption
  sweep. First-glance acceptance follows that sweep.
- **prd31 — the bracketed voice** (`docs/prds/done/prd-31-the-bracketed-voice.md`, shipped):
  one kind grammar, structural conversation bracketing, trace density, and one typed search over
  conversation, feed and trace all ship; filtered surfaces state what they hide.
- **prd32 — the readable instrument** (`docs/prds/done/prd-32-the-readable-instrument.md`, shipped):
  local Inter and JetBrains Mono faces, a build-policed type and colour ramp,
  computed contrast in both themes, one focus token, and a persisted light/dark
  switch whose chrome never impersonates status.
- **prd33 — the living scene** (`docs/prds/prd-33-the-living-scene.md`, BLESSED 2026-08-08,
  acceptance pending): the scene work and recorded before/after frame measurements ship. The
  remaining gate is the first-glance operator act. Success criterion 1's five-lane cap is
  historical and superseded by ruling 10's seven-lane cap.
- **prd34 — the doorstep** (`docs/prds/prd-34-the-doorstep.md`, proposed, release acceptance
  pending): the Electron shell, tray, first run, three-platform installer workflow and update
  gate ship. Signing/feed activation is deliberately deferred by ruling 9; a measured Windows
  first run and release decision remain. prd43 #21 covers install identity and CLI listing only.
- **prd35 — the operator's hand** (`docs/prds/done/prd-35-the-operators-hand.md`, shipped): one
  settings surface owns every preference, makes scope and overrides visible,
  persists them correctly, and structurally forbids controls that would weaken
  the instrument's honesty laws.
- **prd36 — the fleet surface** (`docs/prds/done/prd-36-the-fleet-surface.md`, shipped): the scene
  and roster are one surface with instant, state-preserving organism/list
  representations; the list remains the accessible fleet-scale floor, while
  lane study belongs to the addressed run view rather than duplicate readers.
- **prd37 — the shared world** (`docs/prds/parked/prd-37-the-shared-world.md`, parked): a
  speculative shared/multiplayer product direction with no acceptance evidence, milestone or
  backlog. It requires renewed product approval before grooming.
- **prd38 — the borrowed credential** (`docs/prds/parked/prd-38-the-borrowed-credential.md`,
  parked): a speculative remote-credential direction with no acceptance evidence, milestone or
  backlog. It requires renewed product and security approval before grooming.
- **prd39–43 — current blessed programme** (`docs/prds/prd-39-the-gate-that-holds.md` through
  `docs/prds/prd-43-the-claim-is-a-test.md`): the 24 open board issues all belong here — 2 in
  prd39, 3 in prd40, 5 in prd41, 5 in prd42 and 9 in prd43. These PRDs are fresh, blessed and
  actively represented by the GitHub backlog.

## Unclaimed candidates (cohort-facing)

Scoped, not built — the deliberate inheritance for the cohort's six-week
project rather than this week's work:

- **The catch-up brief** — left unclaimed on purpose as the cohort's
  flagship first milestone, with the trace layer as its enabler.
- **Task graphs** — a TodoWrite/beads collector for task-size-and-growth per
  lane.
- **LiteLLM/OpenRouter/pi capture** — CLIs without native OTel; prd9 ruling 9
  scoped these as cohort issues rather than building them now. Narrower
  since prd15: ruling 4 (`docs/prds/prd-15-anywhere-instrument.md`) already rules the adapter contract,
  and ruling 3 names pi-on-OpenRouter/Gemini explicitly, both ruled but not yet landed —
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
