# Council chair: human factors — attention, interruption, and trust engineering

> Rhizomorph council, 2026-08-06. Repo read at
> `\\wsl.localhost\Ubuntu\home\lachlan\worktrees-challenge` (read-only).
> Claim grades: **[Ran]** = I executed a check (grep/read of live tree) ·
> **[Read]** = read directly in the repo · **[Verified]** = checked against
> primary/multiple external sources · **[Hypothesis]** = my inference, testable.

---

## 0. What I grounded on

Repo: `docs/vision.md` (read-only constitution: "launches nothing, merges
nothing, decides nothing"), `docs/architecture.md` (prd3–prd9 + recordings),
`docs/prd3.md` rulings 18 (five pathologies) and 25 (glance test), `docs/prd15.md`
(two-witness law made universal, beacons), `prompts/133-liveness-second-witness.md`
(the false-summons incident), `packages/web/src/panels/attention/*`
(AttentionStripView, ageBands, useTabSignal, waitedChips),
`packages/web/src/fleet/buildFleet.ts` (ladder), `packages/web/src/tide/chapters.ts`,
`packages/core/src/events/common.ts`. **[Read]**

The operator's own literature review,
`research/2026-07-29-human-seams-in-agentic-pipelines.md` (in agenticlaunchpad):
rarity destroys detection (Wolfe 2005/2007: miss 30% at 1% prevalence);
oversight degrades as automation improves (Bailey & Scerbo 32.4%→48.3% omission
as reliability rose 0.87→0.98; Parasuraman 82% vs 33% detection under
varying vs constant reliability); second-reader-with-arbitration is the best-
evidenced mitigation (CO-OPS: +8.89% detection, false recalls *down*); a high
override rate indicts the gate, not the human (Weingart: 97.9% of overrides
correct); attention collapses fast and rebuilds slowly (Wright 2018:
100%→8.4% in, 9.1%→12.7% back); "are you sure?" friction is a measured
failure; calibration-with-feedback is the one measured success (Wolfe 2007).
**[Read]** — I treat that file's `[Verified]` tags as standing.

External (this session): ISA-18.2 lifecycle/rationalization/shelving
([exida](https://www.exida.com/articles/ALARM-MANAGEMENT-AND-ISA-18-A-JOURNEY-NOT-A-DESTINATION.pdf),
[InstruNexus](https://instrunexus.com/a-comprehensive-analysis-of-alarm-management-and-the-isa-18-2-standard/),
[Emerson rationalization whitepaper](https://www.emerson.com/documents/automation/white-paper-alarm-rationalization-deltav-en-56654.pdf));
ISA-18.2 performance KPIs
([Van Camp, "Alarm System Performance Metrics"](https://isa.ie/wp-content/uploads/2016/06/Alarm_System_Performance_Metrics_Kim_Van_camp.pdf));
EEMUA 191 rates ([HazardEx](https://www.hazardexonthenet.net/article/84993/EEMUA-191--Implications-of-Revision-3-on-KPIs.aspx),
[Sarom Global](https://www.saromglobal.com/dcs-alarm-management-a-practical-guide-for-plant-operators/));
aviation alerting ([FAA AC 25.1322-1](https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_25.1322-1.pdf),
[dark cockpit](https://www.airflow.blog/2025/01/16/the-dark-cockpit-philosophy-enhancing-efficiency-and-safety-in-modern-aviation/),
[ECAM](https://pilotpulse360.com/airbus-ecam/));
interruption economics ([Iqbal & Horvitz, OASIS, TOCHI 2010](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/TOCHI-Oasis-final.pdf),
[Horvitz, attention & bounded deferral](http://erichorvitz.com/interrupt.htm),
[Mark, Gudith & Klocke, CHI 2008](https://ics.uci.edu/~gmark/chi08-mark.pdf),
[provenance caveat on the "23 minutes" figure](https://blog.oberien.de/2023/11/05/23-minutes-15-seconds.html));
trust calibration ([Lee & See 2004](https://journals.sagepub.com/doi/10.1518/hfes.46.1.50_30392));
likelihood alarm systems ([Wiczorek & Manzey on Sorkin-style LADs](https://www.researchgate.net/publication/261296880_Supporting_Attention_Allocation_in_Multitask_Environments_Effects_of_Likelihood_Alarm_Systems_on_Trust_Behavior_and_Performance)). **[Verified]**

---

## 1. Credit first: what rhizomorph already does that mature alarm disciplines demand

This matters because the council should not prescribe what already exists.

- **Dark cockpit, implemented as arithmetic.** Law 9a/9b — calm world capped
  at `CALM_CEILING 0.78`, alarms alone above `ALARM_FLOOR 0.84`, all four
  numbers pinned by tests — *is* the Airbus dark-cockpit principle ("if the
  panel is dark, the ship is fine") plus an alerting hierarchy, done better
  than most industrial HMIs because the contrast budget is test-enforced
  rather than styled. **[Read]**
- **Priority tiers exist and are exclusive.** `LadderRank = calm | notice |
  needs-you | broken` (`buildFleet.ts:124`), hue-exclusive per rung, worst
  rung first. **[Ran]** ISA-18.2's ~80/15/5 low/med/high priority distribution
  has a structural cousin here.
- **Never bare reassurance.** `CalmRow` renders ALL CLEAR only *with* the four
  checked figures (ruling 14), and the calm branch's evidence type pins
  `collisions: 0` at the type level (graft g5). This is the repo's own
  "never render 0 findings as reassurance" law, made structural. **[Read]**
- **Partial flood handling at the presentation layer.** `MAX_CHIPS = 4` with a
  counted `+N` overflow; the scene coalesces traffic and caps concurrent event
  motion at 5 (Pylyshyn & Storm). **[Read]**
- **Alarm aging within, never across, the rung** (ageBands quiet <2m / ink
  2–10m / pulse ≥10m; tab title carries the oldest summons age). This is a
  defensible bounded-deferral curve: a summons gets more insistent with age
  instead of interrupting at birth. **[Read]**
- **Detection honesty as a two-level likelihood display.** The `~` inferred
  mark, "declared beats inferred" (#133's law, universalized in prd15 ruling
  2), and the two-witness liveness rule are exactly the graded-confidence
  ("likelihood alarm") pattern Sorkin's line of work shows outperforms binary
  alarms on trust and compliance. **[Read]/[Verified]**
- **Ack-adjacent state exists once:** `parked` — "an acknowledgement, not a
  mute," evidence untouched. **[Read]**

The gaps below are therefore not "adopt alarm discipline" — the discipline's
*rendering* half is largely here. The gaps are almost all in the **feedback
half**: response, acknowledgement, and the system's measurement of itself.

---

## 2. What mature alarm disciplines have that the attention strip lacks

### 2.1 Rationalization: every alarm has a *defined operator response*

ISA-18.2's rationalization stage requires that each alarm be justified by a
documented consequence, response time, and **operator action** — an alarm you
cannot act on is removed ([exida](https://www.exida.com/articles/ALARM-MANAGEMENT-AND-ISA-18-A-JOURNEY-NOT-A-DESTINATION.pdf),
[Emerson](https://www.emerson.com/documents/automation/white-paper-alarm-rationalization-deltav-en-56654.pdf)).
Airbus ECAM goes further: the alert arrives *with its procedure* on the same
screen ([ECAM](https://pilotpulse360.com/airbus-ecam/)); FAA AC 25.1322-1
binds each alert level to a required crew response ("warning: immediate
awareness *and* immediate response; caution: immediate awareness, subsequent
response"). **[Verified]**

Rhizomorph's chips carry lane + WHY + how long (`Chip` in
`AttentionStripView.tsx`) — evidence is superb; **the verb is absent**. A chip
says `⏸ 133-liveness ~ stopped while pane moved · 4m`; nothing on any surface
says what the *correct operator response to a WAITING lane* is (attach and
answer? check the drawer's conversation first? nudge? redispatch?). The
knowledge lives in the operator's head — which fails prd4 ruling 1's own
layman bar, and fails the handover purpose of prd9. **[Read]** One mark of
craft already points the right way: `scene/retire.ts:107` — "a lane nobody can
act on may not ask for anybody." **[Ran]** That is rationalization's first
half (actionability as a criterion for alarming); the second half (state the
action) is unbuilt.

### 2.2 Acknowledgement and shelving semantics

ISA-18.2 distinguishes unacknowledged / acknowledged-still-active / shelved
(auto-unshelve on a timer, "so they are not forgotten") / out-of-service
([InstruNexus](https://instrunexus.com/a-comprehensive-analysis-of-alarm-management-and-the-isa-18-2-standard/)). **[Verified]**

Rhizomorph has none of these at alarm granularity: grep for
`acknowledge|shelv|snooze|dismiss` across `packages/` returns only the parked
lane's docstrings. **[Ran]** `parked` is lane-scoped, written only by dispatch
tooling in `.swarm/lanes.json`, never operable from the instrument. So an
aged summons in the pulse band cannot distinguish **"unseen for 10 minutes"**
(an emergency for an attention instrument) from **"seen at minute 1, operator
mid-response"** (fine, stop shouting). The tab title escalates identically in
both worlds. **[Read]/[Hypothesis]** — trivially testable: it is one state.

Note the constitutional analysis: acknowledgement is operator state *about the
instrument's own alarm*, not a write to the watched repo and not an act on an
agent. The instrument already writes its own JSONL log and label sidecars
outside the repo (`architecture.md`, #156). Ack/shelve is therefore legal
under "launches nothing, merges nothing, decides nothing." **[Read]**

### 2.3 Alarm-system health metrics — is the instrument crying wolf?

ISA-18.2 audits the *alarm system itself*, monthly, with numeric targets:
~150–300 annunciated alarms/day per operator position (~1–2 per 10 min),
<1% of time in flood, stale alarms <5, **chattering alarms: zero**, top-10
alarms <~5% of load ([Van Camp](https://isa.ie/wp-content/uploads/2016/06/Alarm_System_Performance_Metrics_Kim_Van_camp.pdf));
EEMUA 191 defines a flood as >10 new alarms in 10 minutes
([HazardEx](https://www.hazardexonthenet.net/article/84993/EEMUA-191--Implications-of-Revision-3-on-KPIs.aspx)). **[Verified]**

Rhizomorph measures **nothing about its own alerting**. There is no count of
summonses per session, no time-in-alarm, no flood detection, no chattering
detection — grep for `precision|falsePositive|summons` in `packages/web/src`
finds only rendering code. **[Ran]** Worse, the record *cannot* be mined for
it after the fact: `tide/chapters.ts:39` states in its own doc comment that
**"attention-summons onset has no event"** — the ladder is `buildFleet`'s
per-frame judgement against a wall clock, never persisted. **[Read]**

Two concrete consequences:

- **#133 is the proof case.** The false summons on `132-trace-surfaces` was
  found because the operator *happened to be watching live* and could
  cross-examine the session JSONL by hand. The instrument's record contains
  the lane's events but not the summons itself — so nobody can say how many
  false summonses were *not* witnessed. **[Read]** The repo's own research
  says the response to a bad gate is to fix the gate (Weingart), but you can
  only fix gates whose error rate you can see.
- **Chattering is possible and unmeasured.** Detectors have no hysteresis —
  grep for `hysteresis|debounce` finds anti-flap logic only in scene
  *geometry* (`contour.ts`), not in the pathology detectors. **[Ran]** A lane
  hovering at the `workAgeMs` threshold can flap WAITING↔WORKING on a 2s poll
  cadence. **[Hypothesis]** — testable with one fixture that oscillates a
  single witness across the threshold.

### 2.4 Flood suppression by root cause (first-out logic)

Process alarm systems suppress *designed* cascades: when one upstream failure
makes fifty downstream alarms inevitable, the first-out alarm is presented and
the rest are grouped. **[Verified]** Rhizomorph's strip counts past four chips
(`+N`) — presentation-layer flood control — but has no causal grouping: if the
tmux collector dies on a 20-lane fleet, pane silence goes universal, and once
the telemetry witness also ages out, up to 20 FROZEN chips compete with the
one chip that explains them all (`collector.error` escalates to the strip per
prd3 ruling 15, but as a *peer*, not a *parent*). **[Read]/[Hypothesis]** —
testable on the existing 20-lane fixture by killing a collector.

---

## 3. Interruption economics: when to interrupt vs accumulate

The literature's shape: interruption cost is real but non-fatal when delivery
is timed — deferring notifications to task **breakpoints** measurably cuts
resumption cost and frustration, and **bounded deferral** (hold a
notification while the user is busy, up to a maximum age) captures most of
the benefit ([Iqbal & Horvitz OASIS](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/TOCHI-Oasis-final.pdf),
[Horvitz](http://erichorvitz.com/interrupt.htm)). Mark's CHI 2008 result is
subtler than folklore: interrupted workers finished *faster* but with
significantly higher workload, stress, and frustration
([Mark et al.](https://ics.uci.edu/~gmark/chi08-mark.pdf)); the famous
"23 minutes to refocus" figure traces to interviews, not the paper
([provenance](https://blog.oberien.de/2023/11/05/23-minutes-15-seconds.html)).
And from the repo's own research: the design variable is **alerts per decision
episode**, not per week (Ancker: each additional alert per encounter → 30%
drop in acceptance), and attention lost to over-alerting is mostly
unrecoverable (Wright). **[Verified]/[Read]**

Rhizomorph's stance is already close to correct, and the council should say
so: it is a **pull instrument** — the glance test (prd3 ruling 25) is its
contract, the only push channel is the tab title, and escalation is
age-modulated insistence rather than interruption at onset. That *is* bounded
deferral, implemented as brightness. **[Read]**

What is missing is the **budget**, not more push:

- **No summons-rate figure.** EEMUA's manageable-load benchmark (~6/hr, 1–2
  per 10 min) has a direct analogue: if the fleet summons the operator more
  than ~N times/hour sustained, either the fleet is sick or the thresholds
  are — and per Ancker, every excess summons taxes response to all the
  others. Today the operator cannot see this number at all. **[Read]/[Verified]**
- **No batching window on the strip.** Chips appear the poll they trigger.
  For sub-`needs-you` ranks, a short accumulation window (e.g., NOTICE items
  batch and present on the next glance rather than animating in) would follow
  the breakpoint principle: the operator's glance *is* the breakpoint.
  **[Hypothesis]** — the age-band machinery already gives NEEDS-YOU a 2-minute
  quiet band, which is most of this; the gap is only in NOTICE churn.
- **Resist adding an OS-notification channel.** The temptation will come
  (backgrounded operator, aged summons). The evidence warns: hard
  interruptions are the most effective *and* most harmful mechanism (Strom:
  RCT halted after patient harm), and attention doesn't come back after
  over-alerting (Wright). If one is ever added, it should carry only BROKEN,
  batched, with a per-session cap — a fire alarm, not a doorbell.
  **[Read]/[Verified]**

---

## 4. Trust calibration: how does the operator learn when green is trustworthy?

Lee & See's frame: appropriate reliance requires **calibration** (trust
matching true capability) and **resolution** (trust discriminating between
the contexts where the system is good and where it isn't)
([Lee & See 2004](https://journals.sagepub.com/doi/10.1518/hfes.46.1.50_30392)).
The repo's own research adds the cruel dynamic: as the fleet and instrument
improve, defects rarify, and the operator's detection degrades *invisibly*
(Wolfe; Bailey & Scerbo; Reichenbach — operators who checked every parameter
could not recall what they saw). **[Verified]/[Read]**

Patterns with evidence, mapped to this codebase:

1. **Show the instrument's own reliability history.** An operator can only
   calibrate on outcomes they can see. A small standing surface — "this
   session: 7 summonses, 1 marked false; last 10 sessions: 34 summonses, 3
   false, median response 40s" — turns calibration from vibes into data, and
   gives *resolution* if broken down by detector (e.g., "inferred-WAITING has
   an 18% false rate; FROZEN has never been wrong"). Graded-confidence
   displays measurably beat binary alarms on trust and compliance
   ([likelihood alarm systems](https://www.researchgate.net/publication/261296880_Supporting_Attention_Allocation_in_Multitask_Environments_Effects_of_Likelihood_Alarm_Systems_on_Trust_Behavior_and_Performance)).
   Prerequisites: summons events + operator verdicts (§5, items 1–2).
   **[Verified]/[Hypothesis]**
2. **Surface witness count as graded confidence.** The two-witness machinery
   already computes exactly the confidence gradient the LAD literature wants
   — declared > two-witness-inferred > one-witness-inferred — but the chip
   renders only a binary `~`. Rendering the grade is nearly free. **[Read]**
3. **Deliberate calibration drills.** Wolfe 2007: the *only* measured
   intervention that holds detection criterion at low prevalence is brief
   retraining at high prevalence **with feedback**. Rhizomorph is uniquely
   positioned: it already owns staged-pathology fixtures (prd3 ruling 24) and
   replay-as-first-class. A `rhizomorph drill` that replays a recorded
   session (including the #133 corpus and true-pathology sessions) and asks
   "point at what needed you," then scores it, is a cheap, evidence-backed
   feature almost no commercial observability product has. **[Read]/[Verified]**
4. **Forced sampling of green.** Rarity destroys detection because the
   operator stops looking at healthy lanes. A gentle quota — the instrument
   nominates one *calm* lane per session for a 60-second audit ("spot-check:
   lane 141, calm for 2h — open drawer?"), chosen randomly so it can't be
   gamed — artificially restores inspection prevalence. This is the
   second-reader principle bent inward: the operator becomes an occasional
   independent reader of lanes the instrument called fine, which is also the
   only way false-*negative* rates (missed pathologies) ever become
   measurable. **[Hypothesis]**, derived from Wolfe's retraining result and
   the CO-OPS independence finding.
5. **DONE ≠ REVIEWED.** The scene's terminal state (the cord-cut, the scar,
   the root-mass growing) keys off `agent.status: done` / `worktree.removed`
   (`retire.ts`, `isRetired`). **[Read]** The repo's own research law is
   "child-reported success does not count." In the current swarm workflow the
   conductor gates landings, so the scar is *usually* conductor-verified —
   but the instrument cannot tell a gated landing from a worker that removed
   its own worktree, and it renders both as the same settled green wedge. A
   review/gate fact (from operator-acts or a conductor beacon) would let the
   scar honestly carry "landed, gated" vs "landed, ungated." **[Hypothesis]**

---

## 5. The human's side of the record: operator-acts-as-events

Today: rulings live in `docs/prdN.md` and GitHub comments, blessings and gate
decisions in the journal and the conductor's tooling, fence widenings in
`.swarm/lanes.json` diffs, nudges in tmux panes. None are events; none are
replayable; none share the log's clock. **[Read]**

**For:**

- **Accountability with context.** The operator explicitly rejects "a human
  clicked approve" as an answer to responsibility. The alternative is a
  record of *judgement*: who decided, when, **seeing what**. An event-sourced
  instrument gives "seeing what" for free — fold the log to the decision's
  `ts` and you reconstruct the exact screen the decision was made against.
  That is GitHub's stale-review invariant (approval binds to an artifact
  state, dismissed when the artifact moves — **[Verified]**, and already
  endorsed in the repo's own research) generalized to every operator act.
- **Replay grows its missing half.** Replay today shows what the fleet did;
  it cannot show what the human did about it. Every future #133-style
  forensic session currently depends on the operator's memory and journal
  prose. With `operator.*` events, post-incident review becomes scrubbing.
- **It unlocks §2.3 and §4 wholesale.** Summons precision, response latency,
  ack/shelve honesty in replay, drill scoring — every one of them needs the
  human's side of the conversation in the log. One data addition, many
  organs — exactly the shape ruling 19 (lane manifest → off-fence detection
  for free) already proved works in this codebase. **[Read]**
- **It is constitutionally clean.** Read-only means the instrument never
  *acts on* the repo or the agents. It already writes its own log outside the
  watched repo, and `rhizomorph label` already records operator-authored
  metadata. Recording a decision made elsewhere is observation, not
  conduction. **[Read]**

**Against — and the honest mitigations:**

- **Scope creep toward conductor.** If the instrument renders an "approve"
  button, it decides. Mitigation: the vocabulary is bounded to acts *about
  the instrument's own surfaces* (`operator.ack`, `operator.verdict`
  true/false-summons, `operator.note`) plus *ingestion* of decisions the
  conductor's own tooling declares (a `gate.decision` beacon file, exactly
  prd15 ruling 2's beacon shape). The instrument never carries the approval
  UI for the fleet; it archives the fact that an approval happened.
- **Self-surveillance.** Operator-latency metrics are calibration data for a
  solo operator and management telemetry the moment a team uses this.
  Mitigation: reliability history renders the *instrument's* error rate
  (false-summons %) prominently and the *operator's* latency quietly, local
  only, never exported by `export-record` defaults.
- **A partial record lies.** "No ack event" must never render as "operator
  ignored it" — absence is a gap, and the gap-voice pattern already exists
  for exactly this. **[Read]**
- **Duplication.** GitHub already timestamps comments. True but not joinable:
  wrong clock, wrong store, not local-first, invisible to replay. The journal
  is prose. Neither can drive a selector.

**Verdict: for.** Narrow vocabulary, same envelope, same append-only law,
gap-voiced when absent. The strongest argument is the operator's own arc: if
"a human clicked approve" is not an answer to responsibility, then the record
must be able to show what the human *saw and judged* — and today it cannot
show the human at all.

---

## (a) Ranked missing functionality

1. **The summons ledger — the instrument's judgements become events.**
   Emit/derive `summons.raised` / `summons.cleared` (lane, kind, rank,
   witnesses, evidence) whenever the ladder's rank crosses into and out of
   attention. Evidence: `chapters.ts` documents the absence in its own code
   ("attention-summons onset has no event") **[Ran]**; #133 was only
   recoverable by luck **[Read]**; ISA-18.2 audits alarm systems on exactly
   this record **[Verified]**. Everything in items 2–6 stands on it.
   *Cost: one fenced wave* — the fold already computes rank; the work is
   persisting transitions without breaking reducer purity (a derived-event
   emitter beside the recorder, or prefix-consistent selector over the log,
   the discipline `chapters.ts` already models).
2. **Operator acts as events** (`operator.ack`, `operator.verdict`,
   `operator.note`; `gate.decision` ingested from a conductor beacon), each
   stamped with the log offset it was decided against ("seeing what").
   Evidence: §5; approval-binds-to-artifact-state **[Verified]**; enables
   precision, latency, replay's missing half. *Cost: one wave* — new event
   family + one CLI verb + two small UI writes to the instrument's own log;
   the beacon mechanism is already ruled (prd15 ruling 2).
3. **Acknowledge / shelve on the strip, with auto-unshelve.** Ack mutes
   insistence (age pulse, tab title), never evidence or rung; shelve is ack
   with a timer that *always* returns. Evidence: ISA-18.2 shelving semantics
   **[Verified]**; the aged-summons pulse currently cannot distinguish
   unseen from being-handled **[Read]/[Hypothesis]**; "parked mutes the alarm,
   never the evidence" is the house pattern to extend **[Read]**.
   *Cost: small once #2 exists* (an ack is just an operator event the ladder
   reads back).
4. **Every alarm names its verb (rationalization pass).** A
   `Record<AttentionKind, ResponseHint>` — FROZEN → "attach; if dead,
   redispatch"; WAITING → "open conversation, answer the ask"; OFF-FENCE →
   "check trespass victim, widen fence or stop lane"; COLLISION → "expand
   matrix, sequence the landings"; collector → "run doctor" — rendered in
   chip title and drawer. Evidence: ISA-18.2 rationalization; ECAM
   alert-with-procedure **[Verified]**; layman bar (prd4 ruling 1) **[Read]**.
   *Cost: tiny* (one exhaustive map + tests; the exhaustive-Record pattern is
   house style).
5. **Instrument reliability history + witness-grade on chips.** The
   false-summons rate and per-detector precision over the last N sessions,
   rendered beside ALL CLEAR (quiet, ice register); chips show declared vs
   2-witness vs 1-witness instead of bare `~`. Evidence: Lee & See
   calibration/resolution; likelihood-alarm literature **[Verified]**; the
   witness data already exists in `buildFleet` **[Read]**. *Cost: small*
   after #1+#2 (a selector over summons+verdict events, plus chip cosmetics).
6. **Calibration drills + green-sampling quota.** `rhizomorph drill` replays
   staged-pathology and #133-corpus recordings, scores "point at what needed
   you," and reports; the instrument nominates one random calm lane per
   session for a 60s audit. Evidence: Wolfe 2007 — the only measured fix for
   low-prevalence detection collapse **[Verified]**; fixtures + replay are
   already first-class **[Read]**. *Cost: small-medium* (drill = replay +
   scorecard; quota = one selector + one quiet chip).
7. **Alarm-health meta-panel: summons rate, flood, chattering.** Summons/hour
   vs a declared budget; flood detection (>X new summonses / 10 min → group
   into one first-out item, e.g. collector death suppresses its downstream
   FROZEN storm); hysteresis on threshold detectors so a boundary-hovering
   lane cannot chatter. Evidence: EEMUA 191 flood definition, ISA-18.2
   chattering-zero target **[Verified]**; no hysteresis exists in detectors
   **[Ran]**. *Cost: medium* (grouping needs causal attribution;
   hysteresis is a small detector change with fixture tests).
8. **DONE ≠ GATED on the terminal state.** Scars and the root-mass carry
   whether a landing was gate-verified (from `gate.decision`) or merely
   self-reported. Evidence: "child-reported success does not count" is the
   repo's own law **[Read]**; currently both render identically
   **[Read]/[Hypothesis]**. *Cost: small* after #2.

## (b) Candidate design principles, stated as testable laws

1. **Every alarm names its verb.** No summons renders without a defined
   operator response beside its evidence. *Test:* exhaustive
   `Record<AttentionKind, ResponseHint>` — a new pathology kind without a
   verb fails typecheck, the same trick the palette maps already use.
2. **The instrument's own judgements are events.** Anything the instrument
   ever told the operator must be reconstructable from the log alone.
   *Test:* prefix-consistency (chapters.ts's law 2) applied to summons
   intervals — fold of a time-prefix equals the whole-log fold filtered to
   that prefix; live and replay derive byte-equal summons ledgers.
3. **The human is a collector.** Operator acts enter the same append-only
   log through the same envelope, under the same honesty rules; absence of
   an operator event is voiced as a gap, never rendered as neglect or
   compliance. *Test:* reducer folds `operator.*`; a fixture with no operator
   events renders the gap voice, not a zero.
4. **Acknowledgement mutes insistence, never evidence** (the parked law,
   generalized). An acked item keeps its rung, its evidence, and its place in
   the ladder; only its motion, pulse, and tab-title claim stand down — and a
   shelf always expires. *Test:* acked fixture item still present in
   `ladder.items` with evidence untouched; shelved item re-summons after its
   timer with no new triggering event.
5. **Quiet is priced, not just evidenced.** ALL CLEAR carries both what was
   checked (already law) and how often this instrument has recently been
   wrong. *Test:* `CalmEvidence` grows a `falseSummonsRate` field the type
   requires — bare reassurance stays unrepresentable.
6. **The summons rate is itself an alarm.** A session sustaining more than
   the declared summons budget raises a NOTICE naming the noisiest detector —
   crying wolf is an instrument pathology, ranked and rendered like any
   other. *Test:* 20-summons/hour fixture yields the meta-notice; a calm
   session never does.

## (c) What the operator is missing that's obvious

**The instrument measures every lane's behavior and none of its own — and
none of yours.** You built an event-sourced system precisely so that "replay
falls out free," and then left both parties of the only conversation that
decides whether this product works — *the instrument summons; the operator
responds* — out of the event log entirely. Your own code admits it
(`tide/chapters.ts`: "attention-summons onset has no event"); your own
incident proves it (#133 was caught because you happened to be watching, and
the investigation ran on your memory plus a hand-grepped JSONL); and your own
research file predicts the consequence (detection degrades precisely as the
fleet improves, and the degradation is invisible to the person degrading).
Every future false summons — and every false *calm* — is less likely to be
caught by your glance than this one was. The record has to catch it, and
today the record structurally cannot, because the record does not contain
what the instrument said or what you did.

One addition — summonses and operator acts as events — and the rest of this
chair's list (precision history, ack/shelve, drills, response latency,
DONE≠GATED) stops being features and becomes selectors. That is the same
move that made replay free. You already know this trick; you just haven't
pointed it at yourself.
