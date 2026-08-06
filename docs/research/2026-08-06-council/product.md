# Product strategy chair — jobs, gaps, and leverage

**Council question (verbatim):** *"what other functionality are we missing here? what am I missing that's obvious?"*
**Chair:** product strategy. **Date:** 2026-08-06. **User model:** one solo operator, scarcest resource
attention, stated ambition the one-person company.

**Grading.** `[Ran]` — verified this session by direct repo inspection (file cited).
`[Read]` — repo document read this session, claim is the document's own. `[Verified-by-proxy]` —
external primary source verified by the repo's own graded research notes, which I read; I cite the
note, not the original. `[Hypothesis]` — falsifiable inference, no direct evidence.

**Sources ground truth:** `docs/vision.md`, `docs/prd0.md`, `docs/prd11.md`–`docs/prd16.md`,
`docs/roadmap.md`, `README.md` (Trust), `docs/research/2026-08-05-replay-ux-spike.md`,
`docs/research/2026-08-04-dashboard-ia-spike.md`, `docs/research/2026-08-03-langfuse-ui-study.md`,
`docs/research/2026-08-05-adversarial-audit.md`, source under `packages/web/src` and
`packages/server/src` (all via UNC, read-only), and — outside the repo —
`C:\Users\operator\agenticlaunchpad\research\2026-07-29-human-seams-in-agentic-pipelines.md` and
`C:\Users\operator\agenticlaunchpad\JOURNAL.md`.

---

## 0. What the constitution actually permits now (this matters for every verdict below)

The founding law — read-only, launches nothing, decides nothing (`docs/vision.md`, `docs/prd0.md`
`[Read]`) — has been **amended twice, both times by the same mechanism**: a narrowly-scoped extra
"hand," explicitly human-invoked, writing only outside the watched repo, shipped with its own law
tests.

- **prd12** added the laboratory's hand (fork refs under `refs/rhizomorph/`, artifacts in the data
  directory) `[Read]`.
- **prd16** added the recorder's hand (session rotation; a UI button; writes only under
  `~/.local/share/rhizomorph/<repo>/`) — and, critically, established the **sidecar posture**:
  operator labels live in a file *beside* the append-only log, never inside it (`log/label.ts`,
  prd16 ruling 3) `[Read]`.

So the honest test for any candidate feature is no longer "is it a write?" It is: **(a) does it act
on the watched repo or the agents (forbidden forever), (b) is it operator-invoked, (c) does it land
in rhizomorph's own namespace as a sidecar, (d) does it get a law test?** Several "obviously
unconstitutional" features pass this test. Several "obviously fine" ones fail the *other*
constitution — the curated order, no legend, no second overview, the scene is the hero
(`docs/prd13.md` ruling 1, dashboard-IA spike §5 `[Read]`).

Also load-bearing: the replay spike's jobs ranking — **absence review (daily) > incident forensics
(weekly, highest stakes) > fork-point selection (strategic) > handover > cost forensics (last;
"explicitly no new timeline surface")** (`docs/research/2026-08-05-replay-ux-spike.md` §3 `[Read]`).
I treat that ranking as settled and build on it rather than re-litigating it.

---

## 1. Sweep one — the operator's day, step by step

The day, reconstructed from the operator's own journal and the swarm-conduct workflow (groom fenced
issues → dispatch waves → gate every landing; `JOURNAL.md` in agenticlaunchpad shows the full loop
including the nightly hand-written entry `[Ran]`):

**dispatch → absence → return → triage → gate → review → journal → plan**

| Step | Served today | The gap, honestly |
|---|---|---|
| **Dispatch** | Watches lanes appear; fence manifest read from `.swarm/lanes.json` | None to close — dispatch is conducting. The roadmap already rules "the optimizer never lives in the Rhizomorph: sensor array in the balcony, policy in the conductor" (`docs/roadmap.md` prd6-candidate `[Read]`). |
| **Absence** | Recording always-on; attention ladder; tab title + favicon flip (`useTabSignal` `[Ran]`) | Signal dies with the browser. Nothing reaches an operator who is *away from the tab* — and "nothing leaves the machine" does not forbid a **local** OS notification. Genuine omission, tiny. |
| **Return** | Replay + chapter marks; "Replay this session's birth"; the collapsed picture | **The catch-up brief.** Named "the strongest user-stated pain from the JV call" and left deliberately unclaimed for a cohort (`docs/roadmap.md` `[Read]`) — a cohort that is not here. Absence review is the #1 job and its answer today is *watch a replay*, not *read a brief*. |
| **Triage** | Attention strip: ≤4 chips + `+N`, `n`/`Shift+n` cycling, age-based insistence, PARKED as standing mute (`README.md` `[Ran]`) | No acknowledgement state. A summons you have seen and deferred yells exactly as loudly as one you haven't. `grep` for ack/dismiss/snooze in `panels/attention`: nothing `[Ran]`. |
| **Gate** | Chapter mark `gate-held`; `commit.landed` events; feed line for landings | **The instrument shows no diff, anywhere.** Every `diff` match in `packages/web/src` is a code comment about reviewers, not a surface `[Ran]`. The single highest-stakes human decision of the day — land or don't — happens entirely off-instrument. |
| **Review** | Judge collector (intent collisions via `merge-tree`, `collectors/judge/` `[Ran]`); trace waterfall; transcripts in drawer | Partial. The second-witness *data* is arriving; no surface juxtaposes claim vs. evidence at the landing moment. |
| **Journal** | Nothing | Fully unserved. The operator hand-serializes what the instrument already recorded, nightly — see §4. |
| **Plan** | `rhizomorph sessions` per-session aggregates; ledger | No cross-session view ("what does a wave cost me, typically"). Modest; rides prd16's `/recordings`. |

### Candidate-by-candidate verdicts (the list the council was asked to adjudicate)

**SEARCH — split verdict: accept narrow, kill global.** Nothing searches anything `[Ran — grep across
packages/web/src; every "search" hit is binary-search/geometry code]`. But walk the jobs: the fleet
table is small enough to scan; commits are `git log` territory in the operator's own terminal;
chapters + deep-linked lanes already answer "when did X happen" for the moments that matter. The two
searches with a real daily customer: **find-in-transcript** (the drawer tails a conversation that ran
to ~9 MB on one busy lane — prd16 ruling 3 `[Read]` — and offers no way to find anything in it) and
**jump-to-lane/chapter** by name. Global cross-session full-text search is a Langfuse table stake
(`docs/research/2026-08-03-langfuse-ui-study.md` `[Read]`) that serves teams with thousands of
traces; a solo operator with a recordings library and deep links does not have that problem yet.
Kill global; accept drawer-find + a quick-jump. Cost: S.

**SESSION DIGEST / shift report — accept, highest leverage in this note.** Full argument in §4. The
key product fact: everything needed already exists as tested selectors — `SessionListing` computes
title/lanes/landed/duration/tokens/cost (`log/listing.ts`, prd16 `[Read]`); `chaptersFor` computes
the narrative beats with human-voiced labels (`"163 landed · 14:32:07"`, `chapters.ts` +
`chapterLabel` `[Ran]`); the gap voices are already prose. What's missing is only the emitter.
NOC/control-room practice treats the shift report as table stakes `[Hypothesis — practice claim,
not independently sourced this session]`; the roadmap treats it as the flagship unbuilt feature
`[Read]`. Cost: M. Ship as `rhizomorph digest [session]` → markdown to stdout — a *pipe, not a
panel*, so the curated order is untouched and the no-second-overview law holds by construction.

**DIFF REVIEW surfaces — accept a bounded form; kill the workbench.** The evidence base is the
strongest of any candidate: the operator's own research found second-reader-with-arbitration the
best-evidenced oversight mechanism anywhere (cancer detection +8.89% with *fewer* false recalls,
n=805,206, independence the active ingredient), and simultaneously found that a human reviewing
every diff is a 1%-prevalence searcher missing ~30% of rare defects
(`research/2026-07-29-human-seams-in-agentic-pipelines.md` §1, §7 `[Read; the note grades these
Verified against primary literature]`). Read carefully, that argues **against** "show every diff for
human review" and **for** "make the landing inspectable and put the second witness beside it": click
a `lane-landed` chapter or feed line → diffstat + patch (read-only `git show`, fully within the
observer's law) with any judge finding for those files docked alongside. The human goes where the
machines disagree — the seam the same research says is the one worth spending humans on. What must
NOT be built: approve/reject affordances (that is conducting; the gate lives in the conductor), or a
review queue (a queue implies the instrument owns the workflow). Cost: M.

**ANNOTATIONS on the timeline — accept; the constitution already contains it.** The replay spike
evaluated pins (Dota player markers, Replay.io comments) and deferred them as "a write path in a
read-only product" (§1.6 `[Read]`) — but that was written **before prd16**, which shipped the exact
answer: the label sidecar. An annotation is `rhizomorph label` generalized from session granularity
to instant granularity: a sidecar file of `{ts, text}` pins, rendered in the existing mark lane (no
new hue, still glyphs, coalescing law applies), exported with the record or not by operator choice.
Serves incident review ("look here later"), fork-point selection (mark the candidate before the lab
lands), and handover. It is also the only mark kind the instrument *cannot derive* — the spike says
exactly this `[Read]`. Cost: S–M.

**BUDGETS / burn alerts — kill, with one carve-out.** Cost forensics is the bottom-ranked job and
the spike explicitly forbids growing surfaces for it `[Read]`. Sharper: this operator's marginal
token cost is near zero — course work runs on a Team subscription (project CLAUDE.md `[Ran]`), and
the telemetry docs already carry a subscription-dollars honesty note (`README.md` → `docs/telemetry.md`
`[Read]`). A dollar budget guards a resource this user doesn't spend. The resources actually at
risk during absence are **attention and rate limits** — and prd15 ruling 6 already legislates the
`telemetry.refused` voice `[Read]`. Carve-out: if budgets ever return, they are one more attention
rung with an evidence line, not a config system. Cost of the kill: zero.

**Fleet KNOWLEDGE as product data — defer; accept only the read posture, later.** The scars are
real and currently live in the conductor's hand-written journal ("the workmux two-pane trap…',
'fence what wires, not just what changes'" — agenticlaunchpad `JOURNAL.md` `[Ran]`). Three honest
observations: (1) most scars are *toolchain* knowledge, not *this-repo* knowledge — wrong shape for
a per-repo instrument; (2) the instrument already has a precedent for reading operator-declared
repo facts (`.swarm/lanes.json`, `parked: true` `[Ran — README]`), so a future `.swarm/` knowledge
file surfaced beside lanes is constitutional and cheap *when multiplayer arrives* — the forest is
"persistent knowledge of every coworker's swarm" (`docs/prd11.md` `[Read]`), so this is a forest
organ, not a solo one; (3) annotations (above) cover the moment-anchored slice today. Defer; revisit
at the forest prd. Cost now: zero.

**ACKNOWLEDGEMENT semantics (seen/handled/muted) — accept a narrow "seen"; kill "handled/muted".**
Incident tooling treats ack as table stakes and alarm-management practice (shelving, out-of-service)
exists precisely because un-ackable alarms train operators to ignore the board `[Hypothesis —
practice claim]`. Rhizomorph already has the extreme ends: nothing (no ack) and PARKED (standing,
operator-declared, evidence-preserving mute) `[Ran]`. The missing middle is *seen*: an
operator-invoked dim on a specific summons, which recedes visually but never changes the evidence
line's counts and never suppresses escalation (age still insists; FROZEN still summons). "Handled"
is a lie waiting to happen (the instrument can't verify handling — that's the false-green class the
human-seams note documents `[Read]`), and "muted" already exists as PARKED. The one real design
risk: the attention strip's authority comes from stating what *is*, not what you've admitted; ack
must therefore be brightness/order only, never filtering. Client-side or sidecar state. Cost: S.

**"What should I do next" ordering — mostly served; accept one affordance.** The ladder already
orders by rung, age makes the same rung more insistent without promotion (`README.md` "Amber ages
with attention" `[Ran]`), and `n`/`Shift+n` walks the queue. That *is* the next-action ordering, and
policy beyond it belongs to the conductor (roadmap ruling `[Read]`). The one genuine miss: `+N`
truncation hides the tail of the queue with no way to see it whole — make `+N` expand to the full
ordered list. Anything smarter (priority scores, suggested actions) is the instrument deciding,
which it never does. Cost: XS.

---

## 2. Sweep two — table stakes elsewhere: refusal or omission?

For each adjacent family: what they consider table stakes, and whether rhizomorph's lack is a
**deliberate constitutional refusal (R)** or a **genuine omission (O)**.

**CI dashboards — Buildkite / GitHub Actions** (via the repo's own verified comparison, replay spike
§1.7 `[Read]`):
- *Waterfall/duration view*: the spike found "the Tide's bands already are Buildkite's waterfall" —
  then prd13 ruling 13 **cut the band** after three rounds of fixes, knowingly giving up "the
  at-a-glance busy/quiet texture, and per-lane duration history in the bar," relocating them to
  `/lane/:handle` and the drawer `[Read]`. **R** — but a named, revisitable one: the cut's own text
  says what was given up so "nobody re-adds it by accident."
- *Retry / re-run step*: **R** forever (conducting).
- *Logs per step*: served (drawer transcript + trace waterfall).
- *Notifications on completion/failure*: **O** — the local half. Nothing-leaves-the-machine forbids
  Slack/email, not a browser-local OS notification; today only the tab title flips (`useTabSignal`
  `[Ran]`). Genuine, tiny omission.
- *Run history / badges*: prd16's `/recordings` is this, landing now `[Read]`.

**Incident tooling — PagerDuty / incident.io** `[Hypothesis — category knowledge, no primary doc
fetched this session]`:
- *Ack/resolve*: **O** (narrow accept above). - *Escalation policies, on-call*: **R-shaped kill** —
  there is no second person; the ladder *is* the escalation policy. - *Postmortem timeline with
  annotations*: **O** → annotations (accept above); the replay + record is already the postmortem
  artifact. - *Status page*: n/a solo.

**Session replay — Replay.io / rrweb** (repo-verified, replay spike §1.5 `[Read]`):
- *Focus window filtering surfaces*: already legislated (prd13 ruling 5, #170). - *Comments as
  pins*: **O** → annotations. - *Skip-inactive*: legislated as explicit-jump (spike R5). - *Share
  a moment*: legislated (deep-link window + `t=` recommendation, spike R6). Nothing new to decide
  in this family — its table stakes are either shipped, legislated, or accepted above.

**Agent observability — Langfuse / AgentOps** (repo-verified live study,
`2026-08-03-langfuse-ui-study.md` `[Read]`):
- *Full-text search over traces*: **O**, deliberately narrowed (§1). - *Scores / evals / datasets /
  annotation queues*: **R** — the study's own verdict: "SKIP the annotation/eval surface entirely
  (not our product)"; the judge is the in-house second witness. - *Prompt management*: **R**
  (conducting). - *Aggregate dashboards over time*: **O**, small — cross-session aggregates belong
  in `/recordings`, not a new overview. - The study's sharpest finding cuts the other way: Langfuse
  starves on agent-CLI data (null payloads, $0.00 costs) where rhizomorph pairs spans with the
  actual transcript `[Read]` — the moat is context, not feature count.

**Game replay / spectator — Dota 2, SC2** (replay spike §1.6 `[Read]`):
- *Auto-highlights*: chapters, shipped. - *Player-droppable markers*: **O** → annotations. -
  *Spectator camera / observer UI*: the scene + focus modes are this. - The SC2 community's habit of
  replacing bare replay UIs wholesale is the spike's warning already absorbed into the marks
  investment `[Read]`.

**NOC / mission control** `[Hypothesis — practice claims]`:
- *Alarm ack + shelving with auto-return*: **O** narrow / PARKED covers standing shelving. -
  *Alarm rationalization ("every alarm has a response")*: already law — "an item with no evidence
  string does not render" (dashboard-IA spike §5.4 `[Read]`), and the operator's standing rule
  "every failing mark gets an affordance or is cut" (prd13 ruling 13 `[Read]`). - *Shift-handover
  log*: **O — the digest.** The one NOC table stake with no rhizomorph answer at all. - *Big-board +
  operator console split*: the scene/fleet-table split is this by construction.

**Pattern across all six families:** the refusals are consistently *action-shaped* (retry, escalate,
adjudicate, manage prompts) and the omissions are consistently *memory- and operator-state-shaped*
(digest, pins, ack, find). The constitution has been excellent at refusing action. It has been
silent about memory — and prd16 just built the legal machinery (sidecars, the recorder's hand) that
makes operator-state features constitutional. The omissions cluster is now buildable.

---

## 3. Sweep three — leverage for the one-person company

Scoring: (operator-hours saved × trust gained) / build cost. Costs: XS <½ day · S ~1 day ·
M 2–4 days · L a wave. Hours/trust are `[Hypothesis]` throughout — stated so they can be falsified
by living with the features.

The one-person-company lens changes the usual ranking in two ways. First, **daily beats severe**: a
digest that saves 20 minutes every evening outranks a forensic tool used twice a month. Second,
**trust compounds differently when there is no team** — the operator doesn't need to convince
colleagues; they need to safely *not look* at things, and every feature should be judged by how much
not-looking it makes safe.

---

## (a) The ranked gap list

| # | Gap | Verdict | Cost | Why here |
|---|---|---|---|---|
| 1 | **Session digest / shift report** — `rhizomorph digest [session]` emits markdown: what landed (per lane, from chapters), what it cost (SessionListing), what held at gates, what summoned you and for how long, what the gaps were (gap voices as prose). A draft the operator edits into the journal, never an autonomous log. | **ACCEPT** | **M** | #1 job (absence review) + the fully-unserved journal step, served daily; every ingredient already exists as a tested selector `[Ran/Read]`; zero UI footprint (stdout), so zero constitutional exposure. The roadmap's own flagship-unclaimed feature, un-orphaned. |
| 2 | **The landing is inspectable** — click a `lane-landed` chapter / feed line → diffstat + patch (read-only `git show`), judge findings for those files docked beside it. No approve/reject, ever. | **ACCEPT** | **M** | Highest-stakes decision of the day currently happens fully off-instrument `[Ran]`; second-reader evidence is the strongest in the operator's own research corpus `[Read]`; converts the feed/ledger dead-ends the IA spike flagged into entry points. |
| 3 | **Operator annotations (pins)** — sidecar `{ts, text}` per session, rendered in the existing mark lane, exportable with the record. | **ACCEPT** | **S–M** | The one mark kind that can't be derived `[Read]`; serves jobs 2, 3, and 4 simultaneously; prd16's sidecar law makes it constitutional verbatim. Natural future home: the fork affordance's neighbor. |
| 4 | **"Seen" acknowledgement** — operator-invoked dim on a summons; brightness/order only; evidence counts and escalation untouched. | **ACCEPT (narrow)** | **S** | Return-triage hygiene; the middle state between nothing and PARKED. Killed forms: "handled" (unverifiable claim), "muted" (exists as PARKED). |
| 5 | **Find-in-transcript + quick-jump** — client-side find over the drawer's loaded conversation; a jump palette over lane handles + chapters. | **ACCEPT (narrow)** | **S** | Incident forensics on 9 MB transcripts currently means scrolling `[Read]`. Global cross-session search: **KILL** (no corpus pain yet; revisit at the forest). |
| 6 | **Local OS notification on summons onset** — browser Notification API, fires only when the tab is hidden, carries the chip text. | **ACCEPT** | **XS** | Absence is the #1 job; today's signal dies with the tab `[Ran]`. "Nothing leaves the machine" holds — it's local. |
| 7 | **`+N` expands to the full ordered queue** in the attention strip. | **ACCEPT** | **XS** | The only real hole in next-action ordering; anything smarter is the conductor's policy, not the instrument's. |
| 8 | **Cross-session aggregates** — totals/medians across recordings (cost per session, landings per wave), one summary row in `/recordings`. | **ACCEPT (small)** | **S** | Serves planning without a new overview; rides prd16 ruling 4. |
| 9 | **Fleet knowledge as product data** (scars, coupling maps) | **DEFER** | — | Wrong shape solo (toolchain knowledge, not repo knowledge `[Ran]`); annotations cover the moment-anchored slice; becomes real at the forest, where prd11 already names persistent shared knowledge as the goal `[Read]`. |
| 10 | **Dollar budgets / burn alerts** | **KILL** | — | Bottom-ranked job; this operator's marginal cost is subscription-flat `[Ran — CLAUDE.md]`; EXPENSIVE state + gap voices already flag anomaly; rate-limit honesty is already legislated (prd15 r6). |
| 11 | **Review workbench / arbitration queue** | **KILL** | — | An approval affordance is conducting; the research says route humans to machine *disagreement*, and #2 does exactly that without owning the workflow. |
| 12 | **Global full-text search** | **KILL (for now)** | — | See #5. |
| 13 | **Escalation policies / on-call / status page** | **KILL** | — | There is no second person. The ladder is the escalation policy. |

Sequencing note: #1 needs prd16's session identity to bound "the shift" — it should follow rotation,
not precede it. #2–#7 are independent of the lab track and none touches the curated order.

---

## (b) Candidate design principles, stated as testable laws

1. **The instrument drafts; the operator signs.** Any prose the instrument emits (digest, handover
   note) derives only from recorded events and names its own gaps in the gap voice. *Test:* every
   digest line cites an event ts; a session with an uninstrumented conductor emits that sentence in
   the draft; no digest is ever written to disk unbidden.
2. **Operator marks are sidecars, never events.** Labels, pins, acks live beside the append-only
   log; deleting every sidecar restores the untouched recording. *Test:* the record's hash chain is
   byte-identical before and after any annotation operation.
3. **Acknowledgement changes salience, never evidence.** A seen summons may recede; no count,
   duration, or escalation changes in response to operator mood. *Test:* the attention strip's
   evidence line is invariant under every ack state; FROZEN reaches full brightness regardless.
4. **Show the disagreement; never render the verdict.** The instrument may juxtapose witnesses
   (diff beside judge finding, claim beside trace) but owns no approve/reject affordance. *Test:*
   the readonly greps stay green; no POST route adjudicates anything.
5. **A pipe before a panel.** Any new output whose consumer is the operator's own workflow (journal,
   issue report, handover) ships first as text on stdout; it earns pixels only after it has earned
   use. *Test:* the curated order's row count is unchanged by the feature's v1.
6. **Every summons must be dismissible-with-evidence or it will be ignored wholesale.** (The
   Wright asymmetry from the operator's own research: attention collapses fast under alert burden
   and barely recovers `[Read]`.) *Test:* count summonses per operator return; if the median return
   presents more than ~5, the ladder is misconfigured, not the operator inattentive.

---

## (c) What the operator is missing that's obvious

**You built a perfect memory and you still write your diary by hand.**

Every evening this week, the operator hand-typed a journal entry summarizing what the fleet did —
the agenticlaunchpad git log is literally a row of `Journal: …` commits (`[Ran]`) — while an
instrument purpose-built to witness that exact fleet recorded 55,049 events of the same day
(`[Read — adversarial audit]`). The roadmap has known since prd4 that "what did my swarm do while I
was away" was the strongest user-stated pain; it parked the catch-up brief as a cohort flagship, and
the cohort era ended — but the parking decision was never revisited (`docs/roadmap.md` `[Read]`).
Meanwhile every prd since has been quietly building the digest's parts without naming it: chapters
gave it a beat vocabulary whose labels are already sentences (`"163 landed · 14:32:07"` `[Ran]`),
SessionListing gave it the arithmetic, the gap voices gave it honesty, and prd16 is right now giving
it the one thing it lacked — a bounded, operator-controlled definition of "the shift."

The obvious thing is not a feature the market has and rhizomorph lacks. It is that **the
instrument's entire event-sourced architecture converges on a deliverable it has never once
delivered: the day, told back.** For the one-person company, that artifact is the difference
between an observability tool (you look at it) and a colleague (it reports to you). It is also the
cheapest of the top gaps relative to what's already built — the selectors exist; only the
sentence-emitter is missing.

Runner-up, one sentence: the gate is the only step of the operator's day with irreversible
consequences, and it is the only step the instrument is completely blind to — no diff has ever been
rendered by this product (`[Ran]`).
